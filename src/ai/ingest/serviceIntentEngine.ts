// src/ai/ingest/serviceIntentEngine.ts
import { supa } from "../../db";
import type { IngestResult } from "./types";

type ServiceIntent =
  | "delivery_now"
  | "opening_hours"
  | "pricing_generic"
  | "delivery_area"
  | "store_location"
  | "none";

type OrgServiceConfig = {
  name?: string | null;
  business_type?: string | null;
  store_address_text?: string | null;
  delivery_free_km?: number | null;
  delivery_max_km?: number | null;
  delivery_fee_type?: string | null; 
  delivery_flat_fee?: number | null;
  delivery_per_km_fee?: number | null;
  faq_delivery_answer?: string | null;
  faq_opening_hours_answer?: string | null;
  faq_pricing_answer?: string | null;
  faq_delivery_area_answer?: string | null;
  delivery_open_time?: string | null;  
  delivery_close_time?: string | null;  
  store_timezone?: string | null;      
  phone?: string | null;
  store_lat?: number | null;
  store_lng?: number | null; 
};

// Simple helper: lower + trimmed
function norm(text: string): string {
  return (text || "").toLowerCase().trim();
}

function parseHHMM(s?: string | null) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2}):(\d{2})/); // supports "10:30" or "10:30:00"
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

