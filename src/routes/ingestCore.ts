// src/routes/ingestCore.ts
import { supa } from "../db";
import { parseOrder } from "../parser";
import { detectInquiry } from "../util/inquiry";
import {
  isObviousPromoOrSpam,
  isPureGreetingOrAck,
  isNotOrderMessage,
} from "../util/notOrder";
import { routeProductText } from "../ai/productRouter";
import {
  IngestInput,
  IngestResult,
  IngestSource,
  IngestItem,
  InquiryKind,
} from "../types";
import { findBestProductForTextV2 } from "../util/productMatcher";

import {
  markSessionOnNewOrder,
  markSessionOnAppendOrder,
  markSessionOnInquiry,
  markSessionOnModifier,
  decideSessionNextStep,
  type NluResult as SessionNluResult,
  type ParsedMessage as SessionParsedMessage,
} from "../session/sessionEngine";

import { formatInquiryReply } from "../util/inquiryReply"; // NEW
import { classifyMessage, NLUResult as CoreNluResult } from "../ai/nlu";

// ─────────────────────────────────────────────────────────
// Optional AI parser hook (safe if missing → rules fallback)
// ─────────────────────────────────────────────────────────
let aiParseOrder:
  | undefined
  | ((
      text: string,
      catalog?: any,
      opts?: { org_id?: string; customer_phone?: string }
    ) => Promise<{
      items: any[];
      confidence?: number;
      reason?: string | null;
      is_order_like?: boolean;
      used?: "ai" | "rules";
    }>);

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../ai/parser");
  aiParseOrder = (mod.aiParseOrder ||
    mod.default?.aiParseOrder) as typeof aiParseOrder;
  console.log(
    "[AI][wire][core] aiParseOrder loaded?",
    typeof aiParseOrder === "function"
  );
} catch (e) {
  console.warn("[AI][wire][core] load fail:", (e as any)?.message || e);
  aiParseOrder = undefined;
}

/** ───────────────── helpers ───────────────── **/

const asStr = (v: any) =>
  typeof v === "string" ? v : v == null ? "" : String(v);
const trim = (v: any) => asStr(v).trim();

/** Normalize a product name for catalog matching */
function normalizeNameForMatch(raw?: string | null): string {
  return (
    String(raw || "")
      .toLowerCase()
      // strip leading qty like "1", "2x", "3.5 "
      .replace(/^\s*\d+(\.\d+)?\s*x?\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function normPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/[^\d]/g, "");
  return digits.length >= 7 ? plus + digits : null;
}

function mapToSessionIntent(
  raw: string | undefined | null
): SessionNluResult["intent"] {
  switch (raw) {
    case "greeting":
      return "greeting";
    case "smalltalk":
      return "smalltalk";
    case "spam":
      return "spam";
    case "menu_inquiry":
    case "price_inquiry":
    case "availability_inquiry":
    case "inquiry":
      return "inquiry";
    case "modifier":
    case "order_correction":
      return "modifier";
    case "address_update":
      return "address_update";
    case "order":
      return "order";
    default:
      return "unknown";
  }
}

/** Dedup within the same minute (same org + same text + phone [+ msgId if present]) */
function makeDedupeKey(
  orgId: string,
  text: string,
  ts?: number,
  phone?: string | null,
  msgId?: string | null
) {
  const t = ts ? new Date(ts) : new Date();
  const bucket = new Date(
    Math.floor(t.getTime() / 60000) * 60000
  ).toISOString();
  const p = (phone || "").trim() || "_no_phone_";
  const m = (msgId || "").trim() || "_no_msg_";
  const crypto = require("crypto") as typeof import("crypto");
  return crypto
    .createHash("sha256")
    .update(`${orgId}|${p}|${m}|${text}|${bucket}`)
    .digest("hex");
}

/** ───────────────── line normalization & qty helpers ───────────────── **/

function stripNonItemPreamble(line: string): string {
  let s = line.trim();

  // Keep “add …” tails
  const addRe = /\b(?:can\s+you\s+)?add\s+(.*)$/i;
  const mAdd = s.match(addRe);
  if (mAdd && mAdd[1]) return mAdd[1].trim();

  // Remove common preambles
  s = s.replace(/^(hi|hello|hey)[,!\s]*/i, "");
  s = s.replace(/^can (you|u)\s+(please\s+)?(send|deliver|bring)\s*/i, "");
  s = s.replace(
    /^(i\s+want|i\s+need|please\s+send|pls\s+send|kindly\s+send)\s*/i,
    ""
  );
  s = s.replace(
    /^(and|also|sorry|one more thing|that's it|thats it)[:,]?\s*/i,
    ""
  );

  return s.trim();
}

// Used ONLY for shape detection & list-based fallback
function splitAndCleanLines(textRaw: string): string[] {
  return String(textRaw)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .map(stripNonItemPreamble)
    .map(
      (l) =>
        l
          .replace(/^[•\-\–—()\s]+/, "") // bullets/dashes/brackets
          .replace(/^\d+[\.\)]\s+/, "") // "1. " / "2) "
    )
    .filter(Boolean);
}

// Simple token overlap between query and product name
function hasStrongTokenOverlap(query: string, candidate: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gi, " ")
      .split(/\s+/)
      .filter(Boolean);

  const qTokens = norm(query);
  const cTokens = norm(candidate);

  if (!qTokens.length || !cTokens.length) return false;

  const overlap = qTokens.filter((t) => cTokens.includes(t));
  const overlapCount = overlap.length;

  // 🔑 RULE:
  // - if user gave 2+ words (e.g. "paneer biryani"), require overlap >= 2
  // - if user gave only 1 word (e.g. "biryani"), overlap >= 1 is ok
  if (qTokens.length >= 2) {
    return overlapCount >= 2;
  } else {
    return overlapCount >= 1;
  }
}

// ─────────────────────────────────────────
// Layer 2: Catalog sanity check
// ─────────────────────────────────────────

type CatalogCheckResult = {
  matched: IngestItem[];
  unmatched: IngestItem[];
};

/**
 * Check each parsed item against the org's product catalog.
 *
 * - Uses simple token overlap on canonical/name vs product display_name/canonical.
 * - If products table is empty or query fails → returns null (no blocking).
 * - We only *tag* unmatched items; we don't block orders in this layer.
 */
async function validateItemsAgainstCatalog(
  orgId: string,
  items: IngestItem[]
): Promise<CatalogCheckResult | null> {
  try {
    if (!items || !items.length) return null;

    const { data, error } = await supa
      .from("products")
      .select("id, canonical, display_name")
      .eq("org_id", orgId);

    if (error) {
      console.warn("[INGEST][catalog_check] products err", error.message);
      return null;
    }
    if (!data || !data.length) {
      // No catalog configured for this org → don't enforce anything
      return null;
    }

    const products = data as any[];

    const matched: IngestItem[] = [];
    const unmatched: IngestItem[] = [];

    for (const it of items) {
      const labelRaw = trim(it.canonical || it.name || "");
      const label = normalizeNameForMatch(labelRaw);
      if (!label) {
        // no name → don't mark as unmatched, just let it flow
        matched.push(it);
        continue;
      }

      let found = false;
      for (const p of products) {
        const pNameRaw = trim(p.display_name || p.canonical || "");
        const pName = normalizeNameForMatch(pNameRaw);
        if (!pName) continue;

        // 1️⃣ First try strict overlap (used elsewhere too)
        if (hasStrongTokenOverlap(label, pName)) {
          found = true;
          break;
        }

        // 🔴 NEW 2️⃣ Lenient overlap just for catalog sanity:
        // allow a single shared token to count as "exists in catalog"
        const norm = (s: string) =>
          s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/gi, " ")
            .split(/\s+/)
            .filter(Boolean);

        const qTokens = norm(label);
        const pTokens = norm(pName);
        if (!qTokens.length || !pTokens.length) continue;

        const overlapCount = qTokens.filter((t) => pTokens.includes(t)).length;

        if (overlapCount >= 1) {
          found = true;
          break;
        }
      }

      if (found) {
        matched.push(it);
      } else {
        unmatched.push(it);
      }
    }

    return { matched, unmatched };
  } catch (e: any) {
    console.warn("[INGEST][catalog_check] unexpected err]", e?.message || e);
    return null;
  }
}

