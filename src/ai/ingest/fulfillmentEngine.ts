// src/ai/ingest/fulfillmentEngine.ts
import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";
import { setState, clearState } from "./stateManager";
import { detectMetaIntent } from "./metaIntent";
import { createRazorpayPaymentLink } from "../../payments/razorpay";
/**
 * We store the user's choice in orders.delivery_type:
 * - "pickup" | "delivery"
 *
 * For pickup: we ignore delivery fee/address in downstream usage,
 * but we do NOT delete it (safe + auditable).
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
  const pickupTa = ["pickup venum", "pickup", "takeaway", "take away", "eduthutu varen", "eduthu varen"];
  const deliveryTa = ["delivery venum", "veetuku anupu", "veetukku anupu", "anupu", "home delivery", "delivery"];

  if ([...pickupWords, ...pickupTa].some((k) => msg.includes(k))) return "pickup";
  if ([...deliveryWords, ...deliveryTa].some((k) => msg.includes(k))) return "delivery";

  return null;
}

async function getLatestActiveOrder(org_id: string, from_phone: string) {
  const { data, error } = await supa
    .from("orders")
    .select("id, total_amount, items, delivery_fee, delivery_type, status, created_at, payment_status")
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .in("status", ["awaiting_customer_action", "awaiting_store_action", "accepted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("[FULFILL][FIND_ACTIVE]", { data, error });
  return data || null;
}

async function getOrgStoreInfo(org_id: string) {
  // Add these columns in orgs when you are ready:
  // store_address, store_phone, store_hours, store_maps_url
  const { data, error } = await supa
    .from("orgs")
    .select("id, name, store_address, store_phone, store_hours, store_maps_url")
    .eq("id", org_id)
    .maybeSingle();

  console.log("[FULFILL][ORG_STORE_INFO]", { data, error });
  return data || null;
}

function safeInr(amount: any): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n); // whole rupees for link simplicity
}

export async function handleFulfillment(ctx: IngestContext): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;

  // Only for restaurant
  const isRestaurant = ctx.vertical === "restaurant";
  if (!isRestaurant) {
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
    // If you want: go back to address step for delivery cases.
    // But you told “don’t change flow”, so we keep it simple:
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

  // If Home Delivery → continue existing flow to payment selection
  if (choice === "delivery") {
    await setState(org_id, from_phone, "awaiting_payment");
    return {
      used: true,
      kind: "order",
      order_id: order.id,
      reply:
        "✅ *Delivery selected!*\n\n" +
        "How would you like to pay?\n" +
        "1) Cash\n" +
        "2) Online Payment\n\n" +
        "Please type *1* or *2*.",
    };
  }

  // Pickup → generate Razorpay link + tell store info
  // For pickup we can set delivery_fee to 0 (optional, keeps totals clean)
  await supa.from("orders").update({ delivery_fee: 0 }).eq("id", order.id);

  const store = await getOrgStoreInfo(org_id);

  const amount = safeInr(order.total_amount ?? 0);
  const pl = await createRazorpayPaymentLink({
    org_id,
    order_id: order.id,
    amount_inr: amount,
    customer_phone: from_phone,
  });
  
  const payUrl = pl?.short_url || null;
  const payLinkId = pl?.id || null;

  // Save link details (create these columns when ready)
  // orders.payment_link_url, orders.payment_provider, orders.payment_provider_ref, orders.payment_status
  if (payUrl) {
    await supa.from("orders").update({
      payment_mode: "online",
      payment_status: "unpaid",
      payment_provider: "razorpay",
      razorpay_payment_link_id: payLinkId,
      razorpay_payment_link_url: payUrl,
    } as any).eq("id", order.id);
  } else {
    // If link creation fails, still don’t break flow
    await supa
      .from("orders")
      .update({
        payment_mode: "online",
        payment_status: "pending",
      } as any)
      .eq("id", order.id);
  }

  // After sending link, we stay in a state waiting for webhook to mark paid.
  // You can add this state later if you want: "awaiting_pickup_payment"
  await setState(org_id, from_phone, "awaiting_pickup_payment" as any);
  
  const storeName = store?.name ? `*${store.name}*` : "our store";
  const storeAddr = store?.store_address ? store.store_address : "Store address will be shared after payment.";
  const storePhone = store?.store_phone ? store.store_phone : "";
  const storeHours = store?.store_hours ? store.store_hours : "";
  const maps = store?.store_maps_url ? store.store_maps_url : "";

  const linkLine = payUrl
  ? `🔗 *Pay here to confirm pickup:* ${payUrl}\n\n`
  : "🔗 Payment link is being generated. You’ll receive it shortly.\n\n";

  const storeBlock =
    `🏪 Pickup from: ${storeName}\n` +
    `📍 ${storeAddr}\n` +
    (maps ? `🗺️ ${maps}\n` : "") +
    (storePhone ? `📞 ${storePhone}\n` : "") +
    (storeHours ? `⏰ Open till: ${storeHours}\n` : "");

  return {
    used: true,
    kind: "order",
    order_id: order.id,
    reply:
      "✅ *Store Pickup selected!*\n\n" +
      linkLine +
      "Once payment is successful, we’ll confirm your pickup order with details.\n\n" +
      storeBlock,
  };
}