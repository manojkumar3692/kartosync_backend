// src/ai/ingest/metaIntent.ts

export type MetaIntent =
  | "reset"
  | "help"
  | "menu"
  | "agent"
  | "greeting"
  | "back"
  | null;

// Basic phrase map (later can come from DB)
const map = {
  reset: ["back", "go back", "reset", "cancel", "start again", "new order"],
  help: ["help", "how to", "how to order"],
  menu: ["menu", "show menu", "list items"],
  agent: ["agent", "human", "support", "talk to human", "talk to agent"],
  greeting: ["hi", "hello", "hey", "good morning", "good evening"],
} as const;

const GREETING_STOP_TOKENS = [
  "hi",
  "hello",
  "hey",
  "good",
  "morning",
  "evening",
  "afternoon",
];

const GREETING_PHRASES = map.greeting;

/**
 * Only treat as greeting if the message is basically JUST a greeting
 * (maybe with light decoration), not "hi bro give me biryani".
 */
function isPureGreeting(msg: string): boolean {
  const cleaned = msg
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "") // strip emojis
    .replace(/[!.,?]+/g, " ")
    .trim();

  if (!cleaned) return false;

  // 1) Exact match any greeting phrase
  if (GREETING_PHRASES.some((g) => cleaned === g)) {
    return true;
  }

  // 2) Very short greeting-like messages (<= 2–3 tokens), all tokens greeting-y
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length <= 3) {
    const allGreetingish = tokens.every((t) =>
      GREETING_STOP_TOKENS.includes(t)
    );
    if (allGreetingish) return true;
  }

  // 3) Things like "hi bro", "hi team", "hello sir" – 2 tokens max, starts with greeting
  if (tokens.length === 2 && GREETING_STOP_TOKENS.includes(tokens[0])) {
    return true;
  }

  // Anything longer / with other content → not pure greeting
  return false;
}

export function detectMetaIntent(raw: string): MetaIntent {
  const msg = raw.toLowerCase().trim();

  // 1) First check reset/help/menu/agent with simple includes
  for (const intent of Object.keys(map) as (keyof typeof map)[]) {
    if (intent === "greeting") continue; // handle greeting separately

    const phrases = map[intent];
    for (const w of phrases) {
      if (msg.includes(w)) {
        return intent as MetaIntent;
      }
    }
  }

  // 2) Greeting should ONLY trigger if the whole message is basically a greeting
  if (isPureGreeting(msg)) {
    return "greeting";
  }

  // 3) Otherwise → no meta-intent
  return null;
}