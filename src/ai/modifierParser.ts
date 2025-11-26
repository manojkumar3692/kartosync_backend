// src/ai/modifierParser.ts
import OpenAI from "openai";
import { ModifierPayload } from "../types";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type ParsedModifier = ModifierPayload;

export type ModifierParseResult = {
  modifier: ModifierPayload | null;
  confidence: number; // 0–1
};


export async function parseModifier(text: string): Promise<ModifierParseResult> {
  const trimmed = String(text || "").trim();

  if (!trimmed || !process.env.OPENAI_API_KEY) {
    return { modifier: null, confidence: 0 };
  }

  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const res = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are an assistant that converts free-text WhatsApp order CHANGE messages into a structured JSON modifier payload.",
          "The user message is always about changing an EXISTING order already in the system.",
          "",
          "You MUST respond with a single JSON object only, no extra text.",
          "",
          "JSON shape:",
          "{",
          '  "modifier": {',
          '    "target": {',
          '      "type": "item",',
          '      "text": string,',
          '      "canonical": string | null',
          "    },",
          '    "scope": "one" | "all" | "ambiguous",',
          '    "change": {',
          '      "type": "variant" | "qty" | "remove" | "note",',
          '      "new_variant": string | null,',
          '      "new_qty": number | null,',
          '      "delta_qty": number | null,',
          '      "note": string | null',
          "    }",
          "  },",
          '  "confidence": number (0.0 - 1.0)',
          "}",
          "",
          "Rules:",
          "- If the message is NOT a clear change to an existing order, return:",
          '  { \"modifier\": null, \"confidence\": 0 }',
          "- 'make biryani spicy' → change.type='variant', new_variant='spicy'",
          "- 'make coke 2' → change.type='qty', new_qty=2",
          "- 'add one more coke' → change.type='qty', delta_qty=1",
          "- 'remove coke' → change.type='remove'",
          "- 'no onion in biryani' → change.type='note', note='no onion'",
          "",
          "For target.text, always echo the item phrase the user used ('biryani', 'chicken biriyani', 'everything', etc).",
          "canonical can be a cleaned name like 'chicken biryani' BUT if unsure, set canonical = null.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Message: "${trimmed}"`,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content || "{}";

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { modifier: null, confidence: 0 };
  }

  const modifier = parsed?.modifier ?? null;
  let confidence = Number(parsed?.confidence ?? 0);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  // Basic sanity: must have target + change.type
  if (
    !modifier ||
    !modifier.target ||
    !modifier.change ||
    !modifier.change.type
  ) {
    return { modifier: null, confidence: 0 };
  }

  return { modifier, confidence };
}