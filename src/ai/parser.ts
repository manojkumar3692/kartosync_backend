// src/ai/parser.ts
import OpenAI from "openai";
import { z } from "zod";
import { parseOrder as ruleParse } from "../parser";                  // ← free rules parser
import { addSpendUSD, canSpendMoreUSD, estimateCostUSD } from "./cost"; // ← budget guard
import { supa } from "../db";                                         // ← optional logging

// ─────────────────────────────────────────────────────────────────────────────
// 1) Schema (your exact spec)
// ─────────────────────────────────────────────────────────────────────────────
export const ItemSchema = z.object({
  name: z.string().min(1),                       // raw item text
  qty: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),     // kg / g / l / pack / piece
  notes: z.string().nullable().default(null),    // “curry cut”, “low fat”, etc.
  canonical: z.string().nullable().default(null),// normalized item name
  category: z.string().nullable().default(null), // grocery / veg / meat / dairy / etc.
});

export const ParseResultSchema = z.object({
  items: z.array(ItemSchema),
  confidence: z.number().min(0).max(1),
  reason: z.string().nullable().default(null),
  is_order_like: z.boolean().default(true),
});
export type ParseResult = z.infer<typeof ParseResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const ENABLE_AI = !!OPENAI_API_KEY;

// ─────────────────────────────────────────────────────────────────────────────
// 2) Prompt (system + few-shots)
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM = [
  "You are a precise order parser for WhatsApp messages.",
  "Extract items and quantities from short, messy text.",
  "Always return valid JSON in the requested schema.",
  "Be conservative: greetings like 'hi/thanks/ok' → is_order_like=false and items=[].",
  "Infer sensible units when implied (e.g., '2 milk' → unit:'pack' in India).",
  "Normalize canonical names when obvious (e.g., 'tata salt' → 'Salt').",
  "Do not invent items. Keep outputs minimal and consistent."
].join(" ");

const FEWSHOTS: Array<{ user: string; assistant: ParseResult }> = [
  {
    user: "2kg chicken curry cut, 1 packet milk",
    assistant: {
      items: [
        { name: "chicken curry cut", qty: 2, unit: "kg", notes: "curry cut", canonical: "Chicken", category: "meat" },
        { name: "milk", qty: 1, unit: "pack", notes: null, canonical: "Milk", category: "dairy" },
      ],
      confidence: 0.92, reason: "Clear list with units", is_order_like: true,
    }
  },
  {
    user: "pls send 3 பால் பாக்கெட்",
    assistant: {
      items: [
        { name: "பால் (milk)", qty: 3, unit: "pack", notes: "ta: பால்", canonical: "Milk", category: "dairy" },
      ],
      confidence: 0.85, reason: "Tamil request recognized", is_order_like: true,
    }
  },
  {
    user: "hi",
    assistant: { items: [], confidence: 0.2, reason: "greeting", is_order_like: false }
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3) Utilities
// ─────────────────────────────────────────────────────────────────────────────
function isGreetingOrNoise(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t) return true;
  return /^(hi|hello|hlo|thanks|thank you|ok|k|👍|🙏|good (morning|night|evening)|done|received)\b/.test(t);
}

function applyMicroHeuristics(items: ParseResult["items"]): ParseResult["items"] {
  return (items || []).map((it) => {
    const safeName = (it as any).name ?? (it as any).canonical ?? (it as any).raw ?? "";
    const nameLC = String(safeName).toLowerCase();

    // Infer milk unit if missing
    if (!it.unit && (/\bmilk\b/.test(nameLC) || /\bபால்\b/.test(nameLC))) {
      it = { ...it, unit: "pack" };
    }

    // Normalize tiny typos
    const trimmed = String(safeName || "").trim();
    if (/^amul milk$/i.test(trimmed)) {
      it = { ...it, canonical: it.canonical ?? "Milk", category: it.category ?? "dairy" };
    }

    // Ensure 'name' is always present in our schema
    if (!(it as any).name || typeof (it as any).name !== "string") {
      it = { ...it, name: trimmed || (it.canonical ?? "item") };
    }

    return it;
  });
}

