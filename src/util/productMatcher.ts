import { supa } from "../db";
import Fuse from "fuse.js";

export async function findBestProductForTextV2(org_id: string, text: string) {
  const clean = text.toLowerCase();

  // 1) Load org business type
  const { data: orgData } = await supa
    .from("orgs")
    .select("business_type")
    .eq("id", org_id)
    .single();

  const businessType = orgData?.business_type || "grocery";

  // 2) Load all products for org
  const { data: products } = await supa
    .from("products")
    .select("*")
    .eq("org_id", org_id)
    .eq("active", true);

  if (!products || products.length === 0) return null;

  // 3) Strong match: find canonical name in text
  const directMatch = products.find((p) =>
    clean.includes(p.canonical.toLowerCase())
  );
  if (directMatch) return directMatch;

  // 4) Business-Type Boost
  let scored = products.map((p) => {
    let score = 0;

    const canon = p.canonical.toLowerCase();

    // Simple substring
    if (clean.includes(canon)) score += 50;

    // Category boost (restaurants: main course, starters, etc.)
    if (p.category && clean.includes(p.category.toLowerCase())) score += 20;

    // Unit boost
    if (p.unit && clean.includes(p.unit.toLowerCase())) score += 10;

    // Business-Type weight
    if (businessType === "restaurant" && p.unit === "plate") score += 30;
    if (businessType === "salon" && p.product_type === "service") score += 40;
    if (businessType === "meat" && p.category?.includes("Chicken")) score += 20;
    if (businessType === "grocery") score += 10;

    return { p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (best.score > 10) return best.p;

  // 5) Fuzzy fallback
  const fuse = new Fuse(products, { keys: ["canonical"], threshold: 0.4 });
  const fuzzy = fuse.search(clean);
  if (fuzzy.length > 0) return fuzzy[0].item;

  return null;
}