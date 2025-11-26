// src/ai/modifierQA.ts
import { supa } from "../db";
import type { ModifierPayload } from "../types";
import {
  applyModifierToOrder,
  type ApplyModifierToOrderResult,
} from "../order/applyModifierToOrder";

import {
  buildModifierQuestionFromApplyResult,
  type ModifierQuestion,
} from "../session/modifierQuestion";

import type { ModifierCandidate } from "../order/modifierEngine";

export type StartModifierResult = ApplyModifierToOrderResult & {
  /**
   * Did we find at least one open order for this phone?
   */
  foundOpenOrder: boolean;

  /**
   * If status === "ambiguous", this will contain the
   * human-readable question + payload to store and ask the
   * customer. Otherwise null.
   */
  question?: ModifierQuestion | null;
};

function normText(s: string | null | undefined): string {
  return (s || "").toString().toLowerCase().trim();
}

function isOrderOpen(statusRaw: string | null | undefined): boolean {
  const s = normText(statusRaw);
  if (!s) return true;
  return ![
    "cancelled_by_customer",
    "archived_for_new",
    "paid",
    "shipped",
  ].includes(s);
}

/**
 * Phase-3 brain for modifiers:
 *
 * 1) Find latest OPEN order for this customer.
 * 2) Try to apply modifier via applyModifierToOrder.
 * 3) If result.status === "ambiguous":
 *      - build a ModifierQuestion (text + payload.candidates)
 *      - return it to caller so WABA can:
 *          a) store it (DB / session)
 *          b) send question.text to WhatsApp.
 *
 * NO WhatsApp send here. NO DB for questions here.
 * This stays "core" and pure except for reading orders.
 */
export async function startModifierQALoopForLatestOpenOrder(opts: {
  orgId: string;
  phoneNorm: string;
  modifier: ModifierPayload;
}): Promise<StartModifierResult> {
  const { orgId, phoneNorm, modifier } = opts;

  const phonePlain = phoneNorm.replace(/^\+/, "");

  // 1) Find recent orders for this phone
  const { data, error } = await supa
    .from("orders")
    .select("id, items, status, source_phone, parse_reason")
    .eq("org_id", orgId)
    .or(
      `source_phone.eq.${phonePlain},source_phone.eq.+${phonePlain}` // supabase OR syntax
    )
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    return {
      status: "noop",
      items: [],
      summary: `order_fetch_error:${error.message}`,
      orderId: "",
      foundOpenOrder: false,
      question: null,
    };
  }

  const openOrder = (data || []).find((o: any) =>
    isOrderOpen(o.status as string)
  );

  if (!openOrder || !openOrder.id) {
    return {
      status: "noop",
      items: [],
      summary: "no_open_order_for_phone",
      orderId: "",
      foundOpenOrder: false,
      question: null,
    };
  }

  const orderId = String(openOrder.id);

  // 2) Ask modifier engine to apply it to this order
  const result = await applyModifierToOrder({
    orgId,
    orderId,
    modifier,
  });

  // 3) If ambiguous → build a question + candidates
  let question: ModifierQuestion | null = null;

  if (
    result.status === "ambiguous" &&
    Array.isArray((result as any).candidates) &&
    (result as any).candidates.length > 0
  ) {
    const phone_key = phonePlain;

    question = buildModifierQuestionFromApplyResult({
      org_id: orgId,
      phone_key,
      order_id: orderId,
      modifier,
      applyResult: result as any, // ApplyModifierResult-compatible
    });
  }

  return {
    ...result,
    foundOpenOrder: true,
    question,
  };
}

/**
 * Apply chosen candidate for a stored ModifierQuestion.
 * Used when customer answers the disambiguation question.
 *
 * NOTE: This is Phase-3(b) wiring; you’ll typically call this
 * from a separate "answer modifier question" route after using
 * resolveModifierAnswerFromText().
 */
export type ModifierAnswerResult = ApplyModifierToOrderResult & {
  chosenCandidate?: ModifierCandidate;
};

export async function applyModifierAnswerForQuestion(opts: {
  orgId: string;
  question: ModifierQuestion;
  answerIndex: number; // 0-based index into question.payload.candidates[]
}): Promise<ModifierAnswerResult> {
  const { orgId, question, answerIndex } = opts;

  const candidates = question.payload?.candidates || [];

  if (
    answerIndex < 0 ||
    !Array.isArray(candidates) ||
    answerIndex >= candidates.length
  ) {
    return {
      status: "noop",
      items: [],
      summary: "invalid_answer_index",
      orderId: question.order_id,
    };
  }

  const chosen = candidates[answerIndex];

  const result = await applyModifierToOrder({
    orgId,
    orderId: question.order_id,
    modifier: chosen.modifier ?? null, // depends on how ModifierCandidate is shaped
    resolveIndex: chosen.index,
  });

  return {
    ...result,
    chosenCandidate: chosen,
  };
}