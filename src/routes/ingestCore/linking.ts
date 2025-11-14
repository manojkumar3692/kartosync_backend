// src/routes/ingestCore/linking.ts
export type OrderStatus =
  | "pending" | "confirmed" | "packing"
  | "paid" | "shipped" | "delivered" | "cancelled";

const HARD_CLOSE: OrderStatus[] = ["paid", "shipped", "delivered", "cancelled"];
const DEFAULT_WINDOW_MIN = 120; // 2 hours

export function minutesSince(iso?: string | null) {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

export function looksLikeFreshList(text: string): boolean {
  const lines = (text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const qtyOrUnit =
    /\b\d+(\.\d+)?\s?(kg|g|gram|grams|ltr|liter|litre|l|ml|pcs?|packs?|packet|dozen|bottle|bottles|box|boxes)\b/i.test(text) ||
    /\b\d+\b/.test(text);
  return qtyOrUnit;
}

export function explicitNewOrder(text: string): boolean {
  return /\b(new order|fresh order|separate bill|separate order)\b/i.test(text) || /🆕/.test(text);
}

export function explicitAppend(text: string): boolean {
  return /\b(add|also|same order|update|include)\b/i.test(text);
}

/**
 * Decide whether to append to the last open order or create a new one.
 *
 * @param last Minimal info about last order for the phone (can be null)
 * @param text Incoming message text
 * @param mergeWindowMin Optional override via env
 */
export function decideLinking(
  last: { status: OrderStatus; last_inbound_at?: string | null; created_at?: string } | null,
  text: string,
  mergeWindowMin = Number(process.env.MERGE_WINDOW_MIN ?? DEFAULT_WINDOW_MIN)
): { action: "append" | "new"; reason:
      "no_previous" |
      "new_after_shipped_or_paid" |
      "new_after_window" |
      "explicit_keyword" |
      "fresh_list_shape" |
      "explicit_append" |
      "default_within_window"
} {
  if (!last) return { action: "new", reason: "no_previous" };

  if (HARD_CLOSE.includes(last.status)) {
    return { action: "new", reason: "new_after_shipped_or_paid" };
  }

  const anchor = last.last_inbound_at || last.created_at || null;
  const mins = minutesSince(anchor);
  if (mins > mergeWindowMin) {
    return { action: "new", reason: "new_after_window" };
  }

  if (explicitNewOrder(text)) return { action: "new", reason: "explicit_keyword" };
  if (looksLikeFreshList(text)) return { action: "new", reason: "fresh_list_shape" };
  if (explicitAppend(text)) return { action: "append", reason: "explicit_append" };

  return { action: "append", reason: "default_within_window" };
}