// src/ai/parser.ts
import OpenAI from "openai";
import { z } from "zod";
import { parseOrder as ruleParse } from "../parser";
import {
  canSpendMoreUSD,
  estimateCostUSD,
  estimateCostUSDApprox,
  logAiUsageForCall
} from "./cost"; // keep your existing budget guard
import { supa } from "../db";

// ─────────────────────────────────────────────
// Rule fallback helper (used when AI JSON is bad)
// ─────────────────────────────────────────────

function ruleFallbackOnError(text: string, baseReason: string) {
  const input = String(text || "").trim();
  const ruleItems = ruleParse(input) || [];

  return {
    model: process.env.AI_MODEL || "gpt-4o-mini",
    is_order_like: ruleItems.length > 0,
    reason:
      baseReason +
      (ruleItems.length ? "; rule_fallback" : "; rule_fallback_no_items"),
    items: ruleItems,
    used: (ruleItems.length ? "rules" : "ai") as "rules" | "ai",
  };
}

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
// Types for menu-aware parsing
// ─────────────────────────────────────────────

type CandidateProduct = {
  id: string;
  canonical: string | null;
  display_name: string | null;
  variant: string | null;
};

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

  // NEW – menu-aware fields
  product_id: z.string().min(1).nullable().optional(),
  match_type: z
    .enum(["catalog_exact", "catalog_fuzzy", "text_only"])
    .optional(),
  needs_clarify: z.boolean().optional(),
  clarify_reason: z.string().min(1).nullable().optional(),
  text_span: z.string().min(1).nullable().optional(),
});

const OutputSchema = z.object({
  items: z.array(ItemSchema).default([]),
  is_order_like: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().nullable().optional(),
});

export type AiOrderOutput = z.infer<typeof OutputSchema>;

// ─────────────────────────────────────────────
// L0.5: Fetch candidate menu
// ─────────────────────────────────────────────

async function getCandidateMenuForText(
  org_id: string | undefined,
  _text: string
): Promise<CandidateProduct[]> {
  if (!org_id) return [];

  try {
    const { data, error } = await supa
      .from("products")
      .select("id, canonical, display_name, variant")
      .eq("org_id", org_id)
      .limit(80);

    if (error) {
      console.warn("[AI][order] getCandidateMenuForText err:", error.message);
      return [];
    }

    const products = (data || []) as any[];

    const menu: CandidateProduct[] = products.map((p) => ({
      id: String(p.id),
      canonical: (p.canonical ?? null) as string | null,
      display_name: (p.display_name ?? null) as string | null,
      variant: (p.variant ?? null) as string | null,
    }));

    return menu;
  } catch (e: any) {
    console.warn(
      "[AI][order] getCandidateMenuForText unexpected err:",
      e?.message || e
    );
    return [];
  }
}

// ─────────────────────────────────────────────
// Prompt template
// ─────────────────────────────────────────────

