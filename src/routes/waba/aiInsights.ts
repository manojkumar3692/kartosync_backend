// src/routes/waba/aiInsights.ts
import { supa } from "../../db";

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