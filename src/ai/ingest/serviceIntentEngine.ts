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


  export type ServiceLane =
  | "menu"
  | "opening_hours"
  | "delivery_now"
  | "delivery_area"
  | "delivery_time_specific"
  | "store_location"
  | "pricing_generic"
  | "contact";

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


function buildDeliveryTimeSpecificReply(cfg: OrgServiceConfig, text: string): string {
  const name = cfg.name || "we";
  const tz = cfg.store_timezone || "Asia/Kolkata";
  const openT = cfg.delivery_open_time ?? null;
  const closeT = cfg.delivery_close_time ?? null;

  const hoursLine = fmtHours(openT, closeT);
  const st = isOpenNowInTz(tz, openT, closeT);

  // simple “best effort” messaging (no hard schedule promises)
  // we just explain hours + ask confirmation
  const lines: string[] = [];

  lines.push(`🕒 About delivery timing:`);

  if (hoursLine) lines.push(hoursLine);

  if (st.hasHours) {
    lines.push(
      st.isOpen
        ? `✅ ${name} is open now.`
        : `❌ ${name} is closed right now.`
    );
  }

  lines.push(
    "",
    `Please confirm your area + exact time (e.g. *today 12:00 AM*). I’ll tell you if delivery is possible.`
  );

  return lines.join("\n");
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

type ProductRow = {
  id: string;
  canonical: string;
  display_name: string | null;
  category: string | null;
  unit: string | null;
  default_unit: string | null;
  price_per_unit: number | null;
  active?: boolean | null;
  is_active?: boolean | null;
};

async function handleMenuLane(
  org_id: string,
  cfg: OrgServiceConfig,
  text?: string
): Promise<string> {
  const name = cfg.name || "our shop";

  const { data: productsRaw, error } = await supa
    .from("products")
    .select(
      "id, canonical, display_name, category, unit, default_unit, price_per_unit, active, is_active"
    )
    .eq("org_id", org_id)
    .order("category", { ascending: true })
    .order("canonical", { ascending: true })
    .limit(200);

  if (error) {
    console.warn("[MENU][PRODUCT_FETCH_ERR]", error.message);
  }

  const products: ProductRow[] =
    (productsRaw || []).filter((p) => p.active !== false && p.is_active !== false);

  if (!products.length) {
      return [
        `📋 Menu is not configured yet for *${name}*.`,
        `You can still send the item name with quantity, and the staff will confirm.`,
        ``,
        `For example: *item name 1*, *item name 2*, etc.`,
      ].join("\n");
  }

  // Distinct categories for this org
  const categories = Array.from(
    new Set(
      products
        .map((p) => (p.category || "").trim())
        .filter((c) => c.length > 0)
    )
  );

  const lowerText = (text || "").toLowerCase();

  // Try to detect if user mentioned a category explicitly
  let matchedCategory: string | null = null;
  for (const cat of categories) {
    const lc = cat.toLowerCase();
    if (lc.length >= 3 && lowerText.includes(lc)) {
      matchedCategory = cat;
      break;
    }
  }

  // Helper: choose a nice example qty for a product
  function computeExampleQty(p: ProductRow): string {
    const rawUnit = (p.unit || p.default_unit || "").toLowerCase();
    if (!rawUnit) return "1";

    if (rawUnit.includes("kg")) return "1kg";
    if (rawUnit.includes("g")) return "500g";
    if (rawUnit.includes("ml")) return "1 " + rawUnit;
    if (rawUnit.includes("l")) return "1 " + rawUnit;

    // generic "qty" style
    return "2";
  }

  // Helper: printable line for one product
  function formatProductLine(p: ProductRow, idx?: number): string {
    const label = p.display_name || p.canonical;
    const price = p.price_per_unit != null ? ` – ₹${p.price_per_unit}` : "";
    if (idx != null) {
      return `${idx}) ${label}${price}`;
    }
    return `• ${label}${price}`;
  }

  // If user text matches a category -> show items from that category
  if (matchedCategory) {
    const inCat = products.filter(
      (p) =>
        (p.category || "").toLowerCase() === matchedCategory!.toLowerCase()
    );

    if (!inCat.length) {
      // category detected but no products (edge case)
      return (
        `📋 *${matchedCategory}* items are not configured yet.\n` +
        `You can still type the item you need, e.g. *${matchedCategory} 1kg*.`
      );
    }

    const lines: string[] = [];
    lines.push(`📋 *${matchedCategory}* items:`);

    inCat.slice(0, 15).forEach((p, i) => {
      lines.push(formatProductLine(p, i + 1));
    });

    const sample = inCat[0];
    const sampleName = sample.display_name || sample.canonical;
    const exampleQty = computeExampleQty(sample);

    lines.push(
      "",
      `You can now type the item you want to order, for example:`,
      `*${sampleName} ${exampleQty}*`
    );

    return lines.join("\n");
  }

  // No category detected in message:
  // 1) If we have categories -> show category list
  if (categories.length) {
    const lines: string[] = [];
    lines.push(`📋 *Here are our main categories:*`);

    categories.forEach((cat, i) => {
      lines.push(`${i + 1}) ${cat}`);
    });

    // Pick a sample category + product for examples
    const sampleCat = categories[0];
    const sampleProduct =
      products.find(
        (p) =>
          (p.category || "").toLowerCase() === sampleCat.toLowerCase()
      ) || products[0];

    const sampleName = sampleProduct.display_name || sampleProduct.canonical;
    const exampleQty = computeExampleQty(sampleProduct);

    lines.push(
      "",
      `You can:`,
      `- Ask for a category (e.g. *show ${sampleCat.toLowerCase()} items*).`,
      `- Or directly type an item to order (e.g. *${sampleName} ${exampleQty}*).`
    );

    return lines.join("\n");
  }

  // 2) No categories at all -> flat product list
  const lines: string[] = [];
  lines.push(`📋 *Available items at ${name}:*`);

  products.slice(0, 15).forEach((p, i) => {
    lines.push(formatProductLine(p, i + 1));
  });

  const sample = products[0];
  const sampleName = sample.display_name || sample.canonical;
  const exampleQty = computeExampleQty(sample);

  lines.push(
    "",
    `To order, simply type the item name and quantity, e.g. *${sampleName} ${exampleQty}*.`
  );

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
    "To place an order, just send the item names with quantity (e.g. *2 item A, 1 item B*) or type *menu*."
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


export async function handleServiceLaneAndReply(
  org_id: string,
  lane: ServiceLane,
  opts?: { raw?: string; normalizedText?: string }
): Promise<IngestResult | null> {
  try {
    const { data, error } = await supa
      .from("orgs")
      .select(`
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
      `)
      .eq("id", org_id)
      .maybeSingle();

    if (error) console.warn("[SERVICE][ORG_FETCH_ERR]", error.message);

    const cfg: OrgServiceConfig = (data as any) || {};
    const text = opts?.normalizedText || opts?.raw || "";

    let reply: string | null = null;

    switch (lane) {
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
      case "menu":
        reply = await handleMenuLane(org_id, cfg, text);
        break;
      case "delivery_time_specific":
        reply =
          "⏰ Delivery depends on our working hours.\n" +
            buildOpeningHoursReply(cfg) +
          "\n\nTell me the exact time (ex: *12:00 AM*) and your area, I’ll confirm if delivery is possible.";
          break;
      case "contact": {
        const name = cfg.name || "We";
        const phone = (cfg.phone || "").trim();
        reply = phone
          ? `📞 *${name}* contact: *${phone}*`
          : `📞 Please ask the staff here for the contact number.`;
        break;
      }
      default:
        return null;
    }

    return {
      used: true,
      kind: "service_inquiry",
      reply,
      order_id: null,
      meta: { lane },
    };
  } catch (e: any) {
    console.warn("[SERVICE][ERR]", e?.message || e);
    return null;
  }
}