function buildUserPrompt(input: string, menu: CandidateProduct[]): string {
  const menuSnippet = JSON.stringify(menu, null, 2);

  return [
    "You are parsing a customer message for a WhatsApp ordering assistant.",
    "",
    "Below is the MENU for this specific shop (only these products are valid for mapping):",
    "---------------- MENU JSON ----------------",
    menuSnippet,
    "-------------------------------------------",
    "",
    "User message:",
    "----------------",
    input,
    "----------------",
    "",
    "Decide if this is an order. For example:",
    '- \"2kg onion, 1L milk\"  → order',
    '- \"do you have product X?\" → NOT an order (inquiry only)',
    '- \"hi\" / \"ok thanks\" → not an order',
    '- \"make my order extra spicy\" → not a new order (preference/modifier only)',
    "",
    "Now respond ONLY with a JSON object matching this TypeScript type:",
    "",
    "type Item = {",
    '  // What the user actually wrote for this item (or the key phrase).',
    "  text_span?: string | null;",
    '',
    '  // Normalized/clean item name (e.g. \"Paneer Biryani\").',
    "  name: string;",
    "  canonical?: string | null;",
    "",
    "  qty?: number | null;       // null if unknown",
    '  unit?: string | null;      // e.g. \"kg\", \"g\", \"l\", \"pack\", \"piece\"',
    '  brand?: string | null;     // optional brand or company if user said it',
    '  variant?: string | null;   // optional size/flavour/type if user said it',
    '  notes?: string | null;     // e.g. \"extra spicy\", \"no onion\", \"no sugar\"',
    "",
    "  // MENU mapping:",
    "  product_id?: string | null;  // id from MENU if you are confident",
    '  match_type?: \"catalog_exact\" | \"catalog_fuzzy\" | \"text_only\";',
    "  // If you are NOT fully sure about the mapping, mark needs_clarify = true.",
    "  needs_clarify?: boolean;",
    "  clarify_reason?: string | null;",
    "};",
    "",
    "type Output = {",
    "  items: Item[];",
    "  is_order_like?: boolean;   // true = order or explicit list of items; false = inquiry/chat/etc.",
    "  confidence?: number;       // 0–1, your confidence that you parsed the order correctly",
    '  reason?: string | null;    // short tag, e.g. \"ai:order\", \"ai:not_order:greeting\", \"ai:not_order:inquiry_only\"',
    "};",
    "",
    "MENU mapping rules:",
    "- You MUST only use product_id values that come from the MENU JSON.",
    "- Never invent new product ids.",
    '- If user text clearly matches one MENU item (e.g. \"Paneer Biryani\" vs menu \"Paneer Biryani\"), use match_type = \"catalog_exact\", product_id = that id, needs_clarify = false.',
    '- If user text is a close spelling or fuzzy match (\"panner biryani\" vs menu \"Paneer Biryani\") BUT you are not fully sure → set:',
    "    product_id = null,",
    '    match_type = \"catalog_fuzzy\",',
    "    needs_clarify = true,",
    '    clarify_reason = \"User text looks like X but I am not fully sure; ask user.\"',
    "- If the item cannot be safely mapped to any MENU product →",
    '    product_id = null, match_type = \"text_only\", needs_clarify = true.',
    "",
    "Order vs non-order rules:",
    "- If you are not sure or the text is ambiguous → set is_order_like = false, items = [], reason = 'ai:not_order:ambiguous'.",
    "- If the message is only greeting / thanks / acknowledgement → set is_order_like = false, items = [], reason = 'ai:not_order:greeting'.",
    "- If the message is asking about availability / price (e.g. \"do you have X?\", \"price of Y?\") but NOT clearly placing an order →",
    "    is_order_like = false, items = [], reason = 'ai:not_order:inquiry_only'.",
    "",
    "Important:",
    "- Never hallucinate items that the user did not mention.",
    "- Stay conservative: if you are not sure that the message is an order, treat it as NOT an order.",
    "- Output ONLY valid JSON that matches the Output type. No explanations, no comments, no markdown.",
  ].join("\n");
}

const SYSTEM_PROMPT = `
You are a strict JSON API that interprets customer messages for a WhatsApp-based ordering assistant.

Your job:
- Detect if the user is placing an ORDER (items + quantities) or something else (greeting, inquiry, complaint, preference, etc.).
- When it is an order, extract items cleanly.
- When it's NOT an order, return items = [] and is_order_like = false with a clear reason tag.
- Use the provided MENU JSON to map items to valid products only when it is safe.

You MUST:
- Never hallucinate items that the user did not mention.
- Never assume the business type: the items can be food, grocery, pharmacy, clothing, electronics, salon services, etc.
- Only propose product_id values that exist in the MENU JSON, never invent ids.
- If mapping from user text to MENU item is not clearly safe, set needs_clarify = true and do not set product_id.
- Stay conservative: if you are not sure that the message is an order, treat it as NOT an order.
- Output ONLY valid JSON that matches the Output type.
`.trim();

// ─────────────────────────────────────────────
// Raw model call
// ─────────────────────────────────────────────

