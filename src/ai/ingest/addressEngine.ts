// src/ai/ingest/addressEngine.ts
import { supa } from "../../db";
import { IngestContext, IngestResult, ConversationState } from "./types";
import { setState, clearState } from "./stateManager";
import axios from "axios"; // ⬅️ NEW
import { detectMetaIntent } from "./metaIntent"; // ⬅️ NEW
import { getAttempts, incAttempts, resetAttempts } from "./attempts"; // ⬅️ NEW
// ─────────────────────────────────────────────
// Address heuristic (same as your old version)
// ─────────────────────────────────────────────
function looksLikeAddress(text: string): boolean {
  const msg = text.toLowerCase().trim();

  return (
    msg.includes("street") ||
    msg.includes("st ") ||
    msg.includes("road") ||
    msg.includes("rd ") ||
    msg.includes("area") ||
    msg.includes("blk") ||
    msg.includes("block") ||
    msg.includes("near") ||
    msg.includes("behind") ||
    msg.includes("flat") ||
    msg.includes("villa") ||
    msg.includes("apt") ||
    msg.includes("tower") ||
    msg.includes("building") ||
    msg.includes("nagar") ||
    msg.includes("layout") ||
    msg.includes("colony") ||
    // number + word → common house format
    !!msg.match(/\d+[\/\-]?\d*\s+[a-z]/i) ||
    msg.length > 15
  );
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type OrgDeliveryConfig = {
  id: string;
  store_lat: number | null;
  store_lng: number | null;
  delivery_free_km: number | null;
  delivery_max_km: number | null;
  delivery_fee_type: "flat" | "per_km" | null;
  delivery_flat_fee: number | null;
  delivery_per_km_fee: number | null;
  accept_only_cash: boolean | null;
};

type OrderRow = {
  id: string;
  total_amount: number | null;
  delivery_address_text?: string | null;
  delivery_fee?: number | null;
  delivery_lat?: number | null;
  delivery_lng?: number | null;
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function getLatestPendingOrder(
  org_id: string,
  from_phone: string
): Promise<OrderRow | null> {
  const { data, error } = await supa
    .from("orders")
    .select(
      "id, total_amount, delivery_address_text, delivery_fee, delivery_lat, delivery_lng"
    )
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .in("status", [
      "awaiting_customer_action",
      "awaiting_store_action",
      "accepted",
    ] as any)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("[ADDR][FIND_PENDING]", { data, error });

  return (data as OrderRow) || null;
}

async function getOrgConfig(org_id: string): Promise<OrgDeliveryConfig | null> {
  const { data, error } = await supa
    .from("orgs")
    .select(
      "id, store_lat, store_lng, delivery_free_km, delivery_max_km, delivery_fee_type, delivery_flat_fee, delivery_per_km_fee, accept_only_cash"
    )
    .eq("id", org_id)
    .maybeSingle();

  console.log("[ADDR][ORG_CONFIG]", { data, error });

  return (data as OrgDeliveryConfig) || null;
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371; // km

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

type DeliveryQuote =
  | {
      ok: true;
      distanceKm: number;
      fee: number;
      freeKm: number | null;
      maxKm: number | null;
      reason?: undefined;
    }
  | {
      ok: false;
      distanceKm: number | null;
      fee: number | null;
      freeKm: number | null;
      maxKm: number | null;
      reason: "missing_coords" | "too_far" | "no_config";
    };

/**
 * Compute distance + fee based on org config.
 * NOTE: This expects BOTH store + customer coords to be present.
 */
async function computeDeliveryQuote(
  org_id: string,
  customerLat: number | null,
  customerLng: number | null
): Promise<DeliveryQuote> {
  const cfg = await getOrgConfig(org_id);
  if (!cfg) {
    return {
      ok: false,
      reason: "no_config",
      distanceKm: null,
      fee: null,
      freeKm: null,
      maxKm: null,
    };
  }

  const storeLat = cfg.store_lat;
  const storeLng = cfg.store_lng;

  const freeKm =
    cfg.delivery_free_km != null ? Number(cfg.delivery_free_km) : 0;
  const maxKm =
    cfg.delivery_max_km != null ? Number(cfg.delivery_max_km) : null;

  if (
    storeLat == null ||
    storeLng == null ||
    customerLat == null ||
    customerLng == null
  ) {
    // We can't compute distance right now (no coords or no geocoding)
    return {
      ok: false,
      reason: "missing_coords",
      distanceKm: null,
      fee: null,
      freeKm,
      maxKm,
    };
  }

  const distanceKm = haversineKm(
    Number(storeLat),
    Number(storeLng),
    Number(customerLat),
    Number(customerLng)
  );

  console.log("[ADDR][QUOTE_RAW]", {
    org_id,
    storeLat,
    storeLng,
    customerLat,
    customerLng,
    distanceKm,
    freeKm,
    maxKm,
    feeType: cfg.delivery_fee_type,
  });

  if (maxKm != null && distanceKm > maxKm) {
    return {
      ok: false,
      reason: "too_far",
      distanceKm,
      fee: null,
      freeKm,
      maxKm,
    };
  }

  let fee = 0;

  if (distanceKm <= freeKm) {
    fee = 0;
  } else {
    if (cfg.delivery_fee_type === "flat") {
      fee = cfg.delivery_flat_fee != null ? Number(cfg.delivery_flat_fee) : 0;
    } else if (cfg.delivery_fee_type === "per_km") {
      const perKm =
        cfg.delivery_per_km_fee != null ? Number(cfg.delivery_per_km_fee) : 0;
      const billableKm = Math.max(0, distanceKm - freeKm);
      fee = billableKm * perKm;
    } else {
      // No fee type configured → treat as 0, but still return distance
      fee = 0;
    }
  }

  console.log("[ADDR][QUOTE_DECISION]", {
    org_id,
    distanceKm,
    freeKm,
    maxKm,
    fee,
    reason:
      distanceKm <= freeKm
        ? "within_free_km"
        : cfg.delivery_fee_type === "per_km"
        ? "per_km_charge"
        : cfg.delivery_fee_type === "flat"
        ? "flat_charge"
        : "no_fee_type",
  });

  return {
    ok: true,
    distanceKm,
    fee,
    freeKm,
    maxKm,
  };
}

/**
 * Geocoding via Google Maps.
 * Uses process.env.GOOGLE_MAPS_API_KEY
 */
async function geocodeAddressToLatLng(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[ADDR][GEOCODE] GOOGLE_MAPS_API_KEY missing");
    return null;
  }

  const url = "https://maps.googleapis.com/maps/api/geocode/json";

  try {
    console.log("[ADDR][GEOCODE_REQ]", { address });

    const resp = await axios.get(url, {
      params: {
        address,
        key: apiKey,
      },
    });

    const data = resp.data;

    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      console.warn("[ADDR][GEOCODE_NO_RESULT]", {
        status: data.status,
        address,
      });
      return null;
    }

    const loc = data.results[0]?.geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      console.warn("[ADDR][GEOCODE_BAD_LOCATION]", { address, loc });
      return null;
    }

    console.log("[ADDR][GEOCODE_OK]", { address, lat: loc.lat, lng: loc.lng });
    return { lat: loc.lat, lng: loc.lng };
  } catch (err: any) {
    console.error(
      "[ADDR][GEOCODE_ERR]",
      err?.response?.data || err?.message || err
    );
    return null;
  }
}

