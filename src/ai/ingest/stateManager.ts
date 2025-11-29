// src/ai/ingest/stateManager.ts

import { supa } from "../../db";
import type { ConversationState } from "./types";

type StateRow = {
  org_id: string;
  customer_phone: string;
  state: string | null;
  updated_at?: string;
};

const VALID_STATES: ConversationState[] = [
  "idle",
  "ordering_item",
  "ordering_variant",
  "ordering_qty",
  "awaiting_address",   // 👈 add this
];

function asState(s: string | null | undefined): ConversationState {
  if (!s) return "idle";
  if (VALID_STATES.includes(s as ConversationState)) {
    return s as ConversationState;
  }
  return "idle";
}

export async function getState(
  org_id: string,
  from_phone: string
): Promise<ConversationState> {
  const { data, error } = await supa
    .from("ai_conversation_state")        // ❌ no generic here
    .select("state")
    .eq("org_id", org_id)
    .eq("customer_phone", from_phone)
    .maybeSingle();

  if (error || !data) return "idle";
  return asState((data as StateRow).state);
}

export async function setState(
  org_id: string,
  from_phone: string,
  state: ConversationState
): Promise<void> {
  await supa
  .from("ai_conversation_state")   
    .upsert(
      {
        org_id,
        customer_phone: from_phone,
        state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,customer_phone" }
    );
}

export async function clearState(
  org_id: string,
  from_phone: string
): Promise<void> {
  await supa
    .from("ai_conversation_state")   
    .delete()
    .eq("org_id", org_id)
    .eq("customer_phone", from_phone);
}