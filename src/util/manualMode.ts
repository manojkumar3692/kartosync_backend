// src/util/manualMode.ts
import { supa } from "../db";
import { normalizePhoneForKey } from "../routes/waba/clarifyAddress";

export async function isManualModeActive(orgId: string, phoneRaw: string) {
  const phoneKey = normalizePhoneForKey(phoneRaw);
  const { data, error } = await supa
    .from("org_customer_settings")
    .select("manual_mode, manual_mode_until")
    .eq("org_id", orgId)
    .eq("customer_phone", phoneKey)
    .maybeSingle();

  if (error || !data) return false;

  if (!data.manual_mode) return false;
  if (!data.manual_mode_until) return false;

  const now = new Date();
  const until = new Date(data.manual_mode_until);

  // if expired → treat as OFF
  return until.getTime() > now.getTime();
}