import { supa } from "../../db";

// Reuse the same style of normalization you use for fuzzy labels
function normalizeAliasKey(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

type AliasHit = {
  scope: "customer" | "global";
  canonical_product_id: string;
};

/**
 * Resolve alias from customer-level first, then global-level.
 */
export async function resolveAliasForText(opts: {
  org_id: string;
  customer_phone?: string | null;
  wrong_text: string;
}): Promise<AliasHit | null> {
  const { org_id } = opts;
  const phone = (opts.customer_phone || "").trim();
  const key = normalizeAliasKey(opts.wrong_text);
  if (!key) return null;

  try {
    // 1) Customer-level memory
    if (phone) {
      const { data: custRow, error: custErr } = await supa
        .from("customer_aliases")
        .select("canonical_product_id, occurrence_count")
        .eq("org_id", org_id)
        .eq("customer_phone", phone)
        .eq("wrong_text", key)
        .order("occurrence_count", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!custErr && custRow && custRow.canonical_product_id) {
        return {
          scope: "customer",
          canonical_product_id: custRow.canonical_product_id,
        };
      }
    }

    // 2) Global/org-level memory
    const { data: globRow, error: globErr } = await supa
      .from("product_aliases")
      .select("canonical_product_id, occurrence_count")
      .eq("org_id", org_id)
      .eq("wrong_text", key)
      .order("occurrence_count", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!globErr && globRow && globRow.canonical_product_id) {
      return {
        scope: "global",
        canonical_product_id: globRow.canonical_product_id,
      };
    }

    return null;
  } catch (e: any) {
    console.warn("[aliasEngine][resolveAliasForText err]", e?.message || e);
    return null;
  }
}

/**
 * Record that for this customer, this wrong_text actually meant canonical_product_id.
 * We:
 *   - increment occurrence_count on customer_aliases
 *   - after threshold, promote to product_aliases
 */
export async function recordAliasConfirmation(opts: {
  org_id: string;
  customer_phone: string;
  wrong_text: string;
  canonical_product_id: string;
  confidence?: number; // from 0–1, optional
}) {
  const { org_id, canonical_product_id } = opts;
  const phone = opts.customer_phone.trim();
  const key = normalizeAliasKey(opts.wrong_text);
  if (!key || !phone) return;

  const confidence = typeof opts.confidence === "number" ? opts.confidence : 1.0;

  try {
    // 1) CUSTOMER-LEVEL: select → update or insert
    const { data: existing, error: selErr } = await supa
      .from("customer_aliases")
      .select("id, occurrence_count, canonical_product_id")
      .eq("org_id", org_id)
      .eq("customer_phone", phone)
      .eq("wrong_text", key)
      .limit(1)
      .maybeSingle();

    let newCount = 1;

    if (!selErr && existing && existing.id) {
      const occ = typeof existing.occurrence_count === "number"
        ? existing.occurrence_count
        : 0;

      newCount = occ + 1;

      await supa
        .from("customer_aliases")
        .update({
          canonical_product_id,
          occurrence_count: newCount,
        })
        .eq("id", existing.id);
    } else {
      await supa.from("customer_aliases").insert({
        org_id,
        customer_phone: phone,
        wrong_text: key,
        canonical_product_id,
        occurrence_count: newCount,
      });
    }

    // 2) OPTIONAL: Promote to GLOBAL when seen enough times
    const PROMOTE_THRESHOLD = 3;
    if (newCount >= PROMOTE_THRESHOLD) {
      const { data: glob, error: globSelErr } = await supa
        .from("product_aliases")
        .select("id, occurrence_count, canonical_product_id")
        .eq("org_id", org_id)
        .eq("wrong_text", key)
        .limit(1)
        .maybeSingle();

      if (!globSelErr && glob && glob.id) {
        const occ = typeof glob.occurrence_count === "number"
          ? glob.occurrence_count
          : 0;

        await supa
          .from("product_aliases")
          .update({
            canonical_product_id,
            occurrence_count: occ + 1,
            confidence,
          })
          .eq("id", glob.id);
      } else {
        await supa.from("product_aliases").insert({
          org_id,
          wrong_text: key,
          canonical_product_id,
          occurrence_count: 1,
          confidence,
        });
      }
    }
  } catch (e: any) {
    console.warn("[aliasEngine][recordAliasConfirmation err]", e?.message || e);
  }
}