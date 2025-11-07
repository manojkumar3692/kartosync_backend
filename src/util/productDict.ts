// src/util/productDict.ts
import { supa } from "../db";

/**
 * Lightweight, auto-learning product dictionary per org.
 * - Starts with a small baseline seed (groceries etc.)
 * - Enriches from recent orders + AI corrections
 * - (Optionally) pulls from a popularity table if you have one
 *
 * Returns a Set<string> of normalized producty terms, ready for
 * quick membership tests in your notOrder gate.
 */

type DictOpts = {
  /** how many recent orders to scan for names/canonicals */
  maxOrders?: number;
  /** how many recent ai_corrections to scan */
  maxCorrections?: number;
  /** cache TTL in ms */
  ttlMs?: number;
};

const DEFAULT_OPTS: Required<DictOpts> = {
  maxOrders: 400,
  maxCorrections: 400,
  ttlMs: 5 * 60 * 1000, // 5 min
};

// ─────────────────────────────────────────────────────────
// Baseline seed: short, safe, general-purpose.
// Add/remove freely—auto-learning will expand this anyway.
// ─────────────────────────────────────────────────────────
const BASE_SEED = [
  // common staples
  "milk", "curd", "yogurt", "butter", "cheese", "paneer", "ghee",
  "bread", "bun", "egg", "eggs",
  "rice", "wheat", "atta", "maida", "rava", "semolina",
  "dal", "daal", "lentil", "lentils", "chana", "toor", "urad", "moong",
  "sugar", "salt", "jaggery", "oil", "olive", "sunflower",
  "tea", "coffee",
  // produce
  "onion", "garlic", "tomato", "potato", "ginger", "chilli", "capsicum", "bell pepper",
  "coriander", "cilantro", "mint", "spinach", "carrot", "cucumber", "banana", "apple",
  // packaged
  "biscuit", "biscuits", "chips", "noodles", "maggie", "maggi", "pasta",
  // bakery / ready
  "chapathi", "chapati", "roti", "paratha", "idly", "idli", "dosa", "batter", "idly batter", "idli batter",
  // frozen / ice cream
  "ice cream", "baskin robbins", "kwality", "amul",
  // beverages
  "juice", "water", "coke", "pepsi", "fanta", "mirinda", "sprite",
];

// Simple synonyms (both directions added)
const SYNONYMS: Record<string, string[]> = {
  coriander: ["cilantro"],
  cilantro: ["coriander"],
  capsicum: ["bell pepper"],
  yogurt: ["curd"],
  curd: ["yogurt"],
  dal: ["daal", "lentil", "lentils"],
  daal: ["dal", "lentil", "lentils"],
  maggi: ["maggie"],
  batter: ["idly batter", "idli batter"],
};

function normTerm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s\-&]/gu, "") // strip punctuation except - &
    .trim();
}

function expandPlurality(s: string): string[] {
  // very naive: if ends with 's', include singular; else include plural with 's'
  if (!s) return [];
  const out = new Set<string>([s]);
  if (s.endsWith("s")) out.add(s.replace(/s$/, ""));
  else out.add(s + "s");
  return [...out];
}

