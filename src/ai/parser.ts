// src/ai/parser.ts
import OpenAI from "openai";
import { z } from "zod";
import { parseOrder as ruleParse } from "../parser";
import {
  addSpendUSD,
  canSpendMoreUSD,
  estimateCostUSDApprox,
} from "./cost"; // keep your existing budget guard
import { supa } from "../db";

// ─────────────────────────────────────────────
// L0: Model + config
// ─────────────────────────────────────────────

const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

// Default to gpt-4o-mini, but allow override via env
function getOrderModelName() {
  return process.env.AI_ORDER_MODEL || "gpt-4o-mini";
}

// ─────────────────────────────────────────────
// Shared schemas (items aligned with ingestCore expectation)
// ─────────────────────────────────────────────

const ItemSchema = z.object({
  name: z.string().min(1),
  canonical: z.string().min(1).nullable().optional(),
  qty: z.number().finite().nullable().optional(),
  unit: z.string().min(1).nullable().optional(),
  brand: z.string().min(1).nullable().optional(),
  variant: z.string().min(1).nullable().optional(),
  notes: z.string().min(1).nullable().optional(),
});

const OutputSchema = z.object({
  items: z.array(ItemSchema).default([]),
  is_order_like: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().nullable().optional(),
});

// This is the “raw” shape coming back from AI before we adapt it for ingestCore
export type AiOrderOutput = z.infer<typeof OutputSchema>;

// ─────────────────────────────────────────────
// L0: Prompt template (generic, *not* locked to food)
// ─────────────────────────────────────────────

function buildUserPrompt(input: string): string {
  return [
    "User message:",
    "----------------",
    input,
    "----------------",
    "",
    "Decide if this is an order. For example:",
    '- "2kg onion, 1L milk"  → order',
    '- "do you have product X?" → NOT an order (inquiry only)',
    '- "hi" / "ok thanks" → not an order',
    '- "make my order extra spicy" → not a new order (preference/modifier only)',
    "",
    "Now respond ONLY with a JSON object matching this TypeScript type:",
    "",
    "type Item = {",
    '  name: string;              // e.g. "2kg onion" or "1 face cream"',
    '  canonical?: string | null; // e.g. "onion", "face cream"',
    "  qty?: number | null;       // null if unknown",
    '  unit?: string | null;      // e.g. "kg", "g", "l", "pack", "piece"',
    '  brand?: string | null;     // optional brand or company if user said it',
    '  variant?: string | null;   // optional size/flavour/type if user said it',
    '  notes?: string | null;     // e.g. "extra spicy", "no onion", "no sugar"',
    "};",
    "",
    "type Output = {",
    "  items: Item[];",
    "  is_order_like?: boolean;   // true = order or explicit list of items; false = inquiry/chat/etc.",
    "  confidence?: number;       // 0–1, your confidence that you parsed the order correctly",
    '  reason?: string | null;    // short tag, e.g. "ai:order", "ai:not_order:greeting", "ai:not_order:inquiry_only"',
    "};",
    "",
    "Important:",
    "- If you are not sure or the text is ambiguous → set is_order_like = false, items = [], reason = 'ai:not_order:ambiguous'.",
    "- If the message is only greeting / thanks / acknowledgement → set is_order_like = false, items = [], reason = 'ai:not_order:greeting'.",
    "- If the message is asking about availability / price (e.g. 'do you have X?', 'price of Y?') but *not* clearly placing an order → is_order_like = false, items = [], reason = 'ai:not_order:inquiry_only'.",
    "- Do NOT output any text outside JSON. No explanations, no comments, only JSON.",
  ].join("\n");
}

// System prompt stays generic – works for all business types
const SYSTEM_PROMPT = `
You are a strict JSON API that interprets customer messages for a WhatsApp-based ordering assistant.

Your job:
- Detect if the user is placing an ORDER (items + quantities) or something else (greeting, inquiry, complaint, preference, etc.).
- When it is an order, extract items cleanly.
- When it's NOT an order, return items = [] and is_order_like = false with a clear reason tag.

You MUST:
- Never hallucinate items that the user did not mention.
- Never assume the business type: the items can be food, grocery, pharmacy, clothing, electronics, salon services, etc.
- Stay conservative: if you are not sure that the message is an order, treat it as NOT an order.
- Output ONLY valid JSON that matches the Output type.
`.trim();

// ─────────────────────────────────────────────
// L0: Raw model call (string → JSON string)
// ─────────────────────────────────────────────

