// src/ai/parser.ts
import OpenAI from "openai";
import { z } from "zod";
import { parseOrder as ruleParse } from "../parser";                  // ← free rules parser
import { addSpendUSD, canSpendMoreUSD, estimateCostUSD, estimateCostUSDApprox } from "./cost"; // ← budget guard
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
const PER_CALL_CAP = Number(process.env.AI_PER_CALL_USD_MAX || 0) || undefined; // e.g. 1.00

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

// Coerce any rule-parser shape (e.g., {raw, qty, ...}) into our ItemSchema-ish
function coerceToItem(it: any): z.infer<typeof ItemSchema> {
  const name = (typeof it?.name === "string" && it.name.trim().length > 0)
    ? it.name.trim()
    : (typeof it?.raw === "string" ? String(it.raw).trim() : "");

  return {
    name: name || "",                                   // allow "" here; zod validation happens later downstream
    qty: typeof it?.qty === "number" ? it.qty : (Number.isFinite(it?.qty) ? Number(it.qty) : null),
    unit: (typeof it?.unit === "string" && it.unit.trim()) ? it.unit.trim() : null,
    notes: (typeof it?.notes === "string" && it.notes.trim()) ? it.notes.trim() : null,
    canonical: (typeof it?.canonical === "string" && it.canonical.trim()) ? it.canonical.trim() : null,
    category: (typeof it?.category === "string" && it.category.trim()) ? it.category.trim() : null,
  };
}

// Null-safe micro-heuristics (works with coerced items)
function applyMicroHeuristics(items: Array<z.infer<typeof ItemSchema>>): Array<z.infer<typeof ItemSchema>> {
  return (items || []).map((it) => {
    // 👇 guaranteed string; avoids .trim() on undefined/null
    const baseName = ((it?.name ?? "") as string).toString();

    // Infer milk unit if missing
    if (!it.unit && /milk/i.test(baseName)) {
      it = { ...it, unit: "pack" };
    }

    // Normalize tiny typos
    const trimmed = baseName.trim();
    if (/^amul milk$/i.test(trimmed)) {
      it = { ...it, canonical: "Milk", category: it.category ?? "dairy" };
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

  // Baseline (free) parse first — coerce to our item shape, then heuristics
  const baselineItemsRaw = ruleParse(raw) || [];
  const baselineCoerced = (baselineItemsRaw as any[]).map(coerceToItem);
  const baselineHeur = applyMicroHeuristics(baselineCoerced);

  let baseline: ParseResult = {
    items: baselineHeur,
    confidence: baselineHeur.length ? 0.6 : 0.3,
    reason: baselineHeur.length ? "rule_based" : "rule_based_empty",
    is_order_like: baselineHeur.length > 0
  };

  // If no AI, return baseline immediately
  if (!ENABLE_AI) return baseline;

  // ── Budget PRE-CHECK ───────────────────────────────────────────────────────
  const approxUSD = estimateCostUSDApprox({ prompt_tokens: 150, completion_tokens: 200 }, MODEL);
  if (PER_CALL_CAP && approxUSD > PER_CALL_CAP) {
    console.warn("[AI$ BLOCK pre] approxUSD exceeds per-call cap", { approxUSD, PER_CALL_CAP, model: MODEL });
    return baseline;
  }
  const canSpend = await canSpendMoreUSD(approxUSD as any);
  const gateOk = typeof canSpend === "object" ? (canSpend as any).ok : !!canSpend;
  if (!gateOk) {
    const reason = typeof canSpend === "object" ? (canSpend as any).reason : "daily_cap_exceeded";
    console.warn("[AI$ BLOCK pre] daily cap gate", { reason, approxUSD, model: MODEL });
    return baseline;
  }
  if (typeof canSpend === "object" && (canSpend as any).today !== undefined) {
    console.log(
      `[AI$ PRE ok] today=$${(canSpend as any).today.toFixed(4)} + ~${approxUSD.toFixed(4)} <= cap=$${((canSpend as any).cap ?? 0).toFixed(2)}`
    );
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const catalogHint = catalog?.length
      ? "\nShop catalog (optional):\n" +
        catalog.slice(0, 50)
          .map(x => `- SKU:${x.sku} name:${x.name} aliases:${(x.aliases || []).join(", ")}`)
          .join("\n") +
        "\nIf an item strongly matches, set canonical to catalog name (do NOT invent SKU in output)."
      : "";

    // Build messages (few-shots included). Use `any[]` to avoid SDK type drift.
    const messages: any[] = [
      { role: "system", content: SYSTEM + catalogHint },
      ...FEWSHOTS.flatMap(s => ([
        { role: "user", content: s.user },
        { role: "assistant", content: JSON.stringify(s.assistant) }
      ])),
      { role: "user", content: JSON.stringify({ raw, baseline }) }
    ];

    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      response_format: { type: "json_object" }, // force JSON
      temperature: 0.1,
      max_tokens: 400
    });

    // Record the *actual* spend for this call
    const usage = (resp as any).usage as {
      prompt_tokens?: number; completion_tokens?: number; total_tokens?: number
    } | undefined;

    const cost = estimateCostUSD(usage, MODEL);
    if (PER_CALL_CAP && cost > PER_CALL_CAP) {
      console.warn("[AI$ POST over cap]", { cost: Number(cost.toFixed(6)), PER_CALL_CAP, model: MODEL });
    }
    if (cost > 0) {
      await addSpendUSD(cost);
      console.log(
        "[AI] tokens in/out:",
        usage?.prompt_tokens ?? 0,
        usage?.completion_tokens ?? 0,
        "≈$",
        cost.toFixed(4)
      );
    }

    // Optional DB log (safe-noop if table not present)
    if (usage) {
      try {
        const { error } = await supa.from("ai_usage_log").insert({
          org_id: null,
          model: MODEL,
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0)),
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

    // Safety: normalize items a bit more (already schema-coerced for baseline; AI outputs should match schema)
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
    console.log("[AI SKIPPED → RULES]", { reason: baseline.reason });
    // Fall back gracefully
    return baseline;
  }
}