function explodeSynonyms(base: Set<string>) {
  const out = new Set(base);
  for (const t of Array.from(base)) {
    const syns = SYNONYMS[t];
    if (syns && syns.length) {
      for (const s of syns) out.add(normTerm(s));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// Cache (per org)
// ─────────────────────────────────────────────────────────
const cache = new Map<string, { at: number; words: Set<string> }>();

async function pullFromRecentOrders(orgId: string, max: number): Promise<string[]> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("items")
      .eq("org_id", orgId)
      .not("items", "is", null)
      .order("created_at", { ascending: false })
      .limit(max);

    if (error || !Array.isArray(data)) return [];
    const found: string[] = [];
    for (const row of data) {
      const arr = Array.isArray(row?.items) ? row.items : [];
      for (const it of arr) {
        const raw = String(it?.canonical || it?.name || "");
        const brand = String(it?.brand || "");
        const variant = String(it?.variant || "");
        if (raw) found.push(raw);
        if (brand) found.push(brand);
        if (variant) found.push(variant);
      }
    }
    return found;
  } catch {
    return [];
  }
}

async function pullFromAICorrections(orgId: string, max: number): Promise<string[]> {
  // If you named the table differently, adjust here (ai_corrections or ai_correction_logs)
  const candidates = ["ai_corrections", "ai_correction_logs"];
  for (const table of candidates) {
    try {
      const { data, error } = await supa
        .from(table)
        .select("human_fixed, org_id")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(max);

      if (error || !Array.isArray(data)) continue;

      const found: string[] = [];
      for (const row of data) {
        const items = (row as any)?.human_fixed?.items || (row as any)?.human_fixed || [];
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          const raw = String(it?.canonical || it?.name || "");
          const brand = String(it?.brand || "");
          const variant = String(it?.variant || "");
          if (raw) found.push(raw);
          if (brand) found.push(brand);
          if (variant) found.push(variant);
        }
      }
      return found;
    } catch {
      // try next candidate
    }
  }
  return [];
}

async function pullFromPopularity(orgId: string): Promise<string[]> {
  // Optional: if you keep per-(brand,variant) popularity (we used upsert_bvs RPC),
  // try a few likely table/view names and ignore errors quietly.
  const guesses = [
    { table: "bvs", fields: "canonical,brand,variant" },
    { table: "brand_variant_stats", fields: "canonical,brand,variant" },
    { table: "bvs_view", fields: "canonical,brand,variant" },
  ];
  for (const g of guesses) {
    try {
      const { data, error } = await supa
        .from(g.table)
        .select(g.fields)
        .eq("org_id", orgId)
        .order("score", { ascending: false })
        .limit(500);

      if (error || !Array.isArray(data)) continue;
      const out: string[] = [];
      for (const r of data) {
        const c = normTerm((r as any).canonical || "");
        const b = normTerm((r as any).brand || "");
        const v = normTerm((r as any).variant || "");
        if (c) out.push(c);
        if (b) out.push(b);
        if (v) out.push(v);
      }
      return out;
    } catch {
      // ignore and move on
    }
  }
  return [];
}

/**
 * Build (or return cached) product dictionary for an org.
 */
export async function getOrgProductTerms(
  orgId: string,
  opts?: DictOpts
): Promise<Set<string>> {
  const { maxOrders, maxCorrections, ttlMs } = { ...DEFAULT_OPTS, ...(opts || {}) };

  const hit = cache.get(orgId);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.words;

  // 1) Start with seed (normalized + basic plurality)
  const seed = new Set<string>();
  for (const s of BASE_SEED) {
    const n = normTerm(s);
    for (const e of expandPlurality(n)) seed.add(e);
  }

  // 2) Learn from recent orders
  const fromOrders = await pullFromRecentOrders(orgId, maxOrders);
  for (const s of fromOrders) {
    const n = normTerm(s);
    if (!n) continue;
    for (const e of expandPlurality(n)) seed.add(e);
  }

  // 3) Learn from AI corrections (human_fixed)
  const fromFix = await pullFromAICorrections(orgId, maxCorrections);
  for (const s of fromFix) {
    const n = normTerm(s);
    if (!n) continue;
    for (const e of expandPlurality(n)) seed.add(e);
  }

  // 4) (Optional) Popularity table/view if present
  const fromPop = await pullFromPopularity(orgId);
  for (const s of fromPop) {
    const n = normTerm(s);
    if (!n) continue;
    for (const e of expandPlurality(n)) seed.add(e);
  }

  // 5) Synonym expansion
  const expanded = explodeSynonyms(seed);

  // 6) Finalize cache
  cache.set(orgId, { at: now, words: expanded });
  return expanded;
}

/** Force-refresh the cache (e.g., after big import) */
export async function refreshOrgProductTerms(orgId: string): Promise<Set<string>> {
  cache.delete(orgId);
  return getOrgProductTerms(orgId);
}