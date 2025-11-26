// src/ai/rewriter.ts
import OpenAI from "openai";


const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

export async function rewriteForParser(opts: {
  orgId: string;
  phoneKey: string;
  text: string;
}) {
  const { orgId, phoneKey, text } = opts;

  // Fast path: if message is tiny, just return as-is
  if (!text || text.trim().length < 3) {
    return { text };
  }

  try {
    const prompt = `
You are a WhatsApp order text normalizer for food/grocery stores.

Convert the user message into a single, clean line suitable for an order parser.

Rules:
- Keep only items and quantities.
- Remove slang words (bro, macha, dude, please, etc.).
- Correct obvious spelling mistakes (briyani → biryani, panner → paneer).
- Use comma-separated items.
- Keep parenthetical preferences: "1 coke (cold)", "1 chicken biryani (spicy)".
- Do NOT invent items that are not implied.
- If the text is only a greeting or smalltalk, KEEP IT AS IS.

Examples:
User: "bro 1 palak panner n 1 chkn briyani"
You: "1 palak paneer, 1 chicken biryani"

User: "dude want 1 coke make it cold"
You: "1 coke (cold)"

User: "evrything spicy da machi"
You: "make all items spicy"

Now rewrite this EXACTLY once:

User: "${text}"
Clean:
    `.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini", // or whatever you use
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });

    const raw = completion.choices[0]?.message?.content || text;
    const clean = raw.replace(/^Clean:\s*/i, "").trim();

    return { text: clean || text };
  } catch (e) {
    console.warn("[AI-REWRITER][ERR]", (e as any)?.message || e);
    return { text }; // fail-soft → use original
  }
}