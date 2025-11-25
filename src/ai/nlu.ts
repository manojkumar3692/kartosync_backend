// src/ai/nlu.ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ─────────────────────────────
// INTENT TYPES
// ─────────────────────────────
export type NLUIntent =
  | "order"
  | "other"
  | "order_correction"
  | "modifier"
  | "address_update"
  | "cancel_request"
  | "greeting"
  | "smalltalk"
  | "complaint"
  | "price_inquiry"
  | "availability_inquiry"
  | "menu_inquiry";

export type NLUResult = {
  intent: NLUIntent;
  confidence: number;
  canonical?: string | null;
};

// ─────────────────────────────
// HELPERS
// ─────────────────────────────

// Extract a simple noun-phrase for "chicken biryani", "milk", "rice 1kg"
function extractCanonical(text: string): string | null {
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

  // fallback: keep short phrases only
  const fallback = text.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  if (fallback && fallback.split(" ").length <= 4) return fallback;

  return null;
}

// ─────────────────────────────
// CLASSIFIER
// ─────────────────────────────
export async function classifyMessage(text: string): Promise<NLUResult> {
  const trimmed = String(text || "").trim();

  const prompt = `
You are an NLU classifier for WhatsApp order chats. 
Choose EXACTLY ONE intent from this list:

- order
  → user is placing an order, adding items, or clearly listing items/qty.
- order_correction
  → user is changing an EXISTING order: "make biryani spicy", "remove coke",
    "change coke to sprite", "make quantity 2 instead of 1".
- modifier
  → same as order_correction; you may use either, but PREFER "order_correction"
    for clear change messages.
- address_update
  → user is giving or changing address, location, flat number, landmark,
    Google map link, pin location, etc.
- cancel_request
  → user wants to cancel an existing order: "cancel my order", "no need",
    "don't send", "stop the order".
- price_inquiry
  → asking about price or rate: "rate?", "how much?", "price of chicken biryani".
- availability_inquiry
  → asking if something is available / in stock: "do you have biryani?",
    "is mutton available today", "any biriyani today".
- menu_inquiry
  → asking for menu / list of items: "send menu", "what do you have",
    "share today specials".
- greeting
  → "hi", "hello", "vanakkam", "good morning" without any clear order or inquiry.
- complaint
  → complaining about delay, missing item, cold food, wrong item, bad service, etc.
- smalltalk
  → random chit-chat, jokes, personal talk, not about order/business.
- other
  → anything that does not clearly fit above categories.

Return ONLY strict JSON:
{ "intent": "<one_of_the_above>", "confidence": 0.0 }

User message: "${trimmed}"
`;

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 80,
      response_format: { type: "json_object" },
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
    const intent = parsed.intent as NLUIntent;

    if (
      intent === "price_inquiry" ||
      intent === "availability_inquiry" ||
      intent === "order"
    ) {
      canonical = extractCanonical(text);
    }

    return {
      intent,
      confidence: Number(parsed.confidence) || 0,
      canonical: canonical || null,
    };
  } catch (e) {
    console.error("[NLU] error", e);
    return { intent: "other", confidence: 0.0, canonical: null };
  }
}