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

  // FULFILLMENT (restaurant)
  if (state === "awaiting_fulfillment") {
    console.log("[FULFILLMENT][INCOMING]", {
      org_id,
      from_phone,
      text: raw,
      state,
    });

    // Grab latest pending order (so we can show summary consistently)
    const { data: order, error: ordErr } = await supa
      .from("orders")
      .select("id, items, total_amount, delivery_fee")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    console.log("[FULFILLMENT][ORDER_LOOKUP]", { ordErr, orderId: order?.id });

    // Helper: build a clean summary (don’t crash if items missing)
    const summaryLines: string[] = [];
    if (order?.items && Array.isArray(order.items)) {
      for (const it of order.items) {
        const name = it?.name || "Item";
        const variant = it?.variant ? ` (${it.variant})` : "";
        const qty = Number(it?.qty) || 0;
        const price = Number(it?.price) || 0;
        const lineTotal = qty && price ? qty * price : null;

        if (qty > 0) {
          summaryLines.push(
            `• ${name}${variant} x ${qty}${
              lineTotal != null ? ` — ₹${lineTotal}` : ""
            }`
          );
        }
      }
    }

    const total =
      order?.total_amount != null ? Number(order.total_amount) : null;

    const summaryText =
      summaryLines.length > 0
        ? summaryLines.join("\n") +
          (total != null ? `\n\n💰 Total: *₹${total.toFixed(0)}*` : "")
        : null;

    const menuText =
      (order?.id
        ? `✅ *Order confirmed!* (#${order.id})\n\n`
        : `✅ *Order confirmed!*\n\n`) +
      (summaryText ? `${summaryText}\n\n` : "") +
      "How would you like to receive your order?\n" +
      "1) Store Pickup\n" +
      "2) Home Delivery\n\n" +
      "Please type *1* or *2*.";

    // Accept 1/2 only
    if (lowerRaw === "1") {
      // ✅ Pickup selected
      if (order?.id) {
        await supa
          .from("orders")
          .update({ delivery_type: "pickup" })
          .eq("id", order.id);
      }

      // ✅ online-only for pickup
      // Create Razorpay payment link using org-wise credentials
      let payUrl: string | null = null;
      let payLinkId: string | null = null;

      try {
        const amount = total != null ? Number(total) : 0;

        if (!order?.id) {
          throw new Error("No pending order found for pickup payment link.");
        }
        if (!amount || Number.isNaN(amount) || amount <= 0) {
          throw new Error("Invalid order total; cannot create payment link.");
        }

        const pl = await createRazorpayPaymentLink({
          org_id,
          order_id: order.id,
          amount_inr: amount,
          customer_phone: from_phone,
        });

        payLinkId = pl.id;
        payUrl = pl.short_url;

        // OPTIONAL: store link on order (will work only after you add columns)
        // If columns don’t exist yet, supabase will return error; we ignore it safely.
        const { error: updErr } = await supa
          .from("orders")
          .update({
            payment_provider: "razorpay",
            payment_status: "unpaid",
            razorpay_payment_link_id: payLinkId,
            razorpay_payment_link_url: payUrl,
          } as any)
          .eq("id", order.id);

        if (updErr) {
          console.warn("[PICKUP][ORDER_UPDATE_WARN]", updErr.message);
        }
      } catch (e: any) {
        console.error("[PICKUP][RAZORPAY_LINK_ERR]", e?.message || e);
      }

      // ✅ New state so pickup payment doesn't mix with delivery/COD logic
      await setState(org_id, from_phone, "awaiting_pickup_payment" as any);

      const linkLine = payUrl
        ? `*${payUrl}*`
        : "*Payment link is not available right now.*\nPlease wait / contact the store.";

      return {
        used: true,
        kind: "order",
        order_id: order?.id || null,
        reply:
          "✅ *Store Pickup selected!*\n\n" +
          (summaryText ? `🧾 *Order Summary*\n${summaryText}\n\n` : "") +
          "💳 *Online payment only* for pickup.\n" +
          "Please pay using this link:\n" +
          linkLine +
          "\n\n" +
          "After payment, send the screenshot / transaction id here (or type *paid*).",
      };
    }

    if (lowerRaw === "2") {
      // ✅ Delivery selected
      if (order?.id) {
        await supa
          .from("orders")
          .update({ delivery_type: "delivery" })
          .eq("id", order.id);
      }

      await setState(org_id, from_phone, "awaiting_address");

      return {
        used: true,
        kind: "order",
        order_id: order?.id || null,
        reply:
          (order?.id
            ? `✅ *Order confirmed!* (#${order.id})\n\n`
            : `✅ *Order confirmed!*\n\n`) +
          (summaryText ? `${summaryText}\n\n` : "") +
          "📍 Please send your delivery address.",
      };
    }

    // Any other text → re-prompt with summary
    return {
      used: true,
      kind: "order",
      order_id: order?.id || null,
      reply: menuText,
    };
  }

  // ADDRESS
  if (state === "awaiting_address" || state === "awaiting_location_pin") {
    return handleAddress(ctx, state);
  }

  // PAYMENT
  if (state === "awaiting_payment") return handlePayment(ctx);

  if (state === "awaiting_payment_proof") {
    const lower = (raw || "").trim().toLowerCase();

    // simple UX: let user say "paid" but real truth comes from webhook
    if (["paid", "done", "payment done", "completed"].includes(lower)) {
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "✅ Got it. We are verifying your payment now. You’ll receive confirmation shortly.",
      };
    }

    // otherwise: remind payment link
    const { data: order } = await supa
      .from("orders")
      .select("id, razorpay_payment_link_url, payment_status")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (order?.payment_status === "paid") {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply: "✅ Payment already received.",
      };
    }

    return {
      used: true,
      kind: "order",
      order_id: order?.id || null,
      reply:
        "💳 Your payment is pending.\nPlease pay using this link:\n" +
        `*${order?.razorpay_payment_link_url || "Payment link not found"}*`,
    };
  }

  // PICKUP PAYMENT (Razorpay – restaurant only)
  // PICKUP PAYMENT WAIT (Razorpay link)
  if (state === "awaiting_pickup_payment") {
    const lower = (raw || "").trim().toLowerCase();

    // 1) Allow cancel
    if (lower === "cancel" || lower === "cancel order") {
      // cancel latest pending order
      const { data: ord } = await supa
        .from("orders")
        .select("id")
        .eq("org_id", org_id)
        .eq("source_phone", from_phone)
        .eq("status", "pending")
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
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "✅ Got it. We are verifying your payment now.\n" +
          "You’ll receive confirmation shortly.\n\n" +
          "If you haven’t paid yet, type *resend* to get the link again.",
      };
    }

    // 3) Load latest pending order + stored link
    const { data: order } = await supa
      .from("orders")
      .select(
        "id, razorpay_payment_link_url, razorpay_payment_link_id, total_amount, payment_status"
      )
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

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
          customer_phone: from_phone,
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

        if (serviceReply) return serviceReply;
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
