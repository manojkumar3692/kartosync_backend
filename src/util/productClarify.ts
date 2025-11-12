// src/util/productClarify.ts
import { supa } from "../db";

type ParsedItem = {
  canonical?: string | null;
  name?: string | null;
};

export async function buildClarifyTextForItems(
  orgId: string,
  items: ParsedItem[]
): Promise<string | null> {
  if (!orgId || !items || !items.length) return null;

  const prompts: string[] = [];

  for (const it of items) {
    const raw = (it.canonical || it.name || "").trim();
    if (!raw) continue;

    const label = raw.toLowerCase();

    // Look up active products for this org + canonical
    const { data, error } = await supa
      .from("products")
      .select("brand, variant")
      .eq("org_id", orgId)
      .eq("canonical", label)
      .eq("is_active", true);

    if (error || !data || data.length === 0) continue;

    // Collect distinct non-empty variants/brands
    const variants = Array.from(
      new Set(
        data
          .map((r) => (r.variant || "").trim())
          .filter((v) => v.length > 0)
      )
    );
    const brands = Array.from(
      new Set(
        data
          .map((r) => (r.brand || "").trim())
          .filter((v) => v.length > 0)
      )
    );

    // If there is something to clarify, build a smart line
    if (variants.length > 1) {
      prompts.push(
        `For ${raw}, which variant do you prefer? (${variants.join(", ")})`
      );
    } else if (brands.length > 1) {
      prompts.push(
        `For ${raw}, which brand do you prefer? (${brands.join(", ")})`
      );
    }
  }

  if (!prompts.length) return null;

  return (
    "Quick question before we pack your order:\n" +
    prompts.map((p) => `• ${p}`).join("\n")
  );
}