function getMinutesInTimeZone(tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

function isOpenNowInTz(tz: string, openHHMM: string | null, closeHHMM: string | null) {
  const o = parseHHMM(openHHMM);
  const c = parseHHMM(closeHHMM);
  if (!o || !c) return { hasHours: false, isOpen: false };

  const openMin = o.h * 60 + o.m;
  const closeMin = c.h * 60 + c.m;
  const nowMin = getMinutesInTimeZone(tz);

  // same-day window
  if (closeMin > openMin) {
    return { hasHours: true, isOpen: nowMin >= openMin && nowMin < closeMin };
  }

  // overnight window (e.g. 18:00 → 02:00)
  return { hasHours: true, isOpen: nowMin >= openMin || nowMin < closeMin };
}

function fmtHours(openHHMM: string | null, closeHHMM: string | null) {
  if (!openHHMM || !closeHHMM) return "";
  const o = (openHHMM || "").slice(0, 5);
  const c = (closeHHMM || "").slice(0, 5);
  return `Today’s hours: *${o} – ${c}*`;
}

function detectServiceIntent(text: string): ServiceIntent {
  const t = norm(text);

  if (!t) return "none";

  // Delivery now / availability
  if (
    (t.includes("deliver") || t.includes("delivery")) &&
    (t.includes("now") ||
      t.includes("today") ||
      t.includes("available") ||
      t.includes("are you") ||
      t.includes("do you"))
  ) {
    return "delivery_now";
  }

  // Delivery area: "do you deliver in xxxx / to xxxx?"
  if (
    (t.includes("deliver to") ||
      t.includes("deliver in") ||
      t.includes("delivery in") ||
      t.includes("delivery to") ||
      t.includes("deliver at")) &&
    !t.includes("price") &&
    !t.includes("how much")
  ) {
    return "delivery_area";
  }

  // Opening hours
  if (
    t.includes("open now") ||
    t.includes("are you open") ||
    t.includes("opening time") ||
    t.includes("closing time") ||
    t.includes("what time do you open") ||
    t.includes("what time do you close") ||
    t.includes("timings") ||
    t.includes("working hours") ||
    t.includes("business hours")
  ) {
    return "opening_hours";
  }

  // Store location / address
if (
  t.includes("where is your store") ||
  t.includes("where is the store") ||
  t.includes("store address") ||
  t.includes("address") ||
  t.includes("location") ||
  t.includes("google map") ||
  t.includes("map") ||
  t.includes("how to reach") ||
  t.includes("route")
) {
  return "store_location";
}

  // Generic price / pricing questions (not tied to a specific item)
  if (
    t.includes("price") ||
    t.includes("how much") ||
    t.includes("rate card") ||
    t.includes("ratecard") ||
    t.includes("rate?")
  ) {
    // If they also mention a clear item, it might be better to keep it in
    // normal order flow later; keep this simple for now:
    return "pricing_generic";
  }

  return "none";
}

function buildStoreLocationReply(cfg: OrgServiceConfig): string {
  const name = cfg.name || "We";
  const addr = (cfg.store_address_text || "").trim();
  const phone = (cfg.phone || "").trim();
  const lat = typeof cfg.store_lat === "number" ? cfg.store_lat : null;
  const lng = typeof cfg.store_lng === "number" ? cfg.store_lng : null;

  const lines: string[] = [];
  lines.push(`📍 *${name}* location:`);

  if (addr) lines.push(`Address: *${addr}*`);

  if (lat != null && lng != null) {
    lines.push(`🗺️ Google Maps: https://www.google.com/maps?q=${lat},${lng}`);
  }

  if (phone) lines.push(`📞 Call/WhatsApp: *${phone}*`);

  if (!addr && (lat == null || lng == null)) {
    lines.push(
      "Please share your *location pin* (📎 → Location) and I’ll guide you."
    );
  }

  return lines.join("\n");
}

function buildDeliveryNowReply(
  cfg: OrgServiceConfig,
  text: string
): string {
  // Store custom override first
  if (cfg.faq_delivery_answer && cfg.faq_delivery_answer.trim()) {
    return cfg.faq_delivery_answer.trim();
  }

  const name = cfg.name || "we";
  const tz = cfg.store_timezone || "Asia/Kolkata";
  const openT = cfg.delivery_open_time ?? null;
  const closeT = cfg.delivery_close_time ?? null;

  const st = isOpenNowInTz(tz, openT, closeT);
  const hoursLine = fmtHours(openT, closeT);
  if (st.hasHours && !st.isOpen) {
    return `❌ Sorry, *${name}* is *closed* right now, so we’re *not delivering now*.\n${hoursLine}\n\nYou can still send your order — we’ll confirm it when we open.`;
  }
  const freeKm = Number(cfg.delivery_free_km ?? 0);
  const maxKm = Number(cfg.delivery_max_km ?? 0);
  const feeType = (cfg.delivery_fee_type || "").toLowerCase();
  const flat = Number(cfg.delivery_flat_fee ?? 0);
  const perKm = Number(cfg.delivery_per_km_fee ?? 0);

  const lines: string[] = [];

  lines.push(`✅ Yes, ${name} can deliver now.`);
  if (hoursLine) lines.push(hoursLine);

  if (maxKm > 0) {
    lines.push(`We usually deliver within *${maxKm} km* from the store.`);
  }

  if (feeType === "flat" && flat > 0) {
    if (freeKm > 0) {
      lines.push(
        `Delivery is *free up to ${freeKm} km*, then a flat fee of *₹${flat}*.`
      );
    } else {
      lines.push(`Delivery fee is a flat *₹${flat}* per order.`);
    }
  } else if (feeType === "per_km" && perKm > 0) {
    if (freeKm > 0) {
      lines.push(
        `Delivery is *free up to ${freeKm} km*, then around *₹${perKm} per km* after that.`
      );
    } else {
      lines.push(`Delivery fee is around *₹${perKm} per km* from the store.`);
    }
  }

  lines.push(
    "",
  );
  lines.push(
    "To place an order, just send the item names (e.g. *2 Chicken Biryani, 1 Coke*) or type *menu*."
  );

  return lines.join("\n");
}

function buildOpeningHoursReply(cfg: OrgServiceConfig): string {
  if (cfg.faq_opening_hours_answer && cfg.faq_opening_hours_answer.trim()) {
    return cfg.faq_opening_hours_answer.trim();
  }

  const name = cfg.name || "We";
  const tz = cfg.store_timezone || "Asia/Kolkata";

  const openT = cfg.delivery_open_time ?? null;
  const closeT = cfg.delivery_close_time ?? null;

  const st = isOpenNowInTz(tz, openT, closeT);
  const hoursLine = fmtHours(openT, closeT);

  if (st.hasHours) {
    if (st.isOpen) {
      return `✅ Yes, *${name}* is *OPEN* now.\n${hoursLine}\n\nType *menu* or send items (e.g. *2 Chicken Biryani, 1 Coke*).`;
    }
    return `❌ *${name}* is *CLOSED* right now.\n${hoursLine}\n\nYou can still send your order — we’ll confirm it when we open.`;
  }

  // fallback if hours not configured
  return [
    `${name} is open during our working hours.`,
    "Please ask the staff here for exact timings.",
    "",
    "You can still send your order any time — we’ll process it during working hours.",
  ].join("\n");
}

function buildPricingReply(cfg: OrgServiceConfig): string {
  if (cfg.faq_pricing_answer && cfg.faq_pricing_answer.trim()) {
    return cfg.faq_pricing_answer.trim();
  }

  const bt = (cfg.business_type || "").toLowerCase();
  const name = cfg.name || "we";

  if (bt.includes("restaurant")) {
    return [
      `Our prices depend on the dish and portion size.`,
      "You can type *menu* to see popular items and prices, or send the dish name and I’ll help you choose.",
      "",
      "Example: *2 Chicken Biryani, 1 Coke*.",
    ].join("\n");
  }

  return [
    `${name} has different prices depending on the item.`,
    "Please send the product names (or type *menu* if available) and I’ll guide you with options.",
  ].join("\n");
}

function buildDeliveryAreaReply(cfg: OrgServiceConfig): string {
  if (cfg.faq_delivery_area_answer && cfg.faq_delivery_area_answer.trim()) {
    return cfg.faq_delivery_area_answer.trim();
  }

  const name = cfg.name || "we";
  const maxKm = Number(cfg.delivery_max_km ?? 0);

  const lines: string[] = [];

  if (maxKm > 0) {
    lines.push(
      `${name} usually delivers within *${maxKm} km* of the store location.`
    );
  } else {
    lines.push(`${name} delivers to nearby areas subject to availability.`);
  }

  lines.push(
    "",
    "For best accuracy, please send your *location pin* (📎 → Location) or type your full address here. I’ll confirm if delivery is possible."
  );

  return lines.join("\n");
}

/**
 * Main entry: returns an IngestResult if this looks like a service inquiry,
 * or null if we should continue with normal order flow.
 */
export async function detectServiceIntentAndReply(
  org_id: string,
  normalizedText: string,
  opts?: { raw?: string; vertical?: string }
): Promise<IngestResult | null> {
  const text = normalizedText || opts?.raw || "";
  const intent = detectServiceIntent(text);

  if (intent === "none") return null;

  try {
    const { data, error } = await supa
      .from("orgs")
      .select(
        `
        name,
        phone,
        business_type,
        store_address_text,
        store_lat,
        store_lng,
        delivery_open_time,
        delivery_close_time,
        store_timezone,
        delivery_free_km,
        delivery_max_km,
        delivery_fee_type,
        delivery_flat_fee,
        delivery_per_km_fee,
        faq_delivery_answer,
        faq_opening_hours_answer,
        faq_pricing_answer,
        faq_delivery_area_answer
      `
      )
      .eq("id", org_id)
      .maybeSingle();

    if (error) {
      console.warn("[SERVICE_INTENT][ORG_FETCH_ERR]", error.message);
    }

    const cfg: OrgServiceConfig = (data as any) || {};

    let reply: string;

    switch (intent) {
      case "delivery_now":
        reply = buildDeliveryNowReply(cfg, text);
        break;
      case "opening_hours":
        reply = buildOpeningHoursReply(cfg);
        break;
      case "pricing_generic":
        reply = buildPricingReply(cfg);
        break;
      case "delivery_area":
        reply = buildDeliveryAreaReply(cfg);
        break;
      case "store_location":
        reply = buildStoreLocationReply(cfg);
        break;
      default:
        return null;
    }

    const res: IngestResult = {
      used: true,
      kind: "service_inquiry",
      reply,
      order_id: null,
    };

    return res;
  } catch (e: any) {
    console.warn("[SERVICE_INTENT][ERR]", e?.message || e);
    return null;
  }
}