// src/ai/inquiry.ts
import OpenAI from "openai";
import { z } from "zod";
import {
  addSpendUSD,
  canSpendMoreUSD,
  estimateCostUSDApprox,
} from "./cost";
import { supa } from "../db";

// ─────────────────────────────────────────────
// L2: Model + config (reuse same client style as parser.ts)
// ─────────────────────────────────────────────

const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

// Allow override via env if you want a different (cheaper) model for inquiry
function getInquiryModelName() {
  return process.env.AI_INQUIRY_MODEL || "gpt-4o-mini";
}

// ─────────────────────────────────────────────
// Schema for AI output
// ─────────────────────────────────────────────

const InquiryOutputSchema = z.object({
  // true if this message is PRIMARILY a question / inquiry
  is_inquiry: z.boolean().optional(),

  // high-level intent category (you can extend values later)
  // e.g. "price", "availability", "menu", "delivery_time", "order_status",
  // "delivery_fee", "generic", "greeting", "complaint", "other"
  intent: z.string().nullable().optional(),

  // best-effort canonical product/service text, if there is one
  // e.g. "egg biryani", "hair spa", "iPhone 14", "face cream"
  canonical: z.string().nullable().optional(),

  // 0–1 confidence
  confidence: z.number().min(0).max(1).optional(),

  // short tag explaining why
  // e.g. "ai:inq:price", "ai:not_inquiry:greeting", etc.
  reason: z.string().nullable().optional(),
});

export type AiInquiryOutput = z.infer<typeof InquiryOutputSchema>;

// ─────────────────────────────────────────────
// Prompts (generic, NOT business-specific)
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a strict JSON API that classifies a SINGLE customer WhatsApp message.

Your job:
- Decide if this message is PRIMARILY an INQUIRY (question) or not.
- If it is an inquiry, classify the intent (price, availability, menu, delivery_time, order_status, delivery_fee, generic, complaint, other).
- Extract a best-effort canonical item/service name if applicable (e.g. "egg biryani", "hair spa", "1BHK flat", "pain relief tablet").
- Output ONLY JSON.

Definitions:
- "Inquiry" = message is mainly a QUESTION about price, availability, menu/list, delivery timing, order status, delivery fee/minimum order, or generic doubts.
- "Order-like" messages like "2kg onion, 1L milk" or "book 2 tickets" are NOT inquiries (they are orders).
- "Greeting/thanks" like "hi", "ok thank you", "hello" are NOT inquiries.
- "Small talk" or random chat or complaints without a clear question are NOT inquiries.

NEVER assume the business type: could be grocery, restaurant, pharmacy, clothing, salon, electronics, real estate, etc.