function emptyResult(reason: string): ParseResult {
  return { items: [], confidence: 0, reason, is_order_like: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) MAIN: aiParseOrder
// ─────────────────────────────────────────────────────────────────────────────
export async function aiParseOrder(
  text: string,
  catalog?: Array<{ name: string; sku: string; aliases?: string[] }>
): Promise<ParseResult> {
  const raw = (text || "").trim();
  if (!raw) return emptyResult("empty");

  // Early exit for obvious non-orders
  if (isGreetingOrNoise(raw)) return emptyResult("greeting_or_noise");

  // Baseline (free) parse first — and NORMALIZE to include `name`
  const rawBaseline: any[] = (ruleParse(raw) || []) as any[];
  const baselineItems = rawBaseline.map((r) => {
    const name = String(r.raw ?? r.canonical ?? "").trim();
    return {
      // ensure ItemSchema fields exist
      name: name || "item",
      qty: typeof r.qty === "number" ? r.qty : (Number.isFinite(+r.qty) ? Number(r.qty) : 1),
      unit: r.unit ?? null,
      notes: r.meta?.cut ? String(r.meta.cut) : null,
      canonical: r.canonical ?? null,
      category: r.category ?? null,
    };
  });

  let baseline: ParseResult = {
    items: applyMicroHeuristics(baselineItems as any),
    confidence: baselineItems.length ? 0.6 : 0.3,
    reason: baselineItems.length ? "rule_based" : "rule_based_empty",
    is_order_like: baselineItems.length > 0,
  };

  // If no AI, return baseline immediately
  if (!ENABLE_AI) return baseline;

  // Pre-check budget (quick approximation to avoid calling if already over cap)
  const approxCost = estimateCostUSD({ prompt_tokens: 150, completion_tokens: 200 }, MODEL);
  if (!(await canSpendMoreUSD(approxCost))) {
    return baseline; // budget exceeded → fallback silently
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const catalogHint = catalog?.length
      ? "\nShop catalog (optional):\n" +
        catalog
          .slice(0, 50)
          .map((x) => `- SKU:${x.sku} name:${x.name} aliases:${(x.aliases || []).join(", ")}`)
          .join("\n") +
        "\nIf an item strongly matches, set canonical to catalog name (do NOT invent SKU in output)."
      : "";

    // Build messages (few-shots included). Use `any[]` to avoid SDK type drift.
    const messages: any[] = [
      { role: "system", content: SYSTEM + catalogHint },
      ...FEWSHOTS.flatMap((s) => [
        { role: "user", content: s.user },
        { role: "assistant", content: JSON.stringify(s.assistant) },
      ]),
      { role: "user", content: JSON.stringify({ raw, baseline }) },
    ];

    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      response_format: { type: "json_object" }, // force JSON
      temperature: 0.1,
      max_tokens: 400,
    });

    // Record the *actual* spend for this call
    const usage = (resp as any).usage as {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    } | undefined;

    const cost = estimateCostUSD(usage, MODEL);
    if (cost > 0) await addSpendUSD(cost);

    if (usage) {
      console.log("[AI] tokens in/out:", usage.prompt_tokens, usage.completion_tokens, "≈$", cost.toFixed(4));
      // Optional DB log (safe-noop if table not present)
      try {
        const { error } = await supa.from("ai_usage_log").insert({
          org_id: null, // you can pass org_id when calling if you have it in scope
          model: MODEL,
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens:
            usage.total_tokens ?? (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0),
          cost_usd: cost,
          created_at: new Date().toISOString(),
        });
        if (error) console.warn("[AI log error]", error.message);
      } catch (e) {
        console.warn("[AI log insert fail]", e);
      }
    }

    const content = resp.choices?.[0]?.message?.content || "{}";
    let parsed: ParseResult;

    try {
      parsed = ParseResultSchema.parse(JSON.parse(content));
    } catch {
      // If model returns something odd, stick to baseline
      return baseline;
    }

    // Safety: normalize items a bit more
    parsed.items = applyMicroHeuristics(parsed.items);

    // Ensure a clear parse_reason when AI path succeeded
    if (!parsed.reason) parsed.reason = `ai:${MODEL}`;

    // If model says it's not an order, keep that decision
    if (!parsed.is_order_like || parsed.items.length === 0) {
      return { ...parsed, items: [], is_order_like: false };
    }
    console.log("[AI used]", MODEL, "items:", parsed.items?.length ?? 0);
    return parsed;
  } catch (e: any) {
    console.error("[AI parse] error:", e?.message || e);
    // Fall back gracefully
    return baseline;
  }
}