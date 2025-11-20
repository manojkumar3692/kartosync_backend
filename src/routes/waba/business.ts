// src/routes/waba/business.ts
export type BusinessType =
  | "grocery"
  | "meat"
  | "cloud_kitchen"
  | "restaurant"
  | "salon"
  | "pharmacy"
  | "generic";

export function normalizeBusinessType(raw: string | null | undefined): BusinessType {
  const t = (raw || "").toLowerCase().trim();

  if (["grocery", "supermarket", "mini_mart"].includes(t)) return "grocery";
  if (["meat", "butcher"].includes(t)) return "meat";
  if (["cloud_kitchen", "cloudkitchen", "dark_kitchen"].includes(t))
    return "cloud_kitchen";
  if (["restaurant", "cafe", "café"].includes(t)) return "restaurant";
  if (["salon", "spa", "barber", "barbershop"].includes(t)) return "salon";
  if (["pharmacy", "medical_store"].includes(t)) return "pharmacy";

  return "generic";
}

/**
 * Decide if we should auto-ask for delivery address on WhatsApp.
 *
 * - For most businesses → true by default (if supports_delivery !== false)
 * - For salons (walk-in / appointment-style) → false by default
 * - Explicit supports_delivery=false always disables address asking.
 */
export function orgNeedsDeliveryAddress(org: any): boolean {
  if (org && org.supports_delivery === false) return false;

  const bt = normalizeBusinessType(org?.primary_business_type);
  if (bt === "salon") {
    // Default: don't auto-ask address for salons/barbers
    return false;
  }

  // Others (grocery, meat, cloud_kitchen, restaurant, generic, etc.)
  return true;
}