// src/ai/ingest/index.ts
import { getState, clearState, setState } from "./stateManager";
import { handleAddress } from "./addressEngine";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { handlePayment } from "./paymentEngine";
import { handleFulfillment } from "./fulfillmentEngine";
import { handleStatus } from "./statusEngine";
import { handleCancel } from "./cancelEngine";
import { handleFinalConfirmation } from "./finalConfirmationEngine";
import { handleCatalogFallbackFlow as handleCatalogFlow } from "./orderLegacyEngine";
import { parseIntent, type Vertical } from "./intentEngine";
import { supa } from "../../db";
import { routeIntent, learnOverride, type IntentLane } from "./intentRouter";
import {
  handleServiceLaneAndReply,
  type ServiceLane,
} from "./serviceIntentEngine";
import { normalizeCustomerText } from "../lang/normalize";
import { detectAndTranslate } from "../lang/detectTranslate";
import { getAliasHints } from "../aliases";
import { createRazorpayPaymentLink } from "../../payments/razorpay";

console.log("🔥🔥 INGEST INDEX.TS RUNNING v999");

function isCorrectionMessage(t: string) {
  const s = (t || "").toLowerCase();

  // English
  if (
    (s.startsWith("no") &&
      (s.includes("i asked") ||
        s.includes("i meant") ||
        s.includes("wrong") ||
        s.includes("not that"))) ||
    s.includes("not that") ||
    s.includes("wrong") ||
    s.includes("i asked") ||
    s.includes("i meant") ||
    s.includes("i was asking")
  )
    return true;

  // Tamil common “correction” patterns (romanized)
  if (
    s.includes("illa") || // no
    s.includes("athu illa") || // not that
    s.includes("keten") || // i asked
    s.includes("kett") || // asked (variants)
    s.includes("nu keten") || // i asked that
    s.includes("naan keten") // i asked
  )
    return true;

  return false;
}

const OPEN_ORDER_STATUSES = [
  "draft",
  "pending",
  "pending_payment",
  "awaiting_payment_or_method",
  "awaiting_fulfillment",
  "awaiting_payment",
  "awaiting_payment_proof",
  "awaiting_pickup_payment",
  "awaiting_customer_action",
] as const;

const PENDING_FULFILLMENT_STATUSES = [
  "awaiting_customer_action",
  "awaiting_store_action",
] as const;

const normalizePhone = (p: string) => (p || "").replace(/[^\d]/g, "");

async function getLastIntentEvent(
  orgId: string,
  customerPhone: string,
  offset = 0
) {
  const { data } = await supa
    .from("org_intent_events")
    .select("id, normalized_text, decided_intent, created_at")
    .eq("org_id", orgId)
    .eq("customer_phone", customerPhone)
    .order("created_at", { ascending: false })
    .range(offset, offset); // ✅ offset 0 = latest, 1 = previous

  return data && data[0] ? (data[0] as any) : null;
}

// ORDERING FLOW STATES
function isOrderingState(state: ConversationState): boolean {
  return (
    state === "ordering_item" ||
    state === "ordering_variant" ||
    state === "ordering_qty" ||
    state === "ordering_upsell"
  );
}

const RESET_WORDS = [
  "reset",
  "restart",
  "start over",
  "start again",
  "new order",
  "clear",
  "clear all",
  "fresh start",
];

const BACK_WORDS = ["back", "go back", "exit"];

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

const GREETING_FILLERS = ["bro", "dear", "sir", "team", "anna", "machi"];

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
  const { state, expired } = await getState(org_id, from_phone);
  console.log("[AI][INGEST][PRE]", { org_id, from_phone, text, state });

  // ✅ SESSION EXPIRED MESSAGE
