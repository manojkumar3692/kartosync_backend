// src/ai/interpreter.ts
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { canSpendMoreUSD, addSpendUSD } from "./cost";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// ─────────────────────────────────────────────
// Schema: what the "brain" returns
// ─────────────────────────────────────────────

// High-level intent bucket
export const AIIntentKind = z.enum([
  "order_new", // fresh order
  "order_add", // add items to current open order
  "order_edit", // change items / quantities
  "order_cancel_soft", // "leave it bro / no need today"
  "order_cancel_hard", // explicit cancel
  "inquiry_price", // "what's price of X"
  "inquiry_availability", // "is X available"
  "inquiry_menu", // "send menu / price list"
  "address_provide", // giving address for first time
  "address_update", // changing address
  "smalltalk", // hi/thanks/emoji etc.
  "meta_handoff", // "I want to talk to human"
  "unknown", // couldn't classify confidently
]);

// How the order should be treated in context
export const OrderAction = z.enum([
  "none", // no order effect
  "create_new", // new order
  "append", // add to existing
  "replace", // override existing items
  "cancel", // cancel latest/all depending on cancel_scope
]);

// Very small product/inquiry abstraction (not full parsing)
export const InquiryInfoSchema = z.object({
  type: z.enum(["price", "availability", "menu", "other"]).nullable(),
  canonical_product: z.string().nullable().optional(), // e.g. "chicken biryani"
  quantity: z.number().nullable().optional(),
});

// Emotional / meta info (optional but useful)
export const MoodSchema = z
  .enum(["neutral", "happy", "angry", "confused", "impatient", "sad"])
  .nullable();

// Main interpretation object
export const AIInterpretationSchema = z.object({
  // mandatory
  kind: AIIntentKind, // main bucket
  order_action: OrderAction, // how to treat orders in this turn

  // Should we run full order parser (ingestCore)?
  needs_order_parse: z.boolean().default(false),

  // Is the user providing or updating address?
  is_address_message: z.boolean().default(false),

  // Soft cancel vs hard
  soft_cancel: z.boolean().default(false),
  cancel_scope: z
    .enum(["none", "latest_order", "all_open_orders"])
    .default("none"),

  // Inquiry (if any)
  inquiry: InquiryInfoSchema.nullable().default(null),

  // Conversational/meta
  wants_human: z.boolean().default(false),
  mood: MoodSchema.default("neutral"),
  summary: z.string().default(""), // short natural language summary

  // Safety: if model is unsure, it must set kind="unknown"
  confidence: z.number().min(0).max(1).default(0.5),
});

export type AIInterpretation = z.infer<typeof AIInterpretationSchema>;

// What context we pass into interpreter
export type InterpreterContext = {
  orgId: string;
  phone: string;
  text: string;

  // minimal order context; you can enrich later
  hasOpenOrder: boolean;
  lastOrderStatus?: string | null; // "pending" | "shipped" | "paid" | "cancelled" | null
  lastOrderCreatedAt?: string | null;

  // simple conversation state, if you track it (optional for now)
  state?: "idle" | "awaiting_address" | "awaiting_clarification" | "post_order";

  // channel can matter later (different tone for waba vs local_bridge)
  channel?: "waba" | "local_bridge";

  // optional language hint
  locale?: string | null;
};

// ─────────────────────────────────────────────
// Fallback if we decide not to call AI
// ─────────────────────────────────────────────
function trivialFallback(text: string): AIInterpretation {
  const trimmed = (text || "").trim();

  if (!trimmed) {
    return {
      kind: "unknown",
      order_action: "none",
      needs_order_parse: false,
      is_address_message: false,
      soft_cancel: false,
      cancel_scope: "none",
      inquiry: null,
      wants_human: false,
      mood: "neutral",
      summary: "empty message",
      confidence: 0,
    };
  }

  // pure emojis / thanks → smalltalk
  const lower = trimmed.toLowerCase();
  if (
    /^[🙏👌👍👏❤️]+$/.test(trimmed) ||
    ["thanks", "thank you", "tnx"].some((w) => lower.includes(w))
  ) {
    return {
      kind: "smalltalk",
      order_action: "none",
      needs_order_parse: false,
      is_address_message: false,
      soft_cancel: false,
      cancel_scope: "none",
      inquiry: null,
      wants_human: false,
      mood: "happy",
      summary: "customer is just sending thanks / emoji",
      confidence: 0.9,
    };
  }

  // default unknown → executor can decide to just echo / let AI reply simple
  return {
    kind: "unknown",
    order_action: "none",
    needs_order_parse: false,
    is_address_message: false,
    soft_cancel: false,
    cancel_scope: "none",
    inquiry: null,
    wants_human: false,
    mood: "neutral",
    summary: "unclear message; needs generic handling",
    confidence: 0.3,
  };
}

