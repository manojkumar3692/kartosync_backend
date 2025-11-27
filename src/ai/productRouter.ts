// src/ai/productRouter.ts
//
// Layer 6: Product-Synonym / Router layer
// ---------------------------------------
// Goal:
//  - Take the raw item text the parser extracted (e.g. "panner biriyani 1kg")
//  - Normalize it
//  - Ask our product matcher to pick the best product for this org
//  - Return a clean canonical + product_id + variant, with a simple confidence
//
// This is GENERIC – no hardcoded food words, works for grocery/salon/pharmacy/etc.

import { supa } from "../db";
import { findBestProductForTextV2 } from "../util/productMatcher";
import { resolveAliasForText } from "../routes/waba/aliasEngine";

export type RoutedProduct = {
  product_id: string | null;
  canonical: string | null;
  display_name: string | null;
  variant: string | null;
  base_unit: string | null;
  confidence: number; // 0–1
  source: "alias" | "matcher" | "fallback";
};

// Simple helpers (same flavour as in productMatcher)
function normalize(text: any): string {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

// Rough similarity score between query and product name (for confidence)
function computeNameSimilarity(query: string, productName: string): number {
  const qTokens = new Set(tokenize(query));
  const pTokens = tokenize(productName);

  if (!qTokens.size || !pTokens.length) return 0;

  let overlap = 0;
  for (const t of pTokens) {
    if (qTokens.has(t)) overlap++;
  }

  const denom = Math.max(pTokens.length, qTokens.size);
  if (!denom) return 0;

  return overlap / denom; // 0–1
}

export async function routeProductText(opts: {
  org_id: string;
  rawName: string;
}): Promise<RoutedProduct | null> {
  const { org_id, rawName } = opts;
  const clean = normalize(rawName);
  if (!clean) return null;

  // 0) Try alias memory FIRST (org/global)
  try {
    const aliasHit = await resolveAliasForText({
      org_id,
      // we can later pass customer_phone when we have it in this layer
      customer_phone: undefined,
      wrong_text: rawName,
    });

    if (aliasHit && aliasHit.canonical_product_id) {
      const { data: prod, error: prodErr } = await supa
        .from("products")
        .select("id, canonical, display_name, base_unit, variant")
        .eq("org_id", org_id)
        .eq("id", aliasHit.canonical_product_id)
        .maybeSingle();

      if (!prodErr && prod && prod.id) {
        const canonical =
          (prod.canonical && String(prod.canonical)) ||
          (prod.display_name && String(prod.display_name)) ||
          null;

        const display_name = prod.display_name
          ? String(prod.display_name)
          : canonical;

        const base_unit =
          (prod.base_unit && String(prod.base_unit)) || null;

        // For now, variant comes from product row only
        const variant = prod.variant ? String(prod.variant) : null;

        const nameForSim = [canonical, display_name]
          .filter(Boolean)
          .join(" ");

        const sim = computeNameSimilarity(clean, nameForSim);
        const confidence = Math.max(0, Math.min(1, sim || 1));

        return {
          product_id: prod.id as string,
          canonical,
          display_name,
          variant,
          base_unit,
          confidence,
          source: "alias",
        };
      }
    }
  } catch (e: any) {
    console.warn("[productRouter][alias lookup err]", e?.message || e);
  }

  // 1) Use our upgraded matcher (Layer 6 depends on Layer 5)
  const best: any = await findBestProductForTextV2(org_id, clean);
  if (!best) return null;

  const canonical =
    (best.canonical && String(best.canonical)) ||
    (best.display_name && String(best.display_name)) ||
    null;

  const display_name = best.display_name
    ? String(best.display_name)
    : canonical;

  const base_unit =
    (best.base_unit && String(best.base_unit)) ||
    (best.unit && String(best.unit)) ||
    null;

  // 2) Compute a soft confidence based on name similarity
  const nameForSim = [best.canonical, best.display_name]
    .filter(Boolean)
    .join(" ");

  const sim = computeNameSimilarity(clean, nameForSim);
  const confidence = Math.max(0, Math.min(1, sim || 0));

  const routed: RoutedProduct = {
    product_id: best.id ?? null,
    canonical,
    display_name,
    variant: best.variant ? String(best.variant) : null,
    base_unit,
    confidence,
    source: "matcher",
  };

  return routed;
}

// Optional helper: bulk routing for many items in a parsed order
// (We may use this from ingestCore so we don't call DB for each item separately.)
export async function routeMultipleProducts(opts: {
  org_id: string;
  rawItems: { name: string }[];
}): Promise<RoutedProduct[]> {
  const { org_id, rawItems } = opts;
  const out: RoutedProduct[] = [];

  for (const it of rawItems) {
    const name = (it && it.name) || "";
    if (!name) continue;

    const routed = await routeProductText({ org_id, rawName: name });
    if (routed) out.push(routed);
  }

  return out;
}