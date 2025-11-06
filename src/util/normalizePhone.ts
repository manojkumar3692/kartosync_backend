// src/util/normalizePhone.ts
import { supa } from '../db';

export const normalizePhone = (raw?: string | null): string | null => {
  if (!raw) return null;
  const s = String(raw).trim();
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/[^\d]/g, "");
  // require at least 7 digits to consider it phone-like
  return digits.length >= 7 ? plus + digits : null;
};

// Try to find a phone if current order has a name instead of a phone
export async function resolvePhoneForOrder(
  org_id: string,
  order_id: string,
  customer_name?: string | null
) {
  // 1) Prefer the current order’s normalized phone
  const { data } = await supa
    .from("orders")
    .select("source_phone, customer_name")
    .eq("org_id", org_id)
    .eq("id", order_id)
    .maybeSingle();
  const curPhone = normalizePhone(data?.source_phone);
  if (curPhone) return curPhone;

  const name = (customer_name ?? data?.customer_name ?? "").trim();
  if (!name) return null;

  // 2) Fall back: latest previous order for the same name that *does* have a phone
  const { data: prev } = await supa
    .from("orders")
    .select("source_phone")
    .eq("org_id", org_id)
    .ilike("customer_name", name)
    .order("created_at", { ascending: false })
    .limit(10);
  for (const r of prev || []) {
    const p = normalizePhone(r.source_phone);
    if (p) return p;
  }
  return null;
}

export default resolvePhoneForOrder;