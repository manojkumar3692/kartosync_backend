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

  // 🔥 NEW FIELDS (for pricing)
  price_per_unit: z.number().nullable().default(null),
  line_total: z.number().nullable().default(null),
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
  "If the message asks for price or availability, set is_order_like=false, extract items (if any), and explain in reason (e.g., 'inquiry:price').",
  "Do not let greetings like 'hi/thanks/ok' suppress an item list if the text includes a multi-line list or a comma-separated list of products.",
  "Default missing qty to 1 ONLY when a list pattern strongly implies an order (multi-line list with an order intent or comma-separated with intent).",
  "Infer sensible units only when obvious (e.g., '2 milk' → unit:'pack' in India/UAE).",
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
          // 🔥 NEW
      price_per_unit: null,
      line_total: null,
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
          // 🔥 NEW
      price_per_unit: null,
      line_total: null,
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
          // 🔥 NEW
      price_per_unit: null,
      line_total: null,
        },
      ],
      confidence: 0.85,
      reason: "Tamil request recognized",
      is_order_like: true,
    },
  },
  {
    user: "hi what's the price of onion?",
    assistant: {
      items: [
        {
          name: "onion",
          qty: null,
          unit: null,
          notes: null,
          canonical: "Onion",
          category: "grocery",
          brand: null,
          variant: null,
          // 🔥 NEW
      price_per_unit: null,
      line_total: null,
        },
      ],
      confidence: 0.8,
      reason: "inquiry:price",
      is_order_like: false,
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
// Pre-normalization helpers (tiny synonyms to keep cost low)
// ─────────────────────────────────────────────────────────────────────────────
const VERB_SYNONYMS: Record<string, string> = {
  snd: "send",
  pls: "please",
  plz: "please",
  "gn aap": "please",
  "need to": "need",
  book: "order",
  keep: "send",
  bring: "send",
};

// Replace the whole UNIT_SYNONYMS block with this:
const UNIT_SYNONYMS: Record<string, string> = {
  litre: "l",
  liter: "l",
  ltr: "l",
  lt: "l",
  pk: "pack",
  pkt: "pack",
  packet: "pack",
  piece: "pc",
  pieces: "pc",
  pcs: "pc",
  gms: "g",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
};

const WORD_NORMALIZE: Array<[RegExp, string]> = [
  [/crossaints?/gi, "croissants"],
  [/cholatey/gi, "chocolate"],
  [/chapathi|chapati|chappathi/gi, "chapati"],
  [/idly/gi, "idli"],
  [/tooth\s*brush/gi, "toothbrush"],
  [/david\s*off/gi, "davidoff"],
];

function normalizeLight(text: string): string {
  let s = text;
  s = s.replace(/\bgm(s)?\b/gi, "g");
s = s.replace(/\bkg(s)?\b/gi, "kg");
  // verbs
  for (const [k, v] of Object.entries(VERB_SYNONYMS)) {
    const re = new RegExp(`\\b${k}\\b`, "gi");
    s = s.replace(re, v);
  }
  // units
  for (const [k, v] of Object.entries(UNIT_SYNONYMS)) {
    const re = new RegExp(`\\b${k}\\b`, "gi");
    s = s.replace(re, v);
  }
  // common misspellings
  for (const [re, rep] of WORD_NORMALIZE) s = s.replace(re, rep);

  // soften trailing closers that confuse intent
  s = s.replace(/\b(that'?s it|that's all|done)\.?$/i, "").trim();
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Brand / Variant micro-helpers (cheap heuristics before/after AI)
// ─────────────────────────────────────────────────────────────────────────────
const BRAND_HINTS: Record<string, string[]> = {
  milk: ["almarai", "al rawabi", "al ain", "amul"],
  coke: ["coca cola", "coke", "coca-cola"],
  pepsi: ["pepsi"],
  salt: ["tata", "aashirvaad", "catch"],
  coffee: ["davidoff", "nescafe", "bru", "starbucks"],
  "coffee powder": ["davidoff", "nescafe", "bru"],
  shampoo: ["pantene", "dove", "sunsilk", "head & shoulders", "clinic plus"],
  "sanitary pads": ["whisper", "stayfree", "sofy"],
};

const VARIANT_PATTERNS: Array<{ re: RegExp; norm: string | ((m: RegExpExecArray) => string) }> = [
  { re: /(full\s*fat)/i, norm: "Full Fat" },
  { re: /(low\s*fat|lite|light)/i, norm: "Low Fat" },
  { re: /(skim|double\s*toned)/i, norm: "Skim" },
  { re: /\b(gold|classic|espresso|hazelnut)\b/i, norm: (m) => titleCase(m[1]) },
  { re: /\b(\d+(?:\.\d+)?)\s*(l)\b/i, norm: (m) => `${m[1]}L` },
  { re: /\b(\d+)\s*ml\b/i, norm: (m) => `${m[1]}ml` },
  { re: /\b(\d+)\s*(g|kg)\b/i, norm: (m) => `${m[1]}${String(m[2]).toUpperCase()}` },
];

function titleCase(s: string) {
  return (s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}

function detectBrand(base: string, canonical?: string | null): string | null {
  const t = base.toLowerCase();
  const key = (canonical || "").toLowerCase();
  const pool = [
    ...(BRAND_HINTS[key] || []),
    ...(key !== "milk" ? BRAND_HINTS["milk"] || [] : []),
    ...(BRAND_HINTS["coffee"] || []),
  ];
  for (const b of pool) {
    if (t.includes(b)) return titleCase(b);
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
// List heuristics (bias away from false 'greeting')
// ─────────────────────────────────────────────────────────────────────────────
function hasOrderIntentVerb(t: string): boolean {
  return /\b(send|need|want|order|buy|deliver|give|bring|pack|take|place|can you send)\b/i.test(t);
}
function hasUnitOrQty(t: string): boolean {
  return /\b(\d+(\.\d+)?)\s?(kg|g|l|ml|pack|pc|pcs|dozen)\b/i.test(t) || /\b\d+\b/.test(t);
}
function isMultiLineProducty(t: string): boolean {
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  let productish = 0;
  for (const l of lines) {
    // at least two word tokens or a qty/unit
    const tokens = l.split(/[^a-z0-9+]+/i).filter(Boolean);
    if (tokens.length >= 2 || hasUnitOrQty(l)) productish++;
  }
  return productish >= 2; // two producty lines → looks like a list
}
function isCommaListWithIntent(t: string): boolean {
  const looksCommaList = /[,•·]/.test(t) && /[a-z]/i.test(t);
  return looksCommaList && hasOrderIntentVerb(t);
}

function isGreetingOrNoise(text: string): boolean {
  const t = trimStr(text).toLowerCase();
  if (!t) return true;
  // If it looks like a list, do NOT treat as noise.
  if (isMultiLineProducty(t) || isCommaListWithIntent(t)) return false;
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

  // 🔥 NEW: carry prices if rule parser ever emits them
  const price_per_unit =
    typeof it?.price_per_unit === "number" && !Number.isNaN(it.price_per_unit)
      ? it.price_per_unit
      : null;

  const line_total =
    typeof it?.line_total === "number" && !Number.isNaN(it.line_total)
      ? it.line_total
      : null;

  return {
    name,
    qty,
    unit,
    notes,
    canonical,
    category,
    brand,
    variant,
    price_per_unit,
    line_total,
  };
}

// Null-safe micro-heuristics (now with brand/variant)
function applyMicroHeuristics(
  items: Array<z.infer<typeof ItemSchema>>
): Array<z.infer<typeof ItemSchema>> {
  return (items || []).map((orig) => {
    let it = { ...orig };
    const baseName = asStr(it?.name || it?.canonical || "");
    if (!it.unit && /milk/i.test(baseName)) {
      it.unit = "pack";
    }
    const trimmed = trimStr(baseName);
    if (/^amul milk$/i.test(trimmed)) {
      it.canonical = "Milk";
      it.category = it.category ?? "dairy";
      it.brand = it.brand ?? "Amul";
    }

    // light canonical nudges (safe)
    if (!it.canonical) {
      if (/ice\s*cream/i.test(baseName)) it.canonical = "Ice Cream";
      else if (/croissants?/i.test(baseName)) it.canonical = "Croissant";
      else if (/mustard\s*seeds?/i.test(baseName)) it.canonical = "Mustard Seeds";
      else if (/fenugreek\s*seeds?/i.test(baseName)) it.canonical = "Fenugreek Seeds";
      else if (/tooth\s*brush/i.test(baseName)) it.canonical = "Toothbrush";
      else if (/sanitary\s*pads?/i.test(baseName)) it.canonical = "Sanitary Pads";
      else if (/coffee\s*powder/i.test(baseName)) it.canonical = "Coffee Powder";
      else if (/pop\s*corn/i.test(baseName)) it.canonical = "Popcorn";
      else if (/shampoo/i.test(baseName)) it.canonical = "Shampoo";
      else if (/idli|idly/i.test(baseName)) it.canonical = "Idli Batter";
      else if (/chapati|chapati|chapathi/i.test(baseName)) it.canonical = "Chapati";
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
async function buildLearningsBoost(args: {
  org_id?: string;
  customer_phone?: string;
  baselineCanonicals: string[];
}) {
  const { org_id, customer_phone, baselineCanonicals } = args;
  if (!org_id) return "";

  const canonList = (baselineCanonicals || [])
    .map((c) => (c || "").trim())
    .filter(Boolean);
  const uniqueCanon = Array.from(new Set(canonList)).slice(0, 12);

  let customerRows: any[] = [];
  let orgPopularRows: any[] = [];

  try {
    if (customer_phone) {
      const { data, error } = await supa
        .from("customer_prefs")
        .select("canonical,brand,variant,cnt,last_seen")
        .eq("org_id", org_id)
        .eq("customer_phone", customer_phone)
        .order("cnt", { ascending: false })
        .limit(50);
      if (!error && Array.isArray(data)) customerRows = data;
    }
  } catch {
    // no-op
  }

  try {
    const { data, error } = await supa
      .from("brand_variant_stats")
      .select("canonical,brand,variant,cnt,last_seen")
      .eq("org_id", org_id)
      .order("cnt", { ascending: false })
      .limit(100);
    if (!error && Array.isArray(data)) orgPopularRows = data;
  } catch {
    // no-op
  }

  const filterByCanon =
    uniqueCanon.length > 0
      ? (r: any) => uniqueCanon.includes(String(r?.canonical || ""))
      : (_r: any) => true;

  const cust = customerRows.filter(filterByCanon);
  const pop = orgPopularRows.filter(filterByCanon);

  if (!cust.length && !pop.length) return "";

  const lines: string[] = [];
  if (cust.length) {
    lines.push("Customer preferences (from past orders):");
    const byCanon: Record<string, any[]> = {};
    for (const r of cust) {
      const key = String(r.canonical || "");
      (byCanon[key] ||= []).push(r);
    }
    for (const [canon, arr] of Object.entries(byCanon)) {
      const top = arr
        .slice()
        .sort((a, b) => (b?.cnt || 0) - (a?.cnt || 0))
        .slice(0, 3);
      const choices = top
        .map((r) => {
          const b = r.brand ? `brand:${r.brand}` : null;
          const v = r.variant ? `variant:${r.variant}` : null;
          const cv = [b, v].filter(Boolean).join(", ");
          return `${cv || "generic"} (×${r.cnt ?? 0})`;
        })
        .join(" | ");
      lines.push(`- ${canon}: ${choices}`);
    }
  }

  if (pop.length) {
    lines.push("Shop-wide popular combinations:");
    const byCanon2: Record<string, any[]> = {};
    for (const r of pop) {
      const key = String(r.canonical || "");
      (byCanon2[key] ||= []).push(r);
    }
    for (const [canon, arr] of Object.entries(byCanon2)) {
      const top = arr
        .slice()
        .sort((a, b) => (b?.cnt || 0) - (a?.cnt || 0))
        .slice(0, 3);
      const choices = top
        .map((r) => {
          const b = r.brand ? `brand:${r.brand}` : null;
          const v = r.variant ? `variant:${r.variant}` : null;
          const cv = [b, v].filter(Boolean).join(", ");
          return `${cv || "generic"} (×${r.cnt ?? 0})`;
        })
        .join(" | ");
      lines.push(`- ${canon}: ${choices}`);
    }
  }

  lines.push(
    "Rules: Use these ONLY for gentle disambiguation.",
    "- If one brand/variant clearly dominates (strong majority) AND the text implies it, you MAY set it.",
    "- Otherwise, leave brand/variant as null and explain in `reason` what was ambiguous."
  );

  return `\nLEARNING HINTS\n${lines.join("\n")}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Post-AI fallback: split comma lists if model fused items
// ─────────────────────────────────────────────────────────────────────────────
function postSplitCommaList(raw: string, parsed: ParseResult): ParseResult {
  const t = raw.toLowerCase();
  const looksComma = /[,•·]/.test(t);
  const hasIntent = hasOrderIntentVerb(t);
  if (!looksComma || !hasIntent) return parsed;

  if (parsed.items.length <= 1) {
    // naive split by comma bullets; keep small tokens
    const parts = raw
      .split(/[,\u2022\u00B7]/) // comma or common bullets
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const items = parts.map((p) => ({
        name: p,
        qty: 1,
        unit: null,
        notes: null,
        canonical: null,
        category: null,
        brand: detectBrand(p, null),
        variant: detectVariant(p),
        // 🔥 NEW
  price_per_unit: null,
  line_total: null,
      }));
      return {
        items: applyMicroHeuristics(items as any),
        confidence: Math.max(parsed.confidence ?? 0.5, 0.7),
        reason: (parsed.reason ? parsed.reason + "; " : "") + "post_split_comma_list",
        is_order_like: true,
      };
    }
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) MAIN: aiParseOrder  (supports org-scoped dynamic few-shots + learnings)
// ─────────────────────────────────────────────────────────────────────────────
export async function aiParseOrder(
  text: string,
  catalog?: Array<{ name: string; sku: string; aliases?: string[] }>,
  opts?: { org_id?: string; customer_phone?: string } // ← extended
): Promise<ParseResult> {
  // Pre-normalize cheap synonyms (no cost)
  const raw0 = trimStr(text);
  const raw = normalizeLight(raw0);
  if (!raw) return emptyResult("empty");

  // Nudge: only drop as greeting/noise if it does NOT look like a product list
  if (isGreetingOrNoise(raw)) return emptyResult("greeting_or_noise");

  // Bias: verb-lite multi-line lists are likely orders (qty=1 default downstream if needed)
  const listBias = isMultiLineProducty(raw) || isCommaListWithIntent(raw);

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
    is_order_like: baselineHeur.length > 0 || listBias, // honor list bias
  };

  // If we have a strong list bias but no qty, set qty=1 for each line item (cheap default)
  if (listBias && baseline.items.length > 0) {
    baseline.items = baseline.items.map((it) => ({ ...it, qty: it.qty ?? 1 }));
    baseline.reason = (baseline.reason ? baseline.reason + "; " : "") + "list_bias_qty1";
    baseline.confidence = Math.max(baseline.confidence, 0.7);
  }

  if (!ENABLE_AI) {
    console.warn("[AI$ DISABLED] OPENAI_API_KEY not set; returning baseline only.", {
      model: MODEL,
      org_id: opts?.org_id || null,
      customer_phone: opts?.customer_phone || null,
    });
    return postSplitCommaList(raw, baseline);
  }

  // ── Budget PRE-CHECK ───────────────────────────────────────────────────────
  const approxUSD = estimateCostUSDApprox(
    { prompt_tokens: 160, completion_tokens: 220 },
    MODEL
  );

  if (PER_CALL_CAP && approxUSD > PER_CALL_CAP) {
    console.warn("[AI$ BLOCK pre] approxUSD exceeds per-call cap", {
      approxUSD,
      PER_CALL_CAP,
      model: MODEL,
      org_id: opts?.org_id || null,
      customer_phone: opts?.customer_phone || null,
    });
    return postSplitCommaList(raw, baseline);
  }
  // Visibility: planned cost
  console.log("[AI$ PLAN]", {
    model: MODEL,
    approxUSD: Number((approxUSD as any).toFixed ? (approxUSD as any).toFixed(4) : approxUSD),
    org_id: opts?.org_id || null,
    customer_phone: opts?.customer_phone || null,
  });

  const canSpend = await canSpendMoreUSD(approxUSD as any);
  const gateOk = typeof canSpend === "object" ? (canSpend as any).ok : !!canSpend;
  if (!gateOk) {
    const reason =
      typeof canSpend === "object" ? (canSpend as any).reason : "daily_cap_exceeded";
    console.warn("[AI$ BLOCK pre] daily cap gate", {
      reason,
      approxUSD,
      model: MODEL,
      org_id: opts?.org_id || null,
      customer_phone: opts?.customer_phone || null,
    });
    return postSplitCommaList(raw, baseline);
  }
  if (typeof canSpend === "object" && (canSpend as any).today !== undefined) {
    console.log(
      `[AI$ PRE ok] today=$${(canSpend as any).today.toFixed(4)} + ~${(approxUSD as any).toFixed(
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
                  brand: trimStr(x?.brand) || null,
                  variant: trimStr(x?.variant) || null,
                  price_per_unit:
      typeof x?.price_per_unit === "number" && !Number.isNaN(x.price_per_unit)
        ? x.price_per_unit
        : null,
    line_total:
      typeof x?.line_total === "number" && !Number.isNaN(x.line_total)
        ? x.line_total
        : null,
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

    // Build a short learnings booster (per-customer + org-popular)
    let learningBoost = "";
    try {
      const baselineCanonicals = (baseline.items || [])
        .map((it) => (it?.canonical || it?.name || "").trim())
        .filter(Boolean);
      learningBoost = await buildLearningsBoost({
        org_id: opts?.org_id,
        customer_phone: opts?.customer_phone,
        baselineCanonicals,
      });
    } catch {
      // ignore learnings failures
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
      ...(learningBoost ? [{ role: "system", content: learningBoost }] : []),
      {
        role: "user",
        content: JSON.stringify({
          raw,
          baseline: {
            ...baseline,
            // keep compact for token cost
            items: baseline.items.map((i) => ({
              name: i.name,
              qty: i.qty,
              unit: i.unit,
              brand: i.brand,
              variant: i.variant,
              canonical: i.canonical,
            })),
          },
        }),
      },
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

    if (!usage) {
      console.warn("[AI$ WARN] OpenAI returned no usage; cost cannot be computed.", {
        model: MODEL,
        org_id: opts?.org_id || null,
        customer_phone: opts?.customer_phone || null,
      });
    }

    const cost = estimateCostUSD(usage, MODEL);

    // Store spend + print precise cost
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
    console.log("[AI$ USED]", {
      model: MODEL,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      cost_usd: Number((cost || 0).toFixed(4)),
      org_id: opts?.org_id || null,
      customer_phone: opts?.customer_phone || null,
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    let parsed: ParseResult;

    try {
      parsed = ParseResultSchema.parse(JSON.parse(content));
    } catch {
      console.warn("[AI$ SKIP post] model returned non-JSON → using baseline. reason:", baseline.reason);
      return postSplitCommaList(raw, baseline);
    }

    // Normalize items further (null-safe)
    parsed.items = applyMicroHeuristics(parsed.items);

    // ✅ Preserve model-provided reason; only add fallback if missing/blank
    const aiReason = trimStr(parsed.reason);
    if (!aiReason) {
      parsed.reason = baseline.items.length ? "refined_from_rules" : "items_detected";
    } else {
      parsed.reason = aiReason;
    }

    // If model says it's not an order (or empty items), we still allow inquiry downstream.
    if (!parsed.is_order_like || parsed.items.length === 0) {
      return { ...parsed, items: [], is_order_like: false };
    }

    // Post-split comma list if the model fused them
    parsed = postSplitCommaList(raw, parsed);

    return parsed;
  } catch (e: any) {
    console.error("[AI parse] error:", e?.message || e);
    console.log("[AI SKIPPED → RULES]", { reason: baseline.reason });
    return postSplitCommaList(raw, baseline);
  }
}