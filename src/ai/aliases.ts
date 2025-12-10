// src/ai/aliases.ts
import { supa } from "../db";

// DB row shapes
type DBAliasRow = {
  wrong_text: string;
  canonical_product_id: string | null;
};

type DBProductRow = {
  id: string;
  canonical?: string | null; // canonical group name
  name?: string | null;
};

// ─────────────────────────────────────────────
// Return structured alias hints
// No replacement, no mutation of user text
// ─────────────────────────────────────────────
export async function getAliasHints(
  orgId: string,
  text: string
) {
  const trimmed = (text || "").trim();
  if (!trimmed || !orgId) return [];

  try {
    // 1) Load alias rows for this org
    const { data: aliasRows, error: aliasErr } = await supa
      .from("product_aliases")
      .select("wrong_text, canonical_product_id")
      .eq("org_id", orgId);

    if (aliasErr) {
      console.warn("[aliases] load error", aliasErr.message);
      return [];
    }

    const rows: DBAliasRow[] = Array.isArray(aliasRows)
      ? (aliasRows as DBAliasRow[])
      : [];

    if (!rows.length) return [];

    // 2) Collect unique product IDs
    const productIds = Array.from(
      new Set(
        rows
          .map((r) => r.canonical_product_id)
          .filter((id): id is string => !!id)
      )
    );

    if (!productIds.length) return [];

    // 3) Load product data
    const { data: prodRows, error: prodErr } = await supa
      .from("products")
      .select("id, canonical, name")
      .in("id", productIds);

    if (prodErr) {
      console.warn("[aliases] products load error", prodErr.message);
      return [];
    }

    const products: DBProductRow[] = Array.isArray(prodRows)
      ? (prodRows as DBProductRow[])
      : [];

    // Build product map: product_id → label
    const prodMap = new Map<string, string>();
    for (const p of products) {
      const label =
        (p.canonical && p.canonical.trim()) ||
        (p.name && p.name.trim()) ||
        "";
      if (p.id && label) {
        prodMap.set(p.id, label);
      }
    }

    // Now we scan the text for occurrences of wrong_text
    const hints: Array<{
      wrong: string;
      canonicalProductId: string;
      canonicalLabel: string;
    }> = [];

    const lower = trimmed.toLowerCase();

    for (const row of rows) {
      const aliasText = (row.wrong_text || "").trim().toLowerCase();
      const canonicalProductId = row.canonical_product_id
        ? row.canonical_product_id
        : undefined;

      if (!aliasText || !canonicalProductId) continue;

      const canonicalLabel = prodMap.get(canonicalProductId);
      if (!canonicalLabel) continue;

      // If user text contains this alias text
      if (lower.includes(aliasText)) {
        hints.push({
          wrong: aliasText,
          canonicalProductId,
          canonicalLabel
        });
      }
    }

    return hints;
  } catch (e: any) {
    console.warn("[aliases] getAliasHints catch", e?.message || e);
    return [];
  }
}


// ─────────────────────────────────────────────
// (Optional) Learn alias from a human correction
// For now NO-OP (just log)
// ─────────────────────────────────────────────
export async function learnAliasFromCorrection(args: {
  orgId: string;
  oldCanonical: string | null | undefined;
  newCanonical: string | null | undefined;
}) {
  const { orgId, oldCanonical, newCanonical } = args;
  const alias = (oldCanonical || "").trim();
  const canonical = (newCanonical || "").trim();

  if (!orgId || !alias || !canonical) return;
  if (alias.toLowerCase() === canonical.toLowerCase()) return;

  console.log("[aliases][learnAliasFromCorrection] TODO", {
    orgId,
    alias,
    canonical,
  });
}