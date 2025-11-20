// src/routes/waba.ts
import express from "express";
import axios from "axios";
import { supa } from "../db";
import { ingestCoreFromMessage } from "./ingestCore";
import { getLatestPrice } from "../util/products";
import { findBestProductForTextV2 } from "../util/productMatcher";
import { classifyMessage } from "../ai/nlu";
import {
  getToneFromOrg,
  makeGreeting,
  makeGenericQuestionAck,
} from "../ai/tone";
import {
  getConversationState,
  setConversationStage,
  clearConversationStage,
  type ConversationStage,
} from "../util/conversationState";
import { BusinessType, normalizeBusinessType, orgNeedsDeliveryAddress } from "../routes/waba/business";
export const waba = express.Router();
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
const META_WA_BASE = "https://graph.facebook.com/v21.0";
waba.all("/ping", (_req, res) => res.json({ ok: true, where: "waba" }));
// Simple hit logger so you can confirm mount path
waba.use((req, _res, next) => {
  console.log("[WABA][ROUTER HIT]", req.method, req.path);
  next();
});

// ─────────────────────────────
// 1) Webhook verification (GET)
// ─────────────────────────────
waba.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[WABA][VERIFY]", {
    mode,
    token_ok: token === META_VERIFY_TOKEN,
  });

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("[WABA] webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("[WABA] webhook verify failed");
  return res.sendStatus(403);
});

