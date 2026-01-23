// src/ai/ingest/addressEngine.ts
import { supa } from "../../db";
import { IngestContext, IngestResult, ConversationState } from "./types";
import { setState, clearState } from "./stateManager";
import axios from "axios";
import { detectMetaIntent } from "./metaIntent";
import { getAttempts, incAttempts, resetAttempts } from "./attempts";

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

  delivery_open_time?: string | null; // "11:00:00"
  delivery_close_time?: string | null; // "23:00:00"
  store_timezone?: string | null; // "Asia/Kolkata"

  delivery_slot_enabled?: boolean | null;
  delivery_slot_interval_min?: number | null; // default 30
  delivery_slot_prep_min?: number | null; // default 45
  delivery_slot_capacity?: number | null; // default 10
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
async function getLatestPendingOrder(org_id: string, from_phone: string) {
  const { data } = await supa
    .from("orders")
    .select("id, total_amount, delivery_address_text, delivery_fee, delivery_lat, delivery_lng")
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .in("status", ["awaiting_customer_action", "awaiting_store_action", "accepted"] as any)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as OrderRow) || null;
}

async function getOrgConfig(org_id: string): Promise<OrgDeliveryConfig | null> {
  const { data } = await supa
    .from("orgs")
    .select(
      "id, store_lat, store_lng, delivery_free_km, delivery_max_km, delivery_fee_type, delivery_flat_fee, delivery_per_km_fee, accept_only_cash, delivery_slot_enabled, delivery_open_time, delivery_close_time, store_timezone, delivery_slot_interval_min, delivery_slot_prep_min, delivery_slot_capacity"
    )
    .eq("id", org_id)
    .maybeSingle();

  return (data as OrgDeliveryConfig) || null;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

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

  const freeKm = cfg.delivery_free_km != null ? Number(cfg.delivery_free_km) : 0;
  const maxKm = cfg.delivery_max_km != null ? Number(cfg.delivery_max_km) : null;

  if (storeLat == null || storeLng == null || customerLat == null || customerLng == null) {
    return {
      ok: false,
      reason: "missing_coords",
      distanceKm: null,
      fee: null,
      freeKm,
      maxKm,
    };
  }

  const distanceKm = haversineKm(Number(storeLat), Number(storeLng), Number(customerLat), Number(customerLng));

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
      const perKm = cfg.delivery_per_km_fee != null ? Number(cfg.delivery_per_km_fee) : 0;
      const billableKm = Math.max(0, distanceKm - freeKm);
      fee = billableKm * perKm;
    } else {
      fee = 0;
    }
  }

  return {
    ok: true,
    distanceKm,
    fee,
    freeKm,
    maxKm,
  };
}

async function geocodeAddressToLatLng(address: string) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const url = "https://maps.googleapis.com/maps/api/geocode/json";

  try {
    const resp = await axios.get(url, {
      params: { address, key: apiKey },
    });

    const data = resp.data;

    if (data.status !== "OK" || !data.results || data.results.length === 0) return null;

    const loc = data.results[0]?.geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;

    return { lat: loc.lat, lng: loc.lng };
  } catch {
    return null;
  }
}

// Small helpers
function formatFeeLine(fee: number | null | undefined) {
  if (fee == null) return "🚚 Delivery fee: will be confirmed by the store.";
  if (fee === 0) return "🚚 Delivery fee: *FREE*";
  return `🚚 Delivery fee: *₹${fee.toFixed(0)}*`;
}

function buildPaymentPrompt(onlyCash?: boolean | null) {
  if (onlyCash) {
    return "How would you like to pay?\n1) Cash\n\nType *1* to confirm Cash on Delivery.";
  }
  return "How would you like to pay?\n1) Cash\n2) Online Payment\n\nType *1* or *2*.";
}

// ─────────────────────────────────────────────
// ✅ SLOT HELPERS (V1: Today + Tomorrow only)
// Rules:
// - slot list comes from org open/close + interval
// - exclude slots earlier than (now + prepMin) on TODAY
// - capacity per slot (default 10)
// - show only available slots (count < capacity)
// ─────────────────────────────────────────────

