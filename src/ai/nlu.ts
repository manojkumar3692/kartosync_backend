// src/ai/nlu.ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ─────────────────────────────
// INTENT TYPES
// ─────────────────────────────
export type NLUIntent =
  | "order"
  | "price_inquiry"
  | "availability_inquiry"
  | "menu_inquiry"
  | "greeting"
  | "complaint"
  | "smalltalk"
  | "other";

export type NLUResult = {
  intent: NLUIntent;
  confidence: number;
  canonical?: string | null;   // optional normalized product/item
};

// ─────────────────────────────
// HELPERS
// ─────────────────────────────

// Extract a simple noun-phrase for "chicken biryani", "milk", "rice 1kg"
function extractCanonical(text: string): string | null {
  const t = text.toLowerCase();

  // common patterns for extracting product names from inquiries
  const patterns = [
    /(?:do you have|do u have|have|available|availability of|price of|rate of)\s+([\w\s\-]+)/i,
    /(?:how much is|how much for|price for)\s+([\w\s\-]+)/i,
    /(?:is|do you have)\s+([\w\s\-]+)\s+available/i,
    /([\w\s\-]+)\s+price/i,
    /([\w\s\-]+)\s+available/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const out = m[1].trim();
      if (out && out.length >= 2) return out;
    }
  }

  // fallback: single most meaningful noun-like term
  const fallback = text.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  if (fallback.split(" ").length <= 4) return fallback;

  return null;
}

// ─────────────────────────────
// CLASSIFIER
// ─────────────────────────────
export async function classifyMessage(text: string): Promise<NLUResult> {
  const prompt = `
You are an NLU classifier. Classify the user's message into ONE intent.

INTENTS:
- order → user wants to place an order / mentions qty or items
- price_inquiry → asking price ("rate?", "how much?", "price?")
- availability_inquiry → "do you have X", "is biryani available"
- menu_inquiry → "send menu", "what items do you have"
- greeting → hi, hello, vanakkam
- complaint → delay, missing item, cold food, bad service
- smalltalk → unrelated chit chat
- other → anything else

Return ONLY strict JSON:
{ "intent": "...", "confidence": 0.0 }

User message: "${text}"
`;

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 50
    });

    const raw = resp.choices[0].message?.content || "{}";

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { intent: "other", confidence: 0.0 };
    }

    // Canonical extraction (only for relevant intents)
    let canonical: string | null = null;

    if (
      parsed.intent === "price_inquiry" ||
      parsed.intent === "availability_inquiry" ||
      parsed.intent === "order"
    ) {
      canonical = extractCanonical(text);
    }

    return {
      intent: parsed.intent as NLUIntent,
      confidence: Number(parsed.confidence) || 0,
      canonical: canonical || null,
    };
  } catch (e) {
    console.error("[NLU] error", e);
    return { intent: "other", confidence: 0.0, canonical: null };
  }
}