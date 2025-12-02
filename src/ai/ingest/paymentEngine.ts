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
  let total = 0;

  for (const it of order.items) {
    const name = it.name || "Item";
    const variant = it.variant ? ` (${it.variant})` : "";
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const lineTotal = qty * price;

    if (qty > 0) {
      lines.push(`• ${name}${variant} x ${qty}${price ? ` – ${price}` : ""}`);
    }

    if (!Number.isNaN(lineTotal)) {
      total += lineTotal;
    }
  }

  const body = lines.join("\n");
  return { text: body, total: Number.isFinite(total) && total > 0 ? total : null };
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
    .select("id, status, items")
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
    order && total !== null ? `--------------------------------\nTotal: ${total}\n\n` : "\n";

  let nextStepLine = "";
  if (!order?.id) {
    // No order found – keep old fallback
    nextStepLine = "Payment mode saved for your next order.";
  } else if (mode === "cash" || mode === "card") {
    nextStepLine =
      `${etaLine}\n` +
      "📞 For any changes, just reply here with your message.";
  } else if (mode === "upi" || mode === "online") {
    nextStepLine =
      `${etaLine}\n` +
      "💸 You’ll receive a payment link / UPI details shortly to complete the payment.\n" +
      "📞 For any changes, just reply here with your message.";
  }

  // If we couldn’t read items for some reason, fall back to simple text
  if (!order?.id || !summaryBody) {
    return {
      used: true,
      kind: "payment",
      reply:
        `💳 Payment method saved: *${modeLabel}*.\n\n` +
        (order?.id
          ? `Your order (#${order.id}) is now being processed.\n\n${nextStepLine}`
          : `Payment mode saved for your next order.`),
      order_id: order?.id || null,
    };
  }

  // Rich confirmation
  const reply =
    `💳 Payment method saved: *${modeLabel}*.\n\n` +
    `🧾 *Order Summary (#${order.id})*\n` +
    `${summaryBody}\n` +
    totalLine +
    `${nextStepLine}`;

  return {
    used: true,
    kind: "payment",
    reply,
    order_id: order.id || null,
  };
}