function getNowPartsInTz(tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const pick = (type: string) => parts.find((p) => p.type === type)?.value || "0";

  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
  };
}

function getTodayInTz(tz: string): Date {
  const p = getNowPartsInTz(tz);
  return new Date(p.year, p.month - 1, p.day);
}

function toISODate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatSlotLabel(h: number, m: number) {
  const hour12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "AM" : "PM";
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatSlotRangeLabel(startMinutes: number, durationMinutes: number) {
  const sh = Math.floor(startMinutes / 60);
  const sm = startMinutes % 60;

  const endMinutes = startMinutes + durationMinutes;
  const eh = Math.floor(endMinutes / 60);
  const em = endMinutes % 60;

  return `${formatSlotLabel(sh, sm)} – ${formatSlotLabel(eh, em)}`;
}

function parseChoice(raw: string): number | null {
  const n = Number(String(raw || "").trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

async function getSlotCountsForDate(org_id: string, isoDate: string): Promise<Record<string, number>> {
  const { data } = await supa
    .from("orders")
    .select("delivery_slot_start")
    .eq("org_id", org_id)
    .eq("delivery_slot_date", isoDate)
    .eq("delivery_type", "delivery")
    .in("status", ["awaiting_customer_action", "awaiting_store_action", "accepted"] as any);

  const counts: Record<string, number> = {};
  for (const row of (data as any[]) || []) {
    const start = row?.delivery_slot_start;
    if (!start) continue;
    counts[start] = (counts[start] || 0) + 1;
  }
  return counts;
}

function buildSlotsForDate(opts: {
  date: Date;
  tz: string;
  open: string; // "11:00:00"
  close: string; // "23:00:00"
  intervalMin: number;
  prepMin: number;
  capacity: number;
  counts: Record<string, number>;
  isToday: boolean;
}): { date: string; start: string; label: string }[] {
  const openParts = (opts.open || "09:00:00").split(":").map((x) => parseInt(x, 10));
  const closeParts = (opts.close || "22:00:00").split(":").map((x) => parseInt(x, 10));
  const oh = openParts[0] || 0;
  const om = openParts[1] || 0;
  const ch = closeParts[0] || 0;
  const cm = closeParts[1] || 0;

  const startMinutes = oh * 60 + om;
  const endMinutes = ch * 60 + cm;

  let minAllowed = startMinutes;

  if (opts.isToday) {
    const now = getNowPartsInTz(opts.tz);
    const nowMinutes = now.hour * 60 + now.minute;
    minAllowed = Math.max(minAllowed, nowMinutes + opts.prepMin);
  }

  // round UP to nearest interval
  const step = Math.max(5, opts.intervalMin || 30);
  minAllowed = Math.ceil(minAllowed / step) * step;

  const out: { date: string; start: string; label: string }[] = [];
  const isoDate = toISODate(opts.date);

  for (let t = minAllowed; t + step <= endMinutes; t += step) {
    const h = Math.floor(t / 60);
    const m = t % 60;
    const start = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const booked = opts.counts[start] || 0;

    if (booked < opts.capacity) {
      out.push({ date: isoDate, start, label: formatSlotRangeLabel(t, step) });
    }
  }

  return out;
}

function buildSlotPromptV1(params: {
  todaySlots: { date: string; start: string; label: string }[];
  tomorrowSlots: { date: string; start: string; label: string }[];
}) {
  const { todaySlots, tomorrowSlots } = params;

  const lines: string[] = [];
  let idx = 1;

  if (todaySlots.length) {
    lines.push("*Today*");
    for (const s of todaySlots.slice(0, 6)) {
      lines.push(`${idx}) ${s.label}`);
      idx++;
    }
    lines.push("");
  } else {
    lines.push("*Today*: (no slots available)");
    lines.push("");
  }

  if (tomorrowSlots.length) {
    lines.push("*Tomorrow*");
    for (const s of tomorrowSlots.slice(0, 6)) {
      lines.push(`${idx}) ${s.label}`);
      idx++;
    }
  } else {
    lines.push("*Tomorrow*: (no slots available)");
  }

  return "⏰ Choose delivery time:\n" + lines.join("\n").trim() + "\n\nReply with the number.";
}

// ─────────────────────────────────────────────
// MAIN: Address Flow
// ─────────────────────────────────────────────
export async function handleAddress(ctx: IngestContext, state: ConversationState): Promise<IngestResult> {
  const { org_id, from_phone } = ctx;
  const rawText = (ctx.text || "").trim();
  const lower = rawText.toLowerCase();

  const locLat = (ctx as any).location_lat ?? null;
  const locLng = (ctx as any).location_lng ?? null;

  // ─────────────────────────────────────────
  // ✅ SLOT SELECTION STATE (V1)
  // ─────────────────────────────────────────
  if (state === "awaiting_delivery_slot") {
    const order = await getLatestPendingOrder(org_id, from_phone);
    if (!order) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: "⚠️ I couldn't find an active order.\nPlease type the item name to start a new order.",
      };
    }

    const orgCfg = await getOrgConfig(org_id);
    const tz = orgCfg?.store_timezone || "Asia/Kolkata";

    const open = orgCfg?.delivery_open_time || "09:00:00";
    const close = orgCfg?.delivery_close_time || "22:00:00";

    const intervalMin = Number(orgCfg?.delivery_slot_interval_min || 30);
    const prepMin = Number(orgCfg?.delivery_slot_prep_min || 45);
    const capacity = Number(orgCfg?.delivery_slot_capacity || 10);

    const meta = detectMetaIntent(rawText);
    if (meta === "reset") {
      await clearState(org_id, from_phone);
      await resetAttempts(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: "No problem 👍 I’ve cancelled this step.\nYou can type your order again or say *menu*.",
      };
    }
    if (meta === "agent") {
      await clearState(org_id, from_phone);
      await resetAttempts(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: "I’ll ask a human to help you. Someone will contact you shortly 😊",
      };
    }
    if (meta === "back") {
      await setState(org_id, from_phone, "awaiting_location_pin");
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply: "Please resend your location pin or type *skip*.",
      };
    }

    const today = getTodayInTz(tz);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const todayIso = toISODate(today);
    const tomorrowIso = toISODate(tomorrow);

    const todayCounts = await getSlotCountsForDate(org_id, todayIso);
    const tomorrowCounts = await getSlotCountsForDate(org_id, tomorrowIso);

    const todaySlots = buildSlotsForDate({
      date: today,
      tz,
      open,
      close,
      intervalMin,
      prepMin,
      capacity,
      counts: todayCounts,
      isToday: true,
    });

    const tomorrowSlots = buildSlotsForDate({
      date: tomorrow,
      tz,
      open,
      close,
      intervalMin,
      prepMin,
      capacity,
      counts: tomorrowCounts,
      isToday: false,
    });

    const combined = [...todaySlots, ...tomorrowSlots];

    if (!combined.length) {
      await setState(org_id, from_phone, "awaiting_delivery_slot");
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply:
          "😅 No delivery slots available for *Today* or *Tomorrow*.\n" +
          "Please try again later or contact the store.",
      };
    }

    const choice = parseChoice(rawText);
    if (!choice || choice < 1 || choice > combined.length) {
      await setState(org_id, from_phone, "awaiting_delivery_slot");
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply: buildSlotPromptV1({ todaySlots, tomorrowSlots }),
      };
    }

    const picked = combined[choice - 1];

    // Re-check capacity at selection time (race condition guard)
    const freshCounts = await getSlotCountsForDate(org_id, picked.date);
    if ((freshCounts[picked.start] || 0) >= capacity) {
      await setState(org_id, from_phone, "awaiting_delivery_slot");
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply: "😅 That slot just got filled.\n\n" + buildSlotPromptV1({ todaySlots, tomorrowSlots }),
      };
    }

    await supa
      .from("orders")
      .update({
        delivery_slot_date: picked.date,
        delivery_slot_start: picked.start,
        delivery_slot_label: picked.label,
      } as any)
      .eq("id", order.id);

    await setState(org_id, from_phone, "awaiting_payment");

    return {
      used: true,
      kind: "order",
      order_id: order.id,
      reply: `✅ Delivery slot saved: *${picked.label}*\n\n` + buildPaymentPrompt(orgCfg?.accept_only_cash),
    };
  }

  // ─────────────────────────────────────────────
  // 1) USER SENDING ADDRESS  (state = awaiting_address)
  // ─────────────────────────────────────────────
  if (state === "awaiting_address") {
    const msg = rawText;
    const meta = detectMetaIntent(rawText);

    if (meta === "reset") {
      await clearState(org_id, from_phone);
      await resetAttempts(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: "No problem 👍 I’ve cancelled this step.\nYou can type your order again or say *menu*.",
      };
    }

    if (meta === "agent") {
      await clearState(org_id, from_phone);
      await resetAttempts(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: "I’ll ask a human to help you with the address. Someone will contact you shortly 😊",
      };
    }

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

    if (locLat == null && locLng == null && !looksLikeAddress(msg)) {
      await setState(org_id, from_phone, "awaiting_address");
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
        reply: "⚠️ I couldn't find an active order.\nPlease type the item name to start a new order.",
        order_id: null,
      };
    }

    const addressText = msg;

    await supa
      .from("orders")
      .update({
        shipping_address: addressText,
        delivery_address_text: addressText,
        delivery_lat: null,
        delivery_lng: null,
        delivery_distance_km: null,
        delivery_fee: null,
        delivery_status: "pending_address",
      } as any)
      .eq("id", order.id);

    await resetAttempts(org_id, from_phone);
    await setState(org_id, from_phone, "awaiting_location_pin");

    if (locLat != null && locLng != null) {
      return await handleAddress({ ...ctx, location_lat: locLat, location_lng: locLng }, "awaiting_location_pin");
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
        reply: "⚠️ I couldn't find an active order.\nPlease type the item name to start a new order.",
        order_id: null,
      };
    }

    const addr = order.delivery_address_text || "(no address text)";
    const totalNum = order.total_amount != null ? Number(order.total_amount) : null;

    // 2.a) SKIP branch
    if (["skip", "no", "later", "dont", "don't"].includes(lower)) {
      let finalLat: number | null = (order as any).delivery_lat ?? null;
      let finalLng: number | null = (order as any).delivery_lng ?? null;

      if (finalLat == null || finalLng == null) {
        const geo = await geocodeAddressToLatLng(addr);
        if (geo) {
          finalLat = geo.lat;
          finalLng = geo.lng;
        }
      }

      const quote = await computeDeliveryQuote(org_id, finalLat, finalLng);

      let deliveryFee: number | null = null;
      let distanceKm: number | null = null;
      let deliveryStatus: string = "pending_address";

      if (quote.ok) {
        deliveryFee = quote.fee;
        distanceKm = quote.distanceKm;
        deliveryStatus = "confirmed";
      }

      if (!quote.ok && quote.reason === "too_far") {
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

        const distStr = quote.distanceKm != null ? `${quote.distanceKm.toFixed(1)} km` : "too far";
        const maxStr = quote.maxKm != null ? `${quote.maxKm.toFixed(1)} km` : "the allowed radius";

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

      await supa
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

      const feeLine = formatFeeLine(deliveryFee);
      const totalLine = totalNum != null ? `\n💰 Order total (items): *₹${totalNum.toFixed(0)}*` : "";

      const orgCfg = await getOrgConfig(org_id);

// ✅ SLOT ROUTE (ONLY IF ENABLED)
if (orgCfg?.delivery_slot_enabled) {
  await setState(org_id, from_phone, "awaiting_delivery_slot");

  const tz = orgCfg?.store_timezone || "Asia/Kolkata";
  const open = orgCfg?.delivery_open_time || "09:00:00";
  const close = orgCfg?.delivery_close_time || "22:00:00";
  const intervalMin = Number(orgCfg?.delivery_slot_interval_min || 30);
  const prepMin = Number(orgCfg?.delivery_slot_prep_min || 45);
  const capacity = Number(orgCfg?.delivery_slot_capacity || 10);

  const today = getTodayInTz(tz);
  const todayISO = toISODate(today);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowISO = toISODate(tomorrow);

  // ✅ these are awaited in async handleAddress (valid)
  const todayCounts = await getSlotCountsForDate(org_id, todayISO);
  const tomorrowCounts = await getSlotCountsForDate(org_id, tomorrowISO);

  const todaySlots = buildSlotsForDate({
    date: today,
    tz,
    open,
    close,
    intervalMin,
    prepMin,
    capacity,
    counts: todayCounts,
    isToday: true,
  });

  const tomorrowSlots = buildSlotsForDate({
    date: tomorrow,
    tz,
    open,
    close,
    intervalMin,
    prepMin,
    capacity,
    counts: tomorrowCounts,
    isToday: false,
  });

  return {
    used: true,
    kind: "order",
    order_id: order.id,
    reply:
      "✅ *Delivery details saved!*\n\n" +
      "📍 Delivery address:\n" +
      addr +
      "\n\n" +
      feeLine +
      totalLine +
      "\n\n" +
      buildSlotPromptV1({ todaySlots, tomorrowSlots }),
  };
}

      // old behavior
      const payPrompt = buildPaymentPrompt(orgCfg?.accept_only_cash);
      await setState(org_id, from_phone, "awaiting_payment");
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply:
          "✅ *Delivery details saved!*\n\n" +
          "📍 Delivery address:\n" +
          addr +
          "\n\n" +
          feeLine +
          totalLine +
          "\n\n" +
          payPrompt,
      };
    }

    // 2.b) Location pin branch
    if (locLat != null && locLng != null) {
      const quote = await computeDeliveryQuote(org_id, locLat, locLng);

      if (!quote.ok && quote.reason === "too_far") {
        await setState(org_id, from_phone, "awaiting_address");

        const distStr = quote.distanceKm != null ? `${quote.distanceKm.toFixed(1)} km` : "too far";
        const maxStr = quote.maxKm != null ? `${quote.maxKm.toFixed(1)} km` : "the allowed radius";

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

      await supa
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

      const feeLine = formatFeeLine(deliveryFee);
      const totalLine = totalNum != null ? `\n💰 Order total (items): *₹${totalNum.toFixed(0)}*` : "";

      const orgCfg = await getOrgConfig(org_id);

      // ✅ SLOT ROUTE (ONLY IF ENABLED)
      if (orgCfg?.delivery_slot_enabled) {
        await setState(org_id, from_phone, "awaiting_delivery_slot");
        return {
          used: true,
          kind: "order",
          order_id: order.id,
          reply: "✅ *Delivery details saved!*\n\n" + buildSlotPromptV1(
            // we keep the slot prompt generation in the slot-state itself,
            // so just tell user to pick; they will get the prompt when they reply.
            { todaySlots: [], tomorrowSlots: [] }
          ),
        };
      }

      // old behavior
      const payPrompt = buildPaymentPrompt(orgCfg?.accept_only_cash);
      await setState(org_id, from_phone, "awaiting_payment");
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply:
          "✅ *Delivery details saved!*\n\n" +
          "📍 Delivery address:\n" +
          addr +
          "\n\n" +
          feeLine +
          totalLine +
          "\n\n" +
          payPrompt,
      };
    }

    // 2.c) Neither skip nor location → re-prompt
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

  // Fallback
  return {
    used: false,
    kind: "order",
    reply: "",
    order_id: null,
  };
}