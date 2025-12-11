// src/ai/helpers/storeHours.ts
import { supa } from "../../db";

export type StoreHoursState = {
  isOpenNow: boolean;
  openTime?: string | null;   // "11:00"
  closeTime?: string | null;  // "23:00"
  timezone?: string | null;
};

function parseTimeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  // expect "HH:MM[:SS]"
  const [hh, mm] = t.split(":");
  const h = Number(hh);
  const m = Number(mm ?? "0");
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function getNowMinutesInTZ(timezone: string): number {
  const now = new Date();

  // Get hour/minute in the store's timezone using Intl.
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).formatToParts(now);

  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minStr = parts.find((p) => p.type === "minute")?.value ?? "00";

  const h = Number(hourStr);
  const m = Number(minStr);
  return h * 60 + m;
}

/**
 * Returns whether delivery should be considered "open now"
 * based on org.delivery_open_time / org.delivery_close_time
 * and org.store_timezone (default: Asia/Kolkata).
 */
export async function getDeliveryOpenState(
  org_id: string
): Promise<StoreHoursState> {
  const { data, error } = await supa
    .from("orgs")
    .select("delivery_open_time, delivery_close_time, store_timezone")
    .eq("id", org_id)
    .maybeSingle();

  if (error) {
    console.warn("[STORE_HOURS] org lookup error", error.message);
    return { isOpenNow: true }; // be permissive on error
  }

  const openTime = (data as any)?.delivery_open_time as string | null;
  const closeTime = (data as any)?.delivery_close_time as string | null;
  const timezone =
    ((data as any)?.store_timezone as string | null) || "Asia/Kolkata";

  const openMin = parseTimeToMinutes(openTime);
  const closeMin = parseTimeToMinutes(closeTime);

  // If not configured → treat as always open
  if (openMin == null || closeMin == null) {
    return { isOpenNow: true, openTime, closeTime, timezone };
  }

  const nowMin = getNowMinutesInTZ(timezone);

  // Simple V1 assumption: openMin < closeMin (no overnight shifts)
  const isOpenNow = nowMin >= openMin && nowMin <= closeMin;

  return {
    isOpenNow,
    openTime,
    closeTime,
    timezone,
  };
}