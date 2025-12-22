// src/ai/ingest/paymentEngine.ts

import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";
import { clearState, setState } from "./stateManager";
import { emitNewOrder } from "../../routes/realtimeOrders";
import { createRazorpayPaymentLink } from "../../payments/razorpay";

const PAY_CASH = ["cash", "cod", "cash on delivery"];
const PAY_CARD = ["card", "credit", "debit", "card on delivery"];
const PAY_UPI = ["upi", "gpay", "google pay", "phonepe", "paytm"];
const PAY_ONLINE = ["online", "pay online", "link", "payment link"];

type PaymentMode = "cash" | "card" | "upi" | "online";

function detectMode(msg: string): PaymentMode | null {
  msg = msg.toLowerCase();

  if (PAY_CASH.some((k) => msg.includes(k))) return "cash";
  if (PAY_CARD.some((k) => msg.includes(k))) return "card";
  if (PAY_UPI.some((k) => msg.includes(k))) return "upi";
  if (PAY_ONLINE.some((k) => msg.includes(k))) return "online";

  return null;
}

// Simple ETA helper – can later read from org settings if needed
function getEtaLabel(mode: PaymentMode): string {
  // You can tweak per mode if you want
  return "⏱ Estimated delivery: 30–45 minutes (depending on location).";
}

const normalizePhone = (p: string) => (p || "").replace(/[^\d]/g, "");

function getAmountInrFromSummary(total: number | null): number {
  const amt = Number(total || 0);
  // Razorpay expects amount in INR rupees here because your helper does amount_inr
  return Math.max(0, Math.round(amt));
}

// Safely build order summary text + total from order.items
function buildOrderSummary(order: any | null): {
  text: string;
  total: number | null;
} {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    return { text: "", total: null };
  }

  const lines: string[] = [];
  let subtotal = 0;

  for (const it of order.items) {
    const name = it.name || "Item";
    const variant = it.variant ? ` (${it.variant})` : "";
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const lineTotal = qty * price;

    if (qty > 0) {
      lines.push(
        `• ${name}${variant} x ${qty}${price ? ` — ₹${lineTotal}` : ""}`
      );
    }

    if (!Number.isNaN(lineTotal)) {
      subtotal += lineTotal;
    }
  }

  const deliveryFee = Number(order.delivery_fee ?? 0);
  const grandTotal = subtotal + (deliveryFee > 0 ? deliveryFee : 0);

  const feeLine =
    deliveryFee > 0
      ? `Delivery Fee: ₹${deliveryFee}`
      : deliveryFee === 0
      ? `Delivery Fee: FREE`
      : `Delivery Fee: will be confirmed`;

  const body =
    lines.join("\n") +
    `\n\nSubtotal: ₹${subtotal}` +
    `\n${feeLine}` +
    `\n——————————\n` +
    `*Total Payable: ₹${grandTotal}*`;

  return { text: body, total: grandTotal };
}

