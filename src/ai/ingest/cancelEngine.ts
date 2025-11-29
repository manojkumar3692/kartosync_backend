// src/ai/ingest/cancelEngine.ts

import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";

const CANCELLABLE = ["pending", "accepted", "preparing"];

export async function handleCancel(
  ctx: IngestContext
): Promise<IngestResult> {
  const { org_id, from_phone } = ctx;

  // ─────────────────────────────────────────────
  // Get most recent order
  // ─────────────────────────────────────────────
  const { data: order } = await supa
    .from("orders")
    .select("id, status, created_at")
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!order) {
    return {
      used: true,
      kind: "cancel",
      reply: "You have no active orders to cancel.",
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
    })
    .eq("id", order.id);

  return {
    used: true,
    kind: "cancel",
    reply:
      `🛑 Your order #${order.id} has been *cancelled*.\n` +
      `If you want to order again, just type the item name.`,
    order_id: order.id,
  };
}