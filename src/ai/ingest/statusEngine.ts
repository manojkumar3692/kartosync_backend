// src/ai/ingest/statusEngine.ts

import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";

const STATUS_LABELS: Record<string, string> = {
  pending: "🕒 Pending (waiting for restaurant confirmation)",
  accepted: "🟢 Accepted (order is being prepared)",
  preparing: "👨‍🍳 Preparing your food",
  ready: "📦 Ready for pickup",
  out_for_delivery: "🚗 Out for delivery",
  delivered: "✅ Delivered",
  cancelled: "❌ Cancelled",
};

export async function handleStatus(
  ctx: IngestContext
): Promise<IngestResult> {
  const { org_id, from_phone } = ctx;

  // ─────────────────────────────────────────────
  // Get the most recent order for this customer
  // ─────────────────────────────────────────────
  const { data: order } = await supa
    .from("orders")
    .select("id, status, created_at")
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // No order found
  if (!order) {
    return {
      used: true,
      kind: "status",
      reply:
        "📭 You don't have any orders yet.\n" +
        "You can start ordering by typing the item name (e.g., *Chicken Biryani*).",
      order_id: null,
    };
  }

  const status = order.status;
  const label = STATUS_LABELS[status] || status;

  return {
    used: true,
    kind: "status",
    reply:
      `📦 *Order Status (#${order.id})*\n` +
      `${label}\n\n` +
      `If you want to order something else, just type the item name.`,
    order_id: order.id,
  };
}