export async function handlePayment(ctx: IngestContext): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;
  const raw = (text || "").trim();
  const msg = raw.toLowerCase();

  console.log("✅✅ [PAYMENT_ENGINE][ENTER]", {
    org_id,
    from_phone,
    raw,
    state_expected: "awaiting_payment",
  });

  let mode: PaymentMode | null = null;

  // 1️⃣ NUMBER FIRST (your current UI: 1 = Cash, 2 = Online)
  if (/^[1-4]$/.test(msg)) {
    if (msg === "1") mode = "cash";
    else if (msg === "2") mode = "online";
    else if (msg === "3") mode = "upi";
    else if (msg === "4") mode = "card";
  }

  // 2️⃣ TEXT SECOND
  if (!mode) {
    mode = detectMode(msg);
  }

  // 3️⃣ FALLBACK → ask cleanly again
  if (!mode) {
    return {
      used: true,
      kind: "payment",
      reply:
        "💳 Please choose a payment method:\n" +
        "1) Cash\n" +
        "2) Online Payment\n\n" +
        "Or type: *cash* / *online* / *upi* / *card*.",
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 1) Save payment to customer's profile
  // ─────────────────────────────────────────────
  await supa.from("org_customer_profiles").upsert(
    {
      org_id,
      customer_phone: from_phone,
      payment_mode: mode,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,customer_phone" }
  );

  // ─────────────────────────────────────────────
  // 2) Attach payment mode to latest "pending" order
  //    and fetch items for summary
  // ─────────────────────────────────────────────
  const { data: order } = await supa
    .from("orders")
    .select(
      "id, status, items, total_amount, delivery_fee, delivery_type, created_at, currency_code, razorpay_payment_link_url,razorpay_payment_link_id,payment_provider"
    )
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .in("status", ["awaiting_customer_action"] as any)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (order?.id) {
    // always save chosen mode
    await supa.from("orders").update({ payment_mode: mode }).eq("id", order.id);

    const isCashLike = mode === "cash" || mode === "card";
    const isOnlineLike = !isCashLike; // online / upi

    // ✅ COD/Card: send to store immediately (this triggers dashboard alarm via emitNewOrder)
    if (isCashLike) {
      const { error: accErr } = await supa
        .from("orders")
        .update({
          status: "awaiting_store_action",
          payment_status: "unpaid",
          payment_provider: null,
          razorpay_payment_link_id: null,
          razorpay_payment_link_url: null,
        } as any)
        .eq("id", order.id)
        .eq("org_id", org_id);

      if (!accErr) {
        try {
          emitNewOrder(org_id, {
            id: order.id,
            org_id,
            source_phone: from_phone,
            status: "awaiting_store_action",
            created_at: order.created_at,
            total_amount: order.total_amount ?? null,
            items: order.items ?? [],
            // OPTIONAL: include these if your dashboard filters by them
            delivery_type: order.delivery_type ?? null,
            payment_mode: mode,
          } as any);
        } catch (e) {
          console.warn("[PAYMENT][SSE_EMIT_ERR]", e);
        }
      }

      await clearState(org_id, from_phone);
    }

    // ✅ Online/UPI: generate Razorpay link FIRST (if possible), else fallback to QR
    if (isOnlineLike) {
      // Keep order open but mark as awaiting payment
      await supa
        .from("orders")
        .update({
          status: "awaiting_payment_proof", // 👈 IMPORTANT: makes the flow consistent
          payment_status: "unpaid",
        } as any)
        .eq("id", order.id)
        .eq("org_id", org_id);

      // Put the user in waiting state
      await setState(org_id, from_phone, "awaiting_payment_proof" as any);

      // Only create Razorpay link for "online" (you can include UPI too if you want)
      if (mode === "online") {
        try {
          // Use computed grand total (items + delivery fee)
          const { total } = buildOrderSummary(order);
          const amount_inr = getAmountInrFromSummary(total);

          if (amount_inr > 0) {
            const pl = await createRazorpayPaymentLink({
              org_id,
              order_id: order.id,
              amount_inr,
              customer_phone: normalizePhone(from_phone),
            });

            await supa
              .from("orders")
              .update({
                payment_provider: "razorpay",
                payment_status: "unpaid",
                razorpay_payment_link_id: pl.id,
                razorpay_payment_link_url: pl.short_url,
                status: "awaiting_payment_proof",
              } as any)
              .eq("id", order.id)
              .eq("org_id", org_id);

            // ✅ patch local order so the reply uses link immediately
            (order as any).razorpay_payment_link_url = pl.short_url;
            (order as any).razorpay_payment_link_id = pl.id;
            (order as any).payment_provider = "razorpay";

            console.log("[PAYMENT][RAZORPAY_LINK_OK]", {
              order_id: order.id,
              short_url: pl.short_url,
            });
          }
        } catch (e: any) {
          console.warn("[PAYMENT][RAZORPAY_LINK_FAIL]", e?.message || e);
          // silently fallback to QR (your existing QR logic below will handle)
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  // 3) Decide if this is an "online" mode and load org QR + note
  //    RULE: anything that is NOT cash/card is treated as online
  // ─────────────────────────────────────────────
  const isOnlineMode = mode !== "cash" && mode !== "card";

  let qrUrl: string | null = null;
  let paymentNote: string | null = null;

  if (isOnlineMode) {
    const { data: orgRow, error: orgErr } = await supa
      .from("orgs")
      .select("payment_qr_url, payment_instructions")
      .eq("id", org_id)
      .maybeSingle();

    console.log("[PAYMENT][ORG_ROW]", { orgErr, orgRow });

    if (!orgErr && orgRow) {
      qrUrl = (orgRow as any).payment_qr_url || null;
      paymentNote = (orgRow as any).payment_instructions || null;
    }
  }

  console.log("[PAYMENT][MODE_FLAGS]", {
    mode,
    isOnlineMode,
    qrUrl,
    paymentNote,
  });

  // clear state after payment chosen
  // await clearState(org_id, from_phone);

  const modeLabel =
    mode === "cash"
      ? "Cash on Delivery"
      : mode === "card"
      ? "Card on Delivery"
      : mode === "upi"
      ? "UPI"
      : "Online Payment";

  // Build order summary (if we have an order)
  const { text: summaryBody, total } = buildOrderSummary(order);
  const etaLine = order ? getEtaLabel(mode) : "";
  const totalLine =
    order && total !== null
      ? `--------------------------------\nTotal: ${total}\n\n`
      : "\n";

  console.log("[PAYMENT][PREFERS]", {
    hasPayLink: !!(order as any)?.razorpay_payment_link_url,
    payLink: (order as any)?.razorpay_payment_link_url,
    hasQr: !!qrUrl,
  });

  let nextStepLine = "";
  if (!order?.id) {
    // No order found – keep old fallback
    nextStepLine = "Payment mode saved for your next order.";
  } else if (!isOnlineMode) {
    // Cash / Card on delivery
    nextStepLine =
      `${etaLine}\n` + "📞 For any changes, just reply here with your message.";
  } else {
    const payLink = (order as any)?.razorpay_payment_link_url || null;

    if (payLink) {
      nextStepLine =
        `${etaLine}\n` +
        "💳 Online payment only.\n" +
        "Please pay using this link:\n" +
        `*${payLink}*\n\n` +
        "After payment, send screenshot / transaction id here (or type *paid*).\n" +
        "Type *cancel* to change payment method.";
    } else if (qrUrl) {
      nextStepLine =
        `${etaLine}\n` +
        "📷 Please scan the QR code below to complete the payment.\n" +
        (paymentNote ? `${paymentNote}\n` : "") +
        "After payment, send screenshot / transaction id here (or type *paid*).\n" +
        "Type *cancel* to change payment method.";
    } else {
      nextStepLine =
        `${etaLine}\n` +
        "⚠️ Payment details are not configured.\n" +
        "Type *cancel* to switch to Cash or contact the store.";
    }
  }

  // If we couldn’t read items for some reason, fall back to simple text
  if (!order?.id || !summaryBody) {
    const safeSummary = summaryBody || null;
    const payLink = (order as any)?.razorpay_payment_link_url || null;
    const resultFallback = {
      used: true as const,
      kind: "payment" as const,
      reply:
        `💳 Payment method saved: *${modeLabel}*.\n\n` +
        (safeSummary
          ? safeSummary + `\n\n${nextStepLine}`
          : order?.id
          ? `Your order (#${order.id}) is now being processed.\n\n${nextStepLine}`
          : `Payment mode saved for your next order.`),
      order_id: order?.id || null,
      // 👇 Only non-null for online modes + QR configured
      image: isOnlineMode && !payLink && qrUrl ? qrUrl : null,
    };

    console.log("[PAYMENT][RESULT_FALLBACK]", resultFallback);
    return resultFallback;
  }
  const payLink = (order as any)?.razorpay_payment_link_url || null;
  // Rich confirmation
  const reply =
    `💳 Payment method saved: *${modeLabel}*.\n\n` +
    `🧾 *Order Summary (#${order.id})*\n` +
    `${summaryBody}\n` +
    totalLine +
    `${nextStepLine}`;

  const resultRich = {
    used: true as const,
    kind: "payment" as const,
    reply,
    order_id: order.id || null,
    // 👇 This is what your WABA layer will see and send as image
    image: isOnlineMode && !payLink && qrUrl ? qrUrl : null,
  };

  console.log("[PAYMENT][RESULT_RICH]", resultRich);
  return resultRich;
}