// Extract qty/unit from a single line
function parseInlineQtyUnit(s: string): {
  name: string;
  qty: number | null;
  unit: string | null;
} {
  const str = s.trim();

  // Leading qty: "2 kg rice", "1L milk"
  const lead = str.match(
    /^(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)?\b\s*(.+)$/i
  );
  if (lead) {
    const qty = Number(lead[1]);
    const unit = (lead[2] || "").toLowerCase() || null;
    const name = (lead[3] || "").trim();
    if (name) return { name, qty: Number.isFinite(qty) ? qty : null, unit };
  }

  // Trailing qty+unit: "apples 600 gms"
  const tailWithUnit = str.match(
    /\b(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)\b$/i
  );
  if (tailWithUnit) {
    const qty = Number(tailWithUnit[1]);
    const unit = tailWithUnit[2].toLowerCase();
    const name = str.replace(tailWithUnit[0], "").trim();
    return { name, qty: Number.isFinite(qty) ? qty : null, unit };
  }

  // Trailing bare number: "Idly batter small 3"
  const tailNum = str.match(/\b(\d+)\s*$/);
  if (tailNum) {
    const qty = Number(tailNum[1]);
    const name = str.replace(/\b(\d+)\s*$/, "").trim();
    return { name, qty: Number.isFinite(qty) ? qty : null, unit: null };
  }

  return { name: str, qty: null, unit: null };
}

function isPoliteNoiseLine(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (!t) return true;
  if (/^(hi|hello|hey|hlo|ok|okay|k|thanks|thank you|thanx|thx|sorry)$/.test(t))
    return true;
  if (/^(gm|gn|good (morning|evening|night|afternoon))$/.test(t)) return true;
  return false;
}

// Deterministic items from list lines
function buildLineItemsFromList(listLines: string[]) {
  return listLines
    .map((l) => {
      if (isPoliteNoiseLine(l)) return null;

      const { name, qty, unit } = parseInlineQtyUnit(l);
      const canonical = (name || "").trim();
      if (!canonical) return null;

      return {
        qty: Number.isFinite(qty as any) ? (qty as number) : 1,
        unit: unit ?? null,
        canonical,
        brand: null,
        variant: null,
        notes: null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

// Fallback for single-line / inline orders when AI under-fires.
// Example: "1kg onion and 0.5kg chicken"
function fallbackQtyItems(text: string): IngestItem[] {
  const items: IngestItem[] = [];
  if (!text) return items;

  // Split on newlines / commas / "and"
  const segments = text
    .split(/[\n,]/)
    .flatMap((s) => s.split(/\band\b/i))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const seg of segments) {
    const { name, qty, unit } = parseInlineQtyUnit(seg);
    const canonical = (name || "").trim();

    // We only treat as fallback order item if:
    //  - we have a name
    //  - AND a numeric qty (to avoid "do you have onion" etc.)
    if (!canonical) continue;
    if (qty == null || !Number.isFinite(qty as any)) continue;

    items.push({
      qty: qty as number,
      unit: unit ?? null,
      canonical,
      name: canonical,
      brand: null,
      variant: null,
      notes: null,
    });
  }

  return items;
}

/** ───────────────── Session + gating utilities ───────────────── **/

const INQUIRY_WINDOW_MIN = Number(process.env.INQUIRY_WINDOW_MIN || 1440); // 24h

function isLikelyPromoOrSpam(text: string) {
  if (isObviousPromoOrSpam(text)) return true;
  const t = (text || "").toLowerCase();
  if (
    /\b(unsubscribe|opt[-\s]?out|reply\s*stop|stop\s*to\s*opt[-\s]?out)\b/i.test(
      t
    )
  )
    return true;
  if (/\bterms\s+and\s+conditions\s+apply\b/i.test(t)) return true;
  if (
    /[🎉🎊📣✨💥🔥]/.test(t) &&
    /\b(offer|deal|sale|discount|voucher)\b/.test(t)
  )
    return true;
  return false;
}

async function findRecentInquiry(
  orgId: string,
  phone: string | null,
  minutes: number
) {
  if (!phone) return null;
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data, error } = await supa
    .from("orders")
    .select("id, raw_text, parse_reason, created_at")
    .eq("org_id", orgId)
    .eq("source_phone", phone)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    console.warn("[INGEST][findRecentInquiry]", error.message);
    return null;
  }
  return (data || []).find((r) =>
    String(r.parse_reason || "")
      .toLowerCase()
      .startsWith("inq:")
  );
}

async function findOrderByMsgId(
  orgId: string,
  phone: string | null,
  msgId: string
) {
  if (!msgId || !phone) return null;

  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, status, created_at, parse_reason, msg_id")
      .eq("org_id", orgId)
      .eq("source_phone", phone)
      .eq("msg_id", msgId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!error && data && data[0]) return data[0];
  } catch (e: any) {
    console.warn(
      "[INGEST][findOrderByMsgId] column path failed, trying legacy like()]",
      e?.message || e
    );
  }

  try {
    const like = `msgid:${msgId}%`;
    const { data, error } = await supa
      .from("orders")
      .select("id, status, created_at, parse_reason")
      .eq("org_id", orgId)
      .eq("source_phone", phone)
      .like("parse_reason", like)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!error && data && data[0]) return data[0];
  } catch (e: any) {
    console.warn("[INGEST][findOrderByMsgId legacy]", e?.message || e);
  }

  return null;
}

async function existsOrderByMsgId(msgId: string) {
  if (!msgId) return null;
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id")
      .eq("msg_id", msgId)
      .limit(1);

    if (error) {
      console.warn("[INGEST][existsOrderByMsgId]", error.message);
      return null;
    }

    return data && data[0] ? data[0] : null;
  } catch (e: any) {
    console.warn("[INGEST][existsOrderByMsgId]", e?.message || e);
    return null;
  }
}

/** ───────────────── SMART ENRICH & CLARIFY ─────────────────
 *  1) enrichWithPrefs: BEFORE clarify — hydrate brand/variant
 *  2) maybeAutoSendClarify: AFTER storing — only for WABA
 *  These are small + safe. Skipped if tables/env not present.
 *  Where to call:
 *    - enrichWithPrefs → just after we know it's an ORDER (items exist),
 *      before append/new decision.
 *    - maybeAutoSendClarify → after APPEND and after NEW INSERT.
 *  ───────────────────────────────────────────────────────── */

function blank(v?: string | null) {
  return !v || !String(v).trim();
}

function itemNeedsClarify(it: any) {
  return blank(it?.brand) || blank(it?.variant);
}

async function enrichWithPrefs(
  orgId: string,
  phone: string | null,
  items: any[]
): Promise<{ items: any[]; applied: number }> {
  const out: any[] = [];
  let applied = 0;

  for (const it of items || []) {
    const base = { ...it };
    const canon = (base.canonical || base.name || "").trim();
    if (!canon) {
      out.push(base);
      continue;
    }

    let brandPref: string | null = null;
    let variantPref: string | null = null;

    // 1) per-customer pref (phone normalized w/o '+')
    if (phone) {
      const phonePlain = String(phone).replace(/^\+/, "");
      try {
        const { data: cp } = await supa
          .from("customer_prefs")
          .select("brand, variant, score")
          .eq("org_id", orgId)
          .eq("phone", phonePlain)
          .eq("canonical", canon)
          .order("score", { ascending: false })
          .limit(1);
        if (cp && cp[0]) {
          brandPref = (cp[0].brand || "").trim() || null;
          variantPref = (cp[0].variant || "").trim() || null;
        }
      } catch {}
    }

    // 2) global default (most common) if still missing
    if (!brandPref || !variantPref) {
      try {
        const { data: bvs } = await supa
          .from("brand_variant_stats")
          .select("brand, variant, score")
          .eq("org_id", orgId)
          .eq("canonical", canon)
          .order("score", { ascending: false })
          .limit(1);
        if (bvs && bvs[0]) {
          brandPref = brandPref || (bvs[0].brand || "").trim() || null;
          variantPref = variantPref || (bvs[0].variant || "").trim() || null;
        }
      } catch {}
    }

    // Apply only when missing—never override explicit inputs
    const hadBrand = (base.brand || "").trim() || null;
    const hadVar = (base.variant || "").trim() || null;
    if (!hadBrand && brandPref) {
      base.brand = brandPref;
      applied++;
    }
    if (!hadVar && variantPref) {
      base.variant = variantPref;
      applied++;
    }

    out.push(base);
  }

  return { items: out, applied };
}

