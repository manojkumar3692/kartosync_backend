// src/ai/ingest/intentEngine.ts
import type { ConversationState } from "./types";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type Vertical =
  | "restaurant"
  | "grocery"
  | "salon"
  | "pharmacy"
  | "generic";

export type IntentType =
  | "add_item"
  | "add_items" // multi-line / multi-item add
  | "remove_item"
  | "change_qty"
  | "modify_item"
  | "add_note"
  | "checkout"
  | "new_order"
  | "cancel_order"
  | "unknown";

export type ParsedOrderLine = {
  /** Parsed quantity for that segment (null if unknown) */
  quantity: number | null;
  /** Item text (normalized-ish, without the qty part) */
  itemText: string;
  /** The segment of the message this line came from (normalized) */
  rawSegment: string;
  nameText?: any;
  qty?: any;
};


export type MultiItemLine = ParsedOrderLine;

export type ParsedIntent = {
  intent: IntentType;
  /** original user text */
  rawText: string;
  /** normalized lower-case text */
  normalized: string;

  /** When user refers to an item (single-item flows) */
  targetItemName?: string | null;
  /** When user specifies quantity (single-item flows) */
  quantity?: number | null;

  /** For multi-line cart additions */
  lines?: ParsedOrderLine[] | null;

  /** Optional free-form note / modifiers */
  note?: string | null;

  /** For future use: e.g. which line in cart, menu index, etc. */
  targetIndex?: number | null;

  /**
   * Quick rule that triggered this intent (for debugging).
   * e.g. "RULE_CHECKOUT_KEYWORD", "RULE_QTY_LEADING", etc.
   */
  ruleTag?: string | null;
};

// Options passed from main ingest router
export type IntentOptions = {
  vertical: Vertical;
  state?: ConversationState | null;
};

// ─────────────────────────────────────────────
// Keyword dictionaries (generic, not just food)
// ─────────────────────────────────────────────

const CHECKOUT_KEYWORDS = [
  "checkout",
  "check out",
  "place order",
  "confirm order",
  "confirm my order",
  "pay now",
  "proceed to pay",
  "proceed to payment",
  "ok place",
  "ok place it",
  "book it",
  "book now",
];

const NEW_ORDER_KEYWORDS = [
  "new order",
  "start new order",
  "start again",
  "start over",
  "clear cart",
  "clear my order",
  "change entire order",
  "change my full order",
];

const CANCEL_ORDER_KEYWORDS = [
  "cancel order",
  "cancel my order",
  "cancel everything",
  "cancel all",
];

// Phrases that usually mean "note / instructions"
const NOTE_HINTS = [
  "note:",
  "instruction",
  "instructions",
  "landmark",
  "if possible",
  "pls make sure",
  "please make sure",
  "ring the bell",
  "don’t ring the bell",
  "dont ring the bell",
  "call me",
  "before coming",
  "delivery boy",
];

// Phrases that usually mean modifiers on an item
const MODIFIER_HINTS = [
  "no onion",
  "no onions",
  "less spicy",
  "more spicy",
  "extra spicy",
  "mild spicy",
  "no spice",
  "less sugar",
  "no sugar",
  "no ice",
  "extra cheese",
  "no cheese",
  "well done",
  "extra crispy",
  "no masala",
];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function normalize(text: string): string {
  return (text || "").trim().toLowerCase();
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Try to interpret a message as a multi-item order:
 * e.g. "1 chicken biriyani, 1 coke"
 *      "2 chicken biriyani and 1 coke"
 *      "1 chicken biriyani, coke"
 */
function tryParseMultiItemOrder(
  rawText: string,
  state: ConversationState | null | undefined
): ParsedOrderLine[] | null {
  const normalizedText = normalize(rawText);

  // Only attempt in idle-ish situations so we don't fight with other flows.
  if (state && state !== "idle" && state !== "building_order") {
    return null;
  }

  const hasDelimiter =
    normalizedText.includes(",") ||
    normalizedText.includes(";") ||
    normalizedText.includes("&") ||
    /\sand\s/.test(normalizedText);

  if (!hasDelimiter) return null;

  // Normalize "and", ";" and "&" to comma, then split
  const listText = normalizedText
    .replace(/\s+and\s+/g, ",")
    .replace(/[;&]+/g, ",");

  const segments = listText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length <= 1) return null;

  const lines: ParsedOrderLine[] = [];

  for (const seg of segments) {
    if (!seg) continue;

    let qty: number | null = null;
    let itemPart: string | null = null;

    // Pattern A: "2 chicken biriyani" / "2x chicken biriyani"
    let m =
      seg.match(/^(\d+)\s*(x|×)?\s+(.+)$/) ??
      seg.match(/^(\d+)\s+(.+)$/);

    if (m) {
      const [, qtyStr, _x, itemRaw] =
        m.length === 4 ? m : [m[0], m[1], undefined, m[2]];
      qty = Number(qtyStr);
      itemPart = (itemRaw || "").trim();
    } else {
      // Pattern B: "coke x2"
      m = seg.match(/^(.+?)\s*[x×]\s*(\d+)$/);
      if (m) {
        const [, itemRaw, qtyStr] = m;
        itemPart = (itemRaw || "").trim();
        qty = Number(qtyStr);
      } else {
        // Pattern C: no explicit qty → assume 1
        itemPart = seg.trim();
        qty = 1;
      }
    }

    if (!itemPart) {
      // one broken segment → abort multi-item interpretation and fallback
      return null;
    }

    // Strip trailing punctuation like "." or "," from the item name
    itemPart = itemPart.replace(/[.,]+$/g, "").trim();
    if (!itemPart) {
      return null;
    }

    lines.push({
      quantity: Number.isFinite(qty || 0) && (qty as number) > 0 ? qty! : 1,
      itemText: itemPart,
      rawSegment: seg,
    });
  }

  if (lines.length <= 1) return null;

  return lines;
}

