// src/ai/ingest/stateManager.ts

import { supa } from "../../db";
import type { ConversationState } from "./types";

type StateRow = {
  org_id: string;
  customer_phone: string;
  state: string | null;
  updated_at?: string;
};

const STATE_TTL_MIN = Number(process.env.STATE_TTL_MIN || 10);
const STATE_TTL_MS = STATE_TTL_MIN * 60 * 1000;

const VALID_STATES: ConversationState[] = [
  "idle",
  "ordering_item",
  "ordering_variant",
  "ordering_qty",
  "ordering_upsell",

  "confirming_order",
  "cart_edit_menu",
  "cart_edit_item",
  "cart_edit_qty",
  "cart_remove_item",

  "awaiting_fulfillment",
  "awaiting_address",
  "awaiting_location_pin",
  "address_confirm_confirm",

  "awaiting_payment",
  "awaiting_payment_proof",

  "building_order",
  "agent",

  "order_finalised",
  "status",
  "cancel",
  "awaiting_pickup_payment",
  "awaiting_fulfillment",
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
): Promise<{ state: ConversationState; expired: boolean }> {
  const { data, error } = await supa
    .from("ai_conversation_state")
    .select("state, updated_at")
    .eq("org_id", org_id)
    .eq("customer_phone", from_phone)
    .maybeSingle();

  if (!data || error) return { state: "idle", expired: false };

  const lastUpdated = new Date(data.updated_at).getTime();
  const now = Date.now();

  const SESSION_TTL_MS = STATE_TTL_MS; 
  

  // 🔥 AUTO RESET IF IDLE TOO LONG
  if (now - lastUpdated > SESSION_TTL_MS) {
    console.log("[STATE] Expired session → auto reset");

    // Clear state
    await supa
      .from("ai_conversation_state")
      .delete()
      .eq("org_id", org_id)
      .eq("customer_phone", from_phone);

    // Clear temp cart & flow memory
    await supa
      .from("temp_selected_items")
      .delete()
      .eq("org_id", org_id)
      .eq("customer_phone", from_phone);

      return { state: "idle", expired: true };
  }

  return { state: asState((data as any).state), expired: false };
}

export async function setState(
  org_id: string,
  from_phone: string,
  state: ConversationState
): Promise<void> {
  const { error } = await supa
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

  if (error) {
    console.error("[STATE][SET][ERROR]", { org_id, from_phone, state, error });
  }
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