// ───────────────── SMART PRODUCT ROUTER (Layer 6) ─────────────────
// Uses AI router to:
//  - resolve synonyms → canonical product
//  - attach product_id / unit / variant when safe
//  - but only when overlap with user text is strong
async function hydrateProductsWithRouter(
  orgId: string,
  items: any[]
): Promise<{ items: any[]; applied: number }> {
  const out: any[] = [];
  let applied = 0;

  for (const it of items || []) {
    const base = { ...it };

    const label = trim(base.canonical || base.name || "");
    if (!label) {
      out.push(base);
      continue;
    }

    let routed: any = null;
    try {
      routed = await routeProductText({
        org_id: orgId,
        rawName: label,
      });
    } catch (e: any) {
      console.warn("[INGEST][product_router call warn]", e?.message || e);
      out.push(base);
      continue;
    }

    if (!routed || !routed.canonical) {
      out.push(base);
      continue;
    }

    const candidateName = String(
      routed.display_name || routed.canonical || ""
    ).trim();
    if (!candidateName) {
      out.push(base);
      continue;
    }

    // Safety: only trust router if text tokens overlap strongly
    const strongOverlap = hasStrongTokenOverlap(label, candidateName);

    if (!strongOverlap) {
      // Ex: user: "paneer biryani" vs product: "chicken biryani" → reject
      out.push(base);
      continue;
    }

    // ──────────────────────────────────────
    // NEW: variant ambiguity guard
    // If multiple variants exist for this canonical and user text
    // does NOT mention any of them, DO NOT auto-pick variant/product_id.
    // ──────────────────────────────────────
    let routedProductId: string | null = routed.product_id ?? null;
    let routedVariant: string | null = routed.variant
      ? String(routed.variant)
      : null;

    if (routed.canonical && routedProductId) {
      try {
        const { data: siblings, error: siblingsErr } = await supa
          .from("products")
          .select("id, variant")
          .eq("org_id", orgId)
          .eq("canonical", routed.canonical);

        if (!siblingsErr && siblings && siblings.length) {
          const variants = new Set(
            siblings
              .map((s: any) =>
                String(s.variant || "")
                  .toLowerCase()
                  .trim()
              )
              .filter(Boolean)
          );

          if (variants.size > 1) {
            const labelLower = label.toLowerCase();
            const mentionsVariant = Array.from(variants).some(
              (v) => v && labelLower.includes(v)
            );

            // Example:
            //  - products: "regular", "boneless"
            //  - text: "mutton biriyani"
            // → variants.size = 2, mentionsVariant = false
            // → keep canonical but drop variant + product_id
            if (!mentionsVariant) {
              routedProductId = null;
              routedVariant = null;
            }
          }
        }
      } catch (e: any) {
        console.warn(
          "[INGEST][product_router variant_ambiguity warn]",
          e?.message || e
        );
      }
    }

    // Build updated item, but never destroy explicit user inputs
    const updated = { ...base };

    let changed = false;

    if (routedProductId && !updated.product_id) {
      (updated as any).product_id = routedProductId;
      changed = true;
    }

    if (!updated.canonical && routed.canonical) {
      updated.canonical = routed.canonical;
      changed = true;
    }

    if (!updated.name && routed.display_name) {
      updated.name = routed.display_name;
      changed = true;
    }

    if (!updated.unit && routed.base_unit) {
      updated.unit = routed.base_unit;
      changed = true;
    }

    if (!updated.variant && routedVariant) {
      updated.variant = routedVariant;
      changed = true;
    }

    if (changed) applied++;
    out.push(updated);
  }

  console.log("[L6][product_router] applied=", applied, {
    inCount: (items || []).length,
    outSample: out.slice(0, 3),
  });

  return { items: out, applied };
}

async function orderHasMultiVariantChoices(
  orgId: string,
  items: any[]
): Promise<boolean> {
  if (!items || !items.length) return false;

  for (const it of items) {
    const canon = (it.canonical || it.name || "").trim();
    if (!canon) continue;

    try {
      const { data, error } = await supa
        .from("products")
        .select("variant")
        .eq("org_id", orgId)
        .eq("canonical", canon);

      if (error || !data || !data.length) continue;

      const variants = new Set(
        data
          .map((p: any) =>
            String(p.variant || "")
              .toLowerCase()
              .trim()
          )
          .filter(Boolean)
      );

      // If there are 2+ variants for this item,
      // we consider this item as needing a clarify/confirm.
      if (variants.size > 1) return true;
    } catch (e: any) {
      console.warn(
        "[INGEST][clarify multi-variant check warn]",
        e?.message || e
      );
    }
  }

  return false;
}

type VariantClarifyTarget = {
  canonical: string;
  displayName: string;
  variants: string[];
};

/**
 * Find the first item in the parsed order that:
 *  - has multiple variants in catalog
 *  - but the user text does NOT clearly specify one of them
 *  - and item.variant is still empty (AI/router didn't pick safely)
 */
async function findFirstVariantClarifyTarget(
  orgId: string,
  items: any[]
): Promise<VariantClarifyTarget | null> {
  if (!items || !items.length) return null;

  for (const it of items) {
    const rawName = (it.canonical || it.name || "").trim();
    if (!rawName) continue;

    // If variant already chosen (by user, prefs, or router), skip
    const existingVariant = (it.variant || "").toString().trim();
    if (existingVariant) continue;

    try {
      const { data, error } = await supa
        .from("products")
        .select("display_name, variant, canonical")
        .eq("org_id", orgId)
        .eq("canonical", rawName);

      if (error || !data || !data.length) continue;

      const variants = Array.from(
        new Set(
          data
            .map((p: any) =>
              String(p.variant || "")
                .toLowerCase()
                .trim()
            )
            .filter(Boolean)
        )
      );

      // Only care if there are 2+ variants
      if (variants.length <= 1) continue;

      // If the user's text ALREADY clearly includes one of the variant names,
      // we don't ask again.
      const label = normalizeNameForMatch(rawName);
      const labelLower = label.toLowerCase();

      const mentionsVariant = variants.some((v) => v && labelLower.includes(v));
      if (mentionsVariant) continue;

      const displayName = (data.find((p: any) => p.display_name)
        ?.display_name || rawName) as string;

      return {
        canonical: rawName,
        displayName,
        variants,
      };
    } catch (e: any) {
      console.warn("[INGEST][variant_clarify warn]", e?.message || e);
    }
  }

  return null;
}

async function maybeAutoSendClarify(
  orgId: string,
  orderId: string,
  source: IngestSource
) {
  try {
    if (String(source) !== "waba") return;

    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    try {
      const { data: already } = await supa
        .from("outbound_logs")
        .select("id")
        .eq("org_id", orgId)
        .eq("order_id", orderId)
        .eq("kind", "clarify_bundle")
        .gte("created_at", fifteenMinAgo)
        .limit(1);
      if (already && already[0]) return;
    } catch {}

    const { data: order } = await supa
      .from("orders")
      .select("id, items, source_phone, customer_name, status, created_at")
      .eq("org_id", orgId)
      .eq("id", orderId)
      .single();

    if (!order || !Array.isArray(order.items)) return;
    if (!order.source_phone) return;

    // 🔴 NEW:
    // 1) if any item is missing brand/variant → clarify
    // 2) OR if any item has multiple variants in catalog → clarify/confirm
    const missingBrandOrVariant = order.items.some(itemNeedsClarify);
    const hasMultiVariants = await orderHasMultiVariantChoices(
      orgId,
      order.items
    );

    if (!missingBrandOrVariant && !hasMultiVariants) {
      // nothing to clarify for this order
      return;
    }

    // Build clarify text using existing endpoint
    if (!process.env.BASE_URL || !process.env.INTERNAL_JWT) return;
    const resp = await fetch(
      `${process.env.BASE_URL}/api/orders/${orderId}/clarify-prompt`,
      { headers: { Authorization: `Bearer ${process.env.INTERNAL_JWT}` } }
    ).catch(() => null as any);

    const data = await resp?.json().catch(() => null as any);
    if (!data?.ok || !data?.text) return;

    await supa.from("outbound_logs").insert({
      org_id: orgId,
      order_id: orderId,
      kind: "clarify_bundle",
      payload: { text: data.text, phone: order.source_phone },
    });
  } catch (e: any) {
    console.warn("[INGEST][autosend clarify] skipped:", e?.message || e);
  }
}

/** ───────────────── Parser pipeline ───────────────── **/

type ParsedPipeline = {
  used: "ai" | "rules";
  items: any[];
  confidence?: number;
  reason: string;
  is_order_like?: boolean;
};

