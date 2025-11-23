// src/ai/address.ts
import OpenAI from "openai";
import { z } from "zod";
import {
  addSpendUSD,
  canSpendMoreUSD,
  estimateCostUSDApprox,
} from "./cost";
import { supa } from "../db";

// ─────────────────────────────────────────────
// L3: Model + config
// ─────────────────────────────────────────────

const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

function getAddressModelName() {
  return process.env.AI_ADDRESS_MODEL || "gpt-4o-mini";
}

// ─────────────────────────────────────────────
// Schema for AI output
// ─────────────────────────────────────────────

const AddressPartsSchema = z.object({
  // Keep everything optional, we don't want schema failures
  flat: z.string().min(1).nullable().optional(),        // e.g. "Flat 504"
  building: z.string().min(1).nullable().optional(),    // e.g. "Skyline Tower"
  street: z.string().min(1).nullable().optional(),      // e.g. "Al Wasl Road"
  area: z.string().min(1).nullable().optional(),        // e.g. "Al Barsha"
  city: z.string().min(1).nullable().optional(),        // e.g. "Dubai"
  state: z.string().min(1).nullable().optional(),       // e.g. "Tamil Nadu"
  postcode: z.string().min(1).nullable().optional(),    // e.g. "600042" or "00000"
  landmark: z.string().min(1).nullable().optional(),    // e.g. "near Lulu Mall"
  country: z.string().min(1).nullable().optional(),     // e.g. "UAE", "India"
});

const AddressOutputSchema = z.object({
  // Is this message primarily a delivery address?
  is_address: z.boolean().optional(),

  // Original address text we used
  raw: z.string().nullable().optional(),

  // Single-line normalized address (for storing & showing to staff)
  normalized: z.string().nullable().optional(),

  // Parsed components (best-effort)
  parts: AddressPartsSchema.partial().optional(),

  // Confidence 0–1
  confidence: z.number().min(0).max(1).optional(),

  // Machine-friendly reason tag
  // e.g. "ai:addr:detected", "ai:not_address:greeting", "ai:not_address:order_like"
  reason: z.string().nullable().optional(),
});

export type AiAddressParts = z.infer<typeof AddressPartsSchema>;
export type AiAddressOutput = z.infer<typeof AddressOutputSchema>;

// ─────────────────────────────────────────────
// Prompts (generic, any country / format)
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a strict JSON API that checks if a SINGLE WhatsApp message looks like a DELIVERY ADDRESS
and, if yes, extracts clean address components.

The business type is unknown: it could be restaurant, grocery, pharmacy, clothing, etc.
Your ONLY job is address detection & extraction.

Definitions:
- "Address-like" = user sends location text for delivery, usually with building, street, area, city,
  nearby landmark, or PIN/postcode.
- It can be one long line separated by commas or multiple lines.
- Messages that are only orders, greetings, price questions, or complaints are NOT addresses.

Your output MUST ALWAYS be valid JSON matching:
{
  is_address?: boolean;
  raw?: string | null;
  normalized?: string | null;
  parts?: {
    flat?: string | null;
    building?: string | null;
    street?: string | null;
    area?: string | null;
    city?: string | null;
    state?: string | null;
    postcode?: string | null;
    landmark?: string | null;
    country?: string | null;
  };
  confidence?: number;   // 0–1
  reason?: string | null;
}

