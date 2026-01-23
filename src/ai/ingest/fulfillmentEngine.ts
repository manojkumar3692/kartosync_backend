// src/ai/ingest/fulfillmentEngine.ts
import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";
import { setState, clearState } from "./stateManager";
import { detectMetaIntent } from "./metaIntent";

/**
 * We store the user's choice in orders.delivery_type:
 * - "pickup" | "delivery"
 *
 * For pickup: we ignore delivery fee/address in downstream usage,
 * but we do NOT delete it (safe + auditable).
 *
 * ✅ This engine ONLY handles fulfillment selection + moving to next state.
 * ✅ Payment decisions happen in paymentEngine (or later steps).
 */

type FulfillmentChoice = "pickup" | "delivery";

function detectFulfillmentChoice(raw: string): FulfillmentChoice | null {
  const msg = (raw || "").trim().toLowerCase();

  // numeric
  if (msg === "1") return "pickup";
  if (msg === "2") return "delivery";

  // english keywords
  const pickupWords = [
    "pickup",
    "pick up",
    "store pickup",
    "self pickup",
    "self pick up",
    "takeaway",
    "take away",
    "collect",
    "collection",
  ];
  const deliveryWords = [
    "delivery",
    "home delivery",
    "deliver",
    "ship",
    "send to home",
    "door delivery",
  ];

  // tamil-ish common words (romanized)
  const pickupTa = [
    "pickup venum",
    "pickup",
    "takeaway",
    "take away",
    "eduthutu varen",
    "eduthu varen",
  ];
  const deliveryTa = [
    "delivery venum",
    "veetuku anupu",
    "veetukku anupu",
    "anupu",
    "home delivery",
    "delivery",
  ];

  if ([...pickupWords, ...pickupTa].some((k) => msg.includes(k))) return "pickup";
  if ([...deliveryWords, ...deliveryTa].some((k) => msg.includes(k))) return "delivery";

  return null;
}

async function getLatestActiveOrder(org_id: string, from_phone: string) {
  const { data, error } = await supa
    .from("orders")
    .select(
      "id, total_amount, items, delivery_fee, delivery_type, status, created_at, payment_status"
    )
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .in("status", ["awaiting_customer_action", "awaiting_store_action", "accepted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("[FULFILL][FIND_ACTIVE]", { data, error });
  return data || null;
}

async function getOrgConfig(org_id: string) {
  // ✅ Keep this lightweight. We only need to know if org accepts ONLY cash.
  // If this column doesn't exist yet, it will come as undefined -> treated as false.
  const { data, error } = await supa
    .from("orgs")
    .select("id, name, accept_only_cash")
    .eq("id", org_id)
    .maybeSingle();

  console.log("[FULFILL][ORG_CFG]", { data, error });
  return data || null;
}

export async function handleFulfillment(ctx: IngestContext): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;

  // Only for restaurant + grocery (as per your freeze)
  const allowed = ctx.vertical === "restaurant" || ctx.vertical === "grocery";
  if (!allowed) {
    return { used: false, kind: "order", reply: "", order_id: null };
  }

  const rawText = (text || "").trim();

  // Meta intents (back/reset/agent)
  const meta = detectMetaIntent(rawText);

  if (meta === "reset") {
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "order",
      order_id: null,
      reply: "No problem 👍 Cancelled this step. You can type *menu* or start a new order.",
    };
  }

  if (meta === "agent") {
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "order",
      order_id: null,
      reply: "I’ll ask a human to help you. Someone will contact you shortly 😊",
    };
  }

  if (meta === "back") {
    await setState(org_id, from_phone, "awaiting_fulfillment");
    return {
      used: true,
      kind: "order",
      order_id: null,
      reply:
        "Sure 👍\n" +
        "How would you like to receive your order?\n" +
        "1) Store Pickup\n" +
        "2) Home Delivery\n\n" +
        "Please type *1* or *2*.",
    };
  }

  const choice = detectFulfillmentChoice(rawText);

  if (!choice) {
    await setState(org_id, from_phone, "awaiting_fulfillment");
    return {
      used: true,
      kind: "order",
      order_id: null,
      reply:
        "How would you like to receive your order?\n" +
        "1) Store Pickup\n" +
        "2) Home Delivery\n\n" +
        "Please type *1* or *2*.",
    };
  }

  const order = await getLatestActiveOrder(org_id, from_phone);
  if (!order?.id) {
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "order",
      order_id: null,
      reply: "⚠️ I couldn't find an active order. Please type your item name to start again.",
    };
  }

  // Persist delivery_type on order
  await supa.from("orders").update({ delivery_type: choice }).eq("id", order.id);

  // Home Delivery → address step
  if (choice === "delivery") {
    await setState(org_id, from_phone, "awaiting_address");
    return {
      used: true,
      kind: "order",
      order_id: order.id,
      reply: "✅ *Delivery selected!*\n\n📍 Please send your delivery address.",
    };
  }

  // Pickup → next step depends on org payment capability
  // Optional: keep totals clean for pickup
  await supa.from("orders").update({ delivery_fee: 0 }).eq("id", order.id);

  const orgCfg = await getOrgConfig(org_id);
  const acceptOnlyCash = Boolean((orgCfg as any)?.accept_only_cash);

  // ✅ If org accepts ONLY cash → go to a simple cash confirmation state
  // NOTE: You must handle this state in ingest/index.ts (similar to awaiting_payment)
  // If you don't want a new state, you can set awaiting_payment and let paymentEngine show "Cash only".
  if (acceptOnlyCash) {
    await setState(org_id, from_phone, "awaiting_cash_confirmation" as any);
    return {
      used: true,
      kind: "order",
      order_id: order.id,
      reply:
        "✅ *Store Pickup selected!*\n\n" +
        "💵 This store accepts *Cash only*.\n" +
        "Please reply *OK* to confirm. (You can pay at pickup.)",
    };
  }

  // ✅ Otherwise continue with existing payment flow
  await setState(org_id, from_phone, "awaiting_payment");
  return {
    used: true,
    kind: "order",
    order_id: order.id,
    reply:
      "✅ *Store Pickup selected!*\n\n" +
      "How would you like to pay?\n" +
      "1) Cash\n" +
      "2) Online Payment\n\n" +
      "Please type *1* or *2*.",
  };
}