// src/ai/ingest/deliveryEngine.ts

import { supa } from "../../db";

type OrgDeliverySettings = {
  store_lat: number | null;
  store_lng: number | null;
  delivery_free_km: number | null;
  delivery_max_km: number | null;
  delivery_fee_type: "flat" | "per_km" | null;
  delivery_flat_fee: number | null;
  delivery_per_km_fee: number | null;
};

type FeeResult =
  | {
      ok: true;
      distanceKm: number;
      fee: number;
      reason?: undefined;
    }
  | {
      ok: false;
      distanceKm?: number;
      fee?: number;
      reason:
        | "missing_store_location"
        | "missing_customer_location"
        | "out_of_radius"
        | "no_pricing_rule";
    };

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371; // km
  const toRad = (v: number) => (v * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export async function computeDeliveryFeeForOrder(
  org_id: string,
  delivery_lat: number | null | undefined,
  delivery_lng: number | null | undefined
): Promise<FeeResult> {
  if (
    delivery_lat == null ||
    Number.isNaN(delivery_lat) ||
    delivery_lng == null ||
    Number.isNaN(delivery_lng)
  ) {
    return { ok: false, reason: "missing_customer_location" };
  }

  const { data: org, error } = await supa
    .from("orgs")
    .select(
      `
      store_lat,
      store_lng,
      delivery_free_km,
      delivery_max_km,
      delivery_fee_type,
      delivery_flat_fee,
      delivery_per_km_fee
    `
    )
    .eq("id", org_id)
    .maybeSingle();

  if (error || !org) {
    // you can treat this as no_pricing_rule or log separately
    return { ok: false, reason: "no_pricing_rule" };
  }

  const settings = org as OrgDeliverySettings;

  if (
    settings.store_lat == null ||
    settings.store_lng == null ||
    Number.isNaN(settings.store_lat) ||
    Number.isNaN(settings.store_lng)
  ) {
    return { ok: false, reason: "missing_store_location" };
  }

  const distanceKm = haversineKm(
    settings.store_lat,
    settings.store_lng,
    delivery_lat,
    delivery_lng
  );

  const freeKm = settings.delivery_free_km ?? 0;
  const maxKm = settings.delivery_max_km ?? null;

  if (maxKm != null && distanceKm > maxKm) {
    return { ok: false, reason: "out_of_radius", distanceKm };
  }

  let fee = 0;

  if (distanceKm <= freeKm) {
    fee = 0;
  } else if (settings.delivery_fee_type === "flat") {
    fee = settings.delivery_flat_fee ?? 0;
  } else if (settings.delivery_fee_type === "per_km") {
    const extraKm = Math.max(0, distanceKm - freeKm);
    const perKm = settings.delivery_per_km_fee ?? 0;
    fee = extraKm * perKm;
  } else {
    return { ok: false, reason: "no_pricing_rule", distanceKm };
  }

  return {
    ok: true,
    distanceKm: Number(distanceKm.toFixed(2)),
    fee: Number(fee.toFixed(2)),
  };
}