const WABA_DEBUG = process.env.WABA_DEBUG === "1";
function wabaDebug(...args: any[]) {
  if (!WABA_DEBUG) return;
  console.log("[WABA-DEBUG]", ...args);
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

function normalizeProductText(raw: string): string {
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
// ─────────────────────────────
function extractCatalogUnmatched(reason?: string | null): string[] {
  if (!reason) return [];
  const r = String(reason);
  // Look for "catalog_unmatched:..." up to the next ';'
  const m = /catalog_unmatched:([^;]+)/.exec(r);
  if (!m || !m[1]) return [];
  return m[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}
// Helper: detect the "only unmatched" case (no valid items at all)
function extractCatalogUnmatchedOnly(reason?: string | null): string[] {
  if (!reason) return [];
  const r = String(reason);
  const m = /catalog_unmatched_only:([^;]+)/.exec(r);
  if (!m || !m[1]) return [];
  return m[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────
// Helper: product options + prices for a text
// ─────────────────────────────
type ProductPriceOption = {
  productId: string;
  name: string;
  variant: string | null;
  unit: string;
  price: number | null;
  currency: string | null;
};
type ProductOptionsResult = {
  best: {
    id: string;
    display_name: string;
    canonical?: string | null;
    base_unit?: string | null;
  };
  options: ProductPriceOption[];
};
/**
 * Given a free-text like "price of onion",
 *  1) find the best matching product,
 *  2) then fetch all variants of that canonical for this org,
 *  3) attach latest price for each.
 *
 * If anything fails, we fall back gracefully.
 */
async function findProductOptionsForText(
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
/** Format a single line like:
 *   "Onion Nashik – 7.00 AED / kg"
 */
function formatPriceLine(opt: ProductPriceOption): string {
  const label = opt.variant ? `${opt.name} ${opt.variant}`.trim() : opt.name;

  // ✅ allow price even if currency is null
  if (opt.price != null) {
    const cur = opt.currency || "";
    const curPart = cur ? ` ${cur}` : "";
    return `${label} – ${opt.price}${curPart} / ${opt.unit}`;
  }

  // price missing → softer wording
  return `${label} – price varies, we’ll confirm the exact price.`;
}

function prettyLabelFromText(text: string): string {
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
// ─────────────────────────────
// Helper: smart reply for price / availability inquiries
// ─────────────────────────────
async function buildSmartInquiryReply(opts: {
  org_id: string;
  text: string;
  inquiryType?: string | null;
}) {
  const { org_id, text } = opts;
  const inquiryType = (opts.inquiryType || "").toLowerCase() || null;

  // 1) Try to resolve product + variants + prices
  let optionsResult: ProductOptionsResult | null = null;
  try {
    optionsResult = await findProductOptionsForText(org_id, text);
  } catch (e: any) {
    console.warn("[WABA][buildSmartInquiryReply options err]", e?.message || e);
  }

  // NEW LAYER-5: family-level match (biryani → chicken/mutton/egg biryani)
  try {
    if (!optionsResult) {
      const raw = normalizeProductText(text).trim();
      // extract meaningful keywords
      const words = raw.split(/\s+/).filter(Boolean);
      const stop = new Set([
        "do",
        "you",
        "have",
        "any",
        "is",
        "there",
        "a",
        "the",
        "price",
        "rate",
        "list",
        "please",
        "pls",
        "kindly",
        "today",
        "what",
        "whats",
        "tell",
        "me",
        "my",
        "your",
        "much",
        "how",
        "available",
        "availability",
        "stock",
        "send",
        "show",
        "give",
        "need",
        "want",
        "can",
        "could",
        "this",
        "that",
      ]);

      const kws = words.filter((w) => !stop.has(w) && w.length >= 3);
      if (kws.length) {
        // fetch richer product info so we can show prices if needed
        const { data: all } = await supa
          .from("products")
          .select(
            "id, canonical, display_name, variant, base_unit, price_per_unit"
          )
          .eq("org_id", org_id);

        if (all && all.length) {
          // family hits: any product whose name contains one of the keywords
          const familyHits = all.filter((p) => {
            const name = String(
              p.display_name || p.canonical || ""
            ).toLowerCase();
            return kws.some((kw) => name.includes(kw));
          });

          if (familyHits.length >= 2) {
            // If this is a PRICE inquiry, try to show a small price menu
            if (inquiryType === "price") {
              const MAX_ITEMS = 10;
              const options: ProductPriceOption[] = [];

              for (const row of familyHits.slice(0, MAX_ITEMS)) {
                const id = row.id;
                if (!id) continue;

                const latest = await getLatestPrice(org_id, id).catch(
                  (e: any) => {
                    console.warn(
                      "[WABA][family_price latest err]",
                      e?.message || e
                    );
                    return null;
                  }
                );

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
                  variant: row.variant
                    ? String(row.variant).trim() || null
                    : null,
                  unit: row.base_unit || "unit",
                  price,
                  currency,
                });
              }

              if (options.length) {
                const lines = options.map((opt, idx) => {
                  const num = idx + 1;
                  const line = formatPriceLine(opt);
                  return `${num}) ${line}`;
                });

                const kwLabel = kws.length === 1 ? ` for ${kws[0]}` : "";

                return (
                  `💸 Here are the prices${kwLabel}:\n` +
                  lines.join("\n") +
                  "\n\nTo order, reply with the item and quantity."
                );
              }

              // no price data → fall back to just listing variants
              const names = Array.from(
                new Set(
                  familyHits.map((p) =>
                    p.variant
                      ? `${p.display_name || p.canonical} ${p.variant}`.trim()
                      : p.display_name || p.canonical
                  )
                )
              ).filter(Boolean);

              if (names.length >= 2) {
                return (
                  "We have these options:\n" +
                  names.map((n, i) => `${i + 1}) ${n}`).join("\n") +
                  "\n\nPrices change often — we’ll confirm the exact price for the one you choose."
                );
              }

              // let normal fallback handle if nothing useful
            } else {
              // AVAILABILITY / GENERIC inquiry → same behaviour as Patch 1
              const names = Array.from(
                new Set(
                  familyHits.map((p) =>
                    p.variant
                      ? `${p.display_name || p.canonical} ${p.variant}`.trim()
                      : p.display_name || p.canonical
                  )
                )
              ).filter(Boolean);

              if (names.length >= 2) {
                return (
                  "Here are the options we have:\n" +
                  names.map((n, i) => `${i + 1}) ${n}`).join("\n") +
                  "\n\nWhich one would you like?"
                );
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[WABA][family_match_err]", e);
  }

  // FINAL fallback when we still couldn't map to any product
  if (!optionsResult) {
    try {
      // Try to show a few example items so user can be more specific
      const { data, error } = await supa
        .from("products")
        .select("display_name, canonical")
        .eq("org_id", org_id)
        .limit(5);

      const names =
        !error && data
          ? Array.from(
              new Set(
                data
                  .map((p: any) =>
                    String(p.display_name || p.canonical || "").trim()
                  )
                  .filter(Boolean)
              )
            )
          : [];

      const exampleLines =
        names.length > 0
          ? "\n\nFor example, you can type:\n" +
            names
              .slice(0, 3)
              .map((n) => `• ${n} 1kg`)
              .join("\n")
          : "";

      if (inquiryType === "price") {
        return (
          "💬 I got that you’re asking for a *price*, but I’m not sure which item.\n" +
          "Please mention the exact item name and quantity in one line." +
          exampleLines
        );
      }

      if (inquiryType === "availability") {
        return (
          "💬 I got that you’re asking about *availability*, but I’m not sure which item.\n" +
          "Please mention the exact item name." +
          exampleLines
        );
      }

      // Generic inquiry with no clear type
      return (
        "💬 I’m not fully sure which item you mean.\n" +
        "Please type the exact item name and quantity in one message (e.g. “2kg onion, 1L milk”)." +
        exampleLines
      );
    } catch (e: any) {
      console.warn("[WABA][inquiry final fallback err]", e?.message || e);

      // If Supabase fails, keep the old safe behaviour
      if (inquiryType === "price") {
        return "💬 Got your price question. We’ll confirm the exact price shortly.";
      }
      if (inquiryType === "availability") {
        return "💬 Got your availability question. We’ll confirm stock shortly.";
      }
      return null;
    }
  }

  const { best, options } = optionsResult;

  // 2) PRICE inquiry
  if (inquiryType === "price") {
    const priced = options.filter((o) => o.price != null);

    // 2a) Multiple variants with prices → show menu
    if (priced.length >= 2) {
      const lines = priced.map((opt, idx) => {
        const line = formatPriceLine(opt);
        const num = idx + 1;
        return `${num}\uFE0F\u20E3 ${line}`; // 1️⃣, 2️⃣, ...
      });

      const title =
        `We have a few options for ${best.display_name}:\n` +
        lines.join("\n") +
        "\n\nTo order, reply with the option number and quantity.\n";

      return title;
    }

    // 2b) Single option with price
    if (priced.length === 1) {
      const line = formatPriceLine(priced[0]);
      return `💸 ${line}\n\nWould you like to place the order?`;
    }

    // 2c) No price data but products exist
    if (options.length > 0) {
      // Show variants names, but admit price is changing
      const variantNames = options.map((o) =>
        o.variant ? `${o.name} ${o.variant}`.trim() : o.name
      );
      const unique = Array.from(new Set(variantNames)).filter(Boolean);

      if (unique.length >= 2) {
        return (
          `We do have ${best.display_name} in multiple options:\n` +
          unique.map((v, idx) => `${idx + 1}) ${v}`).join("\n") +
          "\n\n💸 Today’s prices change often — we’ll confirm the exact price now."
        );
      }

      return (
        `💸 We do have ${best.display_name}. ` +
        "Today’s price changes often — we’ll confirm it for you now."
      );
    }

    // Last fallback if somehow no options
    return (
      `💸 We do have ${best.display_name}. ` +
      "Today’s price changes often — we’ll confirm it for you now."
    );
  }

  // 3) AVAILABILITY inquiry
  if (inquiryType === "availability") {
    const names = Array.from(
      new Set(
        options.map((o) =>
          o.variant ? `${o.name} ${o.variant}`.trim() : o.name
        )
      )
    ).filter(Boolean);

    // Use same keyword extractor as menu logic
    const keywords = extractMenuKeywords(text);
    const lowerNames = names.map((n) => n.toLowerCase());

    const hasOverlap = keywords.some((kw) =>
      lowerNames.some((name) => name.includes(kw))
    );
    const missingKeywords = keywords.filter(
      (kw) => !lowerNames.some((name) => name.includes(kw))
    );

    const requestedLabel = prettyLabelFromText(text);

    // 🧠 Partial match case:
    // Example: user -> "panner biriyani"
    // Catalog -> only "Mutton Biryani", "Chicken Biryani"
    // → we matched "biryani" but not "panner" → don't lie.
    if (
      names.length > 0 &&
      keywords.length > 0 &&
      hasOverlap &&
      missingKeywords.length > 0
    ) {
      const header =
        `I couldn’t find *${requestedLabel}* exactly in today’s menu.\n` +
        `We do have:\n`;

      const lines = names.map((n, i) => `${i + 1}) ${n}`);
      const footer = "\n\nWould you like to choose one of these instead?";

      return header + lines.join("\n") + footer;
    }

    // Normal happy path: full match
    if (names.length >= 1) {
      if (names.length >= 2) {
        return (
          "✅ Yes, we have this available. Some options:\n" +
          names.map((n, i) => `${i + 1}) ${n}`).join("\n")
        );
      }

      // Single option but still matched cleanly
      return `✅ Yes, we have ${names[0]} available.`;
    }

    // Fallback when no variants
    return `✅ Yes, we have ${best.display_name} available.`;
  }

  // 4) Unknown inquiry type → soft generic reply
  return "💬 Got your question. We’ll confirm the details shortly.";
}

// ─────────────────────────────
// Helper: MENU / RATE CARD / PRICE LIST
// ─────────────────────────────

function extractMenuKeywords(text: string): string[] {
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

async function buildMenuReply(opts: {
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

// ─────────────────────────────
// Clarify + Address + Memory helpers
// ─────────────────────────────

type VariantChoice = {
  index: number; // item index in order.items
  label: string; // canonical/name (e.g. "Onion")
  variants: string[];
};

// Normalize phone for session key
function normalizePhoneForKey(raw: string): string {
  return String(raw || "").replace(/[^\d]/g, "");
}

async function isAutoReplyEnabledForCustomer(opts: {
  orgId: string;
  phoneRaw: string;
  orgAutoReplyEnabled: boolean;
}): Promise<boolean> {
  const { orgId, phoneRaw, orgAutoReplyEnabled } = opts;

  // 1) Org-level master switch
  if (!orgAutoReplyEnabled) return false;

  const phoneKey = normalizePhoneForKey(phoneRaw);
  if (!phoneKey) return true; // default ON if we can't normalise

  try {
    const { data, error } = await supa
      .from("org_customer_settings")
      .select("auto_reply_enabled")
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey) // ✅ HERE
      .maybeSingle();

    if (error) {
      console.warn("[WABA][cust auto-reply lookup err]", error.message);
      return true; // fail-open
    }

    if (!data || typeof data.auto_reply_enabled !== "boolean") {
      return true; // no override row → default ON
    }

    return data.auto_reply_enabled;
  } catch (e: any) {
    console.warn("[WABA][cust auto-reply catch]", e?.message || e);
    return true;
  }
}

// Find ambiguous items (2+ variants configured) for this order
async function findAmbiguousItemsForOrder(
  org_id: string,
  items: any[]
): Promise<VariantChoice[]> {
  const out: VariantChoice[] = [];
  const seenCanon = new Set<string>();

  for (let i = 0; i < (items || []).length; i++) {
    const it = items[i] || {};
    const labelRaw = String(it.canonical || it.name || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!labelRaw) continue;

    const canonKey = labelRaw.toLowerCase();
    if (seenCanon.has(canonKey)) continue;
    seenCanon.add(canonKey);

    const { data, error } = await supa
      .from("products")
      .select("canonical, variant")
      .eq("org_id", org_id)
      .ilike("canonical", labelRaw); // case-insensitive

    if (error) {
      console.warn("[WABA][ambig products err]", error.message);
      continue;
    }

    const unique = Array.from(
      new Set(
        (data || [])
          .map((r: any) => String(r?.variant || "").trim())
          .filter(Boolean)
      )
    );

    if (unique.length >= 2) {
      out.push({
        index: i,
        label: labelRaw,
        variants: unique,
      });
    }
  }

  return out;
}

// Build a question text for one item
function buildClarifyQuestionText(choice: VariantChoice): string {
  const pretty = choice.label;
  return (
    "Thanks! Just need a quick confirmation:\n" +
    `• ${pretty}: which one do you prefer? (${choice.variants.join(", ")})`
  );
}

// Format summary list for final confirmation
function formatOrderSummary(items: any[]): string {
  const lines = (items || []).map((it: any) => {
    const qty = it.qty ?? 1;
    const unit = it.unit ? ` ${it.unit}` : "";
    const name = it.canonical || it.name || "item";
    const brand = it.brand ? ` · ${it.brand}` : "";
    const variant = it.variant ? ` · ${it.variant}` : "";
    return `* ${qty}${unit} ${name}${brand}${variant}`.trim();
  });
  return lines.join("\n");
}

// Build a synthetic text line from order items, e.g.
//  "2kg onion, 1L milk, 1 Chicken Biryani"
function itemsToOrderText(items: any[]): string {
  return (items || [])
    .map((it: any) => {
      const qty = it.qty ?? 1;
      const unit = it.unit ? String(it.unit).trim() : "";
      const name = String(it.canonical || it.name || "").trim();
      const variant = it.variant ? String(it.variant).trim() : "";
      if (!name) return "";

      const qtyPart = unit ? `${qty}${unit}` : `${qty}`;
      const variantPart = variant ? ` ${variant}` : "";
      return `${qtyPart} ${name}${variantPart}`.trim();
    })
    .filter(Boolean)
    .join(", ");
}

// Last-variant memory: find last chosen variant for this customer+canonical
async function getCustomerLastVariant(
  org_id: string,
  from_phone: string,
  canonical: string
): Promise<string | null> {
  try {
    const canonKey = canonical.toLowerCase().trim();

    const { data, error } = await supa
      .from("orders")
      .select("items")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone) // IMPORTANT: orders.source_phone, not customer_phone
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("[WABA][lastVariant err]", error.message);
      return null;
    }
    if (!data || !data.length) return null;

    for (const row of data) {
      const items = (row as any).items || [];
      for (const it of items) {
        const labelRaw = String(it?.canonical || it?.name || "")
          .toLowerCase()
          .trim();
        if (labelRaw === canonKey && it?.variant) {
          return String(it.variant);
        }
      }
    }
    return null;
  } catch (e: any) {
    console.warn("[WABA][lastVariant catch]", e?.message || e);
    return null;
  }
}

// 🔹 check if we already captured address for this customer (any order)
// Once address_done exists for a phone, we never ask again.
async function hasAddressForOrder(
  org_id: string,
  from_phone: string,
  order_id: string
): Promise<boolean> {
  // 1) Prefer checking the order itself
  try {
    const { data: orderRow, error: orderErr } = await supa
      .from("orders")
      .select("shipping_address")
      .eq("id", order_id)
      .single();

    if (!orderErr && orderRow) {
      const addr = (orderRow as any).shipping_address;
      if (addr && String(addr).trim().length > 0) {
        return true;
      }
    }
  } catch (e: any) {
    console.warn("[WABA][hasAddress order check err]", e?.message || e);
  }

  // 2) Fallback: legacy session-based check
  try {
    const phoneKey = normalizePhoneForKey(from_phone);

    const { data, error } = await supa
      .from("order_clarify_sessions")
      .select("id")
      .eq("org_id", org_id)
      .eq("customer_phone", phoneKey)
      .eq("status", "address_done")
      .limit(1);

    if (error) {
      console.warn("[WABA][hasAddress err]", error.message);
      return false;
    }
    return !!(data && data.length);
  } catch (e: any) {
    console.warn("[WABA][hasAddress catch]", e?.message || e);
    return false;
  }
}

// Active open order per customer (for reference / edit decisions)
async function findActiveOrderForPhone(
  org_id: string,
  from_phone: string
): Promise<any | null> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, created_at")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .in("status", ["pending", "paid"]) // treat shipped as closed
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[WABA][activeOrder err]", error.message);
      return null;
    }
    return data || null;
  } catch (e: any) {
    console.warn("[WABA][activeOrder catch]", e?.message || e);
    return null;
  }
}

// Active open order but excluding a specific order_id (for merge)
async function findActiveOrderForPhoneExcluding(
  org_id: string,
  from_phone: string,
  excludeOrderId: string
): Promise<any | null> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, created_at")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .neq("id", excludeOrderId)
      .in("status", ["pending", "paid"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[WABA][activeOrderExcl err]", error.message);
      return null;
    }
    return data || null;
  } catch (e: any) {
    console.warn("[WABA][activeOrderExcl catch]", e?.message || e);
    return null;
  }
}

// All active orders for a phone (pending + paid), newest first
async function findAllActiveOrdersForPhone(
  org_id: string,
  from_phone: string
): Promise<any[]> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, created_at")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .in("status", ["pending", "paid"])
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("[WABA][allActiveOrders err]", error.message);
      return [];
    }
    return data || [];
  } catch (e: any) {
    console.warn("[WABA][allActiveOrders catch]", e?.message || e);
    return [];
  }
}

// Most recent order for a customer (ANY status)
// Used as a fallback for cancel if nothing is "active"
async function findMostRecentOrderForPhone(
  org_id: string,
  from_phone: string
): Promise<any | null> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, created_at")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[WABA][mostRecentOrder err]", error.message);
      return null;
    }
    return data || null;
  } catch (e: any) {
    console.warn("[WABA][mostRecentOrder catch]", e?.message || e);
    return null;
  }
}