Your result must ALWAYS be valid JSON with keys:
{ is_inquiry, intent, canonical, confidence, reason }.
`.trim();

function buildUserPrompt(input: string): string {
  return [
    "User message:",
    "----------------",
    input,
    "----------------",
    "",
    "Classify this message.",
    "",
    "Examples:",
    '- \"2kg onion, 1L milk\"           → NOT inquiry (order-like)',
    '- \"do you have egg biryani?\"    → inquiry: availability, canonical: \"egg biryani\"',
    '- \"price of 1kg cashew?\"        → inquiry: price, canonical: \"1kg cashew\"',
    '- \"send full menu\"              → inquiry: menu, canonical: null or \"menu\"',
    '- \"when will it be delivered?\"  → inquiry: delivery_time',
    '- \"what is my order status?\"    → inquiry: order_status',
    '- \"what is delivery charge?\"    → inquiry: delivery_fee',
    '- \"hi\" / \"ok thanks\"          → NOT inquiry (greeting/ack)',
    "",
    "Now respond ONLY with a JSON object that matches this TypeScript type:",
    "",
    "type InquiryOutput = {",
    "  is_inquiry?: boolean;         // true if this is mainly a question/inquiry",
    "  intent?: string | null;       // e.g. 'price', 'availability', 'menu', 'delivery_time', 'order_status', 'delivery_fee', 'generic', 'greeting', 'complaint', 'other'",
    "  canonical?: string | null;    // best-effort item/service name, or null",
    "  confidence?: number;          // 0–1 confidence score",
    "  reason?: string | null;       // short machine-friendly tag, e.g. 'ai:inq:price', 'ai:not_inquiry:order_like'",
    "};",
    "",
    "Important rules:",
    "- If the message is clearly an ORDER (list of items to buy), set is_inquiry = false and intent = 'other' and reason = 'ai:not_inquiry:order_like'.",
    "- If the message is only greeting / thanks / acknowledgement, set is_inquiry = false, intent = 'greeting', reason = 'ai:not_inquiry:greeting'.",
    "- If the message is a complaint without an explicit question, set is_inquiry = false, intent = 'complaint'.",
    "- Be conservative: if you are not sure, set is_inquiry = false and intent = 'other'.",
    "- Do NOT output any text outside JSON. No explanations.",
  ].join("\n");
}

// ─────────────────────────────────────────────
// Helper: robust JSON extraction
// ─────────────────────────────────────────────

function extractJsonObject(raw: string | null): any | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fallthrough
    }
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const candidate = raw.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (e: any) {
    console.warn("[AI][inq] JSON.parse candidate failed:", e?.message || e);
    return null;
  }
}

function coerceInquiryShape(json: any): AiInquiryOutput {
  const parsed = InquiryOutputSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  console.warn("[AI][inq] OutputSchema validation failed:", parsed.error);
  return {
    is_inquiry: false,
    intent: "other",
    canonical: null,
    confidence: 0,
    reason: "ai:not_inquiry:invalid_json",
  };
}

// ─────────────────────────────────────────────
// Fallback: cheap keyword-based heuristic
// (used when AI is off or budget guard blocks)
// ─────────────────────────────────────────────

function heuristicDetectInquiry(text: string): AiInquiryOutput {
  const raw = String(text || "");
  const lower = raw.toLowerCase();

  const hasQuestionMark = lower.includes("?");
  const hasPriceWords = /price|rate|how much|cost|rs\.|₹|\$/i.test(lower);
  const hasAvailabilityWords = /available|availability|do you have|stock/i.test(
    lower
  );
  const hasMenuWords = /menu|price list|pricelist|rate card|services list|service menu/i.test(
    lower
  );
  const hasDeliveryTimeWords = /deliver|delivery time|how long|when.*deliver|eta/i.test(
    lower
  );
  const hasStatusWords = /order status|my order|status of order|track/i.test(
    lower
  );
  const hasFeeWords = /delivery charge|delivery fee|min order|minimum order/i.test(
    lower
  );
  const isGreetingOnly =
    !hasQuestionMark &&
    !hasPriceWords &&
    !hasAvailabilityWords &&
    !hasMenuWords &&
    !hasDeliveryTimeWords &&
    !hasStatusWords &&
    !hasFeeWords &&
    /^(hi|hello|hey|ok|okay|k|kk|thanks|thank you|gm|good morning|good night|good evening)[!. ]*$/i.test(
      lower.trim()
    );

  // order-like heuristic: simple pattern "number + unit + word"
  const looksOrderLike = /\d/.test(lower) && /kg|g|gram|l|ltr|ml|piece|pcs|pack|bottle|box/i.test(lower);

  if (isGreetingOnly) {
    return {
      is_inquiry: false,
      intent: "greeting",
      canonical: null,
      confidence: 0.9,
      reason: "heuristic:not_inquiry:greeting",
    };
  }

  if (looksOrderLike && !hasQuestionMark && !hasPriceWords) {
    return {
      is_inquiry: false,
      intent: "other",
      canonical: null,
      confidence: 0.7,
      reason: "heuristic:not_inquiry:order_like",
    };
  }

  // classify basic inquiry types
  if (hasPriceWords) {
    return {
      is_inquiry: true,
      intent: "price",
      canonical: raw,
      confidence: 0.7,
      reason: "heuristic:inq:price",
    };
  }
  if (hasAvailabilityWords) {
    return {
      is_inquiry: true,
      intent: "availability",
      canonical: raw,
      confidence: 0.7,
      reason: "heuristic:inq:availability",
    };
  }
  if (hasMenuWords) {
    return {
      is_inquiry: true,
      intent: "menu",
      canonical: null,
      confidence: 0.7,
      reason: "heuristic:inq:menu",
    };
  }
  if (hasDeliveryTimeWords) {
    return {
      is_inquiry: true,
      intent: "delivery_time",
      canonical: null,
      confidence: 0.7,
      reason: "heuristic:inq:delivery_time",
    };
  }
  if (hasStatusWords) {
    return {
      is_inquiry: true,
      intent: "order_status",
      canonical: null,
      confidence: 0.7,
      reason: "heuristic:inq:order_status",
    };
  }
  if (hasFeeWords) {
    return {
      is_inquiry: true,
      intent: "delivery_fee",
      canonical: null,
      confidence: 0.7,
      reason: "heuristic:inq:delivery_fee",
    };
  }

  // Generic question with "?"
  if (hasQuestionMark) {
    return {
      is_inquiry: true,
      intent: "generic",
      canonical: null,
      confidence: 0.5,
      reason: "heuristic:inq:generic",
    };
  }

  // default: not an inquiry
  return {
    is_inquiry: false,
    intent: "other",
    canonical: null,
    confidence: 0.2,
    reason: "heuristic:not_inquiry:other",
  };
}

// ─────────────────────────────────────────────
// Raw model call
// ─────────────────────────────────────────────

async function callInquiryModelRaw(input: string): Promise<string | null> {
  if (!openai) {
    console.warn("[AI][inq] OPENAI_API_KEY missing, using heuristic only");
    return null;
  }

  const model = getInquiryModelName();

  try {
    const approxCost = estimateCostUSDApprox({
      prompt_tokens: Math.ceil(input.length / 4),
      completion_tokens: 0,
    });

    if (!canSpendMoreUSD(approxCost)) {
      console.warn("[AI][inq] budget guard blocked call", {
        approxCost,
        model,
      });
      return null;
    }
  } catch (e: any) {
    console.warn("[AI][inq] cost estimate failed", e?.message || e);
  }

  const userPrompt = buildUserPrompt(input);

  const start = Date.now();
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 160,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });
  const ms = Date.now() - start;

  const content = completion.choices[0]?.message?.content || "";
  console.log("[AI][inq] model used:", model, "latency_ms:", ms);

  // track cost
  try {
    const promptTokens = completion.usage?.prompt_tokens ?? 0;
    const completionTokens = completion.usage?.completion_tokens ?? 0;
    const approxCost = estimateCostUSDApprox({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    });
    addSpendUSD(approxCost);
  } catch (e: any) {
    console.warn("[AI][inq] addSpendUSD failed", e?.message || e);
  }

  return content || null;
}

// ─────────────────────────────────────────────
// PUBLIC: detectInquiry
// ─────────────────────────────────────────────

export async function detectInquiry(
  text: string,
  opts?: { org_id?: string; customer_phone?: string }
): Promise<AiInquiryOutput> {
  const input = String(text || "").trim();

  if (!input) {
    return {
      is_inquiry: false,
      intent: "other",
      canonical: null,
      confidence: 0,
      reason: "ai:not_inquiry:empty",
    };
  }

  try {
    const raw = await callInquiryModelRaw(input);

    // If AI is disabled or blocked → pure heuristic
    if (!raw) {
      const heuristic = heuristicDetectInquiry(input);
      return heuristic;
    }

    const json = extractJsonObject(raw);
    const coerced = coerceInquiryShape(json);

    // log to supabase (non-fatal, optional)
    try {
      if (opts?.org_id) {
        await supa.from("ai_inquiry_logs").insert({
          org_id: opts.org_id,
          customer_phone: opts.customer_phone || null,
          raw_text: input,
          ai_output: coerced,
          created_at: new Date().toISOString(),
        });
      }
    } catch (e: any) {
      console.warn("[AI][inq] log insert failed", e?.message || e);
    }

    return coerced;
  } catch (e: any) {
    console.error("[AI][inq] ERROR, falling back to heuristic:", e?.message || e);
    return heuristicDetectInquiry(text);
  }
}

export default detectInquiry;