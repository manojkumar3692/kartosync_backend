// src/ai/lang/detectTranslate.ts
import OpenAI from "openai";
import { logAiUsageForCall } from "../cost";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Reuse your global model if you want, or keep this default:
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";

export type DetectTranslateResult = {
  detected_lang: string | null;   // e.g. "ta", "hi", "en"
  translated_text: string;        // always some English text (fallback = original)
};

/**
 * Detect main language of input and translate to neutral English.
 * Safe with older OpenAI SDKs (no Responses API / response_format).
 */
export async function detectAndTranslate(
  text: string
): Promise<DetectTranslateResult> {
  const input = (text || "").trim();
  if (!input) {
    return { detected_lang: null, translated_text: "" };
  }

  try {
    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            'You are a language utility. Detect the main language of the user input and translate it to clear, neutral English, preserving the meaning. Respond ONLY with minified JSON like {"lang":"ta","en":"..."} and nothing else.',
        },
        {
          role: "user",
          content: input,
        },
      ],
    });


     // ✅ Log usage (counts toward ai_daily_spend + ai_usage_log)
     try {
      await logAiUsageForCall({
        orgId: null, // or pass an org id if you wire it in later
        usage: completion.usage,
        model: completion.model || AI_MODEL,
        raw: {
          source: "detectAndTranslate",
          text_len: input.length,
          response_id: completion.id,
        },
      });
    } catch (e: any) {
      console.warn(
        "[lang] detectAndTranslate usage log failed",
        e?.message || e
      );
    }

    const messageContent:any = completion.choices[0]?.message?.content;

    let raw = "";
    if (typeof messageContent === "string") {
      raw = messageContent;
    } else if (Array.isArray(messageContent)) {
      // In some SDKs message.content can be a structured array
      raw = messageContent
        .map((part: any) =>
          typeof part === "string"
            ? part
            : part?.text ?? part?.content ?? ""
        )
        .join("");
    }

    // Try to parse JSON (handle ```json fences if model adds them)
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const cleaned = raw
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      parsed = JSON.parse(cleaned);
    }

    const detected =
      parsed && typeof parsed.lang === "string" ? parsed.lang : null;

    const translated =
      parsed &&
      typeof parsed.en === "string" &&
      parsed.en.trim().length > 0
        ? parsed.en
        : input;

    return {
      detected_lang: detected,
      translated_text: translated,
    };
  } catch (e: any) {
    console.warn(
      "[lang] detectAndTranslate error, falling back to raw",
      e?.message || e
    );
    return { detected_lang: null, translated_text: input };
  }
}