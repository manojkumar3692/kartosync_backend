// src/ai/predictiveOrdering.ts
import { supa } from "../db";

type OrderRow = {
  id: string;
  items: any[] | null;
  status: string | null;
  created_at: string;
};

type ItemKey = {
  key: string; // e.g. "pid:123" or "canon:mutton biryani"
  sampleItem: any;
  orderCount: number; // in how many orders does this appear
  totalQty: number;
  lastSeenIndex: number; // 0 = most recent order
  score: number; // frequency + recency combined
};

export type PredictiveGuess = {
  items: any[];              // suggested "usual" items
  confidence: number;        // 0–1
  baseOrderId: string | null;
  reason: string;            // for logs
};

/**
 * Simple helper: normalize strings.
 */
function norm(s: string | null | undefined): string {
  return (s || "").toString().toLowerCase().trim();
}

/**
 * Statuses we consider as "real completed-ish" orders for learning.
 */
const LEARNABLE_STATUSES = [
  "pending",
  "paid",
  "delivered",
  "completed",
  "confirmed",
];

/**
 * Build a stable key for an item so we can aggregate over orders.
 * Prefer product_id, else canonical/name.
 */
function buildItemKey(it: any): string | null {
  if (!it) return null;

  const pid = it.product_id || it.productId || null;
  if (pid) return `pid:${String(pid)}`;

  const canon = norm(it.canonical || it.name || "");
  if (canon) return `canon:${canon}`;

  return null;
}

/**
 * Compute a simple score for each repeated item using:
 *  - how many orders it appears in
 *  - recency (more weight for recent orders)
 *
 * Then pick a small set of items as "usual order".
 */
export async function guessUsualOrderForCustomer(opts: {
  orgId: string;
  fromPhone: string; // raw WhatsApp number (same as msg.from in waba)
  maxOrders?: number;
}): Promise<PredictiveGuess> {
  const { orgId, fromPhone, maxOrders = 30 } = opts;

  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, created_at")
      .eq("org_id", orgId)
      .eq("source_phone", fromPhone)
      .order("created_at", { ascending: false })
      .limit(maxOrders);

    if (error || !data || !data.length) {
      if (error) {
        console.warn("[PREDICT][orders err]", error.message);
      }
      return {
        items: [],
        confidence: 0,
        baseOrderId: null,
        reason: "no_past_orders",
      };
    }

    const orders = (data as OrderRow[]).filter((o) =>
      LEARNABLE_STATUSES.includes(norm(o.status))
    );

    if (!orders.length) {
      return {
        items: [],
        confidence: 0,
        baseOrderId: null,
        reason: "no_learnable_status_orders",
      };
    }

    const statsByKey = new Map<string, ItemKey>();

    // Go over each order (0 = most recent)
    orders.forEach((ord, orderIndex) => {
      const items = Array.isArray(ord.items) ? (ord.items as any[]) : [];
      if (!items.length) return;

      // Avoid counting same key twice within the same order for orderCount
      const seenInThisOrder = new Set<string>();

      for (const it of items) {
        const key = buildItemKey(it);
        if (!key) continue;

        const qty = Number(it.qty || it.quantity || 1);
        const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;

        let stat = statsByKey.get(key);
        if (!stat) {
          stat = {
            key,
            sampleItem: it,
            orderCount: 0,
            totalQty: 0,
            lastSeenIndex: orderIndex,
            score: 0,
          };
          statsByKey.set(key, stat);
        }

        stat.totalQty += safeQty;

        if (!seenInThisOrder.has(key)) {
          stat.orderCount += 1;
          seenInThisOrder.add(key);

          // Recency weight: recent orders contribute more
          const recencyWeight = 1 / (1 + orderIndex); // 1, 0.5, 0.33, ...
          stat.score += recencyWeight;
        }

        // Track latest seen (closest to 0)
        if (orderIndex < stat.lastSeenIndex) {
          stat.lastSeenIndex = orderIndex;
          // Update sample item to the most recent version
          stat.sampleItem = it;
        }
      }
    });

    const stats = Array.from(statsByKey.values());

    if (!stats.length) {
      return {
        items: [],
        confidence: 0,
        baseOrderId: null,
        reason: "no_items_across_orders",
      };
    }

    // Require items that appear in at least 2 orders to count as "usual"
    const repeated = stats.filter((s) => s.orderCount >= 2);
    if (!repeated.length) {
      return {
        items: [],
        confidence: 0.2,
        baseOrderId: orders[0]?.id || null,
        reason: "no_repeated_items",
      };
    }

    repeated.sort((a, b) => b.score - a.score);

    const top = repeated[0];
    const second = repeated[1];

    const totalOrders = orders.length;
    const freqTop = top.orderCount / totalOrders;
    const margin = second ? top.score - second.score : top.score;

    let confidence = 0.4;
    if (totalOrders >= 3) {
      if (freqTop >= 0.6 && margin >= 0.5) confidence = 0.9;
      else if (freqTop >= 0.5) confidence = 0.75;
      else if (freqTop >= 0.4) confidence = 0.6;
      else confidence = 0.4;
    } else {
      // very little history, but some repetition
      confidence = 0.5;
    }

    // Pick up to 3 top repeated items as "usual order"
    const MAX_SUGGEST = 3;
    const chosen: any[] = [];

    for (const s of repeated) {
      if (chosen.length >= MAX_SUGGEST) break;
      chosen.push(s.sampleItem);
    }

    if (!chosen.length) {
      return {
        items: [],
        confidence: 0.3,
        baseOrderId: orders[0]?.id || null,
        reason: "no_chosen_items",
      };
    }

    return {
      items: chosen,
      confidence,
      baseOrderId: orders[0]?.id || null,
      reason: `ok:${chosen.length}_items:${totalOrders}_orders`,
    };
  } catch (e: any) {
    console.warn("[PREDICT][guessUsualOrder catch]", e?.message || e);
    return {
      items: [],
      confidence: 0,
      baseOrderId: null,
      reason: "exception",
    };
  }
}