function shortOrderLine(order: any, index: number): string {
  const items = (order.items || []) as any[];
  const first = items[0];
  const firstName = first
    ? (first.canonical || first.name || "item").toString()
    : "item";
  const extraCount = Math.max(items.length - 1, 0);
  const extraText = extraCount > 0 ? ` + ${extraCount} more` : "";
  return `${index}. ${firstName}${extraText}`;
}

// ─────────────────────────────
// Debug flow logger (non-invasive)
// ─────────────────────────────
async function logFlowEvent(opts: {
  orgId: string;
  from?: string;
  event: string;
  msgId?: string;
  orderId?: string | null;
  text?: string | null;
  result?: any;
  meta?: any;
}) {
  try {
    await supa.from("waba_flow_logs").insert({
      org_id: opts.orgId,
      customer_phone: opts.from || null,
      event: opts.event,
      msg_id: opts.msgId || null,
      order_id: opts.orderId || null,
      text: opts.text || null,
      result: opts.result ?? null,
      meta: opts.meta ?? null,
      source: "waba",
    });
  } catch (e: any) {
    console.warn("[WABA][FLOW_LOG_ERR]", e?.message || e);
  }
}

// Start MULTI-TURN CLARIFY session (for items)
// - applies last-variant memory first
// - returns first question text, or null if nothing to clarify.
async function startClarifyForOrder(opts: {
  org_id: string;
  order_id: string;
  from_phone: string;
}): Promise<string | null> {
  const { org_id, order_id, from_phone } = opts;
  const phoneKey = normalizePhoneForKey(from_phone);

  const { data: orderRow, error: orderErr } = await supa
    .from("orders")
    .select("id, items, source_phone")
    .eq("id", order_id)
    .single();

  if (orderErr || !orderRow) {
    console.warn("[WABA][clarify start] order not found", orderErr?.message);
    return null;
  }

  let items = ((orderRow as any).items || []) as any[];
  let modified = false;

  // 1) Apply last variant memory
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    if (it.variant) continue;

    const labelRaw = String(it.canonical || it.name || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!labelRaw) continue;

    const lastVariant = await getCustomerLastVariant(
      org_id,
      from_phone,
      labelRaw
    );
    if (lastVariant) {
      modified = true;
      items[i] = { ...it, variant: lastVariant };
    }
  }

  if (modified) {
    await supa.from("orders").update({ items }).eq("id", order_id);
  }

  // 2) Find remaining ambiguous items
  let choices = await findAmbiguousItemsForOrder(org_id, items);
  choices = choices.filter((c) => !items[c.index].variant);

  if (!choices.length) return null;

  const first = choices[0];

  // Close older sessions
  await supa
    .from("order_clarify_sessions")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("org_id", org_id)
    .eq("customer_phone", phoneKey)
    .eq("status", "open");

  await supa.from("order_clarify_sessions").insert({
    org_id,
    order_id,
    customer_phone: phoneKey,
    status: "open",
    current_index: first.index,
  });
  // L9: stage = awaiting_clarification for this order
  await setConversationStage(org_id, from_phone, "awaiting_clarification", {
    active_order_id: order_id,
    last_action: "clarify_item_variant",
  });

  return buildClarifyQuestionText(first);
}
// Start ADDRESS session (no more item clarifications needed)
// - next text from this customer will be treated as address, not order.
async function startAddressSessionForOrder(opts: {
  org_id: string;
  order_id: string;
  from_phone: string;
}) {
  const { org_id, order_id, from_phone } = opts;
  const phoneKey = normalizePhoneForKey(from_phone);

  // close prior sessions
  await supa
    .from("order_clarify_sessions")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("org_id", org_id)
    .eq("customer_phone", phoneKey)
    .eq("status", "open");

  const { error } = await supa.from("order_clarify_sessions").insert({
    org_id,
    order_id,
    customer_phone: phoneKey,
    status: "open",
    current_index: -1, // SPECIAL: -1 = waiting for address
  });

  // L9: mark stage as waiting for address
  await setConversationStage(org_id, from_phone, "awaiting_address", {
    active_order_id: order_id,
    last_action: "ask_address",
  });

  if (error) {
    console.warn("[WABA][address session insert err]", error.message);
  }
}

function looksLikeOrderLineText(raw: string): boolean {
  const text = (raw || "").toLowerCase().trim();

  if (!text) return false;

  // Has a number (1, 2, 3…)
  const hasNumber = /\d/.test(text);

  // Has common units / item markers
  const hasUnit =
    /kg|g|gram|gm|ml|ltr|liter|litre|piece|pc|pcs|pack|plate|bottle|box|dozen/i.test(
      text
    );

  // Has a comma-separated list (often "1kg onion, 2L milk")
  const hasCommaList = text.includes(",");

  // If it has a number and a typical unit OR comma list,
  // it's *very* likely to be items, not an address.
  if ((hasNumber && hasUnit) || hasCommaList) return true;

  return false;
}

