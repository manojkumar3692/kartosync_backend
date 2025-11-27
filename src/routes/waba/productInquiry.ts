// src/routes/waba/productInquiry.ts
import { supa } from "../../db";
import { getLatestPrice } from "../../util/products";
import { findBestProductForTextV2 } from "../../util/productMatcher";
import { BusinessType, normalizeBusinessType } from "./business";
import { normalizeLabelForFuzzy, fuzzyCharOverlapScore } from "../../util/fuzzy";
import { resolveAliasForText } from "../../routes/waba/aliasEngine";


export type MenuEntry = {
  label: string;
  price?: number | null;
  currency?: string | null;
};

export function formatMenuLine(index: number, entry: MenuEntry): string {
  const price = entry.price;
  const currencyCode = (entry.currency || "INR").toUpperCase();

  const priceText =
    typeof price === "number" && price > 0
      ? ` – ${currencyCode} ${price}`
      : "";

  return `${index + 1}) ${entry.label}${priceText}`;
}

// ─────────────────────────────
// Spelling / synonym normalizer for product text (Layer 7)
// ─────────────────────────────
const PRODUCT_NORMALIZE_MAP: Record<string, string> = {
    // Biryani spellings
    biriyani: "biryani",
    briyani: "biryani",
    biryani: "biryani", // idempotent
    biriyaniy: "biryani",
    // Paneer spellings
    panner: "paneer",
    paner: "paneer",
    paneer: "paneer", // idempotent
    panir: "paneer",
    // Common Indian words
    chiken: "chicken",
    chikn: "chicken",
    // Pharmacy
    paracetmol: "paracetamol",
    paracetemol: "paracetamol",
    dolo: "paracetamol 650", // helps “dolo” map to that product if you name it that
    crocin: "paracetamol", // optional
    // Units & forms (helps keywords)
    ltr: "liter",
    ltrs: "liter",
    litre: "liter",
    litres: "liter",
    kg: "kg",
    gms: "gram",
    g: "gram",
    ml: "ml",
    mls: "ml",
    // Misc
    curd: "yogurt",
  };

export function normalizeProductText(raw: string): string {
    if (!raw) return "";
    // lower-case + basic cleanup
    let txt = raw.toLowerCase();
    // remove weird punctuation, keep letters/numbers/spaces
    txt = txt.replace(/[^a-z0-9\s]/gi, " ");
    const words = txt
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => PRODUCT_NORMALIZE_MAP[w] || w);
    return words.join(" ");
  }