// Small helpers
function formatFeeLine(fee: number | null | undefined): string {
  if (fee == null) {
    return "🚚 Delivery fee: will be confirmed by the store.";
  }
  if (fee === 0) {
    return "🚚 Delivery fee: *FREE*";
  }
  return `🚚 Delivery fee: *₹${fee.toFixed(0)}*`;
}

function buildPaymentPrompt(acceptOnlyCash: boolean | null | undefined) {
  const onlyCash = !!acceptOnlyCash;

  if (onlyCash) {
    return (
      "How would you like to pay?\n" +
      "1) Cash\n\n" +
      "Please type *1* to confirm Cash on Delivery."
    );
  }

  return (
    "How would you like to pay?\n" +
    "1) Cash\n" +
    "2) Online Payment\n\n" +
    "Please type *1* or *2*."
  );
}

// ─────────────────────────────────────────────
// MAIN: Address Flow
// ─────────────────────────────────────────────

export async function handleAddress(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
  const { org_id, from_phone } = ctx;
  const isRestaurant = ctx.vertical === "restaurant";
  const rawText = (ctx.text || "").trim();
  const lower = rawText.toLowerCase();

  // WhatsApp location pin (if you wire it later)
  const locLat = (ctx as any).location_lat ?? null;
  const locLng = (ctx as any).location_lng ?? null;

  // ─────────────────────────────────────────────
  // 1) USER SENDING ADDRESS  (state = awaiting_address)
  // We ONLY accept text address here.
  // ─────────────────────────────────────────────
  if (state === "awaiting_address") {
    const msg = rawText;

    // 🧠 Handle back/reset/agent BEFORE address logic
    const meta = detectMetaIntent(rawText);

    if (meta === "reset") {
      await clearState(org_id, from_phone);
      await resetAttempts(org_id, from_phone);

      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "No problem 👍 I’ve cancelled this step.\nYou can type your order again or say *menu*.",
      };
    }

    if (meta === "agent") {
      await clearState(org_id, from_phone);
      await resetAttempts(org_id, from_phone);
      // optionally mark in DB for human follow-up

      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "I’ll ask a human to help you with the address. Someone will contact you shortly 😊",
      };
    }

    // No text at all → ask again (even if they sent only pin)
    if (!msg && locLat == null && locLng == null) {
      await setState(org_id, from_phone, "awaiting_address");
      return {
        used: true,
        kind: "order",
        reply:
          "📍 Please send your full delivery address (flat/door no, building, street, area, city, pincode if you know).",
        order_id: null,
      };
    }

    // Text that doesn't look like address → ask again
    // Text that doesn't look like address → ask again, with retries
    if (locLat == null && locLng == null && !looksLikeAddress(msg)) {
      await setState(org_id, from_phone, "awaiting_address");

      // 🔁 Count how many times they sent a bad address
      await incAttempts(org_id, from_phone);
      const attempts = await getAttempts(org_id, from_phone);

      if (attempts === 1) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "📍 That doesn't look like a full address.\n" +
            "Please send flat/door no, building, street, area and city (with pincode if you know).",
        };
      }

      if (attempts === 2) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "📍 I still don’t see a complete address.\n" +
            "Please send everything in *one message*, for example:\n" +
            "*Flat 203, Green View Apts, 3rd Street, Anna Nagar, Chennai 600040*\n\n" +
            "You can also type *back* to restart or *agent* to talk to a human.",
        };
      }

      // 3rd time or more → stop looping
      await clearState(org_id, from_phone);
      await resetAttempts(org_id, from_phone);

      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "😅 I’m having trouble understanding your address.\n" +
          "I’ll stop this order for now.\nYou can type *hi* to start again or *agent* if you want a human to help.",
      };
    }

    const order = await getLatestPendingOrder(org_id, from_phone);

    if (!order) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        reply:
          "⚠️ I couldn't find an active order.\nPlease type the item name to start a new order.",
        order_id: null,
      };
    }

    const addressText = msg;

    // Save address text; don't compute fee yet
    const { error: updErr } = await supa
      .from("orders")
      .update({
        shipping_address: addressText,
        delivery_address_text: addressText,

        // 🔥 IMPORTANT: whenever address changes,
        // clear old geo/fee so we don't reuse stale values
        delivery_lat: null,
        delivery_lng: null,
        delivery_distance_km: null,
        delivery_fee: null,
        delivery_status: "pending_address",
      } as any)
      .eq("id", order.id);

    console.log("[ADDR][SAVE_ADDRESS]", {
      order_id: order.id,
      updErr,
      addressText,
    });

    // ✅ Address accepted → reset attempts for this stage
    await resetAttempts(org_id, from_phone);

    // Now ask for pin or skip
    await setState(org_id, from_phone, "awaiting_location_pin");

    // 🆕 If user already sent a location pin in the SAME message
    if (locLat != null && locLng != null) {
      // jump directly to location calculation block
      return await handleAddress(
        { ...ctx, location_lat: locLat, location_lng: locLng },
        "awaiting_location_pin"
      );
    }

    return {
      used: true,
      kind: "order",
      reply:
        "📍 Address received!\n\n" +
        addressText +
        "\n\n" +
        "To calculate *exact* delivery charges:\n" +
        "• Tap 📎 → *Location* → send your location (most accurate)\n" +
        "• Or type *skip* to continue without location\n\n" +
        "Please send your location pin or type *skip*.",
      order_id: order.id,
    };
  }

  // ─────────────────────────────────────────────
  // 2) USER SENDING PIN OR SKIP (state = awaiting_location_pin)
  // ─────────────────────────────────────────────
  if (state === "awaiting_location_pin") {
    const order = await getLatestPendingOrder(org_id, from_phone);

    if (!order) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        reply:
          "⚠️ I couldn't find an active order.\nPlease type the item name to start a new order.",
        order_id: null,
      };
    }

    const addr = order.delivery_address_text || "(no address text)";
    const totalNum =
      order.total_amount != null ? Number(order.total_amount) : null;

    // 2.a) User types SKIP → try geocode from text, else fall back
    if (["skip", "no", "later", "dont", "don't"].includes(lower)) {
      console.log("[ADDR][PIN_STAGE_SKIP_BRANCH]");
      let finalLat: number | null = order.delivery_lat ?? null;
      let finalLng: number | null = order.delivery_lng ?? null;

      // If we don't already have coords, try geocoding
      if (finalLat == null || finalLng == null) {
        const geo = await geocodeAddressToLatLng(addr);
        if (geo) {
          finalLat = geo.lat;
          finalLng = geo.lng;
        }
      }

      console.log("[ADDR][PIN_STAGE_SKIP_COORDS]", {
        addr,
        finalLat,
        finalLng,
      });

      const quote = await computeDeliveryQuote(org_id, finalLat, finalLng);

      let deliveryFee: number | null = null;
      let distanceKm: number | null = null;
      let deliveryStatus: string = "pending_address";

      if (quote.ok) {
        deliveryFee = quote.fee;
        distanceKm = quote.distanceKm;
        deliveryStatus = "confirmed";
      }

      // If too far → reject and go back to address step
      if (!quote.ok && quote.reason === "too_far") {
        const distStr =
          quote.distanceKm != null
            ? `${quote.distanceKm.toFixed(1)} km`
            : "too far";
        const maxStr =
          quote.maxKm != null
            ? `${quote.maxKm.toFixed(1)} km`
            : "the allowed radius";

        // 🔥 Clear any stored geo/fee so we don't keep re-using a bad location
        await supa
          .from("orders")
          .update({
            delivery_lat: null,
            delivery_lng: null,
            delivery_distance_km: null,
            delivery_fee: null,
            delivery_status: "pending_address",
          } as any)
          .eq("id", order.id);

        await setState(org_id, from_phone, "awaiting_address");

        return {
          used: true,
          kind: "order",
          reply:
            `This address appears to be about ${distStr} from the store.\n` +
            `We currently deliver only within ${maxStr}.\n\n` +
            "Please send a closer delivery address.",
          order_id: order.id,
        };
      }

      // Update order with whatever we have
      const { error: updErr } = await supa
        .from("orders")
        .update({
          delivery_lat: finalLat,
          delivery_lng: finalLng,
          delivery_distance_km: distanceKm,
          delivery_fee: deliveryFee,
          delivery_type: "delivery",
          delivery_status: deliveryStatus,
        } as any)
        .eq("id", order.id);

      console.log("[ADDR][SKIP_LOCATION_UPDATE]", {
        order_id: order.id,
        updErr,
        quote,
      });

      const feeLine = formatFeeLine(deliveryFee);
      const totalLine =
        totalNum != null
          ? `\n💰 Order total (items): *₹${totalNum.toFixed(0)}*`
          : "";

          const orgCfg = await getOrgConfig(org_id);
const payPrompt = buildPaymentPrompt(orgCfg?.accept_only_cash);
      // ✅ Restaurant: go to payment
      if (isRestaurant) {
        await setState(org_id, from_phone, "awaiting_payment");
        return {
          used: true,
          kind: "order",
          reply:
            "✅ *Delivery details saved!*\n\n" +
            "📍 Delivery address:\n" +
            addr +
            "\n\n" +
            feeLine +
            totalLine +
            "\n\n" +
            payPrompt,
          order_id: order.id,
        };
      }

      // ✅ Non-restaurant: still must RETURN (or you’ll hit re-prompt)
      await setState(org_id, from_phone, "awaiting_payment");
      return {
        used: true,
        kind: "order",
        reply:
          "✅ *Delivery details saved!*\n\n" +
          "📍 Delivery address:\n" +
          addr +
          "\n\n" +
          feeLine +
          totalLine +
          "\n\n" +
          payPrompt,
        order_id: order.id,
      };
    }

    // 2.b) User sends location pin (lat/lng present)
    if (locLat != null && locLng != null) {
      console.log("[ADDR][PIN_STAGE_HAS_LOCATION]", { locLat, locLng });
      const quote = await computeDeliveryQuote(org_id, locLat, locLng);

      // If too far → reject and go back to address step
      if (!quote.ok && quote.reason === "too_far") {
        const distStr =
          quote.distanceKm != null
            ? `${quote.distanceKm.toFixed(1)} km`
            : "too far";
        const maxStr =
          quote.maxKm != null
            ? `${quote.maxKm.toFixed(1)} km`
            : "the allowed radius";

        await setState(org_id, from_phone, "awaiting_address");

        return {
          used: true,
          kind: "order",
          reply:
            `This location appears to be about ${distStr} from the store.\n` +
            `We currently deliver only within ${maxStr}.\n\n` +
            "Please send a closer delivery address.",
          order_id: order.id,
        };
      }

      let deliveryFee: number | null = null;
      let distanceKm: number | null = null;
      let deliveryStatus: string = "pending_address";

      if (quote.ok) {
        deliveryFee = quote.fee;
        distanceKm = quote.distanceKm;
        deliveryStatus = "confirmed";
      }

      const { error: updErr } = await supa
        .from("orders")
        .update({
          delivery_lat: locLat,
          delivery_lng: locLng,
          delivery_distance_km: distanceKm,
          delivery_fee: deliveryFee,
          delivery_type: "delivery",
          delivery_status: deliveryStatus,
        } as any)
        .eq("id", order.id);

      console.log("[ADDR][LOCATION_UPDATE]", {
        order_id: order.id,
        updErr,
        quote,
      });

      const feeLine = formatFeeLine(deliveryFee);
      const totalLine =
        totalNum != null
          ? `\n💰 Order total (items): *₹${totalNum.toFixed(0)}*`
          : "";
      const distanceLine =
        distanceKm != null
          ? `\n📏 Distance from store: ~${distanceKm.toFixed(1)} km`
          : "";


          const orgCfg = await getOrgConfig(org_id);
const payPrompt = buildPaymentPrompt(orgCfg?.accept_only_cash);

      if (isRestaurant) {
        await setState(org_id, from_phone, "awaiting_payment");
        return {
          used: true,
          kind: "order",
          reply:
            "✅ *Delivery details saved!*\n\n" +
            "📍 Delivery address:\n" +
            addr +
            "\n\n" +
            feeLine +
            totalLine +
            "\n\n" +
            payPrompt,
          order_id: order.id,
        };
      }

      // ✅ Non-restaurant: also return
      await setState(org_id, from_phone, "awaiting_payment");
      return {
        used: true,
        kind: "order",
        reply:
          "✅ *Delivery details saved!*\n\n" +
          "📍 Delivery address:\n" +
          addr +
          "\n\n" +
          feeLine +
          totalLine +
          "\n\n" +
          payPrompt,
        order_id: order.id,
      };
    }

    // 2.c) Neither skip nor location → re-prompt
    console.log("[ADDR][PIN_STAGE_NO_SKIP_NO_LOCATION]", {
      rawText,
      lower,
      locLat,
      locLng,
    });
    return {
      used: true,
      kind: "order",
      reply:
        "To calculate delivery fee:\n" +
        "• Please send your *location pin* (📎 → Location)\n" +
        "• Or type *skip* to continue without location.",
      order_id: order.id,
    };
  }

  // Fallback – should rarely hit
  return {
    used: false,
    kind: "order",
    reply: "",
    order_id: null,
  };
}