// Handle a message while clarify/address session is open
// Returns true if the message was consumed by this handler.
async function maybeHandleClarifyReply(opts: {
  org_id: string;
  phoneNumberId: string;
  from: string;
  text: string;
  needsAddress?: boolean;
}): Promise<boolean> {
  const { org_id, phoneNumberId, from, text, needsAddress = true } = opts;
  const phoneKey = normalizePhoneForKey(from);
  const lower = text.toLowerCase().trim();

  // Look up latest open session
  const { data: session, error: sessErr } = await supa
    .from("order_clarify_sessions")
    .select("id, order_id, current_index, status")
    .eq("org_id", org_id)
    .eq("customer_phone", phoneKey)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sessErr) {
    console.warn("[WABA][clarify session err]", sessErr.message);
    return false;
  }
  if (!session) return false;

  // Escape hatch during clarify / address flow
  if (/cancel|ignore previous|new order/i.test(lower)) {
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    await sendWabaText({
      phoneNumberId,
      to: from,
      text: "No problem 👍 You can send a new order whenever you’re ready.",
      orgId: org_id,
    });

    return true;
  }

  if (/talk to agent|talk to human/i.test(lower)) {
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "👨‍💼 Okay, we’ll connect you to a store agent.\n" +
        "Please wait a moment — a human will reply.",
      orgId: org_id,
    });

    return true;
  }

  // ──────────────────────
  // ADDRESS STAGE (current_index === -1)
  // ──────────────────────
  if (session.current_index === -1) {
    if (looksLikeOrderLineText(text)) {
      console.log("[WABA][ADDRESS GUARD] looks like items, not address", {
        org_id,
        order_id: session.order_id,
        customer: from,
        text,
      });

      // Keep the clarify session OPEN (status still 'open', current_index = -1)
      // so the NEXT message can still be a real address.
      //
      // Just gently tell the user what's happening:
      await sendWabaText({
        phoneNumberId,
        to: from,
        orgId: org_id,
        text:
          "Looks like you’re adding more items 👍\n" +
          "I’ll add these to your order.\n" +
          "After that, please send your delivery address in a separate message.",
      });

      // IMPORTANT:
      // returning false → the main WABA handler will continue
      // and pass this text into ingestCore as an order line.
      return false;
    }

    // ✅ Normal path: treat it as address
    console.log("[WABA][ADDRESS CAPTURE]", {
      org_id,
      order_id: session.order_id,
      customer: from,
      address: text,
    });

    // 1) Mark session as address_done
    await supa
      .from("order_clarify_sessions")
      .update({ status: "address_done", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    // 2) Persist address on the order itself
    try {
      await supa
        .from("orders")
        .update({ shipping_address: text })
        .eq("id", session.order_id);
    } catch (e: any) {
      console.warn("[WABA][address save err]", e?.message || e);
    }

    // 3) Mark that we JUST finished an address flow
    lastCommandByPhone.set(from, "address_done");

    // L9: stage = building_order (order + address present, can add more items)
    await setConversationStage(org_id, from, "building_order", {
      active_order_id: session.order_id,
      last_action: "address_captured",
    });

    // 4) Acknowledge to customer
    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "📍 Thanks! We’ve noted your address.\n" +
        "If you’d like to add more items, just send them here.",
      orgId: org_id,
    });

    return true;
  }
  // ──────────────────────
  // ITEM VARIANT CLARIFY STAGE
  // ──────────────────────
  const { data: orderRow, error: orderErr } = await supa
    .from("orders")
    .select("id, items")
    .eq("id", session.order_id)
    .single();

  if (orderErr || !orderRow) {
    console.warn("[WABA][clarify reply] order not found", orderErr?.message);

    // Close the stale session and LET the main handler treat this
    // as a fresh message (no confusing error to customer)
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    return false;
  }

  const order: any = orderRow;
  const items: any[] = order.items || [];
  if (
    !Array.isArray(items) ||
    session.current_index < 0 ||
    session.current_index >= items.length
  ) {
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "Sorry, something went wrong with that confirmation. " +
        "Please send your order again.",
      orgId: org_id,
    });
    return true;
  }

  const currentIndex = session.current_index;
  const currentItem = items[currentIndex] || {};
  const labelRaw = String(
    currentItem.canonical || currentItem.name || ""
  ).trim();
  const labelKey = labelRaw.toLowerCase();

  // Load variants for this item
  const { data: productRows, error: prodErr } = await supa
    .from("products")
    .select("canonical, variant")
    .eq("org_id", org_id)
    .ilike("canonical", labelRaw);

  if (prodErr) {
    console.warn("[WABA][clarify reply products err]", prodErr.message);
  }
  const variants = Array.from(
    new Set(
      (productRows || [])
        .map((r: any) => String(r?.variant || "").trim())
        .filter(Boolean)
    )
  );

  if (!variants.length) {
    // nothing to choose, stop clarify and fall back to manual
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "Got your message 👍 We’ll adjust the order manually for this item " +
        "and continue processing.",
      orgId: org_id,
    });
    return true;
  }

  // Try to match answer to one of the variants
  const answer = lower;
  let chosen: string | null = null;

  for (const v of variants) {
    const vLower = v.toLowerCase();
    if (answer === vLower || answer.includes(vLower)) {
      chosen = v;
      break;
    }
  }

  if (!chosen) {
    const optionsStr = variants.join(" / ");
    await sendWabaText({
      phoneNumberId,
      to: from,
      text: `Sorry, I didn’t catch that. Please reply with one of: ${optionsStr}`,
      orgId: org_id,
    });
    return true;
  }

  // Update variant in order items
  items[currentIndex] = {
    ...currentItem,
    variant: chosen,
  };

  const { error: updErr } = await supa
    .from("orders")
    .update({ items })
    .eq("id", order.id);

  if (updErr) {
    console.warn("[WABA][clarify reply update err]", updErr.message);
    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "I couldn’t update that item just now. " +
        "We’ll adjust it manually and confirm your order.",
      orgId: org_id,
    });
    return true;
  }

  // Check if more ambiguous items remain (still without variant)
  const remainingChoices = await findAmbiguousItemsForOrder(org_id, items);
  const stillAmbiguous = remainingChoices.filter((c) => {
    const it = items[c.index];
    return !it || !it.variant;
  });

  if (!stillAmbiguous.length) {
    // All clarified → close clarify session
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    const summary = formatOrderSummary(items);

    // Should this org ask for address at all?
    if (!needsAddress) {
      const finalText = "✅ Order confirmed:\n" + summary;

      // L9: post_order, no address needed
      await setConversationStage(org_id, from, "post_order", {
        active_order_id: order.id,
        last_action: "clarify_done_no_address",
      });

      await sendWabaText({
        phoneNumberId,
        to: from,
        text: finalText,
        orgId: org_id,
      });

      return true;
    }

    // Check if customer already provided address (any previous address_done)
    const alreadyHasAddress = await hasAddressForOrder(org_id, from, order.id);

    if (alreadyHasAddress) {
      const finalText = "✅ Updated order:\n" + summary;

      // L9: order fully known + address present → post_order
      await setConversationStage(org_id, from, "post_order", {
        active_order_id: order.id,
        last_action: "clarify_done_address_already",
      });

      await sendWabaText({
        phoneNumberId,
        to: from,
        text: finalText,
        orgId: org_id,
      });

      return true;
    }

    // If no address yet → open address session ONCE
    await startAddressSessionForOrder({
      org_id,
      order_id: order.id,
      from_phone: from,
    });

    const finalText =
      "✅ Order confirmed:\n" +
      summary +
      "\n\n📍 Please share your delivery address (or send location) if you haven’t already.";

    await sendWabaText({
      phoneNumberId,
      to: from,
      text: finalText,
      orgId: org_id,
    });

    return true;
  }

  // Move to next item and ask again
  const next = stillAmbiguous[0];
  await supa
    .from("order_clarify_sessions")
    .update({
      current_index: next.index,
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  const prettyCurrent = labelRaw || labelKey || "item";
  const confirmLine = `Got it: ${prettyCurrent} → ${chosen} ✅`;
  const nextQuestion = buildClarifyQuestionText(next);

  await sendWabaText({
    phoneNumberId,
    to: from,
    text: `${confirmLine}\n\n${nextQuestion}`,
    orgId: org_id,
  });

  return true;
}

// Edit-like messages we *don’t* support in V1 (we answer safely)
function isLikelyEditRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("change ")) return true;
  if (lower.includes("instead of")) return true;
  if (lower.includes("make it ")) return true;
  if (lower.includes("make my ")) return true;
  if (lower.includes("remove ")) return true;
  if (lower.startsWith("no ")) return true;
  if (lower.includes("reduce ")) return true;
  if (lower.includes("increase ")) return true;
  return false;
}

// Looks like "add more items to existing order"
function looksLikeAddToExisting(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("add ")) return true;
  if (lower.includes("add on")) return true;
  if (lower.includes("add one more")) return true;
  if (lower.includes("also")) return true;
  if (lower.includes("too")) return true;
  if (lower.includes("more")) return true;
  if (lower.includes("extra")) return true;
  return false;
}

function isPureGreetingText(raw: string): boolean {
  const lower = (raw || "").toLowerCase().replace(/[^a-z0-9\s]/gi, " "); // keep only letters/numbers/spaces
  const tokens = lower.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  // Allowed tokens that *alone* can form a greeting / ack
  const allowed = new Set([
    "hi",
    "hii",
    "hello",
    "hey",
    "gm",
    "good",
    "morning",
    "afternoon",
    "evening",
    "night",
    "ok",
    "okay",
    "k",
    "kk",
    "fine",
    "thanks",
    "thank",
    "thankyou",
    "thankyou",
    "thankyou",
    "thankyou",
    "thx",
    "tnx",
    "pls",
    "please",
    "yo",
    "hola", // just in case
  ]);

  // PURE greeting = *every* token is in this set.
  // So:
  //   "hi", "ok", "ok thanks", "hello good morning" → true
  //   "ok mutton biriyani", "hi 1kg onion" → false
  return tokens.every((t) => allowed.has(t));
}

// ─────────────────────────────
// Explicit user commands: NEW / CANCEL / UPDATE / AGENT
// ─────────────────────────────

type UserCommand =
  | "new"
  | "cancel"
  | "update"
  | "agent"
  | "address_done"
  | "cancel_select"
  | "cancel_pending"
  | "repeat"
  | null;

// last action per phone (in-memory, per Node process)
const lastCommandByPhone = new Map<string, UserCommand>();

// when we show "you have multiple active orders, reply 1/2/3",
// we store the order IDs here for that phone
const pendingCancelOptions = new Map<string, { orderIds: string[] }>();

// Track if we already showed the commands tip for this phone (per process)
const commandsTipShown = new Set<string>();

// For soft-cancel flow (L8): phone → target order id
const pendingSoftCancel = new Map<string, string>();

async function maybeSendCommandsTip(opts: {
  phoneNumberId: string;
  to: string;
  orgId?: string;
}) {
  const key = normalizePhoneForKey(opts.to || "");
  if (!key) return;

  if (commandsTipShown.has(key)) return;
  commandsTipShown.add(key);

  await sendWabaText({
    phoneNumberId: opts.phoneNumberId,
    to: opts.to,
    orgId: opts.orgId,
    text:
      "📝 Tip: You can use quick commands anytime:\n" +
      "• *new* – start a fresh order\n" +
      "• *cancel* – cancel your last order\n" +
      "• *agent* – talk to a human\n" +
      "• *order summary* – see your last order",
  });
}

function detectUserCommand(text: string): UserCommand {
  const lower = text.toLowerCase().trim();

  // keep these fairly strict to avoid colliding with normal sentences
  if (
    lower === "new" ||
    lower === "new order" ||
    lower.startsWith("start new order")
  ) {
    return "new";
  }
  if (
    lower === "cancel" ||
    lower === "cancel order" ||
    lower.startsWith("cancel my order")
  ) {
    return "cancel";
  }
  if (
    lower === "update" ||
    lower === "update order" ||
    lower.startsWith("edit order") ||
    lower.startsWith("modify order")
  ) {
    return "update";
  }
  if (
    lower === "agent" ||
    lower === "talk to agent" ||
    lower === "talk to human" ||
    lower === "human" ||
    lower === "support" ||
    lower === "customer care"
  ) {
    return "agent";
  }

  if (
    lower === "repeat" ||
    lower === "repeat order" ||
    lower === "repeat last order" ||
    lower.includes("same as last time") ||
    lower.includes("same as yesterday") ||
    lower.includes("same order") ||
    lower.includes("same items")
  ) {
    return "repeat";
  }

  return null;
}
function detectSoftCancelIntent(text: string): boolean {
  const lower = text.toLowerCase().trim();
  // Pure "stop" style
  if (
    lower === "stop" ||
    lower === "stop it" ||
    lower === "stop this" ||
    lower.startsWith("stop order") ||
    lower.startsWith("stop this order") ||
    lower.startsWith("stop my order")
  ) {
    return true;
  }

  // "no need" patterns
  if (
    lower.startsWith("no need") ||
    lower.includes("no need this") ||
    lower.includes("no need now")
  ) {
    return true;
  }

  // "don't want" patterns
  if (
    lower.startsWith("dont want") ||
    lower.startsWith("don't want") ||
    lower.includes("dont want this") ||
    lower.includes("don't want this")
  ) {
    return true;
  }

  // Anything containing "cancel" that is NOT the strict "cancel" command
  if (lower.includes("cancel")) {
    return true;
  }

  return false;
}

