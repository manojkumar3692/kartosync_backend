// src/ai/tone.ts

export type Tone = "casual" | "neutral" | "formal";

/**
 * Decide tone for this org.
 *
 * You can later store in DB as:
 *   orgs.reply_tone = 'casual' | 'neutral' | 'formal'
 * or in a JSON column org.settings.reply_tone.
 *
 * For now, if nothing is set → defaults to 'casual'.
 */
export function getToneFromOrg(org: any): Tone {
  try {
    const raw =
      (org?.reply_tone ??
        org?.tone ??
        (org?.settings && (org.settings.reply_tone || org.settings.tone))) ?? "";

    const s = String(raw).toLowerCase().trim();
    if (s === "formal" || s === "neutral" || s === "casual") {
      return s;
    }
  } catch {
    // ignore, fall through to default
  }
  return "casual";
}

export function makeGreeting(tone: Tone): string {
  switch (tone) {
    case "formal":
      return "Good day. How may I assist you with your order?";
    case "neutral":
      return "Hello, how can I help you today?";
    case "casual":
    default:
      return "Hi 👋 How can I help you today?";
  }
}

export function makeGenericQuestionAck(tone: Tone): string {
  switch (tone) {
    case "formal":
      return "💬 I’ve noted your question. We’ll check and update you shortly.";
    case "neutral":
      return "💬 Got your question. We’ll check and reply shortly.";
    case "casual":
    default:
      return "💬 Got your question. We’ll check and reply in a moment.";
  }
}