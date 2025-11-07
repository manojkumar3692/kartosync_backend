// src/util/notOrder.ts
import { getOrgProductTerms } from "./productDict"; // auto-learned per-org dictionary

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight text utilities
// ─────────────────────────────────────────────────────────────────────────────
const toLower = (s: string) =>
  s.normalize("NFKC").toLowerCase();

const tokenize = (s: string) =>
  toLower(s).split(/[^a-z0-9+]+/i).filter(Boolean);

// Emojis-only / whitespace checker
const isOnlyEmojisOrWhitespace = (s: string) =>
  !!s && !/[a-z0-9]/i.test(s) && /\p{Emoji}/u.test(s);

// ─────────────────────────────────────────────────────────────────────────────
// Gates: small-talk / acks (with safe word boundaries)
// ─────────────────────────────────────────────────────────────────────────────
const SMALL_TALK = /\b(hi|hello|hey|how\s+are\s+you|good\s+(morning|evening|night))\b/i;
const ACK_ONLY = /^\s*(ok|okay|thanks|thank\s+you|cool|nice|great|👍|👌|🙏)\s*$/i;

export function isPureGreetingOrAck(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (ACK_ONLY.test(t)) return true;
  if (SMALL_TALK.test(t)) {
    // But allow "hi need milk" etc. → handled upstream with other checks.
    // Here we just say: if it's ONLY small-talk words/emojis, block.
    const stripped = t.replace(SMALL_TALK, "").trim();
    if (!stripped || isOnlyEmojisOrWhitespace(stripped)) return true;
  }
  if (isOnlyEmojisOrWhitespace(t)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Obvious promos / OTP / bank ads
// ─────────────────────────────────────────────────────────────────────────────
export function isObviousPromoOrSpam(text: string): boolean {
  const s = toLower(text);
  return (
    /terms\s+and\s+conditions\s+apply|unsubscribe|opt-?out|visit\s+our\s+app|download\s+our\s+app/.test(s) ||
    /\b(otp|one[-\s]?time\s+password)\b/.test(s) ||
    /\b(loan|interest\s*rate|insurance|credit\s*card|bank(ing)?|emi|investment)\b/.test(s) ||
    /\b(click\s+here|limited\s+time\s+offer|special\s+offer)\b/.test(s)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quantity / unit / intent heuristics
// ─────────────────────────────────────────────────────────────────────────────
export function hasQtyUnit(s: string): boolean {
  const t = toLower(s);
  // 2 kg, 1.5 l, 2 packs, 12 pcs, 1 dozen, 500 g, 1ltr, 1 kilo, 2 bottles, etc.
  const qtyUnit =
    /\b\d+(\.\d+)?\s*(kg|g|gram|grams|kilo|l|ml|litre|liter|pack|packs|pc|pcs|piece|pieces|dozen|tray|box|bottle|bottles|tin|pouch|jar|carton)s?\b/i;
  return qtyUnit.test(t);
}

export function hasOrderIntentVerb(s: string): boolean {
  const t = toLower(s);
  // verbs that imply intent to order even without quantity
  return /\b(send|need|want|buy|order|pack|deliver|give|bring|keep|take|add|book|ship)\b/i.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback generic grocery nouns (only as a backstop when learned terms are empty)
// Keep this list small to avoid false positives; dictionary will outrank this.
// ─────────────────────────────────────────────────────────────────────────────
const FALLBACK_PRODUCT_WORDS = new Set([
  // core staples
  "milk","curd","yogurt","bread","egg","rice","dal","daal","atta","flour","sugar","salt","oil","ghee",
  "tomato","onion","potato","garlic","ginger","banana","apple","orange","lemon","chilli","chili",
  "biscuit","chips","snacks","tea","coffee","soap","shampoo","detergent","water","butter","cheese",
  "bottle","diaper","tissue","paneer",
  // common cooked items
  "chapati","chapathi","roti","idly","idli","dosa","parotta","paratha",
  // ice cream brand in your logs
  "ice","cream","baskin","robbins"
]);

// ─────────────────────────────────────────────────────────────────────────────
// “Looks producty” using the learned dictionary (primary) + fallback (secondary)
// ─────────────────────────────────────────────────────────────────────────────
function looksLikeProductyText(text: string, terms: Set<string>): boolean {
  const s = toLower(text);
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const lineHasTerm = (line: string): boolean => {
    const toks = tokenize(line);
    if (!toks.length) return false;
    // learned terms first
    for (const tok of toks) {
      if (terms.has(tok)) return true;
    }
    // fallback only if learned dictionary is thin
    if (terms.size < 10) {
      for (const tok of toks) {
        if (FALLBACK_PRODUCT_WORDS.has(tok)) return true;
      }
    }
    return false;
  };

  let hitLines = 0;
  for (const l of lines) if (lineHasTerm(l)) hitLines++;

  const intent = hasOrderIntentVerb(s);

  // Accept: multiple “product-like” lines OR a single product line with ordering intent
  if (hitLines >= 2) return true;
  if (hitLines >= 1 && intent) return true;

  // Single-line: allow 2+ product tokens
  if (lines.length === 1) {
    const toks = tokenize(s);
    let hits = 0;
    for (const tok of toks) {
      if (terms.has(tok) || (terms.size < 10 && FALLBACK_PRODUCT_WORDS.has(tok))) hits++;
      if (hits >= 2) return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main exported gate
// Return TRUE only when we believe it's NOT an order/inquiry.
// If it looks producty (by dictionary or heuristics), return FALSE to let downstream parse it.
// ─────────────────────────────────────────────────────────────────────────────
export async function isNotOrderMessage(text: string, orgId: string): Promise<boolean> {
  const raw = (text || "").trim();
  if (!raw) return true;

  // A) Block clear promos/OTP/bank ads immediately
  if (isObviousPromoOrSpam(raw)) return true;

  // B) Load per-org learned dictionary (lower-cased terms)
  const learned = await getOrgProductTerms(orgId).catch(() => new Set<string>());
  const terms = new Set<string>();
  for (const w of learned || []) {
    if (typeof w === "string" && w.trim()) terms.add(toLower(w.trim()));
  }

  // C) If it looks producty (by learned/fallback terms + intent heuristics) → DO NOT block
  if (looksLikeProductyText(raw, terms)) return false;

  // D) Hard signals still allowed: explicit qty/unit → DO NOT block
  if (hasQtyUnit(raw)) return false;

  // E) If there’s an order intent verb BUT no dictionary hits, do a tiny safety net:
  //    allow only if a generic fallback word is present (prevents "ok send 👍" from creating orders).
  if (hasOrderIntentVerb(raw)) {
    const toks = tokenize(raw);
    if (toks.some((t) => FALLBACK_PRODUCT_WORDS.has(t))) return false;
  }

  // F) If it’s *pure* greeting/ack (nothing producty) → block
  if (isPureGreetingOrAck(raw)) return true;

  // Default: treat as not-order to be safe.
  return true;
}