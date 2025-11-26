// src/order/disambiguationSession.ts
import { supa } from "../db";
import { normalizePhone } from "../util/normalizePhone";
import type { ModifierPayload } from "../types";

export type ModifierDisambiguationStatus = "pending" | "resolved" | "expired";

export type ModifierDisambiguationSession = {
  id: string;
  org_id: string;
  order_id: string;
  customer_phone: string;
  modifier: ModifierPayload;
  candidate_indexes: number[];
  question: string;
  options: string[]; // human labels for each candidate index
  status: ModifierDisambiguationStatus;
  created_at: string;
  resolved_at: string | null;
};

export async function createModifierDisambiguationSession(args: {
  orgId: string;
  orderId: string;
  customerPhone: string | null | undefined;
  modifier: ModifierPayload;
  candidateIndexes: number[];
  options: string[];
  question: string;
}): Promise<ModifierDisambiguationSession | null> {
  const { orgId, orderId, customerPhone, modifier, candidateIndexes, options, question } = args;

  const phoneNorm = normalizePhone(customerPhone || "") || "";
  if (!orgId || !orderId || !phoneNorm) {
    console.warn("[disamb] missing org/order/phone, skip session");
    return null;
  }

  if (!candidateIndexes.length || !options.length) {
    console.warn("[disamb] no candidates/options, skip session");
    return null;
  }

  const { data, error } = await supa
    .from("order_modifier_sessions")
    .insert({
      org_id: orgId,
      order_id: orderId,
      customer_phone: phoneNorm,
      modifier,
      candidate_indexes: candidateIndexes,
      question,
      options,
      status: "pending",
    })
    .select("*")
    .single();

  if (error) {
    console.error("[disamb] create session err:", error.message);
    return null;
  }

  return data as unknown as ModifierDisambiguationSession;
}

export async function getActiveModifierSessionForCustomer(args: {
  orgId: string;
  customerPhone: string | null | undefined;
}): Promise<ModifierDisambiguationSession | null> {
  const phoneNorm = normalizePhone(args.customerPhone || "") || "";
  if (!args.orgId || !phoneNorm) return null;

  const { data, error } = await supa
    .from("order_modifier_sessions")
    .select("*")
    .eq("org_id", args.orgId)
    .eq("customer_phone", phoneNorm)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[disamb] getActive err:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : null;
  return (row || null) as ModifierDisambiguationSession | null;
}

export async function markModifierSessionResolved(id: string): Promise<void> {
  if (!id) return;
  const { error } = await supa
    .from("order_modifier_sessions")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("[disamb] markResolved err:", error.message);
  }
}

/**
 * Decide which candidate index was chosen based on the user's reply.
 *
 * Returns the *actual* candidate index (from candidate_indexes[]),
 * not the 0-based UI index.
 */
export function pickCandidateIndexFromAnswer(
  text: string,
  session: ModifierDisambiguationSession
): number | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();

  const { candidate_indexes: candidateIndexes, options } = session;
  if (!candidateIndexes?.length || !options?.length) return null;

  // 1) Pure number: "1", "2", etc.
  const num = Number(raw);
  if (Number.isInteger(num) && num >= 1 && num <= options.length) {
    const idx = num - 1; // 1-based to 0-based
    return candidateIndexes[idx] ?? null;
  }

  // 2) Match by option text (contains / startsWith etc.)
  let best: { index: number; score: number } | null = null;

  options.forEach((opt, i) => {
    const optLower = String(opt || "").toLowerCase();
    if (!optLower) return;

    let score = 0;
    if (lower === optLower) score = 3;
    else if (optLower.startsWith(lower) || lower.startsWith(optLower)) score = 2;
    else if (optLower.includes(lower) || lower.includes(optLower)) score = 1;

    if (score > 0 && (!best || score > best.score)) {
      best = { index: i, score };
    }
  });

  if (best) {
    return candidateIndexes[best.index] ?? null;
  }

  return null;
}