// ─────────────────────────────
// Helper: extract catalog_unmatched items from parse_reason
// Supports BOTH:
//   - catalog_unmatched:...
//   - catalog_unmatched_only:...
// and dedupes the final list.
// ─────────────────────────────
export function extractCatalogUnmatched(reason?: string | null): string[] {
  if (!reason) return [];
  const r = String(reason);

  const allTokens: string[] = [];
  const re = /catalog_unmatched(?:_only)?:([^;]+)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(r)) !== null) {
    if (!m[1]) continue;
    const parts = m[1]
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    allTokens.push(...parts);
  }

  // Dedupe + keep order
  return Array.from(
    new Set(
      allTokens
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

export function extractCatalogUnmatchedOnly(reason?: string | null): string[] {
    if (!reason) return [];
    const r = String(reason);
    const m = /catalog_unmatched_only:([^;]+)/.exec(r);
    if (!m || !m[1]) return [];
    return m[1]
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
  }

export type ProductPriceOption = {
  productId: string;
  name: string;
  variant: string | null;
  unit: string;
  price: number | null;
  currency: string | null;
};

export type ProductOptionsResult = {
  best: {
    id: string;
    display_name: string;
    canonical?: string | null;
    base_unit?: string | null;
  };
  options: ProductPriceOption[];
};

export async function findProductOptionsForText(
    org_id: string,
    text: string
  ): Promise<ProductOptionsResult | null> {
    // 1) Try your existing fuzzy matcher first
    let best: any = await findBestProductForTextV2(org_id, text);
    // ─────────────────────────────────────────────
    // 1b) GENERIC FALLBACK: token-based search
    //     (for spelling differences like biriyani vs biryani,
    //      works for any vertical: grocery, salon, pharmacy, etc.)
    // ─────────────────────────────────────────────
    if (!best || !best.id) {
      try {
        // 🔹 Layer 7: normalised version for product matching
        const raw = normalizeProductText(text || "");
        const words = raw.split(/\s+/).filter(Boolean);
        const stopwords = new Set([
          "hi",
          "hello",
          "hey",
          "what",
          "whats",
          "is",
          "the",
          "a",
          "an",
          "of",
          "for",
          "to",
          "do",
          "you",
          "have",
          "any",
          "today",
          "please",
          "pls",
          "kindly",
          "how",
          "much",
          "price",
          "rate",
          "cost",
          "available",
          "availability",
          "stock",
          "there",
        ]);
        const keywords = words.filter((w) => !stopwords.has(w) && w.length >= 3);
        if (!keywords.length) {
          // nothing meaningful left → give up, keep old behaviour
          return null;
        }
        // Fetch candidate products for this org (generic, all business types)
        const { data, error } = await supa
          .from("products")
          .select("id, canonical, display_name, base_unit")
          .eq("org_id", org_id);
  
        if (error || !data || !data.length) {
          return null;
        }
        // Very simple token-overlap scoring (generic across domains)
        let bestRow: any | null = null;
        let bestScore = 0;
        for (const row of data) {
          const name = String(
            row.display_name || row.canonical || ""
          ).toLowerCase();
          const nameTokens = name.split(/\s+/).filter(Boolean);
          if (!nameTokens.length) continue;
          const overlap = nameTokens.filter((t) => keywords.includes(t));
          let score = overlap.length;
          // Slight bonus if the product name contains the raw keyword string
          const joined = keywords.join(" ");
          if (joined && name.includes(joined)) {
            score += 0.5;
          }
          if (score > bestScore) {
            bestScore = score;
            bestRow = row;
          }
        }
        // Require at least some overlap to avoid random matches
        if (!bestRow || bestScore <= 0) {
          return null; // fall back to your existing generic text
        }
  
        // Map fallback row to the "best" shape your code expects
        best = {
          id: bestRow.id,
          display_name: bestRow.display_name || bestRow.canonical || "item",
          canonical: bestRow.canonical || null,
          base_unit: bestRow.base_unit || null,
        };
      } catch (e: any) {
        console.warn("[WABA][fallback product search err]", e?.message || e);
        return null;
      }
    }
    const canon = (best.canonical || best.display_name || "").toString().trim();
    if (!canon) {
      // we still return best, but no extra options
      return {
        best: {
          id: best.id,
          display_name: best.display_name || canon || "item",
          canonical: best.canonical || null,
          base_unit: best.base_unit || null,
        },
        options: [],
      };
    }
  
    // 2) Fetch all products with same canonical in this org
    const { data, error } = await supa
      .from("products")
      .select("id, canonical, variant, base_unit, display_name, price_per_unit")
      .eq("org_id", org_id)
      .ilike("canonical", canon);
  
    if (error) {
      console.warn("[WABA][productOptions err]", error.message);
      // fall back to just 'best' product
      return {
        best: {
          id: best.id,
          display_name: best.display_name || canon || "item",
          canonical: best.canonical || null,
          base_unit: best.base_unit || null,
        },
        options: [],
      };
    }
  
    const rows = (data || []) as any[];
  
    // If nothing else is configured, still return best as an option
    if (!rows.length) {
      return {
        best: {
          id: best.id,
          display_name: best.display_name || canon || "item",
          canonical: best.canonical || null,
          base_unit: best.base_unit || null,
        },
        options: [],
      };
    }
  
    const options: ProductPriceOption[] = [];
  
    for (const row of rows) {
      const id = row.id;
      if (!id) continue;
  
      const latest = await getLatestPrice(org_id, id).catch((e: any) => {
        console.warn("[WABA][latestPrice err]", e?.message || e);
        return null;
      });
  
      // ✅ NEW: fall back to price_per_unit when there is no latest price
      const price =
        latest && typeof latest.price === "number"
          ? latest.price
          : typeof row.price_per_unit === "number"
          ? row.price_per_unit
          : null;
  
      const currency = latest ? latest.currency : null;
  
      options.push({
        productId: id,
        name:
          row.display_name ||
          row.canonical ||
          best.display_name ||
          canon ||
          "item",
        variant: row.variant ? String(row.variant).trim() || null : null,
        unit: row.base_unit || best.base_unit || "unit",
        price, // ✅ now includes static price_per_unit fallback
        currency, // may be null
      });
    }
  
    return {
      best: {
        id: best.id,
        display_name: best.display_name || canon || "item",
        canonical: best.canonical || null,
        base_unit: best.base_unit || null,
      },
      options,
    };
  }

  export function formatPriceLine(opt: ProductPriceOption): string {
    const label = opt.variant ? `${opt.name} ${opt.variant}`.trim() : opt.name;
  
    if (opt.price != null) {
      // Use DB currency if present, otherwise default to INR
      const currencyCode = (opt.currency || "INR").toUpperCase();
      return `${label} – ${currencyCode} ${opt.price} / ${opt.unit}`;
    }
  
    // price missing → softer wording
    return `${label} – price varies, we’ll confirm the exact price.`;
  }

export function prettyLabelFromText(text: string): string {
    const trimmed = (text || "").trim();
    if (!trimmed) return "this item";
  
    // Try to grab text after "have"
    const m = trimmed.match(/have\s+(.+)$/i);
    const candidate = m && m[1] ? m[1].trim() : trimmed;
  
    const lower = candidate.toLowerCase();
    const words = lower
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  
    return words.join(" ");
  }

// Smart inquiry reply (price / availability) – export as is
export async function buildSmartInquiryReply(opts: {
  org_id: string;
  text: string;
  inquiryType?: string | null;
}) {
  // ... ✂️ entire existing function body as-is
}

// Menu helpers
export function extractMenuKeywords(text: string): string[] {
    // 🔹 Layer 7: normalize spellings before extracting keywords
    const raw = normalizeProductText(text || "");
    const parts = raw.split(/\s+/).filter(Boolean);
  
    const stopwords = new Set([
      "hi",
      "hello",
      "hey",
      "please",
      "pls",
      "kindly",
      "what",
      "whats",
      "is",
      "the",
      "a",
      "an",
      "of",
      "for",
      "to",
      "me",
      "you",
      "your",
      "today",
      "todays",
      "menu",
      "list",
      "price",
      "prices",
      "rate",
      "card",
      "ratecard",
      "services",
      "service",
      "send",
      "show",
      "give",
      "need",
      "want",
      "can",
      "could",
      "tell",
      "my",
      "our",
      "this",
      "that",
    ]);
  
    const kws = parts.filter((w) => !stopwords.has(w) && w.length >= 3);
    return Array.from(new Set(kws)); // unique
  }

export async function buildMenuReply(opts: {
    org_id: string;
    text: string;
    businessType?: BusinessType | null;
  }): Promise<string | null> {
    const { org_id, text } = opts;
    const businessType = opts.businessType || "generic";
  
    try {
      // 1) Fetch all products for this org
      const { data, error } = await supa
        .from("products")
        .select("id, display_name, canonical, variant, base_unit, price_per_unit")
        .eq("org_id", org_id);
  
      if (error) {
        console.warn("[WABA][menu products err]", error.message);
        return null;
      }
  
      const rows = (data || []) as any[];
      if (!rows.length) return null;
  
      // 2) Try to filter by keywords from the text (veg, hair, fish, etc.)
      const keywords = extractMenuKeywords(text);
      let filtered = rows;
  
      if (keywords.length) {
        filtered = rows.filter((row) => {
          const name = String(
            row.display_name || row.canonical || ""
          ).toLowerCase();
          const variant = String(row.variant || "").toLowerCase();
  
          return keywords.some((kw) => name.includes(kw) || variant.includes(kw));
        });
  
        // If filter killed everything, fall back to full list
        if (!filtered.length) {
          filtered = rows;
        }
      }
  
      if (!filtered.length) return null;
  
      // 3) Build ProductPriceOption[] with latest prices
      const options: ProductPriceOption[] = [];
      const MAX_ITEMS = 15;
  
      for (const row of filtered.slice(0, MAX_ITEMS)) {
        const id = row.id;
        if (!id) continue;
  
        const latest = await getLatestPrice(org_id, id).catch((e: any) => {
          console.warn("[WABA][menu latestPrice err]", e?.message || e);
          return null;
        });
  
        const price =
          latest && typeof latest.price === "number"
            ? latest.price
            : typeof row.price_per_unit === "number"
            ? row.price_per_unit
            : null;
  
        const currency = latest ? latest.currency : null;
  
        options.push({
          productId: id,
          name: row.display_name || row.canonical || "item",
          variant: row.variant ? String(row.variant).trim() || null : null,
          unit: row.base_unit || "unit",
          price,
          currency,
        });
      }
  
      if (!options.length) return null;
  
      // 4) Choose header based on business type + whether it was filtered
      const isFiltered = keywords.length > 0;
      let header: string;
  
      if (businessType === "restaurant" || businessType === "cloud_kitchen") {
        header = isFiltered
          ? "📋 Here’s the menu you asked for:\n"
          : "📋 Here’s today’s main menu:\n";
      } else if (businessType === "salon") {
        header = isFiltered
          ? "📋 Here are the services you asked for:\n"
          : "📋 Here’s our main services menu:\n";
      } else {
        header = isFiltered
          ? "📋 Here are the items you asked for:\n"
          : "📋 Here’s our main list:\n";
      }
  
      const lines = options.map((opt, idx) => {
        const num = idx + 1;
        const line = formatPriceLine(opt); // e.g. "Onion Nashik – 7 AED / kg"
        return `${num}) ${line}`;
      });
  
      const footer =
        "\nIf you’d like to order, please reply with the item names and quantities.";
  
      // Extra hint if it was a generic menu (no filter)
      const filterHint = !isFiltered
        ? "\n\nYou can also ask for a specific list, for example “veg menu”, “hair services menu”, or “fruits price list”."
        : "";
  
      return header + lines.join("\n") + "\n" + footer + filterHint;
    } catch (e: any) {
      console.warn("[WABA][buildMenuReply err]", e?.message || e);
      return null;
    }
  }

  // 🔹 Family-level variants helper for availability / suggestions
export async function findFamilyVariantsForKeywords(opts: {
  org_id: string;
  text: string;
  limit?: number;
}): Promise<ProductPriceOption[]> {
  const { org_id, text, limit = 10 } = opts;

  // Reuse the same keyword extractor as menu logic
  const keywords = extractMenuKeywords(text || "");
  if (!keywords.length) return [];

  try {
    const { data, error } = await supa
      .from("products")
      .select(
        "id, display_name, canonical, variant, base_unit, price_per_unit"
      )
      .eq("org_id", org_id);

    if (error || !data || !data.length) {
      if (error) {
        console.warn("[WABA][familyVariants products err]", error.message);
      }
      return [];
    }

    const rows = data as any[];

    // Family hits = any product where name/variant contains any of the keywords
    const hits = rows.filter((row) => {
      const name = String(
        row.display_name || row.canonical || ""
      ).toLowerCase();
      const variant = String(row.variant || "").toLowerCase();

      return keywords.some(
        (kw) => name.includes(kw) || (variant && variant.includes(kw))
      );
    });

    if (!hits.length) return [];

    const limited = hits.slice(0, limit);
    const out: ProductPriceOption[] = [];

    for (const row of limited) {
      const id = row.id;
      if (!id) continue;

      const latest = await getLatestPrice(org_id, id).catch((e: any) => {
        console.warn("[WABA][familyVariants latestPrice err]", e?.message || e);
        return null;
      });

      const price =
        latest && typeof latest.price === "number"
          ? latest.price
          : typeof row.price_per_unit === "number"
          ? row.price_per_unit
          : null;

      const currency = latest ? latest.currency : null;

      out.push({
        productId: id,
        name: row.display_name || row.canonical || "item",
        variant: row.variant ? String(row.variant).trim() || null : null,
        unit: row.base_unit || "unit",
        price,
        currency,
      });
    }

    return out;
  } catch (e: any) {
    console.warn("[WABA][familyVariants err]", e?.message || e);
    return [];
  }
}

export async function findFuzzyProductSuggestions(opts: {
  org_id: string;
  rawLabel: string;
  customer_phone?: string;
  limit?: number;
}): Promise<{ id: string; name: string; score: number }[]> {
  const { org_id, rawLabel } = opts;
  const limit = opts.limit ?? 3;

  const labelNorm = normalizeLabelForFuzzy(rawLabel);
  if (!labelNorm || labelNorm.length < 3) return [];

  // 0️⃣ First try alias memory (customer → org/global)
  try {
    const aliasHit = await resolveAliasForText({
      org_id,
      customer_phone: opts.customer_phone,
      wrong_text: rawLabel,
    });

    if (aliasHit && aliasHit.canonical_product_id) {
      // Load that exact product and return as a "perfect" suggestion
      const { data: prod, error: prodErr } = await supa
        .from("products")
        .select("id, display_name, canonical")
        .eq("org_id", org_id)
        .eq("id", aliasHit.canonical_product_id)
        .maybeSingle();

      if (!prodErr && prod && prod.id) {
        const name = String(prod.display_name || prod.canonical || "").trim();
        if (name) {
          return [
            {
              id: prod.id as string,
              name,
              score: 1.0, // treat as perfect match
            },
          ];
        }
      }
    }
  } catch (e: any) {
    console.warn("[WABA][alias suggestions err]", e?.message || e);
  }

  // 1️⃣ Fallback to your existing fuzzy catalogue scan
  try {
    const { data, error } = await supa
      .from("products")
      .select("id, display_name, canonical")
      .eq("org_id", org_id)
      .limit(200); // keep it small; we only need top few

    if (error || !data || !data.length) return [];

    const scored = data
      .map((p: any) => {
        const name = String(p.display_name || p.canonical || "").trim();
        if (!name) return null;

        const score = fuzzyCharOverlapScore(rawLabel, name);
        return { id: p.id as string, name, score };
      })
      .filter((x: any) => x && x.score >= 0.4)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit);

    return scored as { id: string; name: string; score: number }[];
  } catch (e: any) {
    console.warn("[WABA][fuzzy suggestions err]", e?.message || e);
    return [];
  }
}