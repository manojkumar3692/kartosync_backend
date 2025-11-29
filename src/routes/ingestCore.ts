// src/routes/ingestCore.ts
// Thin wrapper so existing code (waba, local ingest) still calls the same name,
// but the logic is now in src/ai/ingest.

import type { IngestInput as LegacyIngestInput } from "../types"; // your existing global type
import { ingestCoreFromMessage as aiIngestCore } from "../ai/ingest";
import type { IngestContext, IngestResult as AiIngestResult } from "../ai/ingest/types";
// src/ai/ingestCore.ts  (or wherever your helpers live)

import { supa } from "../db";

// Computes totals for order.items
export async function computeOrderTotals(items: any[]) {
  const outLines: string[] = [];
  let subtotal = 0;

  for (const it of items || []) {
    if (!it) continue;

    const qty = Number(it.qty || 1);
    const canonical = it.canonical || it.name || "";
    const variant = it.variant ? ` · ${it.variant}` : "";
    const brand = it.brand ? ` · ${it.brand}` : "";

    let price = 0;

    // fetch product price if product_id present
    if (it.product_id) {
      const { data: prod, error } = await supa
        .from("products")
        .select("price_per_unit")
        .eq("id", it.product_id)
        .maybeSingle();

      if (!error && prod && prod.price_per_unit != null) {
        price = Number(prod.price_per_unit);
      }
    }

    const lineTotal = price * qty;
    subtotal += lineTotal;

    const prettyPrice =
      price > 0 ? ` — ₹${Math.round(lineTotal)}` : "";

    outLines.push(
      `* ${qty} ${canonical}${brand}${variant}${prettyPrice}`
    );
  }

  return {
    subtotal,
    total: subtotal, // later add tax / delivery
    lines: outLines,
  };
}

// Map the old IngestInput → new IngestContext
function mapToContext(input: LegacyIngestInput): IngestContext {
  return {
    org_id: input.org_id,
    from_phone: input.from_phone || "",
    text: input.text,
    ts: input.ts || Date.now(),
    source: (input.source as any) || "waba",
  };
}

// Keep the same exported function name used by waba.ts
export async function ingestCoreFromMessage(
  input: LegacyIngestInput
): Promise<any> {
  const ctx = mapToContext(input);
  const res: AiIngestResult = await aiIngestCore(ctx);

  // For now, just pass through the new result shape.
  // waba.ts only reads: kind, reason?, order_id?, stored?, reply?
  return {
    ok: true,
    stored: typeof res.order_id === "number",
    kind: res.kind,
    used: res.used ? "ai" : "none",
    reply: res.reply ?? null,
    order_id: res.order_id ?? null,
    items: (res as any).items ?? null,
    org_id: ctx.org_id,
  };
}