/**
 * Try a set of quick, deterministic rules before any heavy logic.
 * This keeps behaviour predictable and cheap.
 */
function quickRuleDetect(
  text: string,
  opts: IntentOptions
): ParsedIntent | null {
  const rawText = text ?? "";
  const normalizedText = normalize(rawText);

  if (!normalizedText) {
    return {
      intent: "unknown",
      rawText,
      normalized: normalizedText,
      ruleTag: "RULE_EMPTY",
    };
  }

  const { state } = opts;

  // ── Checkout / place order ──
  if (containsAny(normalizedText, CHECKOUT_KEYWORDS)) {
    return {
      intent: "checkout",
      rawText,
      normalized: normalizedText,
      ruleTag: "RULE_CHECKOUT_KEYWORD",
    };
  }

  // ── New order / reset cart ──
  if (containsAny(normalizedText, NEW_ORDER_KEYWORDS)) {
    return {
      intent: "new_order",
      rawText,
      normalized: normalizedText,
      ruleTag: "RULE_NEW_ORDER_KEYWORD",
    };
  }

  // ── Cancel whole order ──
  if (containsAny(normalizedText, CANCEL_ORDER_KEYWORDS)) {
    return {
      intent: "cancel_order",
      rawText,
      normalized: normalizedText,
      ruleTag: "RULE_CANCEL_ORDER_KEYWORD",
    };
  }

  // ── Remove item: "remove coke", "no coke", "delete biriyani" ──
  if (
    normalizedText.startsWith("remove ") ||
    normalizedText.startsWith("delete ") ||
    normalizedText.startsWith("cancel ") ||
    normalizedText.startsWith("no ")
  ) {
    const cleaned = normalizedText
      .replace(/^remove\s+/, "")
      .replace(/^delete\s+/, "")
      .replace(/^cancel\s+/, "")
      .replace(/^no\s+/, "")
      .trim();

    return {
      intent: "remove_item",
      rawText,
      normalized: normalizedText,
      targetItemName: cleaned || null,
      ruleTag: "RULE_REMOVE_PREFIX",
    };
  }

  // ── Change quantity: "make biriyani 3", "change coke to 2" ──
  const changeQtyMatch =
    normalizedText.match(/(?:make|change)\s+(.+?)\s+(?:to\s+)?(\d+)/) ||
    normalizedText.match(/(.+?)\s+(?:to\s+)?(\d+)\s*(?:qty|quantity|nos|no)?$/);

  if (changeQtyMatch) {
    const [, itemPart, qtyStr] = changeQtyMatch;
    const qty = Number(qtyStr);
    if (Number.isFinite(qty) && qty > 0) {
      return {
        intent: "change_qty",
        rawText,
        normalized: normalizedText,
        targetItemName: (itemPart || "").trim() || null,
        quantity: qty,
        ruleTag: "RULE_CHANGE_QTY",
      };
    }
  }

  // ── Multi-item parsing: "1 chicken biriyani, 1 coke" ──
  const multiLines = tryParseMultiItemOrder(rawText, state ?? null);
  if (multiLines && multiLines.length > 1) {
    return {
      intent: "add_items",
      rawText,
      normalized: normalizedText,
      lines: multiLines,
      ruleTag: "RULE_MULTI_ITEM_LIST",
    };
  }

  // ── Add item: patterns like "2 chicken biryani", "3x coke", "biryani x2" ──

  // Example: "2 chicken biryani", "2x chicken biryani"
  const qtyLeadingMatch =
    normalizedText.match(/^(\d+)\s*(x|×)?\s+(.+)$/) ??
    normalizedText.match(/^(\d+)\s+(.+)$/);

  if (qtyLeadingMatch) {
    const [, qtyStr, _x, itemPartRaw] =
      qtyLeadingMatch.length === 4
        ? qtyLeadingMatch
        : [qtyLeadingMatch[0], qtyLeadingMatch[1], undefined, qtyLeadingMatch[2]];
    const qty = Number(qtyStr);
    const itemPart = itemPartRaw || "";

    if (Number.isFinite(qty) && qty > 0 && itemPart.trim()) {
      return {
        intent: "add_item",
        rawText,
        normalized: normalizedText,
        targetItemName: itemPart.trim(),
        quantity: qty,
        ruleTag: "RULE_QTY_LEADING",
      };
    }
  }

  // Example: "chicken biryani x2", "coke × 3"
  const qtyTrailingMatch = normalizedText.match(/^(.+?)\s*[x×]\s*(\d+)$/);
  if (qtyTrailingMatch) {
    const [, itemPartRaw, qtyStr] = qtyTrailingMatch;
    const qty = Number(qtyStr);
    const itemPart = itemPartRaw || "";

    if (Number.isFinite(qty) && qty > 0 && itemPart.trim()) {
      return {
        intent: "add_item",
        rawText,
        normalized: normalizedText,
        targetItemName: itemPart.trim(),
        quantity: qty,
        ruleTag: "RULE_QTY_TRAILING",
      };
    }
  }

  // Single-word / short item names: e.g. "coke", "biriyani", "shampoo"
  // In idle/cart-building states, we treat this as add_item with qty=1.
  if (
    normalizedText.length >= 2 &&
    normalizedText.length <= 40 &&
    !normalizedText.includes(" ") &&
    /^[a-z0-9\s\-]+$/.test(normalizedText) &&
    (!state || state === "idle" || state === "building_order")
  ) {
    return {
      intent: "add_item",
      rawText,
      normalized: normalizedText,
      targetItemName: normalizedText,
      quantity: 1,
      ruleTag: "RULE_SINGLE_TOKEN_ITEM",
    };
  }

  // ── Modifiers: "make it extra spicy", "no onion pls", etc. ──
  if (containsAny(normalizedText, MODIFIER_HINTS)) {
    return {
      intent: "modify_item",
      rawText,
      normalized: normalizedText,
      note: rawText,
      // targetItemName left null → cartEngine can decide
      ruleTag: "RULE_MODIFIER_HINT",
    };
  }

  // ── Order-level notes / instructions ──
  if (containsAny(normalizedText, NOTE_HINTS)) {
    return {
      intent: "add_note",
      rawText,
      normalized: normalizedText,
      note: rawText,
      ruleTag: "RULE_NOTE_HINT",
    };
  }

  // Fallback → unknown; higher layer decides.
  return null;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Main intent parser used by ingest/index.ts.
 * For now this is *pure rule-based* and vertical-aware only in a light way.
 * Later we can plug LLM-based refinement on top without changing the type.
 */
export async function parseIntent(
  userText: string,
  opts: IntentOptions
): Promise<ParsedIntent> {
  const rawText = userText ?? "";
  const normalizedText = normalize(rawText);

  // 1) Quick deterministic rules
  const quick = quickRuleDetect(rawText, opts);
  if (quick) {
    console.log("[INTENT][PARSE][QUICK]", {
      vertical: opts.vertical,
      state: opts.state,
      intent: quick.intent,
      ruleTag: quick.ruleTag,
      rawText,
    });
    return quick;
  }

  // 2) (Future) vertical-specific special cases
  // For now we keep it simple; in future we can add small helpers
  // for salon/pharmacy if needed without breaking the type.
  console.log("[INTENT][PARSE][FALLBACK_UNKNOWN]", {
    vertical: opts.vertical,
    state: opts.state,
    rawText,
  });

  return {
    intent: "unknown",
    rawText,
    normalized: normalizedText,
    ruleTag: "RULE_FALLBACK_UNKNOWN",
  };
}

// ─────────────────────────────────────────────
// Org vertical helper (simple stub for now)
// ─────────────────────────────────────────────

/**
 * Very simple vertical resolver.
 * Later you can plug org_settings table here.
 */
export async function getOrgVertical(_org_id: string): Promise<Vertical> {
  // TODO: read from DB (org_settings.business_type) and map to Vertical
  return "restaurant";
}