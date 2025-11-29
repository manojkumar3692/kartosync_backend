// src/ai/ingest/paymentEngine.ts

import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";
import { clearState } from "./stateManager";

const PAY_CASH = ["cash", "cod", "cash on delivery"];
const PAY_CARD = ["card", "credit", "debit", "card on delivery"];
const PAY_UPI = ["upi", "gpay", "google pay", "phonepe", "paytm"];
const PAY_ONLINE = ["online", "pay online", "link", "payment link"];

type PaymentMode = "cash" | "card" | "upi" | "online";

function detectModeFromWords(msg: string): PaymentMode | null {
  const m = msg.toLowerCase();

  if (PAY_CASH.some(k => m.includes(k))) return "cash";
  if (PAY_CARD.some(k => m.includes(k))) return "card";
  if (PAY_UPI.some(k => m.includes(k))) return "upi";
  if (PAY_ONLINE.some(k => m.includes(k))) return "online";

  return null;
}

// Prefer numbers (1 / 2 / 3 / 4), then fall back to words
function detectMode(msg: string): PaymentMode | null {
  const clean = msg.trim().toLowerCase();

  if (clean === "1") return "cash";
  if (clean === "2") return "online";
  if (clean === "3") return "card";
  if (clean === "4") return "upi";

  return detectModeFromWords(clean);
}

export async function handlePayment(ctx: IngestContext): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;
  const mode = detectMode(text);

  // Invalid input → ask again
  if (!mode) {
    return {
      used: true,
      kind: "payment",
      reply:
        "💳 Please choose a payment method:\n" +
        "1) Cash\n" +
        "2) Online Payment\n" +
        "3) Card\n" +
        "4) UPI\n\n" +
        "You can type the number (1–4) or the method name (cash / card / upi / online).",
    };
  }

  // 1) Save preference in org_customer_profiles
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

  // 2) Attach payment mode to latest pending order via memos[]
  const { data: order } = await supa
    .from("orders")
    .select("id, memos")
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let orderId: string | null = null;

  if (order?.id) {
    orderId = order.id;

    const existingMemos = Array.isArray(order.memos) ? order.memos : [];
    const newMemos = [
      ...existingMemos,
      {
        kind: "payment_mode",
        value: mode,
        at: new Date().toISOString(),
      },
    ];

    await supa
      .from("orders")
      .update({ memos: newMemos })
      .eq("id", order.id);
  }

  await clearState(org_id, from_phone);

  const modeLabel =
    mode === "cash"
      ? "Cash on Delivery"
      : mode === "card"
      ? "Card on Delivery"
      : mode === "upi"
      ? "UPI"
      : "Online Payment";

  return {
    used: true,
    kind: "payment",
    reply:
      `💳 Payment method saved: *${modeLabel}*.\n\n` +
      (orderId
        ? `Your order (#${orderId}) is now being processed.`
        : `Payment mode saved for your next order.`),
    order_id: orderId,
  };
}