Rules:
- Be conservative. If you are not reasonably sure it's an address, set is_address = false.
- If the message is clearly just an item list (order), set is_address = false and reason = "ai:not_address:order_like".
- If the message is greeting / thanks, set is_address = false and reason = "ai:not_address:greeting".
- If the message is a pure question (price/availability/menu/order status), set is_address = false and reason = "ai:not_address:inquiry".
- For addresses, fill as many parts as you confidently can, leave others null.
- "normalized" should be a single line combining the parts in a clear human-readable order.
- NEVER add house numbers, landmarks, or cities that the user did not mention.
- Do NOT guess the city or country if not clearly there.
`.trim();

function buildUserPrompt(input: string): string {
  return [
    "User message:",
    "----------------",
    input,
    "----------------",
    "",
    "Decide if this is a delivery address and extract parts.",
    "",
    "Examples (ADDRESS):",
    '- \"Flat 504, Skyline Tower, Al Karama, Dubai\"',
    '- \"No 12, 2nd Cross Street, Anna Nagar, Chennai 600042\"',
    '- \"Villa 23, Bloom Gardens, near Khalifa Park, Abu Dhabi\"',
    "",
    "Examples (NOT ADDRESS):",
    '- \"2kg onion, 1L milk\" (order-like)',
    '- \"do you have chicken biryani?\" (inquiry)',
    '- \"hi\" / \"ok thanks\" (greeting/ack)',
    '- \"make my biryani spicy\" (preference, not address)',
    "",
    "Now respond ONLY with a JSON object that matches this TypeScript type:",
    "",
    "type AddressParts = {",
    "  flat?: string | null;",
    "  building?: string | null;",
    "  street?: string | null;",
    "  area?: string | null;",
    "  city?: string | null;",
    "  state?: string | null;",
    "  postcode?: string | null;",
    "  landmark?: string | null;",
    "  country?: string | null;",
    "};",
    "",
    "type AddressOutput = {",
    "  is_address?: boolean;",
    "  raw?: string | null;",
    "  normalized?: string | null;",
    "  parts?: AddressParts;",
    "  confidence?: number;          // 0–1",
    "  reason?: string | null;       // e.g. 'ai:addr:detected', 'ai:not_address:order_like', 'ai:not_address:greeting'",
    "};",
    "",
    "Important rules:",
    "- If not sure → is_address = false, parts = {}, normalized = null, reason = 'ai:not_address:ambiguous'.",
    "- For sure address → is_address = true, confidence >= 0.6, reason = 'ai:addr:detected'.",
    "- Output ONLY JSON. No explanations or comments.",
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
    console.warn("[AI][addr] JSON.parse candidate failed:", e?.message || e);
    return null;
  }
}

function coerceAddressShape(json: any): AiAddressOutput {
  const parsed = AddressOutputSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  console.warn("[AI][addr] OutputSchema validation failed:", parsed.error);
  return {
    is_address: false,
    raw: null,
    normalized: null,
    parts: {},
    confidence: 0,
    reason: "ai:not_address:invalid_json",
  };
}

// ─────────────────────────────────────────────
// Fallback: heuristic detector when AI is off
// ─────────────────────────────────────────────

function heuristicDetectAddress(text: string): AiAddressOutput {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();

  if (!raw) {
    return {
      is_address: false,
      raw: null,
      normalized: null,
      parts: {},
      confidence: 0,
      reason: "heuristic:not_address:empty",
    };
  }

  // Greeting only
  const greetingOnlyRegex =
    /^(hi|hello|hey|ok|okay|k|kk|thanks|thank you|gm|good morning|good night|good evening)[!. ]*$/i;
  const isGreetingOnly = greetingOnlyRegex.test(lower);
  if (isGreetingOnly) {
    return {
      is_address: false,
      raw,
      normalized: null,
      parts: {},
      confidence: 0.9,
      reason: "heuristic:not_address:greeting",
    };
  }

  // Very order-like: "2kg onion, 1L milk"
  const looksOrderLike =
    /\d/.test(lower) &&
    /kg|g|gram|ltr|liter|litre|ml|piece|pcs|pack|bottle|box|qty|quantity/i.test(
      lower
    ) &&
    raw.split(",").length <= 4; // short comma list with quantities

  if (looksOrderLike) {
    return {
      is_address: false,
      raw,
      normalized: null,
      parts: {},
      confidence: 0.7,
      reason: "heuristic:not_address:order_like",
    };
  }

  // Address-ish cues:
  const hasStreetWord = /\bstreet\b|\bst\b|\brd\b|\broad\b|\broad\b|\bavenue\b|\bave\b/i.test(
    lower
  );
  const hasBuildingWord =
    /\bflat\b|\bapt\b|\bapartment\b|\btower\b|\bbuilding\b|\bvilla\b|\bblock\b|\bfloor\b/i.test(
      lower
    );
  const hasLandmarkWord =
    /\bnear\b|\bopp\b|\bopposite\b|\bbehind\b|\blandmark\b/i.test(lower);
  const hasCityLikeWord =
    /\bdubai\b|\bsharjah\b|\babudhabi\b|\babu dhabi\b|\bchennai\b|\bcoimbatore\b|\bbangalore\b|\bdelhi\b|\bmumbai\b/i.test(
      lower
    );
  const hasPincodePattern = /\b\d{5,6}\b/.test(lower); // 5–6 digit code (PIN/postcode)
  const hasManyCommas = (raw.match(/,/g) || []).length >= 2;
  const isLongEnough = raw.length >= 20;

  const addressScore =
    (hasStreetWord ? 1 : 0) +
    (hasBuildingWord ? 1 : 0) +
    (hasLandmarkWord ? 1 : 0) +
    (hasCityLikeWord ? 1 : 0) +
    (hasPincodePattern ? 1 : 0) +
    (hasManyCommas ? 1 : 0);

  if (isLongEnough && addressScore >= 2) {
    // Very simple normalization: collapse whitespace
    const normalized = raw.replace(/\s+/g, " ").trim();

    return {
      is_address: true,
      raw,
      normalized,
      parts: {},
      confidence: 0.6 + Math.min(0.1 * addressScore, 0.3),
      reason: "heuristic:addr:detected",
    };
  }

  // Default: treat as not-address
  return {
    is_address: false,
    raw,
    normalized: null,
    parts: {},
    confidence: 0.3,
    reason: "heuristic:not_address:other",
  };
}

// ─────────────────────────────────────────────
// Raw model call
// ─────────────────────────────────────────────

async function callAddressModelRaw(input: string): Promise<string | null> {
  if (!openai) {
    console.warn("[AI][addr] OPENAI_API_KEY missing, using heuristic only");
    return null;
  }

  const model = getAddressModelName();

  try {
    const approxCost = estimateCostUSDApprox({
      prompt_tokens: Math.ceil(input.length / 4),
      completion_tokens: 0,
    });

    if (!canSpendMoreUSD(approxCost)) {
      console.warn("[AI][addr] budget guard blocked call", {
        approxCost,
        model,
      });
      return null;
    }
  } catch (e: any) {
    console.warn("[AI][addr] cost estimate failed", e?.message || e);
  }

  const userPrompt = buildUserPrompt(input);

  const start = Date.now();
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 220,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });
  const ms = Date.now() - start;

  const content = completion.choices[0]?.message?.content || "";
  console.log("[AI][addr] model used:", model, "latency_ms:", ms);

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
    console.warn("[AI][addr] addSpendUSD failed", e?.message || e);
  }

  return content || null;
}

// ─────────────────────────────────────────────
// PUBLIC: detectAddress
// ─────────────────────────────────────────────

export async function detectAddress(
  text: string,
  opts?: { org_id?: string; customer_phone?: string }
): Promise<AiAddressOutput> {
  const input = String(text || "").trim();

  if (!input) {
    return {
      is_address: false,
      raw: null,
      normalized: null,
      parts: {},
      confidence: 0,
      reason: "ai:not_address:empty",
    };
  }

  try {
    const raw = await callAddressModelRaw(input);

    // If AI is disabled or blocked → heuristic only
    if (!raw) {
      return heuristicDetectAddress(input);
    }

    const json = extractJsonObject(raw);
    const coerced = coerceAddressShape(json);

    // If AI forgot to set raw/normalized, patch best-effort
    if (!coerced.raw) {
      coerced.raw = input;
    }
    if (coerced.is_address && (!coerced.normalized || !coerced.normalized.trim())) {
      coerced.normalized = input.replace(/\s+/g, " ").trim();
    }

    // Log to Supabase (non-fatal)
    try {
      if (opts?.org_id) {
        await supa.from("ai_address_logs").insert({
          org_id: opts.org_id,
          customer_phone: opts.customer_phone || null,
          raw_text: input,
          ai_output: coerced,
          created_at: new Date().toISOString(),
        });
      }
    } catch (e: any) {
      console.warn("[AI][addr] log insert failed", e?.message || e);
    }

    return coerced;
  } catch (e: any) {
    console.error("[AI][addr] ERROR, falling back to heuristic:", e?.message || e);
    return heuristicDetectAddress(text);
  }
}

export default detectAddress;