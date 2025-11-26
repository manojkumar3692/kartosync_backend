// src/session/modifierQuestion.ts
import type { ModifierPayload } from "../types";
import type {
  ModifierCandidate,
  ApplyModifierResult,
} from "../order/modifierEngine";

/**
 * What kind of modifier question this is.
 * For now we only support "which item did you mean?"
 */
export type ModifierQuestionKind = "ambiguous_item";

/**
 * Payload we can safely JSON-serialize and store in session.
 */
export type ModifierQuestionPayload = {
  kind: ModifierQuestionKind;
  candidates: ModifierCandidate[];
  // ⬇️ store the parsed modifier so we can re-apply it later
  modifier: ModifierPayload;
};

/**
 * A full question object your WABA/router can store on session
 * (e.g. in last_modifier_json or a separate table).
 *
 * This file is PURE (no DB writes).
 */
export type ModifierQuestion = {
  /**
   * Org + phone + order help tie this question to a customer/session.
   */
  org_id: string;
  phone_key: string;
  order_id: string;

  /**
   * The text we want to send to WhatsApp.
   */
  text: string;

  /**
   * Structured data to later interpret the user's reply.
   */
  payload: ModifierQuestionPayload;

  /**
   * Timestamp in ISO form.
   */
  created_at: string;
  id?:any
};

/**
 * Build a human-readable question from ambiguous modifier candidates.
 * This DOES NOT touch DB – caller is responsible for:
 *   - storing question.payload in session or a table
 *   - sending question.text to WhatsApp.
 */
export function buildModifierQuestionFromApplyResult(opts: {
  org_id: string;
  phone_key: string;
  order_id: string;
  applyResult: ApplyModifierResult;
  modifier: ModifierPayload;
}): ModifierQuestion | null {
  const { org_id, phone_key, order_id, applyResult, modifier } = opts;

  if (
    applyResult.status !== "ambiguous" ||
    !Array.isArray(applyResult.candidates) ||
    applyResult.candidates.length === 0
  ) {
    return null;
  }

  const candidates = applyResult.candidates.slice(0, 9); // cap at 9 options
  const lines: string[] = [];
  lines.push("I found multiple items that match your change:");
  lines.push("");

  candidates.forEach((c, idx) => {
    const n = idx + 1;
    const parts: string[] = [];
    parts.push(c.label || `Item #${c.index + 1}`);
    if (c.qty != null) {
      parts.push(`qty: ${c.qty}`);
    }
    lines.push(`${n}) ${parts.join(" | ")}`);
  });

  lines.push("");
  lines.push("Please reply with the number (1–" + candidates.length + ")");
  lines.push("or 0 / cancel if you don't want to change any item.");

  const text = lines.join("\n");

  const payload: ModifierQuestionPayload = {
    kind: "ambiguous_item",
    candidates,
    modifier,
  };

  return {
    org_id,
    phone_key,
    order_id,
    text,
    payload,
    created_at: new Date().toISOString(),
  };
}

/**
 * Interpret the customer's reply to an ambiguous-item question.
 *
 * This takes the raw WhatsApp text and the stored payload,
 * and returns which candidate index (into payload.candidates)
 * was chosen, or null if user cancelled / we couldn't resolve.
 *
 * NOTE:
 *  - resolvedIndex is an index into payload.candidates (0-based),
 *    NOT the original order.items index. To get that, use:
 *      const candidate = payload.candidates[resolvedIndex];
 *      const orderIndex = candidate.index;
 */
export function resolveModifierAnswerFromText(opts: {
  text: string;
  payload: ModifierQuestionPayload;
}): { resolvedIndex: number | null; reason: string } {
  const { text, payload } = opts;
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();

  if (!payload || payload.kind !== "ambiguous_item") {
    return { resolvedIndex: null, reason: "payload_invalid_or_unsupported" };
  }

  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  if (!candidates.length) {
    return { resolvedIndex: null, reason: "no_candidates" };
  }

  // 1) Explicit cancel words
  if (
    lower === "0" ||
    lower === "no" ||
    lower === "none" ||
    lower === "cancel" ||
    lower === "skip"
  ) {
    return { resolvedIndex: null, reason: "user_cancelled" };
  }

  // 2) Pure numeric answer: "1", "2", "3", ...
  const numMatch = raw.match(/^\s*(\d+)\s*$/);
  if (numMatch) {
    const n = Number(numMatch[1]);
    if (Number.isFinite(n)) {
      const idx = n - 1; // user sees 1-based, we store 0-based
      if (idx >= 0 && idx < candidates.length) {
        return { resolvedIndex: idx, reason: "numeric_choice" };
      } else {
        return { resolvedIndex: null, reason: "numeric_out_of_range" };
      }
    }
  }

  // 3) Try to match by label substring.
  //    If exactly ONE candidate's label appears in the text, pick it.
  const matches: number[] = [];
  const msg = lower;

  candidates.forEach((c, idx) => {
    const label = String(c.label || "").toLowerCase().trim();
    if (!label) return;

    // If label is short, require whole-word match.
    // If longer, simple substring is usually OK.
    if (label.length <= 4) {
      const re = new RegExp(`\\b${escapeRegex(label)}\\b`, "i");
      if (re.test(msg)) {
        matches.push(idx);
      }
    } else if (msg.includes(label)) {
      matches.push(idx);
    }
  });

  if (matches.length === 1) {
    return { resolvedIndex: matches[0], reason: "label_match" };
  }

  if (matches.length > 1) {
    return { resolvedIndex: null, reason: "multiple_label_matches" };
  }

  // 4) Heuristic: if user says "first / second / third" etc.
  const ordinalMap: Record<string, number> = {
    first: 0,
    "1st": 0,
    second: 1,
    "2nd": 1,
    third: 2,
    "3rd": 2,
    fourth: 3,
    "4th": 3,
    fifth: 4,
    "5th": 4,
  };

  for (const [key, idx] of Object.entries(ordinalMap)) {
    if (lower.includes(key) && idx < candidates.length) {
      return {
        resolvedIndex: idx,
        reason: "ordinal_word_match",
      };
    }
  }

  // 5) Could not resolve
  return { resolvedIndex: null, reason: "unresolved" };
}

/**
 * Escape regex meta characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}