if (expired) {
  const ttl = Number(process.env.STATE_TTL_MIN || 15);

  return {
    used: true,
    kind: "smalltalk",
    order_id: null,
    reply:
      `⏱️ No activity for ${ttl} minutes, so I restarted your session.\n` +
      `Please type the product name again to start fresh 😊`,
  };
}

  // ------------------------------------------------------
  // MANUAL MODE CHECK
  // ------------------------------------------------------
  try {
    const phoneKey = normalizePhone(from_phone);

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

// ✅ GLOBAL ESCAPE HATCH (works in ANY state)
if (
  RESET_WORDS.some((k) => lowerRaw.includes(k)) ||
  CANCEL_WORDS.some((k) => lowerRaw.includes(k)) ||
  BACK_WORDS.some((k) => lowerRaw === k || lowerRaw.includes(k))
) {
  return handleCancel({ ...ctx, text: raw });
}

  // FULFILLMENT (restaurant)
  if (state === "awaiting_fulfillment") {
    return handleFulfillment({
      ...ctx,
      vertical: await getOrgVertical(org_id),
    });
  }

  // ADDRESS
  if (state === "awaiting_address" || state === "awaiting_location_pin") {
    return handleAddress(ctx, state);
  }

  // PAYMENT
  if (state === "awaiting_payment") {
    // ✅ allow cancelling the order (not just changing payment method)
    if (CANCEL_WORDS.some((k) => lowerRaw.includes(k))) {
      return handleCancel(ctx);
    }

    return handlePayment(ctx);
  }

  if (state === "awaiting_payment_proof") {
    const lower = (raw || "").trim().toLowerCase();

    // cancel my order -> real cancel
    if (CANCEL_WORDS.some((k) => lower.includes(k))) {
      return handleCancel(ctx);
    }

    // ✅ Allow cancel/reset to escape this stuck state
    if (["cancel", "reset", "back", "start again"].includes(lower)) {
      await setState(org_id, from_phone, "awaiting_payment"); // go back to Cash/Online menu
      return {
        used: true,
        kind: "payment",
        order_id: null,
        reply:
          "✅ Okay — payment step cancelled.\n\n" +
          "How would you like to pay?\n" +
          "1) Cash\n" +
          "2) Online Payment\n\n" +
          "Please type *1* or *2*.",
      };
    }

    // simple UX: let user say "paid" but real truth comes from webhook / store verification
    if (["paid", "done", "payment done", "completed"].includes(lower)) {
      return {
        used: true,
        kind: "payment",
        order_id: null,
        reply:
          "✅ Got it. We’re verifying your payment now. You’ll receive confirmation shortly.",
      };
    }

    const phoneKey = normalizePhone(from_phone);

    // Load latest open order
    const { data: order } = await supa
      .from("orders")
      .select("id, razorpay_payment_link_url, payment_status, payment_provider")
      .eq("org_id", org_id)
      .eq("source_phone", phoneKey)
      .in("status", OPEN_ORDER_STATUSES as any)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (order?.payment_status === "paid") {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "payment",
        order_id: order.id,
        reply: "✅ Payment already received.",
      };
    }

    // ✅ If no Razorpay link, fall back to QR (your current online mode)
    const { data: orgRow } = await supa
      .from("orgs")
      .select("payment_qr_url, payment_instructions")
      .eq("id", org_id)
      .maybeSingle();

    const qrUrl = orgRow?.payment_qr_url || null;
    const note = (orgRow?.payment_instructions || "").trim();

    // 1) Razorpay link exists → show it
    if (order?.razorpay_payment_link_url) {
      return {
        used: true,
        kind: "payment",
        order_id: order.id,
        reply:
          "💳 Your payment is pending.\n" +
          "Please pay using this link:\n" +
          `*${order.razorpay_payment_link_url}*\n\n` +
          "After payment, send screenshot here or type *paid*.\n" +
          "Type *cancel* to change payment method.",
      };
    }

    // 2) QR exists → show QR instead of “Payment link not found”
    if (qrUrl) {
      return {
        used: true,
        kind: "payment",
        order_id: order?.id || null,
        reply:
          "💳 Your payment is pending.\n" +
          "📷 Please scan the QR code to complete payment.\n" +
          (note ? `\n${note}\n` : "\n") +
          "After payment, send screenshot here or type *paid*.\n" +
          "Type *cancel* to change payment method.",
        image: qrUrl,
      };
    }

    // 3) Nothing configured → honest fallback
    return {
      used: true,
      kind: "payment",
      order_id: order?.id || null,
      reply:
        "💳 Your payment is pending, but payment details are not configured.\n" +
        "Type *cancel* to switch to Cash, or contact the store.",
    };
  }

  // PICKUP PAYMENT (Razorpay – restaurant only)
  if (state === "awaiting_pickup_payment") {
    const lowerRaw = (raw || "").trim().toLowerCase();

    // ✅ map menu numbers to actions
    const lower =
      lowerRaw === "1"
        ? "resend"
        : lowerRaw === "2"
        ? "paid"
        : lowerRaw === "3"
        ? "cancel"
        : lowerRaw;

    // 1) Allow cancel
    if (lower === "cancel" || lower.includes("cancel")) {
      const phoneKey = normalizePhone(from_phone);

      const { data: ord } = await supa
        .from("orders")
        .select("id")
        .eq("org_id", org_id)
        .eq("source_phone", phoneKey)
        .in("status", OPEN_ORDER_STATUSES as any)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (ord?.id) {
        await supa
          .from("orders")
          .update({ status: "cancelled" })
          .eq("id", ord.id);
      }

      await clearState(org_id, from_phone);

      return {
        used: true,
        kind: "order",
        order_id: ord?.id || null,
        reply:
          "❌ Okay, your order is cancelled. You can start a new order now.",
      };
    }

    // 2) If user says paid (we still depend on webhook for truth)
    if (["paid", "done", "payment done", "completed"].includes(lower)) {
      const phoneKey = normalizePhone(from_phone);

      const { data: o } = await supa
        .from("orders")
        .select("id, payment_status, razorpay_payment_link_url, created_at")
        .eq("org_id", org_id)
        .eq("source_phone", phoneKey)
        .in("status", OPEN_ORDER_STATUSES as any)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (o?.payment_status === "paid") {
        await clearState(org_id, from_phone);
        return {
          used: true,
          kind: "order",
          order_id: o.id,
          reply:
            "✅ Payment confirmed!\n" +
            "You’ll receive pickup confirmation details shortly.",
        };
      }

      // Not paid yet -> honest response + quick actions
      return {
        used: true,
        kind: "order",
        order_id: o?.id || null,
        reply:
          "⏳ I haven’t received the payment confirmation yet.\n" +
          "Usually it takes 10–60 seconds.\n\n" +
          (o?.razorpay_payment_link_url
            ? "If you haven’t paid, use this link:\n" +
              `*${o.razorpay_payment_link_url}*\n\n`
            : "") +
          "Reply with one option:\n" +
          "1) *resend*\n" +
          "3) *cancel*",
      };
    }
    const phoneKey = normalizePhone(from_phone);

    // 3) Load latest pending order + stored link
    const { data: order } = await supa
      .from("orders")
      .select(
        "id, razorpay_payment_link_url, razorpay_payment_link_id, total_amount, payment_status, created_at"
      )
      .eq("org_id", org_id)
      .eq("source_phone", phoneKey)
      .in("status", OPEN_ORDER_STATUSES as any)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // ✅ OPTIONAL TIMEOUT (put it HERE)
    const createdAt = order?.created_at
      ? new Date(order.created_at).getTime()
      : null;
    const isStale = createdAt ? Date.now() - createdAt > 10 * 60 * 1000 : false;

    if (isStale && order?.payment_status !== "paid") {
      await supa
        .from("orders")
        .update({ status: "cancelled" })
        .eq("id", order.id);
      await clearState(org_id, from_phone);

      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply:
          "⏳ Payment time expired, so this order was cancelled. Please place a new order.",
      };
    }

    // Already paid?
    if (order?.payment_status === "paid") {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply:
          "✅ Payment already received. Please wait for pickup confirmation message.",
      };
    }

    // 4) Resend existing link if available
    if (lower === "resend" || lower === "pay link" || lower === "link") {
      if (order?.razorpay_payment_link_url) {
        return {
          used: true,
          kind: "order",
          order_id: order.id,
          reply:
            "💳 Please pay using this link:\n" +
            `*${order.razorpay_payment_link_url}*\n\n` +
            "After payment, you’ll automatically receive pickup confirmation.",
        };
      }
    }

    // 5) Regenerate link if missing OR user asks explicitly
    const wantsNewLink = ["new link", "regenerate", "create link"].includes(
      lower
    );
    const missingLink = !order?.razorpay_payment_link_url;

    if ((wantsNewLink || missingLink) && order?.id) {
      try {
        const amount = Number(order.total_amount || 0);
        if (!amount || amount <= 0)
          throw new Error("Invalid amount for payment link");

        const pl = await createRazorpayPaymentLink({
          org_id,
          order_id: order.id,
          amount_inr: amount,
          customer_phone: normalizePhone(from_phone),
        });

        await supa
          .from("orders")
          .update({
            payment_provider: "razorpay",
            payment_status: "unpaid",
            razorpay_payment_link_id: pl.id,
            razorpay_payment_link_url: pl.short_url,
          } as any)
          .eq("id", order.id);

        return {
          used: true,
          kind: "order",
          order_id: order.id,
          reply:
            "💳 Please pay using this link:\n" +
            `*${pl.short_url}*\n\n` +
            "After payment, you’ll automatically receive pickup confirmation.\n" +
            "Type *cancel* to cancel the order.",
        };
      } catch (e: any) {
        console.error("[PICKUP_PAYMENT][REGEN_ERR]", e?.message || e);
        return {
          used: true,
          kind: "order",
          order_id: order.id,
          reply:
            "⚠️ I couldn’t generate the payment link right now.\n" +
            "Please type *resend* later, or type *cancel* to cancel the order.",
        };
      }
    }

    // 6) Default menu (prevents infinite loop confusion)
    return {
      used: true,
      kind: "order",
      order_id: order?.id || null,
      reply:
        "💳 Your pickup order is awaiting payment.\n\n" +
        "Reply with one option:\n" +
        "1) *resend* (get payment link)\n" +
        "2) *paid* (if you already paid)\n" +
        "3) *cancel* (cancel this order)",
    };
  }

  // FINAL CONFIRM
  if (
    state === "confirming_order" ||
    state === "cart_edit_menu" ||
    state === "cart_edit_item" ||
    state === "cart_edit_qty" ||
    state === "cart_remove_item"
  ) {
    const res = await handleFinalConfirmation(ctx, state);

    // ✅ Restaurant: after order is confirmed, go to fulfillment step
    // We detect "confirmed" by presence of order_id + reply containing "Order confirmed"
    // (keeps flow unchanged for edit screens and non-confirm actions)
    const vertical = await getOrgVertical(org_id);

    if (
      vertical === "restaurant" &&
      res?.order_id &&
      typeof res.reply === "string" &&
      res.reply.includes("✅ *Order confirmed!*")
    ) {
      // move next step to fulfillment UI
      await clearState(org_id, from_phone);
      // IMPORTANT: setState is needed here (you already import clearState, not setState)
      // so you must import setState from stateManager OR do it inside finalConfirmationEngine.
      await setState(org_id, from_phone, "awaiting_fulfillment");

      return {
        used: true,
        kind: "order",
        order_id: res.order_id,
        reply:
          "How would you like to receive your order?\n" +
          "1) Store Pickup\n" +
          "2) Home Delivery\n\n" +
          "Please type *1* or *2*.",
      };
    }

    return res;
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

    // -------------------------------
    // Normalize text (same as before)
    // -------------------------------
    if (raw) {
      try {
        console.log("[AI][LANG][ORDERING][RAW]", {
          org_id,
          from_phone,
          text: raw,
        });

        const { detected_lang, translated_text } = await detectAndTranslate(
          raw
        );
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
    const phoneKey = from_phone.replace(/[^\d]/g, "");

    // ------------------------------------------------------
    // 🔥 SERVICE INTERRUPT (CRITICAL FIX)
    // Allow service intents EVEN during ordering
    // ------------------------------------------------------
    try {
      const routed = await routeIntent({
        orgId: org_id,
        customerPhone: phoneKey,
        rawText: raw,
        normalizedText: intentText,
        state,
      });

      console.log("[AI][ROUTED][ORDERING]", routed);

      const serviceLanes: ServiceLane[] = [
        "menu",
        "opening_hours",
        "delivery_now",
        "delivery_area",
        "store_location",
        "pricing_generic",
        "contact",
        "delivery_time_specific",
      ];

      if (
        routed &&
        routed.source !== "fallback" &&
        serviceLanes.includes(routed.intent as ServiceLane)
      ) {
        console.log("[AI][ORDERING][SERVICE_INTERRUPT]", {
          intent: routed.intent,
          text: intentText,
        });

        const serviceReply = await handleServiceLaneAndReply(
          org_id,
          routed.intent as ServiceLane,
          { raw, normalizedText: intentText }
        );

        if (serviceReply) {
          // 🧠 Important UX rule:
          // If user asks for *menu* in the middle of ordering (item/variant/qty),
          // treat next message as a fresh product selection.
          if (routed.intent === "menu") {
            await clearState(org_id, from_phone);
            console.log("[AI][ORDERING][SERVICE_INTERRUPT][MENU_CLEAR_STATE]", {
              org_id,
              from_phone,
              prevState: state,
            });
          }

          return serviceReply;
        }
      }
    } catch (e: any) {
      console.warn("[AI][ORDERING][SERVICE_ROUTER_ERR]", e?.message || e);
    }

    // ------------------------------------------------------
    // ⬇️ NORMAL ORDER FLOW (unchanged)
    // ------------------------------------------------------
    const intent = await parseIntent(intentText, { vertical, state });

    console.log("[AI][INGEST][INTENT][ORDERING]", { vertical, state, intent });

    return handleCatalogFlow({ ...ctx, intent, vertical }, state);
  }

  // ------------------------------------------------------
  // IDLE STATE
  // ------------------------------------------------------

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
  const phoneKey = from_phone.replace(/[^\d]/g, "");

  // ------------------------------------------------------
  // 🔒 SERVICE SHORT-CIRCUIT (MUST RUN BEFORE parseIntent)
  // ------------------------------------------------------

  // Greetings (only if it's basically just a greeting)
  const tokens = lowerRaw.split(/\s+/).filter(Boolean);

  const isPureGreeting =
    GREETING_WORDS.some((w) => lowerRaw === w) ||
    (tokens.length > 0 &&
      tokens.length <= 3 &&
      GREETING_WORDS.includes(tokens[0]) &&
      tokens.slice(1).every((t) => GREETING_FILLERS.includes(t)));

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

  // ------------------------------------------------------
  // ✅ 1) ROUTE the message (logs current event inside routeIntent)
  // ------------------------------------------------------
  let routed: Awaited<ReturnType<typeof routeIntent>> | null = null;

  try {
    routed = await routeIntent({
      orgId: org_id,
      customerPhone: phoneKey,
      rawText: raw,
      normalizedText: idleIntentText,
      state,
    });
    console.log("[AI][ROUTED]", routed);

    // 🔥 HARD STOP — MUST BE HERE
    // BEFORE learning
    // BEFORE resetState
    // BEFORE parseIntent
    if (routed?.source === "override") {
      console.log("[AI][OVERRIDE][HARD_STOP]", {
        text: idleIntentText,
        intent: routed.intent,
      });

      const serviceReply = await handleServiceLaneAndReply(
        org_id,
        routed.intent as ServiceLane,
        { raw, normalizedText: idleIntentText }
      );

      // If service engine didn't return anything, still stop parsing
      return (
        serviceReply ?? {
          used: true,
          kind: "service_inquiry",
          intentLane: routed.intent,
          reply: routed.reply || null, // (optional) only if router sometimes provides a real reply
          order_id: null,
        }
      );
    }
    // 🔥 SERVICE HANDLING (IDLE)
    // MUST BE HERE — ONLY HERE
    if (routed) {
      const serviceLanes: ServiceLane[] = [
        "menu",
        "opening_hours",
        "delivery_now",
        "delivery_area",
        "store_location",
        "pricing_generic",
        "contact",
        "delivery_time_specific",
      ];

      if (serviceLanes.includes(routed.intent as ServiceLane)) {
        const serviceReply = await handleServiceLaneAndReply(
          org_id,
          routed.intent as ServiceLane,
          { raw, normalizedText: idleIntentText }
        );

        if (serviceReply) return serviceReply;
      }
    }
  } catch (e: any) {
    console.warn("[AI][ROUTER][ERR]", e?.message || e);
  }

  // ------------------------------------------------------
  // ✅ 2) LEARN if this message is a correction (compare with PREVIOUS event)
  // Since routeIntent already logged CURRENT, previous = offset 1
  // ------------------------------------------------------
  try {
    if (routed && isCorrectionMessage(idleIntentText)) {
      const prev = await getLastIntentEvent(org_id, phoneKey, 1); // ✅ previous

      const correctedLane = routed.intent as IntentLane;

      // ✅ Block auto-learning for parameter intents (prevents bad org overrides)
      const BLOCK_LEARN: IntentLane[] = [
        "delivery_time_specific",
        "delivery_area",
      ];

      if (BLOCK_LEARN.includes(correctedLane)) {
        console.log("[AI][LEARN][SKIP_PARAM_INTENT]", {
          correctedLane,
          idleIntentText,
        });
        // just skip learning
      } else if (
        prev?.normalized_text &&
        prev?.decided_intent &&
        correctedLane &&
        prev.decided_intent !== correctedLane
      ) {
        // ✅ GUARD: don't learn "delivery_time_specific" unless the correction contains a time
        const needsTime = correctedLane === "delivery_time_specific";
        const hasTime =
          /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(idleIntentText) || // 12am, 12:30 pm
          (/\b\d{1,2}\b/.test(idleIntentText) &&
            (idleIntentText.includes("night") ||
              idleIntentText.includes("tonight"))) ||
          idleIntentText.includes("midnight");

        if (needsTime && !hasTime) {
          console.log("[AI][LEARN][SKIP_NO_TIME]", {
            correctedLane,
            idleIntentText,
          });
        } else {
          await learnOverride({
            orgId: org_id,
            normalizedText: prev.normalized_text,
            correctedIntent: correctedLane,
            createdBy: "system",
          });

          console.log("[AI][LEARN][OVERRIDE_CREATED]", {
            org_id,
            phoneKey,
            from_intent: prev.decided_intent,
            to_intent: correctedLane,
            pattern: prev.normalized_text,
          });
        }
      }
    }
  } catch (e: any) {
    console.warn("[AI][LEARN][ERR]", e?.message || e);
  }

  // ------------------------------------------------------
  // 🔥 CRITICAL FIX: reset state after correction
  // Without this, learned overrides NEVER apply
  // ------------------------------------------------------
  if (routed && isCorrectionMessage(idleIntentText)) {
    console.log("[AI][STATE][RESET_AFTER_CORRECTION]", {
      org_id,
      from_phone,
      prevState: state,
    });

    await clearState(org_id, from_phone);
  }

  // ------------------------------------------------------
  // FALL BACK TO NORMAL ORDER / PRODUCT FLOW
  // ------------------------------------------------------
  let intent = await parseIntent(idleIntentText, { vertical, state });

  // Guard: don't treat messages with NO digits as multi-item "add_items"
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

  return handleCatalogFlow({ ...ctx, intent, vertical }, "idle");
}
