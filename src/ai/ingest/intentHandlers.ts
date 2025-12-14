// src/ai/ingest/intentHandlers.ts
import { supa } from "../../db";
import type { IntentLane, RouteResult } from "./intentRouter";

type OrgCfg = {
  name: string | null;
  phone: string | null;
  store_address_text: string | null;
  delivery_open_time: string | null;
  delivery_close_time: string | null;
  store_timezone: string | null;

  delivery_free_km: number | null;
  delivery_max_km: number | null;
  delivery_fee_type: string | null;
  delivery_flat_fee: number | null;
  delivery_per_km_fee: number | null;

  faq_opening_hours_answer: string | null;
  faq_delivery_answer: string | null;
  faq_delivery_area_answer: string | null;
  faq_pricing_answer: string | null;
  faq_contact_answer: string | null;
  faq_location_answer: string | null;
};

function parseHHMM(s?: string | null) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2}):(\d{2})/);
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

  if (closeMin > openMin) return { hasHours: true, isOpen: nowMin >= openMin && nowMin < closeMin };
  return { hasHours: true, isOpen: nowMin >= openMin || nowMin < closeMin };
}

function fmtHours(openHHMM: string | null, closeHHMM: string | null) {
  if (!openHHMM || !closeHHMM) return "";
  return `Today’s hours: *${openHHMM.slice(0, 5)} – ${closeHHMM.slice(0, 5)}*`;
}

async function getOrgCfg(orgId: string): Promise<OrgCfg> {
  const { data } = await supa
    .from("orgs")
    .select(`
      name, phone, store_address_text,
      delivery_open_time, delivery_close_time, store_timezone,
      delivery_free_km, delivery_max_km, delivery_fee_type, delivery_flat_fee, delivery_per_km_fee,
      faq_opening_hours_answer, faq_delivery_answer, faq_delivery_area_answer, faq_pricing_answer,
      faq_contact_answer, faq_location_answer
    `)
    .eq("id", orgId)
    .maybeSingle();

  return (data as any) || {};
}

export async function buildReplyForIntent(params: {
  orgId: string;
  intent: IntentLane;
  normalizedText: string;
}): Promise<string | null> {
  const cfg = await getOrgCfg(params.orgId);
  const name = cfg.name || "We";
  const tz = cfg.store_timezone || "Asia/Kolkata";

  if (params.intent === "opening_hours") {
    if (cfg.faq_opening_hours_answer?.trim()) return cfg.faq_opening_hours_answer.trim();

    const st = isOpenNowInTz(tz, cfg.delivery_open_time ?? null, cfg.delivery_close_time ?? null);
    const hours = fmtHours(cfg.delivery_open_time ?? null, cfg.delivery_close_time ?? null);

    if (st.hasHours) {
      return st.isOpen
        ? `✅ Yes, *${name}* is *OPEN* now.\n${hours}\n\nType *menu* or send items (e.g. *2 Chicken Biryani, 1 Coke*).`
        : `❌ *${name}* is *CLOSED* right now.\n${hours}\n\nYou can still send your order — we’ll confirm it when we open.`;
    }

    return `${name} is open during our working hours.\nIf you want exact timings, please call us or ask here.`;
  }

  if (params.intent === "contact") {
    if (cfg.faq_contact_answer?.trim()) return cfg.faq_contact_answer.trim();

    const phone = cfg.phone ? `📞 Call: *${cfg.phone}*` : null;
    const wa = `💬 WhatsApp: reply here anytime`;
    return [ `You can contact *${name}* here:`, wa, phone ].filter(Boolean).join("\n");
  }

  if (params.intent === "store_location") {
    if (cfg.faq_location_answer?.trim()) return cfg.faq_location_answer.trim();

    if (cfg.store_address_text?.trim()) {
      return `📍 *${name}* location:\n${cfg.store_address_text.trim()}\n\nIf you want, share your area and I’ll confirm delivery availability.`;
    }
    return `📍 I don’t have the exact address saved yet.\nPlease call us or ask the staff here for the location.`;
  }

  if (params.intent === "delivery_time_specific") {
    // User asking “12am delivery?”
    const st = isOpenNowInTz(tz, cfg.delivery_open_time ?? null, cfg.delivery_close_time ?? null);
    const hours = fmtHours(cfg.delivery_open_time ?? null, cfg.delivery_close_time ?? null);
    if (st.hasHours) {
      return `Our delivery depends on working hours.\n${hours}\n\nTell me your delivery time + area, I’ll confirm if possible.`;
    }
    return `Delivery depends on working hours. Please call us to confirm late-night delivery.`;
  }

  if (params.intent === "delivery_now") {
    if (cfg.faq_delivery_answer?.trim()) return cfg.faq_delivery_answer.trim();

    const st = isOpenNowInTz(tz, cfg.delivery_open_time ?? null, cfg.delivery_close_time ?? null);
    const hours = fmtHours(cfg.delivery_open_time ?? null, cfg.delivery_close_time ?? null);

    if (st.hasHours && !st.isOpen) {
      return `❌ Sorry, *${name}* is *closed* right now, so we’re *not delivering now*.\n${hours}\n\nYou can still send your order — we’ll confirm it when we open.`;
    }

    const freeKm = Number(cfg.delivery_free_km ?? 0);
    const maxKm = Number(cfg.delivery_max_km ?? 0);
    const feeType = (cfg.delivery_fee_type || "").toLowerCase();
    const flat = Number(cfg.delivery_flat_fee ?? 0);
    const perKm = Number(cfg.delivery_per_km_fee ?? 0);

    const lines: string[] = [];
    lines.push(`✅ Yes, *${name}* can deliver now.`);
    if (hours) lines.push(hours);
    if (maxKm > 0) lines.push(`We usually deliver within *${maxKm} km* from the store.`);

    if (feeType === "flat" && flat > 0) {
      lines.push(freeKm > 0
        ? `Delivery is *free up to ${freeKm} km*, then a flat fee of *₹${flat}*.`
        : `Delivery fee is a flat *₹${flat}* per order.`
      );
    } else if (feeType === "per_km" && perKm > 0) {
      lines.push(freeKm > 0
        ? `Delivery is *free up to ${freeKm} km*, then around *₹${perKm} per km* after that.`
        : `Delivery fee is around *₹${perKm} per km* from the store.`
      );
    }

    lines.push("", "To place an order, send item names (e.g. *2 Chicken Biryani, 1 Coke*) or type *menu*.");
    return lines.join("\n");
  }

  if (params.intent === "menu") {
    // You already have menu flow; just return a trigger string or call your menu builder.
    // Keep it clean: do NOT treat as order.
    return `Sure — here’s our menu.\nType *menu* (or reply *1*) to see full list, or tell me what you want (e.g. *2 Chicken Biryani*).`;
  }

  if (params.intent === "human_help") {
    // The golden fallback (never “type item name”)
    return [
      "I can help with:",
      "1) *Menu*",
      "2) *Today’s opening hours*",
      "3) *Delivery now / delivery area*",
      "4) *Store location*",
      "5) *Contact number*",
      "",
      "Reply with a number (1–5) or type what you need."
    ].join("\n");
  }

  return null;
}