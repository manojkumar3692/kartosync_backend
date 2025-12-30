// src/ai/ingest/cancelEngine.ts

import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";
import { clearState } from "./stateManager";
import { resetAttempts } from "./attempts";

const CANCELLABLE = [
  "awaiting_customer_action",
  "awaiting_payment",
  "awaiting_payment_proof",
  "awaiting_pickup_payment",
  "pending_payment",
  "draft",
  "pending",
];

async function clearTempCart(org_id: string, from_phone: string) {
  const phoneKey = String(from_phone || "").replace(/[^\d]/g, "");

  await supa.from("temp_selected_items").upsert({
    org_id,
    customer_phone: phoneKey,
    updated_at: new Date().toISOString(),
    cart: [],
    item: null,
    list: null,
  } as any);
}

export async function handleCancel(
  ctx: IngestContext
): Promise<IngestResult> {
  const { org_id, from_phone } = ctx;

  // ─────────────────────────────────────────────
  // Get most recent order
  // ─────────────────────────────────────────────
  const phoneKey = String(from_phone || "").replace(/[^\d]/g, "");

  const { data: order } = await supa
    .from("orders")
    .select("id, status, created_at")
    .eq("org_id", org_id)
    .eq("source_phone", phoneKey)
    .in("status", CANCELLABLE as any)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

    if (!order) {
      await clearState(org_id, from_phone);
      await clearTempCart(org_id, from_phone);
      await resetAttempts(org_id, from_phone);
  
      return {
        used: true,
        kind: "cancel",
        reply:
          "✅ Done — I cleared the current flow.\n" +
          "You can start a new order by typing an item name.",
        order_id: null,
      };
    }

  // ─────────────────────────────────────────────
  // Check if order is cancellable
  // ─────────────────────────────────────────────
  if (!CANCELLABLE.includes(order.status)) {
    return {
      used: true,
      kind: "cancel",
      reply:
        `❌ Order #${order.id} cannot be cancelled now.\n` +
        `Current status: *${order.status.toUpperCase()}*`,
      order_id: order.id,
    };
  }

  // ─────────────────────────────────────────────
  // Update DB → cancel order
  // ─────────────────────────────────────────────
  await supa
    .from("orders")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      payment_status: "unpaid",
    })
    .eq("id", order.id);

     // ✅ clear ALL flow state + temp cart so user can restart cleanly
  await clearState(org_id, from_phone);
  await clearTempCart(org_id, from_phone);
  await resetAttempts(org_id, from_phone);

  return {
    used: true,
    kind: "cancel",
    reply:
      `🛑 Your order #${order.id} has been *cancelled*.\n` +
      `If you want to order again, just type the item name.`,
    order_id: order.id,
  };
}