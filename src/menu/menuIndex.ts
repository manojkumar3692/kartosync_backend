// src/menu/menuIndex.ts
import { supa } from "../db";

export type ProductLite = {
  id: string;
  org_id: string;
  canonical: string;
  display_name: string | null;
  brand: string | null;
  variant: string | null;
  category: string | null;
  tokens: string[]; // for simple matching
};

// in-memory cache per org
type CachedMenu = {
  items: ProductLite[];
  loadedAt: number;
};

const menuCache = new Map<string, CachedMenu>();
const CACHE_TTL_MS = 60_000; // 1 minute – safe + cheap

const norm = (v: any) =>
  typeof v === "string" ? v.toLowerCase() : v == null ? "" : String(v).toLowerCase();

export async function getOrgMenuIndex(org_id: string): Promise<ProductLite[]> {
  const now = Date.now();
  const cached = menuCache.get(org_id);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.items;
  }

  const { data, error } = await supa
    .from("products")
    .select("id, org_id, canonical, display_name, brand, variant, category, is_active")
    .eq("org_id", org_id)
    .eq("is_active", true);

  if (error) {
    console.error("[menuIndex] load error:", error.message);
    // on error: return old cache if any, or empty
    return cached?.items || [];
  }

  const items: ProductLite[] = (data || []).map((row: any) => {
    const canonical = row.canonical || "";
    const display = row.display_name || canonical;
    const brand = row.brand || "";
    const variant = row.variant || "";

    const baseText = [canonical, display, brand, variant]
      .map(norm)
      .filter(Boolean)
      .join(" ");

    const tokens = Array.from(
      new Set(baseText.split(/\s+/).filter(Boolean))
    );

    return {
      id: row.id,
      org_id: row.org_id,
      canonical: row.canonical,
      display_name: row.display_name,
      brand: row.brand,
      variant: row.variant,
      category: row.category,
      tokens,
    };
  });

  menuCache.set(org_id, { items, loadedAt: now });
  return items;
}

// simple match helper
export type MenuMatchResult =
  | { type: "exact"; product: ProductLite; suggestions: ProductLite[] }
  | { type: "fuzzy_one"; product: ProductLite; suggestions: ProductLite[] }
  | { type: "ambiguous"; product: null; suggestions: ProductLite[] }
  | { type: "none"; product: null; suggestions: ProductLite[] };

export function matchMenuItem(rawName: string, menu: ProductLite[]): MenuMatchResult {
  const text = norm(rawName).trim();
  if (!text) {
    return { type: "none", product: null, suggestions: [] };
  }

  const words = text.split(/\s+/).filter(Boolean);

  // 1) exact by canonical or display_name
  const exact = menu.find(
    (p) =>
      norm(p.canonical) === text ||
      norm(p.display_name || "") === text
  );
  if (exact) {
    return { type: "exact", product: exact, suggestions: [] };
  }

  // 2) overlap score: "panner biryani" → match all biryani things
  const scored = menu
    .map((p) => {
      const overlap = p.tokens.filter((t) => words.includes(t)).length;
      return { p, overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  if (!scored.length) {
    return { type: "none", product: null, suggestions: [] };
  }

  // if single strong match (e.g. "chikn biryani" for "chicken biryani")
  if (scored[0].overlap >= 2 && scored.length === 1) {
    return { type: "fuzzy_one", product: scored[0].p, suggestions: [] };
  }

  // else ambiguous: many biryani variants etc.
  const suggestions = scored.map((x) => x.p);
  return { type: "ambiguous", product: null, suggestions };
}