// ─────────────────────────────
// 2) Incoming messages (POST)
// ─────────────────────────────
waba.post("/", async (req, res) => {
  try {
    console.log("🔥 WABA HANDLER v10 LIVE", { path: __filename });
    console.log("[WABA][RAW BODY]", JSON.stringify(req.body));

    const body = req.body;
    if (!body || !body.entry) {
      console.log("[WABA] no entry in body");
      return res.sendStatus(200);
    }

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const metadata = value.metadata || {};
        const phoneNumberId = metadata.phone_number_id as string | undefined;

        console.log("[WABA][ENTRY]", {
          phoneNumberId,
          messages_len: messages.length,
        });

        if (!phoneNumberId || messages.length === 0) continue;

        // Find org by WABA phone_number_id
        const { data: orgs, error: orgErr } = await supa
          .from("orgs")
          .select(
            "id, name, ingest_mode, auto_reply_enabled, primary_business_type, supports_delivery"
          )
          .eq("wa_phone_number_id", phoneNumberId)
          .limit(1);

        if (orgErr) {
          console.warn("[WABA] org lookup error", orgErr.message);
          continue;
        }
        const org = orgs?.[0];
        if (!org) {
          console.warn("[WABA] no org for phone_number_id", phoneNumberId);
          continue;
        }

        if (org.ingest_mode !== "waba") {
          console.log("[WABA] org not in waba mode, skipping", {
            org_id: org.id,
            ingest_mode: org.ingest_mode,
          });
          continue;
        }

        const tone = getToneFromOrg(org);

        for (const msg of messages) {
          if (msg.type !== "text") continue;

          const from = msg.from as string;
          let text: string = msg.text?.body?.trim() || "";
          const msgId = msg.id as string;
          const ts = Number(msg.timestamp || Date.now()) * 1000;

          if (!text) continue;

          await logInboundMessageToInbox({
            orgId: org.id,
            from,
            text,
            msgId,
          });

          // 🔹 Check per-customer auto-reply *before* going into AI
          const autoReplyForCustomer = await isAutoReplyEnabledForCustomer({
            orgId: org.id,
            phoneRaw: from,
            orgAutoReplyEnabled: !!org.auto_reply_enabled,
          });

          if (!autoReplyForCustomer) {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "auto_reply_disabled_for_customer_inbound",
              msgId,
              text,
            });

            continue; // 🛑 skip clarify, commands, ingestCore, auto-replies
          }

          const convoState = await getConversationState(org.id, from);
          const convoStage: ConversationStage = convoState?.stage || "idle";
          const stageActiveOrderId = convoState?.active_order_id || null;

          if (!text) continue;

          let lowerText = text.toLowerCase().trim();

          // 🔹 Compute active order ONCE per message
          const activeOrder = await findActiveOrderForPhone(org.id, from);
          const activeOrderId = activeOrder?.id || null;

          wabaDebug("ROUTER HIT", req.method, req.path);
          wabaDebug("RAW BODY", JSON.stringify(req.body));

          wabaDebug("MSG DEBUG", {
            text,
            from,
            hasActiveOrder: Boolean(activeOrder),
            isEditLike: isLikelyEditRequest(text),
            looksLikeAdd: looksLikeAddToExisting(text),
          });

          const lastCmd = lastCommandByPhone.get(from);

          // 0.12) L8: waiting for YES/NO to confirm soft cancel
          if (lastCmd === "cancel_pending") {
            const targetOrderId =
              pendingSoftCancel.get(from) || activeOrderId || null;

            if (!targetOrderId) {
              // nothing to cancel anymore → clear state and fall through to normal flow
              lastCommandByPhone.delete(from);
              pendingSoftCancel.delete(from);
            } else {
              const ans = lowerText;

              const isYes =
                ans === "yes" ||
                ans === "y" ||
                ans === "ya" ||
                ans === "yeah" ||
                ans === "yup" ||
                ans === "yes cancel" ||
                ans === "ok" ||
                ans === "okay" ||
                ans === "k" ||
                ans === "kk" ||
                ans === "cancel" ||
                ans.startsWith("yes, cancel") ||
                ans.startsWith("pls cancel") ||
                ans.startsWith("please cancel");

              const isNo =
                ans === "no" ||
                ans === "n" ||
                ans === "nope" ||
                ans.startsWith("dont cancel") ||
                ans.startsWith("don't cancel") ||
                ans.startsWith("keep") ||
                ans.startsWith("continue");

              if (!isYes && !isNo) {
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "⚠️ Please reply *YES* to cancel your last order, or *NO* to keep it as is.",
                  orgId: org.id,
                });

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "soft_cancel_ask_again",
                  msgId,
                  orderId: targetOrderId,
                  text,
                });

                continue;
              }

              if (isNo) {
                lastCommandByPhone.delete(from);
                pendingSoftCancel.delete(from);

                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "✅ Got it — we’ll keep your order as it is.\nIf you ever want to cancel, just type *cancel*.",
                  orgId: org.id,
                });

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "soft_cancel_rejected",
                  msgId,
                  orderId: targetOrderId,
                  text,
                });

                continue;
              }

              // YES → cancel the order
              const { data: ordRow, error: ordErr } = await supa
                .from("orders")
                .select("id, items, status")
                .eq("id", targetOrderId)
                .single();

              if (ordErr || !ordRow) {
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "I couldn’t find that order anymore. It may have already been updated by the store.",
                  orgId: org.id,
                });

                lastCommandByPhone.delete(from);
                pendingSoftCancel.delete(from);

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "soft_cancel_missing_order",
                  msgId,
                  orderId: targetOrderId,
                  text,
                });

                continue;
              }

              await supa
                .from("orders")
                .update({ status: "cancelled_by_customer" })
                .eq("id", targetOrderId);

              const summary = formatOrderSummary(ordRow.items || []);

              const txt =
                "❌ Your last order has been cancelled:\n" +
                summary +
                "\n\nIf this was a mistake, you can send a new order.";

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: txt,
                orgId: org.id,
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "soft_cancel_confirmed",
                msgId,
                orderId: targetOrderId,
                text,
                result: { summary },
              });

              lastCommandByPhone.delete(from);
              pendingSoftCancel.delete(from);
              await clearConversationStage(org.id, from);

              continue;
            }
          }

          // 0.15) If we are waiting for the user to choose WHICH order to cancel
          if (lastCmd === "cancel_select") {
            const choiceNum = parseInt(lowerText, 10);

            const options = pendingCancelOptions.get(from);
            if (!options || !options.orderIds.length) {
              // nothing to select anymore → reset and let normal flow handle
              lastCommandByPhone.delete(from);
            } else if (!Number.isNaN(choiceNum)) {
              const idx = choiceNum - 1;
              const orderId = options.orderIds[idx];

              if (idx < 0 || idx >= options.orderIds.length || !orderId) {
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "Please reply with a valid number from the list (for example 1 or 2).",
                  orgId: org.id,
                });
                continue;
              }

              // Cancel the chosen order
              const { data: ordRow, error: ordErr } = await supa
                .from("orders")
                .select("id, items, status")
                .eq("id", orderId)
                .single();

              if (ordErr || !ordRow) {
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "I couldn’t find that order anymore. It may have already been updated by the store.",
                  orgId: org.id,
                });
              } else {
                // mark as cancelled
                await supa
                  .from("orders")
                  .update({ status: "cancelled_by_customer" })
                  .eq("id", orderId);

                const summary = formatOrderSummary(ordRow.items || []);

                const txt =
                  "❌ The selected order has been cancelled:\n" +
                  summary +
                  "\n\nIf this was a mistake, you can send a new order.";

                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: txt,
                  orgId: org.id,
                });

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "cancel_select_done",
                  msgId,
                  orderId,
                  text,
                  result: { summary },
                });
              }

              // clear state
              lastCommandByPhone.delete(from);
              pendingCancelOptions.delete(from);
              continue;
            } else {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text: "Please reply with the number of the order you want to cancel (for example 1 or 2).",
                orgId: org.id,
              });
              continue;
            }
          }

          const needsAddressForOrg = orgNeedsDeliveryAddress(org);

          // 0) If we’re in clarify/address session → consume here and SKIP ingestCore
          const handledByClarify = await maybeHandleClarifyReply({
            org_id: org.id,
            phoneNumberId,
            from,
            text,
            needsAddress: needsAddressForOrg,
          });

          if (handledByClarify) {
            continue;
          }

          // 🔹 After address flow, treat small "no/ok/thanks" as final confirmation, not as an item
          if (lastCmd === "address_done" || convoStage === "building_order") {
            // Normalise once
            const soft = lowerText;

            // Phrases that usually mean "nothing more"
            const isSoftAck =
              soft === "no" ||
              soft === "nope" ||
              soft === "ok" ||
              soft === "okay" ||
              soft === "k" ||
              soft === "fine" ||
              soft === "thanks" ||
              soft === "thank you" ||
              soft === "tnx" ||
              soft === "thx" ||
              soft === "nothing" ||
              soft === "nothing else" ||
              soft === "nothing more" ||
              soft === "thats all" ||
              soft === "that's all" ||
              soft === "thats it" ||
              soft === "that's it" ||
              soft.startsWith("no more") ||
              soft.startsWith("no need") ||
              soft.startsWith("no other") ||
              soft.startsWith("no items");

            // Rough heuristic: if it looks like an item list, don't treat as ack
            const looksLikeItemText =
              /\d/.test(soft) || // has numbers
              /kg|g|gram|ml|ltr|liter|litre|piece|pcs|pc|pack|plate|bottle|box/i.test(
                soft
              ) ||
              soft.includes(",");

            if (isSoftAck && !looksLikeItemText) {
              // Build a generic final confirmation that works for all business types
              const bt = normalizeBusinessType(org.primary_business_type);
              let finalText: string;

              if (bt === "salon") {
                finalText =
                  "✅ Your booking request is confirmed. We’ll schedule it and update you shortly.\n" +
                  "If you need anything else, just message here.";
              } else {
                // grocery, restaurant, cloud_kitchen, pharmacy, generic, etc.
                finalText =
                  "✅ Your order is confirmed. We’ll start processing it now.\n" +
                  "If you need anything else, just message here.";
              }

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: finalText,
                orgId: org.id,
              });

              // We handled this "no/ok/thanks" message fully
              lastCommandByPhone.delete(from);

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "address_done_soft_ack",
                msgId,
                orderId: activeOrder?.id || null,
                text,
                result: { finalText },
              });

              continue; // 👉 DO NOT go to ingestCore / AI
            }
          }

          // 0.15) Commands menu: help / menu / commands / options
          if (/^(help|commands|options)$/i.test(lowerText)) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "📝 Quick commands you can use:\n" +
                "• *new* – start a fresh order\n" +
                "• *cancel* – cancel your last order\n" +
                "• *agent* – talk to a human\n" +
                "• *order summary* – show your last order\n\n" +
                "You can also just type your items, e.g. “2kg onion, 1L milk”.",
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "commands_menu_shown",
              msgId,
              text,
            });

            continue;
          }
          // 0.1) "order summary" → show ALL active (pending/paid) orders
          if (
            /order summary|my order|my orders|show my order|show my orders/i.test(
              lowerText
            )
          ) {
            const activeOrders = await findAllActiveOrdersForPhone(
              org.id,
              from
            );

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "order_summary_active",
              msgId,
              text,
              meta: { activeCount: activeOrders.length },
            });

            if (!activeOrders.length) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "📦 You don’t have any active orders right now.\n" +
                  "If you’d like to place a new order, just send your items here.",
                orgId: org.id,
              });
            } else {
              const blocks = activeOrders.map((o, idx) => {
                const n = idx + 1;
                const summary = formatOrderSummary(o.items || []);
                const status = String(o.status || "pending");
                return (
                  `#${n} — status: ${status}\n` +
                  (summary || "(no items found)")
                );
              });

              const textOut =
                "📦 Your active orders:\n\n" +
                blocks.join("\n\n") +
                "\n\nTo cancel one, you can type *cancel* and choose the order.";

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: textOut,
                orgId: org.id,
              });
            }

            continue;
          }

          // 0.2) Explicit commands: NEW / CANCEL / UPDATE / AGENT
          const cmd = detectUserCommand(text);

          // 0.25) Repeat last order → convert last items into synthetic text
          if (cmd === "repeat") {
            const last = await findMostRecentOrderForPhone(org.id, from);

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_repeat",
              msgId,
              text,
              orderId: last?.id || null,
            });

            if (
              !last ||
              !Array.isArray(last.items) ||
              last.items.length === 0
            ) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "I couldn’t find any previous orders to repeat for this number.\n" +
                  "You can send a new order by typing the items.",
                orgId: org.id,
              });
              continue;
            }

            const synthetic = itemsToOrderText(last.items || []);

            if (!synthetic) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "Your last order looks empty in our system.\n" +
                  "Please send the items you’d like to order again.",
                orgId: org.id,
              });
              continue;
            }

            // Overwrite text so the normal parser sees a clean item list
            text = synthetic;
            lowerText = text.toLowerCase().trim();

            // Treat this like starting a fresh order
            lastCommandByPhone.set(from, "new");

            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "👍 Repeating your last order with the same items.\n" +
                "If you want to change anything, please type it now.",
              orgId: org.id,
            });
          }

          // 0.18) Show last order summary (read-only)
          if (
            /order summary/i.test(lowerText) ||
            /show (my )?order/i.test(lowerText) ||
            /last order/i.test(lowerText)
          ) {
            const last = await findMostRecentOrderForPhone(org.id, from);

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "order_summary_last",
              msgId,
              text,
              orderId: last?.id || null,
            });

            if (
              !last ||
              !Array.isArray(last.items) ||
              last.items.length === 0
            ) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text: "I couldn’t find any previous orders for this number.",
                orgId: org.id,
              });
            } else {
              const summary = formatOrderSummary(last.items || []);

              const rawStatus = String(last.status || "pending");
              let statusText = `Status: ${rawStatus}`;
              if (rawStatus === "pending") statusText = "🟡 Status: pending";
              else if (rawStatus === "paid") statusText = "🟢 Status: paid";
              else if (rawStatus.startsWith("cancelled"))
                statusText = "🔴 Status: cancelled";

              const textOut =
                "📦 Your last order:\n" + summary + "\n\n" + statusText;

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: textOut,
                orgId: org.id,
              });
            }

            continue;
          }

          if (cmd === "agent") {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_agent",
              msgId,
              text,
            });

            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "👨‍💼 Okay, we’ll connect you to a store agent.\n" +
                "Please wait a moment — a human will reply.",
              orgId: org.id,
            });
            // here you could also flag the conversation row in DB
            continue;
          }

          if (cmd === "cancel") {
            const activeOrders = await findAllActiveOrdersForPhone(
              org.id,
              from
            );

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_cancel",
              msgId,
              text,
              meta: { activeCount: activeOrders.length },
            });

            if (!activeOrders.length) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "You don’t have any active orders right now.\n" +
                  "If you’d like to place a new order, please send your items.",
                orgId: org.id,
              });
              await clearConversationStage(org.id, from);
              continue;
            }

            if (activeOrders.length === 1) {
              // Same behaviour as before (Option A) – cancel the single active order
              const activeOrderForCancel = activeOrders[0];

              await supa
                .from("orders")
                .update({ status: "cancelled_by_customer" })
                .eq("id", activeOrderForCancel.id);

              const summary = formatOrderSummary(
                activeOrderForCancel.items || []
              );

              const textOut =
                "❌ Your last order has been cancelled:\n" +
                summary +
                "\n\nIf this was a mistake, you can send a new order.";

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: textOut,
                orgId: org.id,
              });

              await maybeSendCommandsTip({
                phoneNumberId,
                to: from,
                orgId: org.id,
              });

              // remember last action (if you still want it)
              lastCommandByPhone.set(from, "cancel");

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "command_cancel_single",
                msgId,
                orderId: activeOrderForCancel.id,
                text,
                result: { summary },
              });

              continue;
            }

            // Multiple active orders → ask user to choose
            lastCommandByPhone.set(from, "cancel_select");

            const orderIds = activeOrders.map((o) => o.id);
            pendingCancelOptions.set(from, { orderIds });

            const lines = activeOrders.map((o, idx) => {
              const n = idx + 1;
              const items = (o.items || []) as any[];
              const first = items[0];
              const firstName = first
                ? String(first.canonical || first.name || "item")
                : "item";
              const extra =
                items.length > 1 ? ` + ${items.length - 1} more item(s)` : "";
              const status = String(o.status || "pending");
              return `${n}) ${firstName}${extra}  [${status}]`;
            });

            const textOut =
              "You have multiple active orders:\n" +
              lines.join("\n") +
              "\n\nReply with the number of the order you want to cancel (for example 1 or 2).";

            await sendWabaText({
              phoneNumberId,
              to: from,
              text: textOut,
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_cancel_multi",
              msgId,
              text,
              meta: { orderIds },
            });

            continue;
          }

          if (cmd === "new") {
            // remember last command
            lastCommandByPhone.set(from, "new");

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_new",
              msgId,
              text,
            });

            // 1) Close all active orders for this phone
            await supa
              .from("orders")
              .update({ status: "archived_for_new" })
              .eq("org_id", org.id)
              .eq("source_phone", from)
              .in("status", ["pending", "paid"]);

            // 2) Close clarify/address sessions
            const phoneKey = normalizePhoneForKey(from);
            await supa
              .from("order_clarify_sessions")
              .update({
                status: "closed",
                updated_at: new Date().toISOString(),
              })
              .eq("org_id", org.id)
              .eq("customer_phone", phoneKey)
              .eq("status", "open");

            // 3) Respond
            await sendWabaText({
              phoneNumberId,
              to: from,
              text: "👍 Starting a fresh order. Please send the items you’d like to buy.",
              orgId: org.id,
            });

            await clearConversationStage(org.id, from);

            continue;
          }

          if (cmd === "update") {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_update",
              msgId,
              text,
            });

            // We do *not* auto-edit any existing order in V1.
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "I can’t update specific items automatically yet.\n" +
                "Please type your changes clearly (e.g., “change 1kg onion to 2kg onion”) and the store will review it.",
              orgId: org.id,
            });
            continue;
          }

          // 0.3) L8 — Soft cancel intent (stop / no need / cancel it pls / don't want)
          if (!cmd && activeOrderId && detectSoftCancelIntent(text)) {
            // Target the latest active order for soft-cancel
            pendingSoftCancel.set(from, activeOrderId);
            lastCommandByPhone.set(from, "cancel_pending");

            const summary = formatOrderSummary(activeOrder.items || []);
            const promptText =
              "⚠️ It looks like you want to cancel your last order:\n" +
              (summary || "(no items found)") +
              "\n\nReply *YES* to cancel it, or *NO* to keep it.";

            await sendWabaText({
              phoneNumberId,
              to: from,
              text: promptText,
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "soft_cancel_prompt",
              msgId,
              orderId: activeOrderId,
              text,
              result: { summary },
            });

            continue;
          }

          // 0.8) Edit-like messages while an order is open → safe fallback (no auto edit in V1)
          const activeOrderForEdit = activeOrder;
          if (activeOrderForEdit && isLikelyEditRequest(text)) {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "edit_like_message",
              msgId,
              text,
              orderId: activeOrderForEdit.id,
            });

            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "I’m not sure which part of your order to change.\n" +
                "Please send the updated order clearly, or talk to the store directly.\n" +
                "If you want, you can cancel this order and create a new one from the beginning.",
              orgId: org.id,
            });
            continue;
          }
          // ─────────────────────────────
          // LAYER 1: NLU classifier
          // ─────────────────────────────
          const nlu = await classifyMessage(text);
          console.log("[WABA][NLU]", {
            intent: nlu.intent,
            conf: nlu.confidence,
          });
          // Greeting detection → only short-circuit for *pure* greeting/thanks/ok
          if (nlu.intent === "greeting" && isPureGreetingText(text)) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text: makeGreeting(tone),
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "nlu_greeting_pure",
              msgId,
              text,
              result: { intent: nlu.intent },
            });

            continue; // ← ONLY for pure greeting
          }
          // If NLU said "greeting" but message has extra words (e.g. "ok mutton biriyani"),
          // we just log it and FALL THROUGH to ingestCore.
          if (nlu.intent === "greeting" && !isPureGreetingText(text)) {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "nlu_greeting_but_not_pure",
              msgId,
              text,
              result: { intent: nlu.intent },
            });
          }
          // 1) Normal path: parse + store
          const result: any = await ingestCoreFromMessage({
            org_id: org.id,
            text,
            ts,
            from_phone: from,
            from_name: null,
            msg_id: msgId,
            source: "waba",
            // 🔹 NEW: tell core which order is currently active (if any)
            active_order_id: activeOrderId || undefined,
          });
          console.log("[WABA][INGEST-RESULT]", {
            org_id: org.id,
            from,
            msgId,
            used: result.used,
            kind: result.kind,
            inquiry: result.inquiry || result.inquiry_type,
            order_id: result.order_id,
            reason: result.reason,
            stored: result.stored,
          });
          await logFlowEvent({
            orgId: org.id,
            from,
            event: "ingest_result",
            msgId,
            orderId: result.order_id || null,
            text,
            result,
            meta: {
              kind: result.kind,
              reason: result.reason,
              stored: result.stored,
              lastCmd,
            },
          });
          // ─────────────────────────────
          // MENU HEURISTIC: convert to inquiry:menu when appropriate
          // ─────────────────────────────
          const menuRegex =
            /\b(menu|price list|pricelist|rate card|ratecard|services list|service menu)\b/i;

          const looksLikeMenu = menuRegex.test(lowerText);

          if (looksLikeMenu && result.kind !== "order") {
            result.kind = "inquiry";
            if (!result.inquiry && !result.inquiry_type) {
              (result as any).inquiry_type = "menu";
            }
          }
          // ────────────────────────────
          // NEW: snapshot last inquiry for Inbox center card
          // ─────────────────────────────
          try {
            if (result && result.kind === "inquiry") {
              const phoneKey = normalizePhoneForKey(from);

              // Normalize inquiry type ("availability", "price", "menu", etc.)
              const inquiryRaw = result.inquiry || result.inquiry_type || null;
              const inquiryType = inquiryRaw
                ? String(inquiryRaw).toLowerCase()
                : null;

              // Try to guess a canonical name for the product being asked about
              let canonical: string | null = null;

              if (typeof (result as any).inquiry_canonical === "string") {
                canonical = (result as any).inquiry_canonical;
              } else if (typeof (result as any).canonical === "string") {
                canonical = (result as any).canonical;
              } else if (typeof result.reason === "string") {
                // e.g. "inq:availability:paneer biryani"
                const m = result.reason.match(/^inq:[^:]+:(.+)$/i);
                if (m && m[1]) {
                  canonical = m[1];
                }
              }
              await supa.from("org_customer_settings").upsert(
                {
                  org_id: org.id,
                  customer_phone: phoneKey,
                  last_inquiry_text: text, // "Do you have panner biriyani"
                  last_inquiry_kind: inquiryType, // "availability" / "price" / "menu" / ...
                  last_inquiry_canonical: canonical, // "paneer biryani" (best effort)
                  last_inquiry_at: new Date().toISOString(),
                  last_inquiry_status: "unresolved",
                },
                { onConflict: "org_id,customer_phone" }
              );
            }
          } catch (e: any) {
            console.warn(
              "[WABA][inquiry snapshot upsert err]",
              e?.message || e
            );
          }

          //   if (!org.auto_reply_enabled) continue;

          let reply: string | null = null;

          const unmatchedOnly = extractCatalogUnmatchedOnly(result.reason);

          // Tiny acks like "ok", "no", "thanks" should not become fake items
          const tinyAckWords = new Set([
            "ok",
            "okay",
            "k",
            "kk",
            "thanks",
            "thank you",
            "thx",
            "no",
            "yes",
            "yup",
            "ya",
            "yeah",
          ]);
          const isTinyAck = tinyAckWords.has(lowerText);
          // 🔸 Prefer AI canonical (Egg Rice) over the shorter catalog label (Rice)
          function pickNiceUnmatchedLabel(
            result: any,
            unmatchedOnly: string[]
          ): string {
            const canonFromInquiry =
              typeof result.inquiry_canonical === "string"
                ? result.inquiry_canonical.trim()
                : "";

            if (canonFromInquiry) return canonFromInquiry;

            const fromReason = unmatchedOnly.join(", ").trim();
            if (fromReason) return fromReason;

            // Last fallback: use raw text if nothing else
            return (result.raw_text || "").slice(0, 80) || "that item";
          }

          if (
            !reply &&
            result.kind === "inquiry" &&
            unmatchedOnly.length &&
            !isTinyAck
          ) {
            const label = pickNiceUnmatchedLabel(result, unmatchedOnly);

            if (activeOrderId) {
              reply =
                `⚠️ Sorry, I couldn’t find “${label}” in today’s items.\n` +
                "Your existing order is unchanged — the store will confirm if they can add it or suggest alternatives.";
            } else {
              reply =
                `⚠️ Sorry, I couldn’t find “${label}” in today’s items.\n` +
                "Please send a different item name or check the menu, and the store will help you.";
            }
          }

          const shouldForceMergeAfterAddress = lastCmd === "address_done";
          const canMerge =
            lastCmd !== "cancel" &&
            lastCmd !== "new" &&
            (looksLikeAddToExisting(text) || shouldForceMergeAfterAddress);
          // 1.5) If this is an order and there is a PREVIOUS open order,
          // MERGE when:
          //   - text clearly looks like "add more", OR
          //   - we JUST finished an address flow for this phone
          if (
            canMerge &&
            result.kind === "order" &&
            result.stored &&
            result.order_id &&
            Array.isArray(result.items)
          ) {
            const previousOpen = await findActiveOrderForPhoneExcluding(
              org.id,
              from,
              result.order_id
            );

            if (previousOpen && previousOpen.id) {
              const baseItems = (previousOpen.items || []) as any[];
              const newItems = (result.items || []) as any[];

              const mergedItems = [...baseItems, ...newItems];

              const { error: updErr } = await supa
                .from("orders")
                .update({ items: mergedItems })
                .eq("id", previousOpen.id);

              if (updErr) {
                console.warn("[WABA][merge update err]", updErr.message);
              } else {
                // Try to delete the temporary new order (best effort)
                const { error: delErr } = await supa
                  .from("orders")
                  .delete()
                  .eq("id", result.order_id);
                if (delErr) {
                  console.warn("[WABA][merge delete err]", delErr.message);
                }

                // Point the result at the merged/base order
                result.order_id = previousOpen.id;
                result.items = mergedItems;

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "merged_into_existing_order",
                  msgId,
                  orderId: previousOpen.id,
                  text,
                  result: {
                    mergedInto: previousOpen.id,
                    newOrderId: result.order_id,
                    addedItems: newItems.length,
                    baseItems: baseItems.length,
                  },
                });
              }
            }
          }
          // 2) Order path → either start multi-turn clarify OR
          //    (if no clarify) confirm + maybe open address session
          if (result.kind === "order" && result.stored && result.order_id) {
            lastCommandByPhone.delete(from);
            const items = (result.items || []) as any[];

            const needsAddress = needsAddressForOrg;

            const unmatchedItems = extractCatalogUnmatched(result.reason);
            const unmatchedNote =
              unmatchedItems.length > 0
                ? "\n\n⚠️ We couldn’t find these items in our list: " +
                  unmatchedItems.join(", ") +
                  ". The store will confirm or suggest alternatives."
                : "";

            const clarifyStart = await startClarifyForOrder({
              org_id: org.id,
              order_id: result.order_id,
              from_phone: from,
            });
            if (clarifyStart) {
              // L9: stage is already set to "awaiting_clarification" inside startClarifyForOrder
              reply = clarifyStart + unmatchedNote;
            } else {
              const summary = formatOrderSummary(items);

              if (!needsAddress) {
                reply = "✅ We’ve got your order:\n" + summary + unmatchedNote;

                // L9: order confirmed, no address → post_order
                await setConversationStage(org.id, from, "post_order", {
                  active_order_id: result.order_id,
                  last_action: "order_created_no_address_needed",
                });
              } else {
                const alreadyHasAddress = await hasAddressForOrder(
                  org.id,
                  from,
                  result.order_id
                );

                if (alreadyHasAddress) {
                  reply = "✅ Updated order:\n" + summary + unmatchedNote;

                  // L9: order + address → post_order
                  await setConversationStage(org.id, from, "post_order", {
                    active_order_id: result.order_id,
                    last_action: "order_created_address_already",
                  });
                } else {
                  await startAddressSessionForOrder({
                    org_id: org.id,
                    order_id: result.order_id,
                    from_phone: from,
                  });

                  reply =
                    "✅ We’ve got your order:\n" +
                    summary +
                    unmatchedNote +
                    "\n\n📍 Please share your delivery address (or send location) if you haven’t already.";
                  // stage for address is already set to "awaiting_address" in startAddressSessionForOrder
                }
              }
            }
          }
          // 3) Inquiry path → MENU or smart price/availability
          if (!reply && result.kind === "inquiry") {
            const inquiryRaw = result.inquiry || result.inquiry_type || null;
            const inquiryType = inquiryRaw
              ? String(inquiryRaw).toLowerCase()
              : null;

            const menuRegex =
              /\b(menu|price list|pricelist|rate card|ratecard|services list|service menu)\b/i;
            const looksLikeMenu = menuRegex.test(lowerText);

            // 3a) MENU / RATE CARD / PRICE LIST
            if (inquiryType === "menu" || looksLikeMenu) {
              const menuText = await buildMenuReply({
                org_id: org.id,
                text,
                businessType: normalizeBusinessType(org.primary_business_type),
              });

              reply =
                menuText ||
                "📋 Our menu / price list changes often. We’ll share the latest options with you shortly.";
            } else {
              // 3b) Normal smart inquiry (price / availability / etc.)
              reply = await buildSmartInquiryReply({
                org_id: org.id,
                text,
                inquiryType,
              });

              if (!reply) {
                reply =
                  "💬 Got your question. We’ll confirm the details shortly.";
              }
            }
          }
          // After answering an inquiry, mark last inquiry as resolved in customer settings
          if (reply && result.kind === "inquiry") {
            try {
              const phoneKey = normalizePhoneForKey(from);
              await supa
                .from("org_customer_settings")
                .update({
                  last_inquiry_status: "resolved",
                  last_inquiry_resolved_at: new Date().toISOString(),
                })
                .eq("org_id", org.id)
                .eq("customer_phone", phoneKey);
            } catch (e: any) {
              console.warn(
                "[WABA][inquiry mark resolved err]",
                e?.message || e
              );
            }
          }
          // 4) Heuristic question fallback (looks like inquiry but parser didn’t classify cleanly)
          if (
            !reply &&
            /price|rate|how much|available|stock|do you have/i.test(lowerText)
          ) {
            reply = makeGenericQuestionAck(tone);
          }
          // 5) Skip obvious small-talk
          if (
            !reply &&
            !result.stored &&
            result.reason === "small_talk_or_non_order"
          ) {
            reply = null;
          }
          // 6) Final fail-soft ack (safe + generic + commands)
          if (!reply) {
            const phoneKey = normalizePhoneForKey(from);
            const alreadySawTip = commandsTipShown.has(phoneKey);

            if (result.kind === "order") {
              // Only when parser really saw an order
              reply =
                "✅ We’ve received your order. We’ll follow up if anything needs clarification.";
            } else if (result.reason === "dropped:greeting_ack") {
              // short messages like "hi", "ok", "thanks"
              if (activeOrderId) {
                // 🔇 After an order is already active: don't spam another intro
                console.log(
                  "[WABA][AUTO-REPLY] greeting_ack with active order → no reply"
                );
                reply = null; // no WhatsApp message
              } else {
                // First-time greeting (no active order) → behave like intro
                const greet = makeGreeting(tone);
                if (!alreadySawTip) {
                  commandsTipShown.add(phoneKey);
                  reply =
                    greet +
                    "\n\n" +
                    "• To place an order, just type what you want in one message.\n" +
                    "• To see your orders, type: order summary\n" +
                    "• To talk to a human, type: agent\n" +
                    "• To cancel your last order, type: cancel";
                } else {
                  reply = greet;
                }
              }
            } else {
              // Other non-order, non-greeting messages → keep old generic behaviour
              const greet = makeGreeting(tone);

              if (!alreadySawTip) {
                commandsTipShown.add(phoneKey);
                reply =
                  greet +
                  "\n\n" +
                  "• To place an order, just type what you want in one message.\n" +
                  "• To see your orders, type: order summary\n" +
                  "• To talk to a human, type: agent\n" +
                  "• To cancel your last order, type: cancel";
              } else {
                reply = greet;
              }
            }
          }
          if (reply) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text: reply,
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "auto_reply_decided",
              msgId,
              orderId: result.order_id || null,
              text: reply,
              result: {
                kind: result.kind,
                reason: result.reason,
              },
            });
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (e: any) {
    console.error("[WABA][ERR]", e?.message || e);
    return res.sendStatus(200);
  }
});

