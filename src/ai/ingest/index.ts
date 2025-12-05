// src/ai/ingest/index.ts
import { getState, clearState } from "./stateManager";
// import { handleCatalogFlow } from "./orderEngine";
import { handleAddress } from "./addressEngine";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { handlePayment } from "./paymentEngine";
import { handleStatus } from "./statusEngine";
import { handleCancel } from "./cancelEngine";
import { handleFinalConfirmation } from "./finalConfirmationEngine";
import { handleCatalogFallbackFlow as handleCatalogFlow } from "./orderLegacyEngine";
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

// vertical reader
async function getOrgVertical(org_id: string): Promise<Vertical> {
  const { data } = await supa
    .from("orgs")
    .select("business_type")
    .eq("id", org_id)
    .maybeSingle();

  const t = (data?.business_type || "").toLowerCase();
  if (t.includes("restaurant")) return "restaurant";
  if (t.includes("grocery")) return "grocery";
  if (t.includes("salon")) return "salon";
  if (t.includes("pharmacy")) return "pharmacy";
  return "generic";
}

export async function ingestCoreFromMessage(
  ctx: IngestContext
): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;
  const raw = (text || "").trim();
  const lower = raw.toLowerCase();

  const state = await getState(org_id, from_phone);
  console.log("[AI][INGEST][PRE]", { org_id, from_phone, text, state });

  // ───────────────────────────────────────────────
  // MANUAL MODE CHECK — Stop AI immediately
  // ───────────────────────────────────────────────
  try {
    const phoneKey = from_phone.replace(/[^\d]/g, "");

    const { data: cust, error: custErr } = await supa
      .from("org_customer_settings")
      .select("manual_mode, manual_mode_until")
      .eq("org_id", org_id)
      .eq("customer_phone", phoneKey)
      .maybeSingle();

    if (!custErr && cust?.manual_mode) {
      const until = cust.manual_mode_until
        ? new Date(cust.manual_mode_until).getTime()
        : null;
      const now = Date.now();

      // Manual mode still active?
      if (!until || until > now) {
        return {
          used: false, // AI NOT used
          kind: "manual_mode", // internal helper type
          reply: null, // DO NOT auto-reply
          order_id: null,
        };
      }
    }
  } catch (e) {
    console.warn("[AI][MANUAL_MODE_CHECK][ERR]", e);
  }

  // RESET
  if (RESET_WORDS.includes(lower)) {
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "smalltalk",
      reply: "🔄 Order reset. Please type your item name again.",
      order_id: null,
    };
  }

  // ADDRESS ENGINE
  if (state === "awaiting_address" || state === "awaiting_location_pin") {
    return handleAddress(ctx, state);
  }

  // PAYMENT
  if (state === "awaiting_payment") return handlePayment(ctx);

  // FINAL CONFIRM / CART EDIT
  if (
    state === "confirming_order" ||
    state === "cart_edit_item" ||
    state === "cart_edit_qty" ||
    state === "cart_remove_item"
  ) {
    return handleFinalConfirmation(ctx, state);
  }

  // STATUS
  if (STATUS_WORDS.some((k) => lower.includes(k))) {
    return handleStatus(ctx);
  }

  // CANCEL
  if (CANCEL_WORDS.some((k) => lower.includes(k))) {
    return handleCancel(ctx);
  }

  // INSIDE ORDERING FLOW
  if (isOrderingState(state)) {
    const vertical = await getOrgVertical(org_id);
    const intent = await parseIntent(raw, { vertical, state });

    console.log("[AI][INGEST][INTENT][ORDERING]", {
      vertical,
      state,
      intent,
    });

    return handleCatalogFlow({ ...ctx, intent }, state);
  }

  // -----------------------------
  // IDLE STATE
  // -----------------------------

  // GREETINGS
  if (
    ["hi", "hello", "hey", "yo"].includes(lower) ||
    lower.startsWith("hi ") ||
    lower.startsWith("hello ")
  ) {
    return {
      used: true,
      kind: "greeting",
      reply:
        "👋 Hello! I’m your Human-AI assistant — here to take your order smoothly.\n" +
        "You can ask for anything or just send item names directly.\n" +
        "To restart at any time, type back or cancel.",
      order_id: null,
    };
  }

  // SMALLTALK
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

  // ➤ Parse intent (REAL variable declared here)
  const vertical = await getOrgVertical(org_id);
  const intent = await parseIntent(raw, { vertical, state });

  console.log("[AI][INGEST][INTENT][IDLE]", {
    vertical,
    state,
    intent,
  });

  // DEFAULT → legacy engine
  return handleCatalogFlow({ ...ctx, intent }, "idle");
}
