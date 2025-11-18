// src/db/productPrices.ts
import { supa } from "../db";

export async function getLatestPriceForCanonical(
  org_id: string,
  canonical: string
): Promise<number | null> {
  const canon = (canonical || "").trim();
  if (!org_id || !canon) return null;

  try {
    const { data, error } = await supa
      .from("product_prices")
      .select("price")
      .eq("org_id", org_id)
      .eq("canonical", canon)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[product_prices] latest err", error);
      return null;
    }

    return data?.price ?? null;
  } catch (e) {
    console.error("[product_prices] latest EXCEPTION", e);
    return null;
  }
}