// Log inbound-only message (when auto-reply is OFF for this customer)
async function logInboundMessageToInbox(opts: {
  orgId: string;
  from: string; // customer phone (raw)
  text: string;
  msgId?: string;
}) {
  try {
    const { orgId, from, text } = opts;
    const phonePlain = normalizePhoneForKey(from); // digits only
    const phonePlus = phonePlain ? `+${phonePlain}` : "";
    // Find existing conversation by phone
    const { data: conv1 } = await supa
      .from("conversations")
      .select("id")
      .eq("org_id", orgId)
      .eq("customer_phone", phonePlain)
      .limit(1)
      .maybeSingle();

    let conversationId = conv1?.id || null;

    if (!conversationId) {
      const { data: conv2 } = await supa
        .from("conversations")
        .select("id")
        .eq("org_id", orgId)
        .eq("customer_phone", phonePlus)
        .limit(1)
        .maybeSingle();
      conversationId = conv2?.id || null;
    }
    // If still nothing, create a new conversation row
    if (!conversationId) {
      const { data: inserted, error: convErr } = await supa
        .from("conversations")
        .insert({
          org_id: orgId,
          customer_phone: phonePlain,
          customer_name: null,
          source: "waba",
          last_message_at: new Date().toISOString(),
          last_message_preview: text.slice(0, 120),
        })
        .select("id")
        .single();

      if (convErr) {
        console.warn("[INBOX][inbound conv insert err]", convErr.message);
        return;
      }
      conversationId = inserted.id;
    } else {
      // bump preview if conv exists
      await supa
        .from("conversations")
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: text.slice(0, 120),
        })
        .eq("id", conversationId)
        .eq("org_id", orgId);
    }

    // Insert inbound message row
    await supa.from("messages").insert({
      org_id: orgId,
      conversation_id: conversationId,
      direction: "in",
      sender_type: "customer",
      channel: "waba",
      body: text,
      wa_msg_id: opts.msgId || null,
    });
  } catch (e: any) {
    console.warn("[INBOX][inbound log err]", e?.message || e);
  }
}

