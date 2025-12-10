// src/ai/lang/normalize.ts

// Basic helpers
const stripExtraSpaces = (s: string) => s.replace(/\s+/g, " ").trim();

// Common Indian chat filler words (Tamil/Kannada/Hindi/“bro” etc.)
const FILLER_WORDS = [
  "da", "dai", "dei", "ma", "anna", "machan", "machaa",
  "bro", "broo", "yaar", "ya", "yaa", "bhai",
  "pls", "plz", "please", "sir", "madam",
  "ji", "ga", "ra"
];

// Hard-coded slang / spelling maps – we can expand later
const CANONICAL_MAP: Record<string, string> = {
  // biryani variants
  "briyani": "biryani",
  "biriyani": "biryani",
  "byriani": "biryani",
  "bariyani": "biryani",
  "brayani": "biryani",

  // short forms
  "chkn": "chicken",
  "ckn": "chicken",

  // house slang
  "mini buckt": "mini bucket",
  "mini buck": "mini bucket",
  "mini buket": "mini bucket",

  // generic
  "1bhk": "1 bhk",
  "2bhk": "2 bhk",
  "3bhk": "3 bhk",
};

function normalizeCaseAndPunctuation(text: string): string {
  // lower-case but keep numbers & basic punctuation
  return text
    .toLowerCase()
    .replace(/[“”‘’]/g, '"')   // fancy quotes to normal
    .replace(/[–—]/g, "-");    // dashes
}

function removeFillerWords(text: string): string {
  const pattern = new RegExp(`\\b(${FILLER_WORDS.join("|")})\\b`, "gi");
  return text.replace(pattern, " ");
}

function applyCanonicalMap(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(CANONICAL_MAP)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    out = out.replace(re, to);
  }
  return out;
}

/**
 * High-level normalization used BEFORE aliases & AI parse.
 *  - lowers case
 *  - drops filler words (da, bro, ma, etc.)
 *  - normalizes a few known spellings
 */
export function normalizeCustomerText(raw: string): string {
  if (!raw) return "";
  let t = String(raw);

  t = normalizeCaseAndPunctuation(t);
  t = removeFillerWords(t);
  t = stripExtraSpaces(t);
  t = applyCanonicalMap(t);
  t = stripExtraSpaces(t);

  return t;
}