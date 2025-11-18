// src/util/products.ts
import { supa } from "../db";
import { findBestProductForTextV2 } from "./productMatcher"; // add this
/**
 * Very small helper to find the best matching product for a text snippet.
 * Uses canonical or display_name with ILIKE.
 */
export async function findBestProductForText(org_id: string, text: string) {
    // 1) Try new V2 matcher first
    const v2 = await findBestProductForTextV2(org_id, text);
    if (v2) return v2;
  
    // 2) Fallback → old method (existing logic)
    const q = (text || "").toLowerCase().trim();
    if (!q) return null;
  
    const { data, error } = await supa
      .from("products")
      .select(
        "id, canonical, display_name, base_unit, category, brand, variant, dynamic_price"
      )
      .eq("org_id", org_id)
      .eq("is_active", true)
      .ilike("canonical", `%${q}%`)
      .limit(5);
  
    if (error) {
      console.warn("[products] search err", error.message);
      return null;
    }
    if (!data || !data.length) return null;
  
    const best = [...data].sort(
      (a, b) =>
        (a.canonical || a.display_name || "").length -
        (b.canonical || b.display_name || "").length
    )[0];
  
    return best || null;
  }

/**
 * Get the latest price row for a product (if you added product_prices table).
 */
export async function getLatestPrice(org_id: string, product_id: string) {
  const { data, error } = await supa
    .from("product_prices")
    .select("price, currency, valid_from")
    .eq("org_id", org_id)
    .eq("product_id", product_id)
    .order("valid_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[product_prices] latest err", error.message);
    return null;
  }
  if (!data) return null;
  return data;
}