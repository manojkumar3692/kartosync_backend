// src/ai/parser.ts
import OpenAI from "openai";
import { z } from "zod";
import { parseOrder as ruleParse } from "../parser"; // ← free rules parser
import {
  addSpendUSD,
  canSpendMoreUSD,
  estimateCostUSD,
  estimateCostUSDApprox,
} from "./cost"; // ← budget guard
import { supa } from "../db"; // ← optional logging

// ─────────────────────────────────────────────────────────────────────────────
// Safe string helpers (avoid .trim on undefined / non-strings)
// ─────────────────────────────────────────────────────────────────────────────
const asStr = (v: any) => (typeof v === "string" ? v : v == null ? "" : String(v));
const trimStr = (v: any) => asStr(v).trim();

// ─────────────────────────────────────────────────────────────────────────────
// 1) Schema (your exact spec)  + brand/variant support
// ─────────────────────────────────────────────────────────────────────────────
export const ItemSchema = z.object({
  name: z.string().min(1),
  qty: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  canonical: z.string().nullable().default(null),
  category: z.string().nullable().default(null),

  // NEW:
  brand: z.string().nullable().default(null),
  variant: z.string().nullable().default(null),
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
  "Extract brand and variant if user mentions them (e.g., 'Almarai' or 'Full Fat'/'1L'). If absent, leave null—do not invent.",
  "Do not invent items. Keep outputs minimal and consistent.",
].join(" ");

const FEWSHOTS: Array<{ user: string; assistant: ParseResult }> = [
  {
    user: "2kg chicken curry cut, 1 packet milk",
    assistant: {
      items: [
        {
          name: "chicken curry cut",
          qty: 2,
          unit: "kg",
          notes: "curry cut",
          canonical: "Chicken",
          category: "meat",
          brand: null,
          variant: null,
        },
        {
          name: "milk",
          qty: 1,
          unit: "pack",
          notes: null,
          canonical: "Milk",
          category: "dairy",
          brand: null,
          variant: null,
        },
      ],
      confidence: 0.92,
      reason: "Clear list with units",
      is_order_like: true,
    },
  },
  {
    user: "pls send 3 பால் பாக்கெட்",
    assistant: {
      items: [
        {
          name: "பால் (milk)",
          qty: 3,
          unit: "pack",
          notes: "ta: பால்",
          canonical: "Milk",
          category: "dairy",
          brand: null,
          variant: null,
        },
      ],
      confidence: 0.85,
      reason: "Tamil request recognized",
      is_order_like: true,
    },
  },
  {
    user: "hi",
    assistant: {
      items: [],
      confidence: 0.2,
      reason: "greeting",
      is_order_like: false,
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Brand / Variant micro-helpers (cheap heuristics before/after AI)
// ─────────────────────────────────────────────────────────────────────────────
const BRAND_HINTS: Record<string, string[]> = {
  // canonical -> likely brands (UAE-first for dairy)
  milk: ["almarai", "al rawabi", "al ain", "amul"],
  coke: ["coca cola", "coke", "coca-cola"],
  pepsi: ["pepsi"],
  salt: ["tata", "aashirvaad", "catch"],
};

const VARIANT_PATTERNS: Array<{ re: RegExp; norm: string | ((m: RegExpExecArray) => string) }> = [
  { re: /(full\s*fat)/i, norm: "Full Fat" },
  { re: /(low\s*fat|lite|light)/i, norm: "Low Fat" },
  { re: /(skim|double\s*toned)/i, norm: "Skim" },
  { re: /\b(\d+(?:\.\d+)?)\s*(l|ltr|litre|liter)\b/i, norm: (m) => `${m[1]}L` },
  { re: /\b(\d+)\s*ml\b/i, norm: (m) => `${m[1]}ml` },
  { re: /\b(\d+)\s*(g|kg)\b/i, norm: (m) => `${m[1]}${String(m[2]).toUpperCase()}` },
];

function detectBrand(base: string, canonical?: string | null): string | null {
  const t = base.toLowerCase();
  const key = (canonical || "").toLowerCase();
  const pool = [
    ...(BRAND_HINTS[key] || []),
    ...(BRAND_HINTS["milk"] || []), // fallback common category
  ];
  for (const b of pool) {
    if (t.includes(b)) {
      return b.replace(/\b\w/g, (c) => c.toUpperCase()); // naive title case
    }
  }
  return null;
}

function detectVariant(base: string): string | null {
  for (const p of VARIANT_PATTERNS) {
    const m = p.re.exec(base);
    if (m) return typeof p.norm === "function" ? p.norm(m) : p.norm;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
function isGreetingOrNoise(text: string): boolean {
  const t = trimStr(text).toLowerCase();
  if (!t) return true;
  return /^(hi|hello|hlo|thanks|thank you|ok|k|👍|🙏|good (morning|night|evening)|done|received)\b/.test(
    t
  );
}

// Coerce any rule-parser shape into our ItemSchema-ish
function coerceToItem(it: any): z.infer<typeof ItemSchema> {
  const nameCandidate = asStr(it?.name);
  const fallbackRaw = asStr(it?.raw);
  const name = trimStr(nameCandidate) || trimStr(fallbackRaw);

  const qty =
    typeof it?.qty === "number"
      ? it.qty
      : Number.isFinite(it?.qty)
      ? Number(it.qty)
      : null;

  const unit = (() => {
    const u = trimStr(it?.unit);
    return u ? u : null;
  })();

  const notes = (() => {
    const n = trimStr(it?.notes);
    return n ? n : null;
  })();

  const canonical = (() => {
    const c = trimStr(it?.canonical);
    return c ? c : null;
  })();

  const category = (() => {
    const c = trimStr(it?.category);
    return c ? c : null;
  })();

  // NEW:
  const brand = (() => {
    const b = trimStr(it?.brand);
    return b ? b : null;
  })();

  const variant = (() => {
    const v = trimStr(it?.variant);
    return v ? v : null;
  })();

  return { name, qty, unit, notes, canonical, category, brand, variant };
}

// Null-safe micro-heuristics (now with brand/variant)
function applyMicroHeuristics(
  items: Array<z.infer<typeof ItemSchema>>
): Array<z.infer<typeof ItemSchema>> {
  return (items || []).map((orig) => {
    let it = { ...orig };
    const baseName = asStr(it?.name || it?.canonical || "");
    if (!it.unit && /milk/i.test(baseName)) {
      // keep your earlier default behavior
      it.unit = "pack";
    }
    const trimmed = trimStr(baseName);
    if (/^amul milk$/i.test(trimmed)) {
      it.canonical = "Milk";
      it.category = it.category ?? "dairy";
      it.brand = it.brand ?? "Amul";
    }

    // NEW: cheap brand + variant detection from raw text
    if (!it.brand) it.brand = detectBrand(baseName, it.canonical);
    if (!it.variant) {
      const v = detectVariant(baseName);
      if (v) it.variant = v;
    }

    return it;
  });
}

function emptyResult(reason: string): ParseResult {
  return { items: [], confidence: 0, reason, is_order_like: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) MAIN: aiParseOrder  (supports org-scoped dynamic few-shots)
// ─────────────────────────────────────────────────────────────────────────────
export async function aiParseOrder(
  text: string,
  catalog?: Array<{ name: string; sku: string; aliases?: string[] }>,
  opts?: { org_id?: string }
): Promise<ParseResult> {
  const raw = trimStr(text);
  if (!raw) return emptyResult("empty");

  if (isGreetingOrNoise(raw)) return emptyResult("greeting_or_noise");

  // Baseline (free) parse first — coerce & heuristics
  const baselineItemsRaw = ruleParse(raw) || [];
  let baselineHeur: Array<z.infer<typeof ItemSchema>> = [];
  try {
    const baselineCoerced = (Array.isArray(baselineItemsRaw)
      ? baselineItemsRaw
      : []
    ).map(coerceToItem);
    baselineHeur = applyMicroHeuristics(baselineCoerced);
  } catch {
    baselineHeur = [];
  }

  let baseline: ParseResult = {
    items: baselineHeur,
    confidence: baselineHeur.length ? 0.6 : 0.3,
    reason: baselineHeur.length ? "rule_based" : "rule_based_empty",
    is_order_like: baselineHeur.length > 0,
  };

  if (!ENABLE_AI) return baseline;

  // ── Budget PRE-CHECK ───────────────────────────────────────────────────────
  const approxUSD = estimateCostUSDApprox(
    { prompt_tokens: 150, completion_tokens: 200 },
    MODEL
  );
  if (PER_CALL_CAP && approxUSD > PER_CALL_CAP) {
    console.warn("[AI$ BLOCK pre] approxUSD exceeds per-call cap", {
      approxUSD,
      PER_CALL_CAP,
      model: MODEL,
    });
    return baseline;
  }
  const canSpend = await canSpendMoreUSD(approxUSD as any);
  const gateOk = typeof canSpend === "object" ? (canSpend as any).ok : !!canSpend;
  if (!gateOk) {
    const reason =
      typeof canSpend === "object"
        ? (canSpend as any).reason
        : "daily_cap_exceeded";
    console.warn("[AI$ BLOCK pre] daily cap gate", {
      reason,
      approxUSD,
      model: MODEL,
    });
    return baseline;
  }
  if (typeof canSpend === "object" && (canSpend as any).today !== undefined) {
    console.log(
      `[AI$ PRE ok] today=$${(canSpend as any).today.toFixed(4)} + ~${approxUSD.toFixed(
        4
      )} <= cap=$${((canSpend as any).cap ?? 0).toFixed(2)}`
    );
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    // ── Pull dynamic few-shots from recent human fixes for this org (if any)
    let dynamicShots: Array<{ user: string; assistant: ParseResult }> = [];
    try {
      if (opts?.org_id) {
        const { data: shots, error: shotsErr } = await supa
          .from("ai_corrections")
          .select("message_text, human_fixed")
          .eq("org_id", opts.org_id)
          .order("created_at", { ascending: false })
          .limit(8);

        if (!shotsErr && Array.isArray(shots)) {
          for (const row of shots) {
            const msg = trimStr(row?.message_text);
            const items: any[] = Array.isArray(row?.human_fixed?.items)
              ? row.human_fixed.items
              : [];
            if (msg && items.length) {
              // ensure items satisfy our schema shape minimally
              const safeItems = items
                .map((x) => ({
                  name: trimStr(x?.name || x?.canonical || ""),
                  qty:
                    typeof x?.qty === "number"
                      ? x.qty
                      : Number.isFinite(x?.qty)
                      ? Number(x.qty)
                      : null,
                  unit: trimStr(x?.unit) || null,
                  notes: trimStr(x?.notes) || null,
                  canonical: trimStr(x?.canonical) || null,
                  category: trimStr(x?.category) || null,
                  // NEW: include brand/variant in few-shot assistant
                  brand: trimStr(x?.brand) || null,
                  variant: trimStr(x?.variant) || null,
                }))
                .filter((x) => !!x.name);

              if (safeItems.length) {
                dynamicShots.push({
                  user: msg,
                  assistant: {
                    items: safeItems,
                    confidence: 0.95,
                    reason: "human_fixed_fewshot",
                    is_order_like: true,
                  },
                });
              }
            }
          }
        }
      }
    } catch {
      // ignore dynamic few-shot errors
    }

    const catalogHint =
      Array.isArray(catalog) && catalog.length
        ? "\nShop catalog (optional):\n" +
          catalog
            .slice(0, 50)
            .map(
              (x) =>
                `- SKU:${asStr(x.sku)} name:${asStr(x.name)} aliases:${(
                  Array.isArray(x.aliases) ? x.aliases : []
                )
                  .map(asStr)
                  .join(", ")}`
            )
            .join("\n") +
          "\nIf an item strongly matches, set canonical to catalog name (do NOT invent SKU in output)."
        : "";

    const messages: any[] = [
      { role: "system", content: SYSTEM + catalogHint },
      ...[...FEWSHOTS, ...dynamicShots].flatMap((s) => [
        { role: "user", content: s.user },
        { role: "assistant", content: JSON.stringify(s.assistant) },
      ]),
      { role: "user", content: JSON.stringify({ raw, baseline }) },
    ];

    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 400,
    });

    const usage = (resp as any).usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        }
      | undefined;

    const cost = estimateCostUSD(usage, MODEL);
    if (PER_CALL_CAP && cost > PER_CALL_CAP) {
      console.warn("[AI$ POST over cap]", {
        cost: Number(cost.toFixed(6)),
        PER_CALL_CAP,
        model: MODEL,
      });
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
          prompt_tokens: usage?.prompt_tokens ?? 0,
          completion_tokens: usage?.completion_tokens ?? 0,
          total_tokens:
            usage?.total_tokens ??
            (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0),
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

    // Normalize items further (null-safe)
    parsed.items = applyMicroHeuristics(parsed.items);

    // ✅ Preserve model-provided reason; only add fallback if missing/blank
    const aiReason = trimStr(parsed.reason);
    if (!aiReason) {
      parsed.reason = baselineHeur.length ? "refined_from_rules" : "items_detected";
    } else {
      parsed.reason = aiReason;
    }

    // If model says it's not an order, keep that decision
    if (!parsed.is_order_like || parsed.items.length === 0) {
      return { ...parsed, items: [], is_order_like: false };
    }

    console.log(
      "[AI used]",
      MODEL,
      "items:",
      parsed.items?.length ?? 0,
      "reason:",
      parsed.reason
    );
    return parsed;
  } catch (e: any) {
    console.error("[AI parse] error:", e?.message || e);
    console.log("[AI SKIPPED → RULES]", { reason: baseline.reason });
    return baseline;
  }
}