async function callOrderModelRaw(input: string): Promise<string | null> {
  if (!openai) {
    console.warn("[AI][order] OPENAI_API_KEY missing, skip AI");
    return null;
  }

  const model = getOrderModelName();

  // Simple approximate cost guard (depends on your existing cost.ts)
  try {
    const approxCost = estimateCostUSDApprox({
      prompt_tokens: Math.ceil(input.length / 4),
      completion_tokens: 0,
    });
    if (!canSpendMoreUSD(approxCost)) {
      console.warn("[AI][order] budget guard blocked call", {
        approxCost,
        model,
      });
      return null;
    }
  } catch (e: any) {
    console.warn("[AI][order] cost estimate failed", e?.message || e);
  }

  const userPrompt = buildUserPrompt(input);

  const start = Date.now();
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 256,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });
  const ms = Date.now() - start;

  const content = completion.choices[0]?.message?.content || "";
  console.log("[AI][order] model used:", model, "latency_ms:", ms);

  // track cost (best-effort)
  try {
    const promptTokens = completion.usage?.prompt_tokens ?? 0;
    const completionTokens = completion.usage?.completion_tokens ?? 0;
    const approxCost = estimateCostUSDApprox({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    });
    addSpendUSD(approxCost);
  } catch (e: any) {
    console.warn("[AI][order] addSpendUSD failed", e?.message || e);
  }

  return content || null;
}

// ─────────────────────────────────────────────
// L1: Robust JSON extraction + validation
// ─────────────────────────────────────────────

function extractJsonObject(raw: string | null): any | null {
  if (!raw) return null;

  // Common case: model already returns pure JSON
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to more robust scan
    }
  }

  // Fallback: find first '{' and last '}' and parse substring
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const candidate = raw.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (e: any) {
    console.warn("[AI][order] JSON.parse candidate failed:", e?.message || e);
    return null;
  }
}

function coerceOutputShape(json: any): AiOrderOutput {
  const parsed = OutputSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  console.warn("[AI][order] OutputSchema validation failed:", parsed.error);

  return {
    items: [],
    is_order_like: false,
    confidence: 0,
    reason: "ai:not_order:invalid_json",
  };
}

// ─────────────────────────────────────────────
// PUBLIC: aiParseOrder (used by ingestCore)
// Signature must match ingestCore.ts expectations.
// ─────────────────────────────────────────────

export async function aiParseOrder(
  text: string,
  // catalog is currently unused but kept for future tuning
  _catalog?: any,
  opts?: { org_id?: string; customer_phone?: string }
): Promise<{
  items: any[];
  confidence?: number;
  reason?: string | null;
  is_order_like?: boolean;
  used?: "ai" | "rules";
}> {
  const input = String(text || "").trim();

  if (!input) {
    return {
      items: [],
      is_order_like: false,
      confidence: 0,
      reason: "ai:not_order:empty",
      used: "rules",
    };
  }

  // If no API key or model is disabled → fallback to rules
  if (!openai) {
    console.log("[AI][order] no client, using rules only");
    const items = ruleParse(input) || [];
    return {
      items,
      is_order_like: items.length > 0,
      confidence: undefined,
      reason: "rule_only:no_api_key",
      used: "rules",
    };
  }

  try {
    console.log("[AI][order] calling model for org/customer", {
      org_id: opts?.org_id || null,
      customer_phone: opts?.customer_phone || null,
      model: getOrderModelName(),
    });

    const raw = await callOrderModelRaw(input);

    if (!raw) {
      // e.g., blocked by budget guard → fallback to rules
      const items = ruleParse(input) || [];
      return {
        items,
        is_order_like: items.length > 0,
        confidence: undefined,
        reason: "rule_fallback:ai_skipped",
        used: "rules",
      };
    }

    const json = extractJsonObject(raw);
    const coerced = coerceOutputShape(json);

    const isOrder =
      typeof coerced.is_order_like === "boolean"
        ? coerced.is_order_like
        : (coerced.items || []).length > 0;

    // Lightweight logging to supabase for debugging (optional, non-fatal)
    try {
      if (opts?.org_id) {
        await supa.from("ai_order_logs").insert({
          org_id: opts.org_id,
          customer_phone: opts.customer_phone || null,
          raw_text: input,
          ai_output: coerced,
          created_at: new Date().toISOString(),
        });
      }
    } catch (e: any) {
      console.warn("[AI][order] log insert failed", e?.message || e);
    }

    return {
      items: coerced.items || [],
      is_order_like: isOrder,
      confidence: coerced.confidence,
      reason: coerced.reason || (isOrder ? "ai:order" : "ai:not_order"),
      used: "ai",
    };
  } catch (e: any) {
    console.error("[AI][order] ERROR, falling back to rules:", e?.message || e);

    const items = ruleParse(input) || [];
    return {
      items,
      is_order_like: items.length > 0,
      confidence: undefined,
      reason: "rule_fallback:ai_error",
      used: "rules",
    };
  }
}

export default aiParseOrder;