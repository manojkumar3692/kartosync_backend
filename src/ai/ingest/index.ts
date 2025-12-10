// src/ai/ingest/index.ts
import { getState, clearState } from "./stateManager";
import { handleAddress } from "./addressEngine";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { handlePayment } from "./paymentEngine";
import { handleStatus } from "./statusEngine";
import { handleCancel } from "./cancelEngine";
import { handleFinalConfirmation } from "./finalConfirmationEngine";
import { handleCatalogFallbackFlow as handleCatalogFlow } from "./orderLegacyEngine";
import { parseIntent, type Vertical } from "./intentEngine";
import { supa } from "../../db";

// 🔤 NEW: language + alias helpers
import { normalizeCustomerText } from "../lang/normalize";
import { detectAndTranslate } from "../lang/detectTranslate";
import { getAliasHints } from "../aliases";

// ORDERING FLOW STATES
function isOrderingState(state: ConversationState): boolean {
  return (
    state === "ordering_item" ||
    state === "ordering_variant" ||
    state === "ordering_qty"
  );
}

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

const GREETING_WORDS = [
  "hi",
  "hello",
  "hey",
  "yo",
  "hola",
  "vanakkam",
  "namaste",
  "gm",
  "good morning",
  "good afternoon",
  "good evening",
];

const GREETING_FILLERS = [
  "bro",
  "dear",
  "sir",
  "team",
  "anna",
  "machi",
];

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
  const lowerRaw = raw.toLowerCase();

  const state = await getState(org_id, from_phone);
  console.log("[AI][INGEST][PRE]", { org_id, from_phone, text, state });

  // ------------------------------------------------------
  // MANUAL MODE CHECK
  // ------------------------------------------------------
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

      if (!until || until > now) {
        return {
          used: false,
          kind: "manual_mode",
          reply: null,
          order_id: null,
        };
      }
    }
  } catch (e) {
    console.warn("[AI][MANUAL_MODE_CHECK][ERR]", e);
  }

  // RESET
  if (RESET_WORDS.includes(lowerRaw)) {
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "smalltalk",
      reply: "🔄 Order reset. Please type your item name again.",
      order_id: null,
    };
  }

  // ADDRESS
  if (state === "awaiting_address" || state === "awaiting_location_pin") {
    return handleAddress(ctx, state);
  }

  // PAYMENT
  if (state === "awaiting_payment") return handlePayment(ctx);

  // FINAL CONFIRM
  if (
    state === "confirming_order" ||
    state === "cart_edit_item" ||
    state === "cart_edit_qty" ||
    state === "cart_remove_item"
  ) {
    return handleFinalConfirmation(ctx, state);
  }

  // STATUS
  if (STATUS_WORDS.some((k) => lowerRaw.includes(k))) {
    return handleStatus(ctx);
  }

  // CANCEL
  if (CANCEL_WORDS.some((k) => lowerRaw.includes(k))) {
    return handleCancel(ctx);
  }

  // ------------------------------------------------------
  // INSIDE ORDERING FLOW
  // ------------------------------------------------------
  if (isOrderingState(state)) {
    let intentText = raw;

    if (raw) {
      try {
        console.log("[AI][LANG][ORDERING][RAW]", { org_id, from_phone, text: raw });

        const { detected_lang, translated_text } = await detectAndTranslate(raw);
        const normalized = normalizeCustomerText(translated_text);

        const aliasHints = await getAliasHints(org_id, normalized);

        intentText = normalized;

        console.log("[AI][LANG][ORDERING][NORM]", {
          org_id,
          from_phone,
          detected_lang,
          norm_preview: intentText.slice(0, 160),
          aliasHints,
        });
      } catch (e: any) {
        console.warn("[AI][LANG][ORDERING][ERR]", e?.message || String(e));
        intentText = raw;
      }
    }

    const vertical = await getOrgVertical(org_id);
    const intent = await parseIntent(intentText, { vertical, state });

    console.log("[AI][INGEST][INTENT][ORDERING]", { vertical, state, intent });

    return handleCatalogFlow({ ...ctx, intent }, state);
  }

  // ------------------------------------------------------
  // IDLE STATE
  // ------------------------------------------------------

  // Greetings (only if it's basically just a greeting)
  const tokens = lowerRaw.split(/\s+/).filter(Boolean);

  const isPureGreeting =
    // exact match with a greeting phrase
    GREETING_WORDS.some((w) => lowerRaw === w) ||
    // short messages (<= 3 words) like "hi bro", "hello sir", "hi team"
    (
      tokens.length > 0 &&
      tokens.length <= 3 &&
      GREETING_WORDS.includes(tokens[0]) &&
      tokens.slice(1).every((t) => GREETING_FILLERS.includes(t))
    );

  if (isPureGreeting) {
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

  // Smalltalk
  if (
    ["ok", "thanks", "thank you", "tnx"].includes(lowerRaw) ||
    lowerRaw.includes("thank")
  ) {
    return {
      used: true,
      kind: "smalltalk",
      reply: "👍 Sure! You can send your order whenever you're ready.",
      order_id: null,
    };
  }

  // IDLE TEXT → normalize & alias hints
  let idleIntentText = raw;
  if (raw) {
    try {
      console.log("[AI][LANG][IDLE][RAW]", { org_id, from_phone, text: raw });

      const { detected_lang, translated_text } = await detectAndTranslate(raw);
      const normalized = normalizeCustomerText(translated_text);

      const aliasHints = await getAliasHints(org_id, normalized);

      idleIntentText = normalized;

      console.log("[AI][LANG][IDLE][NORM]", {
        org_id,
        from_phone,
        detected_lang,
        norm_preview: idleIntentText.slice(0, 160),
        aliasHints,
      });
    } catch (e: any) {
      console.warn("[AI][LANG][IDLE][ERR]", e?.message || String(e));
      idleIntentText = raw;
    }
  }

  const vertical = await getOrgVertical(org_id);
  let intent = await parseIntent(idleIntentText, { vertical, state });

  // 🛡 Guard: don't treat messages with NO digits as multi-item "add_items"
  if (intent.intent === "add_items" && !/\d/.test(idleIntentText)) {
    console.log("[AI][INGEST][INTENT][IDLE][DOWNGRADE_ADD_ITEMS_NO_DIGITS]", {
      idleIntentText,
      intentBefore: intent,
    });

    intent = {
      ...intent,
      intent: "unknown",
      lines: null,
      ruleTag: (intent.ruleTag || "") + "|DOWNGRADED_NO_DIGITS",
    };
  }

  console.log("[AI][INGEST][INTENT][IDLE]", { vertical, state, intent });

  return handleCatalogFlow({ ...ctx, intent }, "idle");
}