async function parsePipeline(
  text: string,
  opts?: { org_id?: string; customer_phone?: string }
): Promise<ParsedPipeline> {
  const hasKey = !!process.env.OPENAI_API_KEY;
  const hasFn = typeof aiParseOrder === "function";
  const useAI = !!(hasFn && hasKey);

  console.log("[INGEST][AI gate]", {
    hasFn,
    hasKey,
    useAI,
    model: process.env.AI_MODEL,
    org_id: opts?.org_id || null,
    customer_phone: opts?.customer_phone || null,
  });

  if (useAI) {
    try {
      console.log("[INGEST][AI call] invoking aiParseOrder…");
      const ai = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(
        String(text),
        undefined,
        {
          org_id: opts?.org_id,
          customer_phone: opts?.customer_phone,
        }
      );

      const reason = ai?.reason || null;
      const itemCount = Array.isArray(ai?.items) ? ai.items.length : 0;

      console.log(
        `[AI used] ${
          process.env.AI_MODEL || "ai"
        } items: ${itemCount} reason: ${reason || "—"}`
      );
      console.log("[INGEST][AI result]", {
        is_order_like: ai?.is_order_like,
        items: itemCount,
        reason,
      });

      return {
        used: "ai",
        items: ai?.items || [],
        confidence:
          typeof ai?.confidence === "number" ? ai.confidence : undefined,
        reason: reason || (ai?.is_order_like === false ? "ai_not_order" : "ai"),
        is_order_like: ai?.is_order_like,
      };
    } catch (e: any) {
      console.warn(
        "[INGEST] AI parse failed, falling back to rules:",
        e?.message || e
      );
    }
  } else {
    console.log(
      "[INGEST][AI skip] useAI=false (hasFn=%s, hasKey=%s)",
      hasFn,
      hasKey
    );
  }

  const items = parseOrder(String(text)) || [];
  console.log("[INGEST][RULES] items:", items?.length || 0);
  return {
    used: "rules",
    items,
    confidence: undefined,
    reason: "rule_fallback",
    is_order_like: items.length > 0,
  };
}

async function upsertConversationAndInboundMessage(opts: {
  orgId: string;
  phoneNorm: string | null;
  customerName: string | null;
  source: IngestSource;
  text: string;
  msg_id?: string | null;
  raw?: any;
}) {
  try {
    // Without a phone we can't key a conversation reliably
    if (!opts.phoneNorm) {
      return;
    }

    // 1) Upsert conversation (one per org + phone)
    const { data: conv, error: convErr } = await supa
      .from("conversations")
      .upsert(
        {
          org_id: opts.orgId,
          customer_phone: opts.phoneNorm,
          customer_name: opts.customerName,
          source: opts.source,
          last_message_at: new Date().toISOString(),
          last_message_preview: opts.text.slice(0, 120),
        },
        { onConflict: "org_id,customer_phone" }
      )
      .select("id")
      .single();

    if (convErr || !conv) {
      console.warn("[INBOX][CONV upsert err]", convErr?.message);
      return;
    }

    // 2) Insert inbound message
    const { error: msgErr } = await supa.from("messages").insert({
      org_id: opts.orgId,
      conversation_id: conv.id,
      direction: "in",
      sender_type: "customer",
      channel: opts.source, // 'waba' | 'local_bridge' | ...
      body: opts.text,
      wa_msg_id: opts.msg_id || null,
      raw: opts.raw || null,
    });

    if (msgErr) {
      console.warn("[INBOX][MSG in err]", msgErr.message);
    }
  } catch (e: any) {
    console.warn("[INBOX][inbound err]", e?.message || e);
  }
}

/** ───────────────── CORE INGEST FUNCTION ───────────────── **/

/**
 * Core pipeline used by:
 *  - /api/ingest/local   (Android notification bridge)
 *  - /api/ingest/waba    (Meta Cloud API)
 *
 * Caller:
 *  1. Resolves org_id (e.g. from org_phone / WABA phone).
 *  2. Passes message payload into ingestCoreFromMessage.
 *  3. Uses returned IngestResult for HTTP response / UI.
 */

