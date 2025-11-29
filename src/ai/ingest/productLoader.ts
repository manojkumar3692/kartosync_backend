// src/ai/ingest/productLoader.ts

import { supa } from "../../db";

export type ProductRow = {
  id: string;
  canonical: string | null;
  display_name: string | null;
  brand: string | null;
  variant: string | null;
  category: string | null;
  price_per_unit: string | null;
  active?: boolean | null;
};

export async function loadActiveProducts(
  org_id: string
): Promise<ProductRow[]> {
  const { data, error } = await supa
    .from("products")
    .select(
      "id, canonical, display_name, brand, variant, category, price_per_unit, active"
    )
    .eq("org_id", org_id)
    .eq("active", true);

  if (error || !data) return [];
  return data as ProductRow[];
}