// ─────────────────────────────────────────────
// Main entry: interpretMessage
// ─────────────────────────────────────────────

export async function interpretMessage(
  ctx: InterpreterContext
): Promise<AIInterpretation> {
  const { text } = ctx;
  const raw = (text || "").trim();

  // 1) Super-light guards: empty / pure emoji → no AI call
  if (!raw || /^[🙏👌👍👏❤️]+$/.test(raw)) {
    return trivialFallback(raw);
  }

  // Rough char-based estimate: assume ~4 chars per token and a small reply
  const approxPromptTokens = Math.ceil(raw.length / 4);
  const approxCompletionTokens = 120; // small JSON reply
  const approxCost =
    ((approxPromptTokens + approxCompletionTokens) / 1000) * 0.0005; // tweak if you like

  if (!canSpendMoreUSD(approxCost)) {
    return trivialFallback(raw);
  }

  const systemPrompt = `
You are an AI planner for a WhatsApp order assistant.
Your job is NOT to reply text, but to interpret the user's latest message
into a structured intent, given some light context.

The business can be:
- restaurant / cloud kitchen (biryani, burgers, etc.)
- grocery / supermarket (milk, eggs, vegetables)
- other "WhatsApp ordering" businesses.

You MUST:
- Decide if this message is about a new order, adding to existing order, editing, cancelling, address, or just an inquiry (price / availability / menu).
- Avoid being over-confident. If unsure, use kind="unknown" and confidence<=0.4.
- For cancellation, decide soft_cancel=true when it's more like "leave it today, don't send", not a strict permanent cancellation.
- For inquiry, only set inquiry.type when the user is clearly asking a question (price, availability, menu).
- 'needs_order_parse' = true ONLY when there is an actual order/change that should be parsed into items.
- 'order_action':
  - "create_new"   → new order (no open order or user wants a fresh one)
  - "append"       → add items to existing open order
  - "replace"      → replace items in existing open order
  - "cancel"       → cancel open order(s) (use cancel_scope)
  - "none"         → no change to orders (pure inquiry, smalltalk, etc.)

Mood:
- Rough emotional state based ONLY on message text: neutral, happy, angry, confused, impatient, sad.

Never invent items or prices here. This step is only about INTENT, not full item parsing.
`;

  const userContext = `
ORG_ID: ${ctx.orgId}
CHANNEL: ${ctx.channel || "waba"}
PHONE: ${ctx.phone}
LOCALE: ${ctx.locale || "unknown"}
STATE: ${ctx.state || "idle"}
HAS_OPEN_ORDER: ${ctx.hasOpenOrder}
LAST_ORDER_STATUS: ${ctx.lastOrderStatus || "none"}
LAST_ORDER_CREATED_AT: ${ctx.lastOrderCreatedAt || "none"}

LATEST_MESSAGE:
"""${raw}"""
`;

  try {
    const response = await openai.responses.parse({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContext },
      ],
      text: {
        // NEW: use zodTextFormat instead of response_format / plain string
        format: zodTextFormat(AIInterpretationSchema, "ai_interpretation"),
      },
    });

    const parsed = response.output_parsed as AIInterpretation;
    addSpendUSD(approxCost);

    // Safety: if model did something weird or confidence too low, degrade to unknown
    if (!parsed || parsed.confidence < 0.25) {
      return {
        ...trivialFallback(raw),
        summary: parsed?.summary || "low-confidence interpretation",
      };
    }

    return parsed;
  } catch (err) {
    console.error("[interpretMessage] LLM failed, falling back:", err);
    return trivialFallback(raw);
  }
}