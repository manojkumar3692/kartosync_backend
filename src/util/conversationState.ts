// src/util/conversationState.ts
import { supa } from "../db";

/**
 * Conversation state is stored in `org_customer_settings`.
 *
 * You should have these (nullable) columns added:
 *
 *  - conversation_stage  text
 *  - active_order_id     uuid
 *  - last_action         text
 *  - last_stage_at       timestamptz
 *  - conversation_meta   jsonb
 *
 * Existing columns like `auto_reply_enabled`, `last_inquiry_*` remain as-is.
 */

export type ConversationStage =
  | "idle"
  | "building_order"          // order exists, items being added/edited
  | "awaiting_clarification"  // variant clarification in progress
  | "awaiting_address"        // waiting for delivery address
  | "post_order";             // order confirmed / done

export interface ConversationState {
  stage: ConversationStage;
  active_order_id: string | null;
  last_action: string | null;
  last_stage_at: string | null;
  meta: any | null;
}

// Local normaliser (duplicated from waba, but independent to avoid cycles)
function normalizePhoneForKey(raw: string): string {
  return String(raw || "").replace(/[^\d]/g, "");
}

export async function getConversationState(
  orgId: string,
  phoneRaw: string
): Promise<ConversationState | null> {
  const phoneKey = normalizePhoneForKey(phoneRaw);
  if (!phoneKey) return null;

  try {
    const { data, error } = await supa
      .from("org_customer_settings")
      .select(
        "conversation_stage, conversation_meta, active_order_id, last_action, last_stage_at"
      )
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey)
      .maybeSingle();

    if (error) {
      console.warn("[CONV_STATE][get error]", error.message);
      return null;
    }
    if (!data) return null;

    const stage =
      (data.conversation_stage as ConversationStage | null) || "idle";

    return {
      stage,
      active_order_id: (data.active_order_id as string | null) || null,
      last_action: (data.last_action as string | null) || null,
      last_stage_at: (data.last_stage_at as string | null) || null,
      meta: data.conversation_meta ?? null,
    };
  } catch (e: any) {
    console.warn("[CONV_STATE][get catch]", e?.message || e);
    return null;
  }
}

interface StagePayload {
  active_order_id?: string | null;
  last_action?: string | null;
  meta?: any;
}

export async function setConversationStage(
  orgId: string,
  phoneRaw: string,
  stage: ConversationStage,
  payload: StagePayload = {}
): Promise<void> {
  const phoneKey = normalizePhoneForKey(phoneRaw);
  if (!phoneKey) return;

  const patch: any = {
    org_id: orgId,
    customer_phone: phoneKey,
    conversation_stage: stage,
    last_stage_at: new Date().toISOString(),
  };

  if ("active_order_id" in payload) {
    patch.active_order_id = payload.active_order_id;
  }
  if ("last_action" in payload) {
    patch.last_action = payload.last_action;
  }
  if ("meta" in payload) {
    patch.conversation_meta = payload.meta;
  }

  try {
    await supa.from("org_customer_settings").upsert(patch, {
      onConflict: "org_id,customer_phone",
    });
  } catch (e: any) {
    console.warn("[CONV_STATE][set catch]", e?.message || e);
  }
}

export async function clearConversationStage(
  orgId: string,
  phoneRaw: string
): Promise<void> {
  await setConversationStage(orgId, phoneRaw, "idle", {
    active_order_id: null,
    last_action: "cleared",
  });
}