// src/ai/ingest/orderCode.ts
import { supa } from "../../db";
import crypto from "crypto";

// Characters without confusing ones (no 0/O, 1/I)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    const idx = bytes[i] % CODE_CHARS.length;
    out += CODE_CHARS[idx];
  }
  return out;
}

/**
 * Generate a unique 7-char code for an order inside a given org.
 * Ensures uniqueness (org_id, order_code) via DB check.
 */
export async function generateOrderCode(org_id: string): Promise<string> {
  let attempts = 0;
  while (attempts < 5) {
    attempts++;
    const code = randomCode(7);

    const { data, error } = await supa
      .from("orders")
      .select("id")
      .eq("org_id", org_id)
      .eq("order_code", code)
      .maybeSingle();

    if (!data && !error) {
      return code;
    }
  }

  // Fallback: extremely unlikely
  throw new Error("Failed to generate unique order code");
}

/**
 * Get display id for an order, fallback to UUID last 6 chars if needed.
 */
export function getOrderDisplayId(order: any): string {
  if (order?.order_code) return order.order_code;
  if (order?.id && typeof order.id === "string") {
    return order.id.slice(-6).toUpperCase();
  }
  return "ORDER";
}