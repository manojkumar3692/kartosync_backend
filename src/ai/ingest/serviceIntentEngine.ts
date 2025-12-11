// src/ai/ingest/serviceIntentEngine.ts
import { supa } from "../../db";
import type { IngestResult } from "./types";

type ServiceIntent =
  | "delivery_now"
  | "opening_hours"
  | "pricing_generic"
  | "delivery_area"
  | "none";

type OrgServiceConfig = {
  name?: string | null;
  business_type?: string | null;
  store_address_text?: string | null;
  delivery_free_km?: number | null;
  delivery_max_km?: number | null;
  delivery_fee_type?: string | null;     // 'flat' | 'per_km'
  delivery_flat_fee?: number | null;
  delivery_per_km_fee?: number | null;
  faq_delivery_answer?: string | null;
  faq_opening_hours_answer?: string | null;
  faq_pricing_answer?: string | null;
  faq_delivery_area_answer?: string | null;
};

// Simple helper: lower + trimmed
function norm(text: string): string {
  return (text || "").toLowerCase().trim();
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

function buildDeliveryNowReply(
  cfg: OrgServiceConfig,
  text: string
): string {
  // Store custom override first
  if (cfg.faq_delivery_answer && cfg.faq_delivery_answer.trim()) {
    return cfg.faq_delivery_answer.trim();
  }

  const name = cfg.name || "we";
  const freeKm = Number(cfg.delivery_free_km ?? 0);
  const maxKm = Number(cfg.delivery_max_km ?? 0);
  const feeType = (cfg.delivery_fee_type || "").toLowerCase();
  const flat = Number(cfg.delivery_flat_fee ?? 0);
  const perKm = Number(cfg.delivery_per_km_fee ?? 0);

  const lines: string[] = [];

  lines.push(`Yes, ${name} can deliver to you during our working hours.`);

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

  // We don't know exact hours from DB yet → generic but useful answer
  const name = cfg.name || "we";

  return [
    `${name} is open daily during our regular working hours.`,
    "For the most accurate timing, please check our Google listing or ask the staff here.",
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
        business_type,
        store_address_text,
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