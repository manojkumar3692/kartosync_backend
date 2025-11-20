import { supa } from "../db";
import Fuse from "fuse.js";

// ─────────────────────────────────────────────
// Generic helpers (no domain hardcoding)
// ─────────────────────────────────────────────

function normalize(text: any): string {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

export async function findBestProductForTextV2(
  org_id: string,
  text: string
) {
  const clean = normalize(text);
  if (!clean) return null;

  const queryTokens = tokenize(clean);

  // 1) Load org business type (same as your original)
  const { data: orgData } = await supa
    .from("orgs")
    .select("business_type")
    .eq("id", org_id)
    .single();

  const businessType: string = orgData?.business_type || "grocery";

  // 2) Load all active products for this org
  const { data: products, error: productsErr } = await supa
    .from("products")
    .select("*")
    .eq("org_id", org_id)
    .eq("active", true);

  if (productsErr) {
    console.warn("[productMatcher] products error", productsErr.message);
  }

  if (!products || products.length === 0) return null;

  // 3) Strong direct match: canonical/display_name fully inside text
  const directMatch = (products as any[]).find((p) => {
    const canonNorm = normalize(p.canonical);
    const displayNorm = normalize(p.display_name);

    if (canonNorm && clean.includes(canonNorm)) return true;
    if (displayNorm && clean.includes(displayNorm)) return true;
    return false;
  });

  if (directMatch) return directMatch;

  // 4) Generic scoring: token overlap + your businessType boosts
  const scored = (products as any[]).map((p) => {
    let score = 0;

    const canonNorm = normalize(p.canonical);
    const displayNorm = normalize(p.display_name);
    const categoryNorm = normalize(p.category);
    const unitNorm = normalize(p.unit || p.base_unit); // support both names
    const productTypeNorm = normalize(p.product_type);

    // Combine name fields into one search string
    const nameCombined = [canonNorm, displayNorm].filter(Boolean).join(" ");
    const nameTokens = tokenize(nameCombined);

    // 4a) Token overlap (generic – works for any vertical)
    if (nameTokens.length && queryTokens.length) {
      const qSet = new Set(queryTokens);
      let overlapCount = 0;
      for (const t of nameTokens) {
        if (qSet.has(t)) overlapCount++;
      }
      if (overlapCount > 0) {
        score += overlapCount * 12; // each matching token gives weight
      }
    }

    // 4b) Simple substring matches (after normalization)
    if (canonNorm && clean.includes(canonNorm)) score += 40;
    if (displayNorm && clean.includes(displayNorm)) score += 30;

    // 4c) Category & unit hints (still fully generic)
    if (categoryNorm && clean.includes(categoryNorm)) score += 15;
    if (unitNorm && clean.includes(unitNorm)) score += 10;

    // 4d) Light businessType-based weights (from your original logic)
    if (businessType === "restaurant" && unitNorm === "plate") {
      score += 30;
    }
    if (businessType === "salon" && productTypeNorm === "service") {
      score += 40;
    }
    if (
      businessType === "meat" &&
      categoryNorm &&
      categoryNorm.includes("chicken")
    ) {
      score += 20;
    }
    if (businessType === "grocery") {
      score += 10;
    }

    return { p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // Require minimum signal to trust this match
  if (best && best.score > 10) {
    return best.p;
  }

  // 5) Fuzzy fallback (extended to display_name as well)
  const fuse = new Fuse(products as any[], {
    keys: ["canonical", "display_name"],
    threshold: 0.4,
  });

  const fuzzy = fuse.search(clean || text || "");
  if (fuzzy.length > 0) {
    return fuzzy[0].item;
  }

  return null;
}