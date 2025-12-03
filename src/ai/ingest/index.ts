// src/ai/ingest/index.ts

import { getState, clearState } from "./stateManager";
import { handleCatalogFlow } from "./orderEngine";
import { handleAddress } from "./addressEngine";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { handlePayment } from "./paymentEngine";
import { handleStatus } from "./statusEngine";
import { handleCancel } from "./cancelEngine";
import { handleFinalConfirmation } from "./finalConfirmationEngine";

// 🆕 Generic intent engine + vertical helper
import { parseIntent, type Vertical } from "./intentEngine";
import { supa } from "../../db";

// ORDERING FLOW STATES
function isOrderingState(state: ConversationState): boolean {
  return (
    state === "ordering_item" ||
    state === "ordering_variant" ||
    state === "ordering_qty"
  );
}

// RESET keywords
const RESET_WORDS = ["reset", "start again", "new order", "clear"];

const STATUS_WORDS = [
  "status",
  "order status",
  "track",
  "tracking",
  "where is my order",
];

const CANCEL_WORDS = [
  "cancel",
  "cancel order",
  "dont send",
  "don't send",
  "cancel my order",
];

// 🆕 Helper: map org.business_type → vertical
async function getOrgVertical(org_id: string): Promise<Vertical> {
  const { data } = await supa
    .from("orgs")
    .select("business_type")
    .eq("id", org_id)
    .maybeSingle();

  const t = (data?.business_type || "").toLowerCase();

  if (t.includes("restaurant") || t.includes("cloud_kitchen")) return "restaurant";
  if (t.includes("grocery") || t.includes("supermarket")) return "grocery";
  if (t.includes("salon") || t.includes("spa")) return "salon";
  if (t.includes("pharmacy") || t.includes("medical")) return "pharmacy";

  return "generic";
}

export async function ingestCoreFromMessage(
  ctx: IngestContext
): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;
  const raw = (text || "").trim();
  const lower = raw.toLowerCase();

  // 1) Get DB state
  const state = await getState(org_id, from_phone);
  console.log("[AI][INGEST][PRE]", { org_id, from_phone, text, state });

  // 2) Hard reset handler
  if (RESET_WORDS.includes(lower)) {
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "smalltalk",
      reply: "🔄 Order reset. Please type your item name again.",
      order_id: null,
    };
  }

  // 3) ADDRESS WAIT STATE — MUST interrupt everything
  if (state === "awaiting_address" || state === "awaiting_location_pin") {
    console.log("[AI][INGEST] → forwarding to addressEngine");
    return handleAddress(ctx, state);
  }

  // 3.5 Handle Payment Feature
  if (state === "awaiting_payment") {
    return await handlePayment(ctx);
  }

  // 3.7 Final confirmation + cart edit states
  if (
    state === "confirming_order" ||
    state === "cart_edit_item" ||
    state === "cart_edit_qty" ||
    state === "cart_remove_item"
  ) {
    return await handleFinalConfirmation(ctx, state);
  }

  // 3.8 STATUS KEYWORDS (global)
  if (STATUS_WORDS.some((k) => lower.includes(k))) {
    return await handleStatus(ctx);
  }

  // 3.9 CANCEL KEYWORDS (global)
  if (CANCEL_WORDS.some((k) => lower.includes(k))) {
    return await handleCancel(ctx);
  }

  // 4) ORDER FLOW STATES — ordering_item / ordering_variant / ordering_qty
  if (isOrderingState(state)) {
    console.log("[AI][INGEST] → inside ordering flow");

    // 🆕: parse intent (for logging / future use)
    try {
      const vertical = await getOrgVertical(org_id);
      const intent = await parseIntent(raw, { vertical, state });
      console.log("[AI][INGEST][INTENT][ORDERING]", {
        vertical,
        state,
        intent,
      });
    } catch (e) {
      console.log("[AI][INGEST][INTENT][ORDERING][ERROR]", (e as Error).message);
    }

    // Behaviour unchanged: still route to catalog flow with state
    return handleCatalogFlow(ctx, state);
  }

  // 5) IDLE STATE (initial interaction only)

  // GREETING
  if (
    ["hi", "hello", "hey", "yo"].includes(lower) ||
    lower.startsWith("hi ") ||
    lower.startsWith("hello ")
  ) {
    return {
      used: true,
      kind: "greeting",
      reply: "👋 Hello! How can I help you today?",
      order_id: null,
    };
  }

  // SMALLTALK / ACK
  if (
    ["ok", "thanks", "thank you", "tnx"].includes(lower) ||
    lower.includes("thank")
  ) {
    return {
      used: true,
      kind: "smalltalk",
      reply: "👍 Sure! You can send your order whenever you're ready.",
      order_id: null,
    };
  }

  // 6) EVERYTHING ELSE → go to order engine
  console.log("[AI][INGEST] → idle → intent + catalogFlow");

  // 🆕: parse intent also in idle, but only for logging right now
  try {
    const vertical = await getOrgVertical(org_id);
    const intent = await parseIntent(raw, { vertical, state });
    console.log("[AI][INGEST][INTENT][IDLE]", {
      vertical,
      state,
      intent,
    });
  } catch (e) {
    console.log("[AI][INGEST][INTENT][IDLE][ERROR]", (e as Error).message);
  }

  return handleCatalogFlow(ctx, "idle"); 
}