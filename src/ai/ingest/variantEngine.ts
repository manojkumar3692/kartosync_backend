// src/ai/ingest/variantEngine.ts

import { ProductRow } from "./productLoader";

// One canonical + all its variants
export type VariantHit = {
  canonical: string;
  variants: ProductRow[];
};

export type VariantMatchResult = VariantHit[];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function normalize(text: string | null | undefined): string {
  return (text || "").toLowerCase();
}

// Extract meaningful search tokens (very similar to your old logic)
export function extractKeywords(raw: string): string[] {
  const stop = new Set([
    "do",
    "you",
    "have",
    "plz",
    "please",
    "bro",
    "sir",
    "madam",
    "is",
    "there",
    "any",
    "a",
    "an",
    "the",
    "need",
    "want",
    "get",
    "u",
    "ur",
    "your",
    "my",
  ]);

  return raw
    .toLowerCase()
    .split(/[\s,.-]+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

// Higher score = stronger match
function getMatchScore(text: string, keywords: string[]): number {
  let score = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) score += 2; // strong direct match
    if (text.startsWith(kw)) score += 1;
  }
  return score;
}

// Look for variants where query hits display_name / canonical / variant
function findVariantsInsideCatalog(
  query: string,
  catalog: ProductRow[]
): ProductRow[] {
  const keywords = extractKeywords(query);
  if (!keywords.length) return [];

  const hits: { row: ProductRow; score: number }[] = [];

  for (const row of catalog) {
    const fullText = normalize(
      `${row.display_name || ""} ${row.canonical || ""} ${row.variant || ""}`
    );

    const score = getMatchScore(fullText, keywords);
    if (score > 0) {
      hits.push({ row, score });
    }
  }

  if (!hits.length) return [];

  // best first (not strictly required, but nice)
  hits.sort((a, b) => b.score - a.score);
  return hits.map((h) => h.row);
}

// ─────────────────────────────────────────────
// PUBLIC API used by orderEngine
// ─────────────────────────────────────────────

export function findVariantMatches(
  rawQuery: string,
  catalog: ProductRow[]
): VariantMatchResult {
  const rows = findVariantsInsideCatalog(rawQuery, catalog);
  if (!rows.length) return [];

  const byCanonical = new Map<string, ProductRow[]>();

  for (const row of rows) {
    const key = (row.canonical || "").trim();
    if (!key) continue;

    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key)!.push(row);
  }

  return Array.from(byCanonical.entries()).map(([canonical, variants]) => ({
    canonical,
    variants,
  }));
}


export function filterVariantsByKeyword(
  variants: any[],
  raw: string
) {
  const keywords = extractKeywords(raw);
  if (!keywords.length) return [];

  const out: any[] = [];

  for (const v of variants) {
    const full = normalize(
      `${v.name || ""} ${v.variant || ""} ${v.display_name || ""}`
    );

    const score = getMatchScore(full, keywords);
    if (score > 0) {
      out.push({ v, score });
    }
  }

  return out
    .sort((a, b) => b.score - a.score)
    .map(x => x.v);
}