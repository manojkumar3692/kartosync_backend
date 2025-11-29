// src/ai/ingest/textMatchEngine.ts

import type { ProductRow } from "./productLoader";

export type CanonicalMatch = {
  canonical: string;
  variants: ProductRow[];
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const STOP_WORDS = new Set([
  "do", "u", "you", "have", "pls", "please", "want", "need",
  "i", "me", "my", "the", "a", "an", "some", "any", "is", "there",
  "hai", "hey", "hi", "hello", "can", "could", "give", "send",
]);

const DOWNWEIGHT_CANONICAL_KEYWORDS = ["combo", "bucket"];

function normalize(str: string): string {
  return (str || "").toLowerCase().trim();
}

function tokenize(str: string): string[] {
  const lower = normalize(str);
  const rawTokens = lower.match(/[a-z0-9]+/g) || [];
  return rawTokens.filter((t) => !STOP_WORDS.has(t));
}

function productText(p: ProductRow): string {
  const parts = [
    p.canonical || "",
    p.display_name || "",
    p.variant || "",
  ];
  return normalize(parts.join(" "));
}

// Group catalog by canonical
function groupByCanonical(catalog: ProductRow[]): Map<string, ProductRow[]> {
  const map = new Map<string, ProductRow[]>();
  for (const p of catalog) {
    const key = (p.canonical || "").trim();
    if (!key) continue;
    const arr = map.get(key) || [];
    arr.push(p);
    map.set(key, arr);
  }
  return map;
}

// ─────────────────────────────────────────────
// MAIN MATCH FUNCTION
// ─────────────────────────────────────────────

export function findCanonicalMatches(
  raw: string,
  catalog: ProductRow[]
): CanonicalMatch[] {
  const queryTokens = tokenize(raw);
  if (!catalog.length) return [];

  const grouped = groupByCanonical(catalog);
  const scores: { canonical: string; score: number }[] = [];

  for (const [canonical, variants] of grouped.entries()) {
    const canonicalLc = canonical.toLowerCase();
    let bestScoreForCanonical = 0;

    for (const v of variants) {
      const text = productText(v); // canonical + display_name + variant
      let score = 0;

      for (const qt of queryTokens) {
        if (!qt) continue;
        if (text.includes(qt)) {
          score += 1;
        }
      }

      if (score > bestScoreForCanonical) {
        bestScoreForCanonical = score;
      }
    }

    // Downweight combos / buckets unless user explicitly asked
    if (!queryTokens.some((t) => DOWNWEIGHT_CANONICAL_KEYWORDS.includes(t))) {
      if (DOWNWEIGHT_CANONICAL_KEYWORDS.some((k) => canonicalLc.includes(k))) {
        bestScoreForCanonical -= 1;
      }
    }

    scores.push({ canonical, score: bestScoreForCanonical });
  }

  // Find maximum score among canonicals
  let maxScore = scores.reduce(
    (m, s) => (s.score > m ? s.score : m),
    0
  );

  // Primary behaviour: return only top-scoring canonicals with score > 0
  let topCanonicals = scores
    .filter((s) => s.score > 0 && s.score === maxScore)
    .map((s) => s.canonical);

  // If nothing got a positive score, do a softer fallback:
  // match on any overlap of tokens in canonical/display_name/variant.
  if (!topCanonicals.length) {
    if (!queryTokens.length) return [];

    const fallbackCanonicals: Set<string> = new Set();

    for (const [canonical, variants] of grouped.entries()) {
      const canonicalLc = canonical.toLowerCase();

      let hit = false;
      for (const qt of queryTokens) {
        if (!qt) continue;

        if (canonicalLc.includes(qt)) {
          hit = true;
          break;
        }

        for (const v of variants) {
          if (productText(v).includes(qt)) {
            hit = true;
            break;
          }
        }

        if (hit) break;
      }

      if (hit) fallbackCanonicals.add(canonical);
    }

    topCanonicals = Array.from(fallbackCanonicals);
  }

  // Build final matches
  return topCanonicals.map((canonical) => ({
    canonical,
    variants: grouped.get(canonical) || [],
  }));
}