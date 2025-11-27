// src/routes/waba/aiInsights.ts
import { supa } from "../../db";
import { normalizeAliasKey } from "./aliasEngine";

export async function saveAiInsight(opts: {
  orgId: string;
  phoneKey: string;          // normalized phone
  msgId?: string;
  msgAt?: Date;
  interpretation: any;       // type from interpretMessage
}) {
  const { orgId, phoneKey, msgId, msgAt, interpretation } = opts;

  const intent: string | null =
    (interpretation && interpretation.intent) || null;
  const confidence: number | null =
    typeof interpretation?.confidence === "number"
      ? interpretation.confidence
      : null;
  const summary: string | null =
    typeof interpretation?.summary === "string"
      ? interpretation.summary
      : null;

  const now = msgAt ? msgAt.toISOString() : new Date().toISOString();

  try {
    const { error } = await supa
      .from("waba_ai_insights")
      .upsert(
        {
          org_id: orgId,
          customer_phone: phoneKey,
          last_msg_id: msgId || null,
          last_msg_at: now,
          intent,
          confidence,
          summary,
          raw: interpretation ?? null,
          updated_at: now,
        },
        { onConflict: "org_id,customer_phone" }
      );

    if (error) {
      console.warn("[AI_INSIGHT][UPSERT_ERR]", error.message);
    }
  } catch (e: any) {
    console.warn("[AI_INSIGHT][UPSERT_EX]", e?.message || e);
  }
}


export async function recordVariantAlias(opts: {
  org_id: string;
  customer_phone: string;
  wrong_text: string;
  canonical_product_id: string;
  variant: string;
}) {
  const { org_id, canonical_product_id, variant } = opts;
  const phone = opts.customer_phone.trim();
  const key = normalizeAliasKey(opts.wrong_text);
  if (!key || !phone) return;

  try {
    // 1) CUSTOMER-LEVEL
    const { data: existing } = await supa
      .from("customer_aliases")
      .select("id, occurrence_count")
      .eq("org_id", org_id)
      .eq("customer_phone", phone)
      .eq("wrong_text", key)
      .limit(1)
      .maybeSingle();

    if (existing) {
      await supa
        .from("customer_aliases")
        .update({
          canonical_product_id,
          variant_name: variant,
          occurrence_count: existing.occurrence_count + 1,
        })
        .eq("id", existing.id);
    } else {
      await supa.from("customer_aliases").insert({
        org_id,
        customer_phone: phone,
        wrong_text: key,
        canonical_product_id,
        variant_name: variant,
        occurrence_count: 1,
      });
    }

    // 2) Promote to GLOBAL
    const { data: global } = await supa
      .from("product_aliases")
      .select("id, occurrence_count")
      .eq("org_id", org_id)
      .eq("wrong_text", key)
      .limit(1)
      .maybeSingle();

    if (global) {
      await supa
        .from("product_aliases")
        .update({
          canonical_product_id,
          variant_name: variant,
          occurrence_count: global.occurrence_count + 1,
        })
        .eq("id", global.id);
    } else {
      await supa.from("product_aliases").insert({
        org_id,
        wrong_text: key,
        canonical_product_id,
        variant_name: variant,
        occurrence_count: 1,
      });
    }
  } catch (e: any) {
    console.warn("[aliasEngine][recordVariantAlias err]", e?.message || e);
  }
}