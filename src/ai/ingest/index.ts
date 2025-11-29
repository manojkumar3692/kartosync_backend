// src/ai/ingest/index.ts

import { getState, clearState } from "./stateManager";
import { handleCatalogFlow } from "./orderEngine";
import { handleAddress } from "./addressEngine";
import type { IngestContext, IngestResult, ConversationState } from "./types";

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
  if (state === "awaiting_address") {
    console.log("[AI][INGEST] → forwarding to addressEngine");
    return handleAddress(ctx, state);
  }

  // 4) ORDER FLOW STATES — ordering_item / ordering_variant / ordering_qty
  if (isOrderingState(state)) {
    console.log("[AI][INGEST] → inside ordering flow");
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
  console.log("[AI][INGEST] → idle → catalogFlow");
  return handleCatalogFlow(ctx, "idle");
}