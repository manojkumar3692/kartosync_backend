// src/ai/ingest/paymentEngine.ts

import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";
import { clearState } from "./stateManager";

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

// Safely build order summary text + total from order.items
function buildOrderSummary(order: any | null): { text: string; total: number | null } {
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
  await supa
    .from("org_customer_profiles")
    .upsert(
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
      "id, status, items, total_amount, delivery_fee, delivery_distance_km, delivery_type"
    )
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (order?.id) {
    await supa
      .from("orders")
      .update({
        payment_mode: mode,
      })
      .eq("id", order.id);
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
  await clearState(org_id, from_phone);

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

  let nextStepLine = "";
  if (!order?.id) {
    // No order found – keep old fallback
    nextStepLine = "Payment mode saved for your next order.";
  } else if (!isOnlineMode) {
    // Cash / Card on delivery
    nextStepLine =
      `${etaLine}\n` +
      "📞 For any changes, just reply here with your message.";
  } else {
    // Any ONLINE mode (UPI / link / other)
    if (qrUrl) {
      // 🔹 We HAVE a QR → tell customer to scan it
      nextStepLine =
        `${etaLine}\n` +
        "📷 Please scan the QR code below to complete the payment.\n" +
        (paymentNote ? `${paymentNote}\n` : "") +
        "📞 For any changes, just reply here with your message.";
    } else {
      // 🔹 No QR configured → old fallback
      nextStepLine =
        `${etaLine}\n` +
        "💸 You’ll receive a payment link / UPI details shortly to complete the payment.\n" +
        "📞 For any changes, just reply here with your message.";
    }
  }

  // If we couldn’t read items for some reason, fall back to simple text
  if (!order?.id || !summaryBody) {
    const safeSummary = summaryBody || null;

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
      image: isOnlineMode && qrUrl ? qrUrl : null,
    };

    console.log("[PAYMENT][RESULT_FALLBACK]", resultFallback);
    return resultFallback;
  }

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
    image: isOnlineMode && qrUrl ? qrUrl : null,
  };

  console.log("[PAYMENT][RESULT_RICH]", resultRich);
  return resultRich;
}