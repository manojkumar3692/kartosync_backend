// src/order/applyModifierToOrder.ts
import { supa } from "../db";
import type { ModifierPayload, IngestItem } from "../types";
import {
  applyModifierToItems,
  type ApplyModifierResult,
} from "./modifierEngine";

export type ApplyModifierToOrderResult = ApplyModifierResult & {
  orderId: string;
};

export async function applyModifierToOrder(opts: {
  orgId: string;
  orderId: string;
  modifier: ModifierPayload | null;
  // resolveIndex is reserved for future disambiguation answers,
  // but NOT used yet (to keep engine signature simple for now).
  resolveIndex?: number;
}): Promise<ApplyModifierToOrderResult> {
  const { orgId, orderId, modifier } = opts;

  if (!modifier) {
    return {
      status: "noop",
      items: [],
      summary: "no modifier provided",
      orderId,
    };
  }

  // 1) Load order
  const { data: order, error } = await supa
    .from("orders")
    .select("id, items, parse_reason")
    .eq("org_id", orgId)
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return {
      status: "noop",
      items: [],
      summary: "Order not found",
      orderId,
    };
  }

  const items: IngestItem[] = Array.isArray(order.items)
    ? order.items
    : [];

  // 2) Apply modifier in-memory (2-arg version, no options yet)
  const result = applyModifierToItems(items, modifier);

  if (result.status !== "applied") {
    // nothing written to DB
    return { ...result, orderId };
  }

  // 3) Persist updated items
  const nextReason =
    ((order.parse_reason as string) || "") +
    `; modifier:${result.summary}`;

  const { error: upErr } = await supa
    .from("orders")
    .update({
      items: result.items,
      parse_reason: nextReason,
    })
    .eq("org_id", orgId)
    .eq("id", orderId);

  if (upErr) {
    return {
      status: "noop",
      items,
      summary: `DB update failed: ${upErr.message}`,
      orderId,
    };
  }

  return { ...result, orderId };
}