async function callOrderModelRaw(
  input: string,
  menu: CandidateProduct[],
  orgId?: string
): Promise<string | null> {
  if (!openai) {
    console.warn("[AI][order] OPENAI_API_KEY missing, skip AI");
    return null;
  }

  const model = getOrderModelName();
  const userPrompt = buildUserPrompt(input, menu);

  // ─────────────────────────────────────────────
  // 1) Pre-flight cost estimate + budget guard
  // ─────────────────────────────────────────────
  try {
    const approxCost = estimateCostUSDApprox({
      prompt_tokens: Math.ceil(userPrompt.length / 4),
      completion_tokens: 0,
    });

    const pre = await canSpendMoreUSD(approxCost);
    if (!pre.ok) {
      console.warn("[AI][order] budget guard blocked call", {
        approxCost,
        model,
        reason: pre.reason,
        today: pre.today,
        cap: pre.cap,
      });
      return null;
    }
  } catch (e: any) {
    console.warn("[AI][order] cost estimate / guard failed", e?.message || e);
  }

  // ─────────────────────────────────────────────
  // 2) Actual OpenAI call
  // ─────────────────────────────────────────────
  const start = Date.now();
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 256,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });
  const ms = Date.now() - start;

  const content = completion.choices[0]?.message?.content || "";
  console.log("[AI][order] model used:", model, "latency_ms:", ms);

  // ─────────────────────────────────────────────
  // 3) Track spend (global + per-org) via helper
  // ─────────────────────────────────────────────
  try {
    await logAiUsageForCall({
      orgId,
      usage: completion.usage,
      model,
      raw: {
        source: "aiParseOrder",
        response_id: completion.id,
        latency_ms: ms,
        org_id: orgId ?? null,
      },
    });
  } catch (e: any) {
    console.warn("[AI][order] spend / usage logging failed", e?.message || e);
  }

  return content || null;
}

// ─────────────────────────────────────────────
// JSON extraction + validation
// ─────────────────────────────────────────────

function extractJsonObject(raw: string | null): any | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }

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
// PUBLIC: aiParseOrder
// ─────────────────────────────────────────────

export async function aiParseOrder(
  text: string,
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

  // No API key → pure rules
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
    const menu = await getCandidateMenuForText(opts?.org_id, input);

    console.log("[AI][order] calling model for org/customer", {
      org_id: opts?.org_id || null,
      customer_phone: opts?.customer_phone || null,
      model: getOrderModelName(),
      menu_count: menu.length,
    });

    const raw = await callOrderModelRaw(input, menu, opts?.org_id);
    if (!raw) {
      // budget-guard or other skip → rules fallback
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

    // ❗ If we can't parse JSON at all → RULE FALLBACK
    if (!json) {
      const fb = ruleFallbackOnError(input, "ai:not_order:invalid_json");
      console.log("[AI][order] json null → ruleFallbackOnError", {
        reason: fb.reason,
        items: fb.items.length,
      });
      return {
        items: fb.items,
        is_order_like: fb.is_order_like,
        confidence: undefined,
        reason: fb.reason,
        used: fb.used,
      };
    }

    const coerced = coerceOutputShape(json);

    // ❗ If schema validation says "invalid_json" → RULE FALLBACK
    if (coerced.reason === "ai:not_order:invalid_json") {
      const fb = ruleFallbackOnError(input, coerced.reason);
      console.log("[AI][order] invalid_json schema → ruleFallbackOnError", {
        reason: fb.reason,
        items: fb.items.length,
      });
      return {
        items: fb.items,
        is_order_like: fb.is_order_like,
        confidence: undefined,
        reason: fb.reason,
        used: fb.used,
      };
    }

    const isOrder =
      typeof coerced.is_order_like === "boolean"
        ? coerced.is_order_like
        : (coerced.items || []).length > 0;

    // optional log to DB
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

    console.log("[AI][order][DEBUG_OUTPUT]", {
      model: getOrderModelName(),
      is_order_like: isOrder,
      reason: coerced.reason,
      items: (coerced.items || []).map((it) => ({
        name: it.name,
        canonical: it.canonical,
        product_id: it.product_id,
        match_type: it.match_type,
        needs_clarify: it.needs_clarify,
        clarify_reason: it.clarify_reason,
        text_span: it.text_span,
      })),
    });

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