export async function ingestCoreFromMessage(
  input: IngestInput
): Promise<IngestResult> {
  console.log(
    `[INGEST-CORE] ← source=${input.source || "unknown"} org=${
      input.org_id
    } phone=${input.from_phone || "-"}`
  );
  try {
    const orgId = trim(input.org_id);
    const textRaw = trim(input.text);
    const ts = Number.isFinite(input.ts as any)
      ? (input.ts as number)
      : Date.now();
    const msg_id = trim(input.msg_id || "");
    const edited_at = Number(input.edited_at || 0) || 0;
    const from_name = trim(input.from_name || "");
    const from_phone_raw = trim(input.from_phone || "");
    const source = input.source || "other";
    const activeOrderId = trim(input.active_order_id || "");

    if (!orgId || !textRaw) {
      return {
        ok: false,
        stored: false,
        kind: "none",
        error: "org_id_and_text_required",
        reason: "org_id_and_text_required",
      };
    }

    // 1) Line normalization and shape detection
    const rawLines0 = splitAndCleanLines(textRaw);
    console.log("[INGEST][core][dbg] rawLines0=", rawLines0);

    const listLines = rawLines0.filter((s) => {
      if (!s) return false;
      const t = s.trim().toLowerCase();
      if (!t) return false;
      if (
        /^(hi|hello|hey|hlo|ok|okay|k|thanks|thank you|thanx|thx|sorry)$/.test(
          t
        )
      )
        return false;
      if (/^(gm|gn|good (morning|evening|night|afternoon))$/.test(t))
        return false;
      return true;
    });

    const hasListShape = listLines.length >= 2;

    console.log(
      "[INGEST][core][dbg] listLines.len=",
      listLines.length,
      "listLines=",
      listLines
    );
    console.log("[INGEST][core][dbg] hasListShape=%s", hasListShape);

    const textFlat = rawLines0.join(" ") || textRaw;

    // 2) Normalize phone + customer name
    let phoneNorm = normPhone(from_phone_raw);

    let customerName: string | null = phoneNorm
      ? from_name || null
      : from_name || null;

    if (!phoneNorm && customerName) {
      const since = new Date(
        Date.now() - 14 * 24 * 60 * 60 * 1000
      ).toISOString();
      const { data: prev, error } = await supa
        .from("orders")
        .select("source_phone")
        .eq("org_id", orgId)
        .ilike("customer_name", customerName)
        .gte("created_at", since)
        .not("source_phone", "is", null)
        .limit(25);
      if (!error) {
        const uniq = Array.from(
          new Set(
            (prev || [])
              .map((r) => (r.source_phone || "").trim())
              .filter(Boolean)
          )
        );
        phoneNorm = uniq.length === 1 ? normPhone(uniq[0]) : null;
      }
    }

    console.log("[INGEST][core][phone]", {
      source,
      from_name,
      from_phone_raw,
      phoneNorm,
      customerName,
      msg_id: msg_id || undefined,
      edited_at: edited_at || undefined,
    });

    // 🔑 Session key = digits-only phone (no "+")
    const phoneKey = phoneNorm ? String(phoneNorm).replace(/^\+/, "") : null;

    // 3) Fast gates
    if (isLikelyPromoOrSpam(textFlat)) {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: "none",
        reason: "dropped:promo_spam",
      };
    }

    if (!hasListShape && isPureGreetingOrAck(textFlat)) {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: "none",
        reason: "greeting_ack",
        // ⬇️ WABA: if result.reply exists, send it back as a text message
        reply: "Good morning 👋 How can I help you with your order today?",
      };
    }

    // ─────────────────────────────────────────
    // LAYER 1: NLU ROUTER (INTENT FIRST)
    // ─────────────────────────────────────────
    let nlu: CoreNluResult | null = null;

    try {
      nlu = await classifyMessage(textRaw);
      console.log("[NLU]", nlu);
    } catch (e) {
      console.warn("[NLU error]", e);
    }

    // SAFETY: default
    nlu = nlu || { intent: "other", confidence: 0, canonical: null };

    // ─────────────────────────────
    // 1) GREETING → no order
    // ─────────────────────────────
    if (nlu.intent === "greeting") {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: "none",
        reason: "nlu:greeting",
        reply: "Hi 👋 How can I help you with your order today?",
      };
    }

    // ─────────────────────────────
    // 2) SMALLTALK → ignore
    // ─────────────────────────────
    if (nlu.intent === "smalltalk") {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: "none",
        reason: "small_talk_or_non_order",
      };
    }

    // ─────────────────────────────
    // 3) COMPLAINT (store as none)
    // ─────────────────────────────
    if (nlu.intent === "complaint") {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: "none",
        reason: "nlu:complaint",
      };
    }

    // ─────────────────────────────
    // 4) MENU INQUIRY
    // ─────────────────────────────
    if (nlu.intent === "menu_inquiry") {
      if (phoneKey) {
        await markSessionOnInquiry({
          org_id: orgId,
          phone_key: phoneKey,
          kind: "availability",
          canonical: "menu",
          text: textRaw,
          status: "pending",
        });
      }

      return {
        ok: true,
        stored: false,
        kind: "inquiry",
        used: "inquiry",
        inquiry: "availability",
        inquiry_type: "availability",
        inquiry_canonical: "menu",
        reply: "Here is the menu 👇\n(Your business can auto-fill this)",
        reason: "nlu:menu_inquiry",
      };
    }

    // ─────────────────────────────
    // 5) PRICE INQUIRY
    // ─────────────────────────────
    if (nlu.intent === "price_inquiry") {
      if (phoneKey) {
        await markSessionOnInquiry({
          org_id: orgId,
          phone_key: phoneKey,
          kind: "price",
          canonical: nlu.canonical || textRaw,
          text: textRaw,
          status: "pending",
        });
      }

      return {
        ok: true,
        stored: false,
        kind: "inquiry",
        used: "inquiry",
        inquiry: "price",
        inquiry_type: "price",
        inquiry_canonical: nlu.canonical || "",
        reply: "Let me check the price…",
        reason: "nlu:price_inquiry",
      };
    }

    // 6) AVAILABILITY INQUIRY
    if (nlu.intent === "availability_inquiry") {
      if (phoneKey) {
        await markSessionOnInquiry({
          org_id: orgId,
          phone_key: phoneKey,
          kind: "availability",
          canonical: nlu.canonical || textRaw,
          text: textRaw,
          status: "pending",
        });
      }

      // ⛔ DO NOT return here.
      // Let the rest of the pipeline run:
      // - detectInquiry()
      // - findBestProductForTextV2()
      // - smart reply:
      //   "I couldn’t find X... We do have: 1) ... 2) ..."
    }

    // ─────────────────────────────
    // 6b) ADDRESS UPDATE (handle in WABA, not as order)
    // ─────────────────────────────
    if (nlu.intent === "address_update") {
      // We DON'T create/append any order here.
      // WABA will see this and update the address on the last open order / customer profile.
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: "none",
        reason: "nlu:address_update",
      };
    }

    // ─────────────────────────────
    // 6c) ORDER CORRECTION / MODIFIER (Option C)
    // ─────────────────────────────
    if (nlu.intent === "order_correction" || nlu.intent === "modifier") {
      // Example texts:
      //  - "make biriyani spicy"
      //  - "only boneless"
      //  - "remove coke"
      //
      // We don't touch DB here. Just snapshot the modifier in session
      // so UI + WABA can see “customer sent a change request”.
      if (phoneKey) {
        await markSessionOnModifier({
          org_id: orgId,
          phone_key: phoneKey,
          modifier: {
            text: textRaw,
            intent: nlu.intent,
            ts,
          },
        });
      }

      return {
        ok: true,
        stored: false,
        kind: "modifier",
        used: "none",
        reason: `nlu:${nlu.intent}`,
      };
    }

    // ─────────────────────────────
    // 7) ORDER INTENT → continue to AI/rule pipeline
    // ─────────────────────────────
    if (nlu.intent === "order") {
      console.log("[NLU] intent=order → continue with parse pipeline");
    }

    // [INBOX] Record inbound message for unified view
    await upsertConversationAndInboundMessage({
      orgId,
      phoneNorm,
      customerName,
      source,
      text: textRaw,
      msg_id,
      raw: { source, ts },
    });

    // Use AI + rules parser pipeline directly
    let parsed = await parsePipeline(textRaw, {
      org_id: orgId,
      customer_phone: phoneNorm || undefined,
    });

    // 5) Multi-line list preference: if it looks like a list, prefer deterministic parsing
    if (hasListShape) {
      const lineItems = buildLineItemsFromList(listLines);
      if (lineItems.length >= 1) {
        parsed = {
          used: "rules",
          items: lineItems,
          confidence: 1,
          reason: "list_lines_preferred",
          is_order_like: true,
        };
        console.log("[INGEST][core][list_preferred]", {
          lines: listLines.length,
          items: lineItems.length,
        });
      }
    }

    // 5b) Single-line qty fallback
    if (!parsed.items || parsed.items.length === 0) {
      const fbItems = fallbackQtyItems(textFlat);
      if (fbItems.length) {
        parsed = {
          ...parsed,
          used: parsed.used || "rules",
          items: fbItems,
          is_order_like: true,
          reason: ((parsed.reason || "") + "; fallback_qty_parse").trim(),
        };
        console.log("[INGEST][core][fallback_qty]", {
          items: fbItems.length,
          text: textFlat,
        });
      }
    }

    // 6) Late small-talk gate (only when items still empty)
    if (!hasListShape && (!parsed.items || parsed.items.length === 0)) {
      if (parsed.is_order_like === false) {
        // let inquiry detection run next
      } else if (await isNotOrderMessage(textFlat, orgId)) {
        console.log(
          "[INGEST][core] skipped small-talk/non-order (late gate):",
          textFlat
        );
        return {
          ok: true,
          stored: false,
          kind: "none",
          used: parsed.used,
          reason: "small_talk_or_non_order",
        };
      }
    }

    // Let AI hint that this is an inquiry even if our regex misses slang
    const aiTaggedInquiry =
      typeof parsed.reason === "string" &&
      /^inq:/.test(parsed.reason.toLowerCase());

    // Only treat as "inquiry" when the text clearly looks like a question
    // (we now support both "do you have" and "do u have"/"hv", etc.)
    const looksLikeQuestion =
      /(\?|do you have|do u have|have stock|in stock|available|availability|price|rate|how much|stock)/i.test(
        textFlat
      ) ||
      /\b(can i get|can i have|is there|you have|u have)\b/i.test(textFlat);

    // 🔍 Diagnostic log — extremely helpful
    console.log("[INGEST][core][inquiry-guard-check]", {
      text: textFlat,
      parsedItems: parsed.items?.length || 0,
      hasListShape,
      looksLikeQuestion,
      aiTaggedInquiry,
      parsedReason: parsed.reason,
    });

    if (
      (!parsed.items || parsed.items.length === 0) &&
      !hasListShape &&
      (looksLikeQuestion || aiTaggedInquiry)
    ) {
      console.log("[INGEST][core] → considering inquiry detection");

      // Small helper type for what detectInquiry returns
      type DetectedInquiry = {
        kind: InquiryKind; // "availability" | "price" | etc.
        canonical: string;
        confidence?: number;
      };

      let detected: DetectedInquiry | null = null;

      // 1️⃣ Try to derive inquiry directly from AI reason, e.g.
      //    "inq:availability:Paneer Biryani" or "inq:price:onion"
      if (
        typeof parsed.reason === "string" &&
        /^inq:/.test(parsed.reason.toLowerCase())
      ) {
        const m =
          /^inq:(price|availability)(?::(.+))?/i.exec(parsed.reason) || null;
        if (m) {
          const kind = m[1].toLowerCase() as InquiryKind;
          const canonical = (m[2] || "").trim() || textFlat;
          detected = { kind, canonical, confidence: 0.9 };
          console.log("[INGEST][core][inquiry-from-ai-reason]", detected);
        }
      }

      // 2️⃣ Fallback to regex-based detector if AI did not give us a clean hint
      if (!detected) {
        const d = detectInquiry(textFlat) as any;
        if (d && d.kind && d.canonical) {
          detected = {
            kind: d.kind as InquiryKind,
            canonical: d.canonical,
            confidence: d.confidence,
          };
        }
      }

      console.log("[INGEST][core][detectInquiry]", detected);

      if (detected) {
        // allow storing product_id + canonical on the result
        const base: IngestResult & {
          inquiry_product_id?: string;
          canonical?: string;
        } = {
          ok: true,
          kind: "inquiry",
          used: "inquiry",
          stored: false,
          order_id: undefined,

          inquiry: detected.kind, // InquiryKind
          inquiry_type: detected.kind,
          inquiry_canonical: detected.canonical,
        };

        let matched: any = null;
        try {
          matched = await findBestProductForTextV2(orgId, detected.canonical);
          console.log("[INGEST][core][inquiry-match-success]", matched);
        } catch (e: any) {
          console.log("[INGEST][core][inquiry-match-error]", e?.message || e);
        }

        if (matched) {
          const candidateName = String(
            matched.display_name || matched.canonical || ""
          ).trim();

          const queryName = String(detected.canonical || "").trim();

          const strongEnough = hasStrongTokenOverlap(queryName, candidateName);

          console.log("[INGEST][core][inquiry-match-overlap]", {
            queryName,
            candidateName,
            strongEnough,
          });

          if (strongEnough) {
            // 💡 final canonical we want to show/learn
            const finalCanonical =
              candidateName || detected.canonical || queryName;

            // update base with canonical + product_id
            base.inquiry_canonical = finalCanonical;
            base.canonical = finalCanonical;
            if (matched.id) {
              (base as any).inquiry_product_id = matched.id;
            }

            if (phoneKey) {
              await markSessionOnInquiry({
                org_id: orgId,
                phone_key: phoneKey,
                kind: detected.kind,
                canonical: finalCanonical,
                text: textRaw,
                status: "answered",
              });
            }

            return {
              ...base,
              reply: formatInquiryReply(matched, detected.kind),
              reason: "inquiry_detected",
            };
          }

          // fall through to no-match below
        }

        // ❌ no safe match → keep original canonical, mark pending
        if (phoneKey) {
          await markSessionOnInquiry({
            org_id: orgId,
            phone_key: phoneKey,
            kind: detected.kind,
            canonical: detected.canonical,
            text: textRaw,
            status: "pending",
          });
        }

        return {
          ...base,
          reply: `I could not find "${detected.canonical}". Please send exact product name.`,
          reason: "inquiry_no_match",
        };
      }
    }

    // 🔴 NEW: if AI explicitly said "not order / ambiguous" and we still
    // have no items, treat this as a soft availability inquiry instead of "none".
    const aiAmbiguousNotOrder =
      parsed.is_order_like === false &&
      typeof parsed.reason === "string" &&
      parsed.reason.toLowerCase().startsWith("ai:not_order:");

    if (
      (!parsed.items || parsed.items.length === 0) &&
      !hasListShape &&
      aiAmbiguousNotOrder
    ) {
      const canonical = (nlu.canonical || textFlat).trim();

      console.log(
        "[INGEST][core] ai:not_order:ambiguous → treating as availability inquiry",
        { canonical }
      );

      return {
        ok: true,
        stored: false,
        kind: "inquiry",
        used: "inquiry",
        inquiry: "availability",
        inquiry_type: "availability",
        inquiry_canonical: canonical,
        reply: "Let me check availability…",
        reason: "inquiry_from_ai_not_order",
      };
    }

    // 8) ORDER path starts here

    // ⬇️ NEW: BEFORE anything, hydrate brand/variant from prefs (auto-learned)
    // WHY: If we can resolve brand/variant, we want to avoid sending clarify at all.
    try {
      const { items: hydrated, applied } = await enrichWithPrefs(
        orgId,
        phoneNorm,
        parsed.items || []
      );
      if (applied > 0) {
        parsed.items = hydrated;
        parsed.reason = ((parsed.reason || "") + "; prefs_hydrated").trim();
      }
    } catch (e: any) {
      console.warn("[INGEST][prefs_enrich warn]", e?.message || e);
    }

    // ⬇️ LAYER 6: product router (synonyms / aliases → canonical product)
    try {
      const { items: routedItems, applied: prodApplied } =
        await hydrateProductsWithRouter(orgId, parsed.items || []);
      if (prodApplied > 0) {
        parsed.items = routedItems;
        parsed.reason = ((parsed.reason || "") + "; product_routed").trim();
      }
    } catch (e: any) {
      console.warn("[INGEST][product_router warn]", e?.message || e);
    }

    // ⛑ SAFETY NET:
    // If, after AI + rules + list fallback + qty fallback + prefs enrich,
    // we STILL have no items, do NOT create or update an order.
    if (!parsed.items || parsed.items.length === 0) {
      console.log(
        "[INGEST][core] no items after parse + enrich; treating as none",
        {
          reason: parsed.reason || "—",
          text: textFlat,
        }
      );

      return {
        ok: true,
        stored: false,
        kind: "none",
        used: parsed.used,
        reason: `no_items_after_parse:${parsed.reason || ""}`.trim(),
      };
    }

    // ─────────────────────────────────────────
    // LAYER 2: catalog sanity + "unmatched-only" guard
    // ─────────────────────────────────────────
    try {
      const check = await validateItemsAgainstCatalog(orgId, parsed.items);
      if (check) {
        const matched = check.matched || [];
        const unmatched = check.unmatched || [];

        // 📌 CASE A: ALL items are unmatched
        if (!matched.length && unmatched.length) {
          const missingNames = unmatched
            .map((it) => normalizeNameForMatch(it.name || it.canonical || ""))
            .filter(Boolean);

          const tag = "catalog_unmatched_only:" + missingNames.join("|");

          console.log("[INGEST][core][catalog_unmatched_only]", {
            orgId,
            missingNames,
          });

          // Try to build a smart clarify reply instead of placing a bad order
          const firstLabel =
            normalizeNameForMatch(
              unmatched[0].canonical || unmatched[0].name || ""
            ) ||
            missingNames[0] ||
            textFlat;

          let replyText = `I couldn’t find "${firstLabel}" exactly in today’s menu.`;

          try {
            // Use your matcher to find the best product and its siblings (variants)
            const best = await findBestProductForTextV2(orgId, firstLabel);
            if (best && (best.canonical || best.display_name)) {
              const canonical = (best.canonical || "").trim();
              const { data: siblings, error: siblingsErr } = await supa
                .from("products")
                .select("display_name, variant")
                .eq("org_id", orgId)
                .eq("canonical", canonical);

              if (!siblingsErr && siblings && siblings.length) {
                const uniqueNames = Array.from(
                  new Set(
                    siblings
                      .map(
                        (s: any) =>
                          String(s.display_name || "").trim() ||
                          String(s.variant || "").trim()
                      )
                      .filter(Boolean)
                  )
                );

                if (uniqueNames.length) {
                  replyText += "\nWe do have:\n";
                  replyText += uniqueNames
                    .map((n, idx) => `${idx + 1}) ${n}`)
                    .join("\n");
                  replyText +=
                    "\n\nPlease reply with the option number or exact name.";
                } else {
                  replyText +=
                    "\nPlease send the exact item name as shown in the menu.";
                }
              } else {
                replyText +=
                  "\nPlease send the exact item name as shown in the menu.";
              }
            } else {
              replyText +=
                "\nPlease send the exact item name as shown in the menu.";
            }
          } catch (e: any) {
            console.warn(
              "[INGEST][core][catalog_unmatched_only clarify warn]",
              e?.message || e
            );
            // fallback: simple message
            replyText +=
              "\nPlease send the exact item name as shown in the menu.";
          }

          // ❌ Do NOT create / append an order here.
          // Treat this as an availability-style inquiry needing clarification.
          if (phoneKey) {
            await markSessionOnInquiry({
              org_id: orgId,
              phone_key: phoneKey,
              kind: "availability",
              canonical: firstLabel,
              text: textRaw,
              status: "pending",
            });
          }

          return {
            ok: true,
            stored: false,
            kind: "inquiry",
            used: "inquiry",
            inquiry: "availability",
            inquiry_type: "availability",
            inquiry_canonical: firstLabel,
            reply: replyText,
            reason: (parsed.reason
              ? `${parsed.reason}; ${tag}`
              : tag) as string,
          };
        }

        // 📌 CASE B: Some matched, some unmatched → keep only matched in order
        if (matched.length) {
          parsed.items = matched;
        }

        // Tag the unmatched ones so WABA can still show a warning if needed
        if (unmatched.length) {
          const missingNames = unmatched
            .map((it) => normalizeNameForMatch(it.canonical || it.name || ""))
            .filter(Boolean);

          if (missingNames.length) {
            const tag = `catalog_unmatched:${missingNames.join("|")}`;
            parsed.reason = parsed.reason ? `${parsed.reason}; ${tag}` : tag;

            console.log("[INGEST][core][catalog_unmatched]", {
              orgId,
              missingNames,
            });
          }
        }
      }
    } catch (e: any) {
      console.warn("[INGEST][core][catalog_tag warn]", e?.message || e);
    }

    // ─────────────────────────────────────────
    // LAYER 6b: Inline VARIANT CLARIFY (pre-order)
    // If there are multiple variants in catalog for an item, and
    // user text does not clearly pick one → ask "Which variant?"
    // instead of blindly placing an order.
    // ─────────────────────────────────────────
    // ─────────────────────────────────────────
    // LAYER 6b: Inline VARIANT CLARIFY (pre-order)
    // ─────────────────────────────────────────
    try {
      const clarifyTarget = await findFirstVariantClarifyTarget(
        orgId,
        parsed.items || []
      );

      if (
        clarifyTarget &&
        parsed.items.length === 1 &&                       // Single item only
        !hasListShape &&                                  // Not multi-line list
        !/\band\b/i.test(textFlat) &&                     // No "and" multiple items
        !/\b(\d+|\d+\s*(kg|g|l|ml|pcs|packs))\b/i.test(textFlat) && // Not explicit ordered qties
        (looksLikeQuestion || nlu.intent !== "order")     // Only questions, not orders
      ) {
        const niceName = clarifyTarget.displayName || clarifyTarget.canonical;
        const prettyVariants = clarifyTarget.variants
          .map((v) =>
            v
              .split(" ")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
              .join(" ")
          )
          .join(" / ");

        const replyText = `Which ${niceName} – ${prettyVariants}?`;

        console.log("[INGEST][core][variant_clarify]", {
          canonical: clarifyTarget.canonical,
          variants: clarifyTarget.variants,
        });

        // 🔥 FIX: VARIANT CLARIFY IS NOT AN INQUIRY
        return {
          ok: true,
          stored: false,
          kind: "inquiry", // ✅ allowed by IngestResult
          used: "inquiry", // ✅ allowed by IngestResult
          inquiry: "availability",
          inquiry_type: "availability",
          inquiry_canonical: clarifyTarget.canonical,
          reply: replyText,
          reason: "variant_clarify",
        };
      }
    } catch (e: any) {
      console.warn(
        "[INGEST][core][variant_clarify block warn]",
        e?.message || e
      );
    }

    // Ignore seller-style money messages (heuristic)
    if (/\b(aed|dirham|dh|dhs|price|₹|rs|\$)\b/i.test(textFlat)) {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: parsed.used,
        reason: "seller_money_message",
      };
    }

    // If there is a recent inquiry and this isn't explicit confirmation, don't auto-place
    const recentInq = await findRecentInquiry(
      orgId,
      phoneNorm,
      INQUIRY_WINDOW_MIN
    );
    const looksConfirm =
      /\b(ok|okay|yes|confirm|place|book|send|need|take|buy)\b/i.test(
        textFlat
      ) ||
      /\b(\d+(\.\d+)?)\s?(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)\b/i.test(
        textFlat
      );

    if (recentInq && !looksConfirm) {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: parsed.used,
        reason: "awaiting_explicit_confirmation",
      };
    }

    console.log("[INGEST][core] parsed order", {
      used: parsed.used,
      items: parsed.items.length,
      reason: parsed.reason || "—",
    });

    // EDIT handling (must run BEFORE append/new decision)
    const EDIT_WINDOW_MIN = 15;
    if (msg_id && phoneNorm && edited_at) {
      const target = await findOrderByMsgId(orgId, phoneNorm, msg_id);
      if (target && target.id) {
        const tCreated = new Date(target.created_at);
        const ageMin = (Date.now() - tCreated.getTime()) / 60000;
        if (ageMin <= EDIT_WINDOW_MIN) {
          const { error: upE } = await supa
            .from("orders")
            .update({
              items: parsed.items,
              parse_reason:
                (parsed.reason || "edited_replace") +
                `; msgid:${msg_id}; edited_at:${edited_at}`,
              parse_confidence: parsed.confidence ?? null,
              msg_id: msg_id,
            })
            .eq("id", target.id)
            .eq("org_id", orgId);
          if (upE) throw upE;

          // learning writes (non-fatal)
          try {
            for (const it of parsed.items) {
              const canon = trim(it.canonical || it.name || "");
              if (!canon) continue;
              const brand = (it.brand ?? "") + "";
              const variant = (it.variant ?? "") + "";
              const { error: eb } = await supa.rpc("upsert_bvs", {
                p_org_id: orgId,
                p_canonical: canon,
                p_brand: brand,
                p_variant: variant,
                p_inc: 1,
              });
              if (eb) console.warn("[INGEST][core][bvs err]", eb.message);
              if (phoneNorm) {
                const { error: ec } = await supa.rpc("upsert_customer_pref", {
                  p_org_id: orgId,
                  p_phone: phoneNorm,
                  p_canonical: canon,
                  p_brand: brand,
                  p_variant: variant,
                  p_inc: 1,
                });
                if (ec)
                  console.warn("[INGEST][core][custpref err]", ec.message);
              }
            }
          } catch (e: any) {
            console.warn("[INGEST][core][edit learn warn]", e?.message || e);
          }

          console.log(
            "[INGEST][core] edit -> replaced items in order",
            target.id
          );
          return {
            ok: true,
            stored: true,
            kind: "order",
            used: parsed.used,
            edited_order_id: target.id,
            order_id: target.id,
            items: parsed.items,
            org_id: orgId,
            reason: "edited_replace",
          };
        }
      }
    }

    // ─────────────────────────────────────────────────────────
    // Forced append when caller passes active_order_id
    // (e.g., WABA knows there is an active pending order)
    // ─────────────────────────────────────────────────────────
    if (activeOrderId) {
      try {
        const { data: target, error: tgtErr } = await supa
          .from("orders")
          .select("id, items, status, source_phone")
          .eq("org_id", orgId)
          .eq("id", activeOrderId)
          .single();

        if (!tgtErr && target && target.id) {
          const status = String(target.status || "").toLowerCase();

          // Only append if it is still "open" and belongs to same phone
          const phonePlain = String(phoneNorm || "").replace(/^\+/, "");
          const srcPhone = String(target.source_phone || "");
          const matchesPhone =
            !phonePlain ||
            srcPhone === phonePlain ||
            srcPhone === "+" + phonePlain;

          const isOpen = ![
            "cancelled_by_customer",
            "archived_for_new",
            "paid",
            "shipped",
          ].includes(status);

          if (matchesPhone && isOpen) {
            const prevItems = Array.isArray(target.items) ? target.items : [];
            const newItems = [...prevItems, ...(parsed.items || [])];

            const { error: upErr } = await supa
              .from("orders")
              .update({
                items: newItems,
                parse_reason:
                  (parsed.reason ?? "forced_append_active_order") +
                  (msg_id ? `; msgid:${msg_id}` : ""),
                parse_confidence: parsed.confidence ?? null,
                ...(msg_id ? { msg_id } : {}),
                order_link_reason: "forced_append_active_order",
              })
              .eq("id", target.id);

            if (upErr) throw upErr;

            // learning writes (same as append path)
            try {
              for (const it of parsed.items) {
                const canon = trim(it.canonical || it.name || "");
                if (!canon) continue;
                const brand = (it.brand ?? "") + "";
                const variant = (it.variant ?? "") + "";
                const { error: eb } = await supa.rpc("upsert_bvs", {
                  p_org_id: orgId,
                  p_canonical: canon,
                  p_brand: brand,
                  p_variant: variant,
                  p_inc: 1,
                });
                if (eb) console.warn("[INGEST][core][bvs err]", eb.message);
                if (phoneNorm) {
                  const { error: ec } = await supa.rpc("upsert_customer_pref", {
                    p_org_id: orgId,
                    p_phone: phoneNorm,
                    p_canonical: canon,
                    p_brand: brand,
                    p_variant: variant,
                    p_inc: 1,
                  });
                  if (ec)
                    console.warn("[INGEST][core][custpref err]", ec.message);
                }
              }
            } catch (e: any) {
              console.warn(
                "[INGEST][core][forced_append learn warn]",
                e?.message || e
              );
            }

            // Auto-clarify if needed (WABA-only)
            await maybeAutoSendClarify(orgId, target.id, source);

            console.log(
              "[INGEST][core] forced append into active_order_id",
              target.id
            );

            if (phoneKey) {
              await markSessionOnAppendOrder({
                org_id: orgId,
                phone_key: phoneKey,
                order_id: target.id,
                status,
              });
            }

            return {
              ok: true,
              stored: true,
              kind: "order",
              used: parsed.used,
              merged_into: target.id,
              order_id: target.id,
              items: newItems,
              org_id: orgId,
              reason: "forced_append_active_order",
            };
          }
        }
      } catch (e: any) {
        console.warn("[INGEST][core][forced_append warn]", e?.message || e);
        // if anything fails, we simply fall through to normal append/new logic
      }
    }

    // ─────────────────────────────────────────────────────────
    // LAYER B: Session Engine decision (append vs new)
    // ─────────────────────────────────────────────────────────

    let sessionAction: "start_new_order" | "append_items" = "start_new_order";
    let sessionTargetOrderId: string | null = null;
    let sessionReason: string | null = null;

    if (phoneKey) {
      // Build minimal NLU + parsed payload for the session engine
      const sessionNlu: SessionNluResult | null = nlu
        ? {
            intent: mapToSessionIntent(nlu.intent as any),
            canonical: (nlu.canonical ?? null) as string | null,
            confidence: typeof nlu.confidence === "number" ? nlu.confidence : 0,
          }
        : null;

      const sessionParsed: SessionParsedMessage = {
        kind: "order",
        items: parsed.items || [],
        inquiryKind: null,
        canonical: null,
        reason: parsed.reason ?? null,
        raw: null,
      };

      const sessionDecision = await decideSessionNextStep({
        org_id: orgId,
        phone_key: phoneKey,
        text: textFlat,
        nlu: sessionNlu,
        parsed: sessionParsed,
      });

      console.log("[INGEST][sessionDecision]", sessionDecision);

      // If session engine says this is not an order action, do nothing safely
      if (
        sessionDecision.action !== "start_new_order" &&
        sessionDecision.action !== "append_items"
      ) {
        return {
          ok: true,
          stored: false,
          kind: "none",
          used: parsed.used,
          reason: `session_${sessionDecision.action}`,
        };
      }

      sessionAction = sessionDecision.action;
      sessionTargetOrderId = sessionDecision.targetOrderId || null;
      sessionReason = sessionDecision.reason || null;
    } else {
      // No phone → no session tracking; default to NEW order
      sessionAction = "start_new_order";
      sessionTargetOrderId = null;
      sessionReason = "no_phone_key_session_default_new";
    }

    // ─────────────────────────────────────────────────────────
    // Apply SessionEngine decision: APPEND or NEW
    // ─────────────────────────────────────────────────────────

    // 1) APPEND path (SessionEngine says append_items to some order)
    if (sessionAction === "append_items" && sessionTargetOrderId) {
      try {
        const { data: target, error: tgtErr } = await supa
          .from("orders")
          .select("id, items, status, source_phone")
          .eq("org_id", orgId)
          .eq("id", sessionTargetOrderId)
          .single();

        if (!tgtErr && target && target.id) {
          const status = String(target.status || "").toLowerCase();

          const phonePlain = String(phoneNorm || "").replace(/^\+/, "");
          const srcPhone = String(target.source_phone || "");
          const matchesPhone =
            !phonePlain ||
            srcPhone === phonePlain ||
            srcPhone === "+" + phonePlain;

          const isOpen = ![
            "cancelled_by_customer",
            "archived_for_new",
            "paid",
            "shipped",
          ].includes(status);

          if (matchesPhone && isOpen) {
            const prevItems = Array.isArray(target.items) ? target.items : [];
            const newItems = [...prevItems, ...(parsed.items || [])];

            const linkReason = sessionReason || "session_append_items";

            const { error: upErr } = await supa
              .from("orders")
              .update({
                items: newItems,
                parse_reason:
                  (parsed.reason ?? "session_append_items") +
                  (msg_id ? `; msgid:${msg_id}` : ""),
                parse_confidence: parsed.confidence ?? null,
                ...(msg_id ? { msg_id } : {}),
                order_link_reason: linkReason,
              })
              .eq("id", target.id);

            if (upErr) throw upErr;

            // learning writes (same as older append path)
            try {
              for (const it of parsed.items) {
                const canon = trim(it.canonical || it.name || "");
                if (!canon) continue;
                const brand = (it.brand ?? "") + "";
                const variant = (it.variant ?? "") + "";
                const { error: eb } = await supa.rpc("upsert_bvs", {
                  p_org_id: orgId,
                  p_canonical: canon,
                  p_brand: brand,
                  p_variant: variant,
                  p_inc: 1,
                });
                if (eb) console.warn("[INGEST][core][bvs err]", eb.message);
                if (phoneNorm) {
                  const { error: ec } = await supa.rpc("upsert_customer_pref", {
                    p_org_id: orgId,
                    p_phone: phoneNorm,
                    p_canonical: canon,
                    p_brand: brand,
                    p_variant: variant,
                    p_inc: 1,
                  });
                  if (ec)
                    console.warn("[INGEST][core][custpref err]", ec.message);
                }
              }
            } catch (e: any) {
              console.warn(
                "[INGEST][core][session_append learn warn]",
                e?.message || e
              );
            }

            // Auto-clarify if needed (WABA-only)
            await maybeAutoSendClarify(orgId, target.id, source);

            if (phoneKey) {
              await markSessionOnAppendOrder({
                org_id: orgId,
                phone_key: phoneKey,
                order_id: target.id,
                status,
              });
            }

            console.log("[INGEST][core] session-append into", target.id);

            return {
              ok: true,
              stored: true,
              kind: "order",
              used: parsed.used,
              merged_into: target.id,
              order_id: target.id,
              items: newItems,
              org_id: orgId,
              reason: "session_append_items",
            };
          }
        }
      } catch (e: any) {
        console.warn("[INGEST][core][session_append warn]", e?.message || e);
        // fall through to NEW order path if append failed
      }
    }

    // 2) NEW order path (SessionEngine says start_new_order OR append failed)

    // New order dedupe
    const dedupeKey = makeDedupeKey(
      orgId,
      String(textFlat),
      ts,
      phoneNorm,
      msg_id || null
    );
    const { data: existing, error: exErr } = await supa
      .from("orders")
      .select("id")
      .eq("org_id", orgId)
      .eq("dedupe_key", dedupeKey)
      .limit(1);
    if (exErr) throw exErr;
    if (existing && existing[0]) {
      console.log("[INGEST][core][SKIP] duplicate", { orgId, dedupeKey });
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: parsed.used,
        reason: "duplicate",
      };
    }

    // Guard against msg_id duplicate for orders
    if (msg_id) {
      const existingByMsg = await existsOrderByMsgId(msg_id);
      if (existingByMsg) {
        console.log("[INGEST][core][SKIP] duplicate-order-msgid", {
          msg_id,
          order_id: existingByMsg.id,
        });
        return {
          ok: true,
          stored: false,
          kind: "none",
          used: parsed.used,
          reason: "duplicate_msgid",
          order_id: existingByMsg.id,
        };
      }
    }

    const linkReasonNew = sessionReason || "session_new_order";

    // Insert NEW order
    const reasonTag =
      (parsed.reason ?? "") + (msg_id ? `; msgid:${msg_id}` : "");
    const { error: insErr, data: created } = await supa
      .from("orders")
      .insert({
        org_id: orgId,
        source_phone: phoneNorm,
        customer_name: customerName,
        raw_text: textRaw,
        items: parsed.items,
        status: "pending",
        created_at: new Date(ts).toISOString(),
        dedupe_key: dedupeKey,
        parse_confidence: parsed.confidence ?? null,
        parse_reason: reasonTag || null,
        msg_id: msg_id || null,
        order_link_reason: linkReasonNew,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    console.log("[INGEST][core] stored NEW", { orgId, dedupeKey });

    if (phoneKey && created?.id) {
      await markSessionOnNewOrder({
        org_id: orgId,
        phone_key: phoneKey,
        order_id: created.id,
        status: "pending",
      });
    }

    // learning writes (non-fatal)
    try {
      for (const it of parsed.items) {
        const canon = trim(it.canonical || it.name || "");
        if (!canon) continue;
        const brand = (it.brand ?? "") + "";
        const variant = (it.variant ?? "") + "";
        const { error: eb } = await supa.rpc("upsert_bvs", {
          p_org_id: orgId,
          p_canonical: canon,
          p_brand: brand,
          p_variant: variant,
          p_inc: 1,
        });
        if (eb) console.warn("[INGEST][core][bvs err]", eb.message);
        if (phoneNorm) {
          const { error: ec } = await supa.rpc("upsert_customer_pref", {
            p_org_id: orgId,
            p_phone: phoneNorm,
            p_canonical: canon,
            p_brand: brand,
            p_variant: variant,
            p_inc: 1,
          });
          if (ec) console.warn("[INGEST][core][custpref err]", ec.message);
        }
      }
    } catch (e: any) {
      console.warn("[INGEST][core][learn non-fatal]", e?.message || e);
    }

    // AFTER new insert, maybe auto-send clarify (WABA only)
    await maybeAutoSendClarify(orgId, created!.id, source);

    return {
      ok: true,
      stored: true,
      kind: "order",
      used: parsed.used,
      order_id: created!.id,
      items: parsed.items,
      org_id: orgId,
      reason: parsed.reason,
    };
  } catch (e: any) {
    console.error("[INGEST][core] ERROR", e?.message || e);
    return {
      ok: false,
      stored: false,
      kind: "none",
      error: e?.message || "ingest_core_error",
      reason: "ingest_core_error",
    };
  }
}

// ─────────────────────────────────────────
// [INBOX] helpers: conversations + messages
// (intentionally placed elsewhere in your codebase)
// ─────────────────────────────────────────