// ─────────────────────────────
// Send via Cloud API + log to inbox
// ─────────────────────────────
async function sendWabaText(opts: {
  phoneNumberId: string;
  to: string;
  text?: string;
  image?: string; // <── NEW
  caption?: string; // <── NEW
  orgId?: string;
}) {
  const token = process.env.WA_ACCESS_TOKEN || process.env.META_WA_TOKEN;
  if (!token) {
    console.warn("[WABA] WA_ACCESS_TOKEN missing, cannot send reply");
    return;
  }

  const toNorm = opts.to.startsWith("+") ? opts.to : `+${opts.to}`;

  // -------------------------------------------
  // 🚀 1) SEND IMAGE (NEW)
  // -------------------------------------------
  let payload: any;

  if (opts.image) {
    payload = {
      messaging_product: "whatsapp",
      to: toNorm,
      type: "image",
      image: {
        link: opts.image, // direct URL
        caption: opts.caption || opts.text || "",
      },
    };
  } else {
    // -------------------------------------------
    // 🚀 2) FALLBACK → TEXT (EXACT OLD LOGIC)
    // -------------------------------------------
    payload = {
      messaging_product: "whatsapp",
      to: toNorm,
      type: "text",
      text: { body: opts.text || "" },
    };
  }

  try {
    const resp = await axios.post(
      `${META_WA_BASE}/${opts.phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("[WABA][SEND]", {
      to: toNorm,
      type: opts.image ? "image" : "text",
      text: opts.text,
      image: opts.image,
    });

    // ------------------------------------------------
    // FLOW LOG (unchanged)
    // ------------------------------------------------
    if (opts.orgId) {
      try {
        await logFlowEvent({
          orgId: opts.orgId,
          from: toNorm.replace(/^\+/, ""),
          event: "auto_reply_sent",
          msgId:
            resp.data?.messages && resp.data.messages[0]?.id
              ? String(resp.data.messages[0].id)
              : undefined,
          text: opts.text,
          meta: {
            phoneNumberId: opts.phoneNumberId,
            image: opts.image || null,
          },
        });
      } catch (e: any) {
        console.warn("[WABA][FLOW_LOG_OUT_ERR]", e?.message || e);
      }
    }

    // ------------------------------------------------
    // INBOX MESSAGE LOGGING (unchanged)
    // ------------------------------------------------
    if (opts.orgId) {
      try {
        const { data: conv } = await supa
          .from("conversations")
          .select("id")
          .eq("org_id", opts.orgId)
          .eq("customer_phone", toNorm.replace(/^\+/, ""))
          .limit(1)
          .maybeSingle();

        let convId = conv?.id || null;

        if (!convId) {
          const { data: conv2 } = await supa
            .from("conversations")
            .select("id")
            .eq("org_id", opts.orgId)
            .eq("customer_phone", toNorm)
            .limit(1)
            .maybeSingle();
          convId = conv2?.id || null;
        }

        if (convId) {
          const wa_msg_id =
            resp.data?.messages && resp.data.messages[0]?.id
              ? String(resp.data.messages[0].id)
              : null;

          const bodyToStore = opts.image
            ? `[image sent] ${opts.caption || opts.text || ""}`
            : opts.text;

          const { error: msgErr } = await supa.from("messages").insert({
            org_id: opts.orgId,
            conversation_id: convId,
            direction: "out",
            sender_type: "ai",
            channel: "waba",
            body: bodyToStore,
            wa_msg_id,
          });

          if (msgErr) {
            console.warn("[INBOX][MSG out err]", msgErr.message);
          }
        }
      } catch (e: any) {
        console.warn("[INBOX][outbound log err]", e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn("[WABA][SEND_ERR]", e?.response?.data || e?.message || e);
  }
}
export default waba;
export { sendWabaText };
