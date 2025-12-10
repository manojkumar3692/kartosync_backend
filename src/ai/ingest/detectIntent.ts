// src/ai/ingest/detectIntent.ts

import { ConversationState } from "./types";

// -------------------------------------------------------
// Keywords (deterministic, multilingual-safe)
// -------------------------------------------------------

const GREETING_WORDS = [
  "hi",
  "hello",
  "hey",
  "yo",
  "hola",
  "vanakkam",
  "namaste",
  "gm",
  "good morning",
  "good afternoon",
  "good evening",
];

const GREETING_FILLERS = [
  "bro",
  "dear",
  "sir",
  "team",
  "anna",
  "machi",
];

const SMALLTALK_WORDS = [
  "ok",
  "okay",
  "k",
  "kk",
  "thanks",
  "thank you",
  "tnx",
  "thx",
  "super",
  "nice",
];

const PRICE_WORDS = ["price", "rate", "how much", "cost"];
const AVAIL_WORDS = ["available", "availability", "do you have", "stock"];
const ADDRESS_WORDS = ["address", "location is", "my address", "deliver to"];
const PAYMENT_WORDS = ["cash", "card", "upi", "pay online", "payment"];
const AGENT_WORDS = ["agent", "human", "support", "help", "customer care"];
const STATUS_WORDS = ["status", "where is my order", "order status", "track"];
const CANCEL_WORDS = ["cancel", "stop order", "dont want", "don't want"];

// -------------------------------------------------------
// MAIN FUNCTION
// -------------------------------------------------------
export function detectIntent(text: string, state: ConversationState): string {
  const msg = text.toLowerCase().trim();

  // -------------------------------------------------------
  // 🔥 HIGHEST PRIORITY:
  // If waiting for address → force address intent
  // -------------------------------------------------------
  if (state === "awaiting_address") {
    console.log("[INTENT][HIT] awaiting_address → address");
    return "address";
  }

  // -------------------------------------------------------
  // 0) Agent mode override
  // -------------------------------------------------------
  // if (state === "agent") return "agent";

  // -------------------------------------------------------
  // 1) Greeting  (only if message is basically just a greeting)
  // -------------------------------------------------------
  const tokens = msg.split(/\s+/).filter(Boolean);

  const isPureGreeting =
    // exact match with a greeting
    GREETING_WORDS.some((w) => msg === w) ||
    // short messages (<= 3 tokens) like "hi", "hi bro", "hello sir"
    (
      tokens.length > 0 &&
      tokens.length <= 3 &&
      GREETING_WORDS.includes(tokens[0]) &&
      tokens.slice(1).every((t) => GREETING_FILLERS.includes(t))
    );

  if (isPureGreeting) {
    console.log("[INTENT][HIT] greeting", { msg, state });
    return "greeting";
  }

  // -------------------------------------------------------
  // 2) Small talk
  // -------------------------------------------------------
  if (SMALLTALK_WORDS.some((w) => msg === w)) {
    return "smalltalk";
  }

  // -------------------------------------------------------
  // 3) Cancel intent
  // -------------------------------------------------------
  if (CANCEL_WORDS.some((k) => msg.includes(k))) {
    return "cancel";
  }

  // -------------------------------------------------------
  // 4) Agent / Support
  // -------------------------------------------------------
  if (AGENT_WORDS.some((k) => msg.includes(k))) {
    return "agent";
  }

  // -------------------------------------------------------
  // 5) Order status
  // -------------------------------------------------------
  if (STATUS_WORDS.some((k) => msg.includes(k))) {
    return "status";
  }

  // -------------------------------------------------------
  // 6) Address detection (strong rules)
  // -------------------------------------------------------
  if (
    ADDRESS_WORDS.some((k) => msg.includes(k)) ||
    // common address patterns:
    msg.startsWith("flat") ||
    msg.startsWith("villa") ||
    msg.startsWith("apt") ||
    msg.startsWith("no.") ||
    msg.match(/\d+[\/\-]?\d*\s+[a-z]/i) || // "12/3 Ragav street", "13A Ramaswamy st"
    msg.includes("street") ||
    msg.includes("st ") ||
    msg.includes("road") ||
    msg.includes("rd ") ||
    msg.includes("area") ||
    msg.includes("layout") ||
    msg.includes("nagar") ||
    msg.includes("colony")
  ) {
    return "address";
  }

  // -------------------------------------------------------
  // 7) Payment
  // -------------------------------------------------------
  if (PAYMENT_WORDS.some((k) => msg.includes(k))) {
    return "payment";
  }

  // -------------------------------------------------------
  // 8) Pricing
  // -------------------------------------------------------
  if (PRICE_WORDS.some((k) => msg.includes(k))) {
    return "price";
  }

  // -------------------------------------------------------
  // 9) Availability
  // -------------------------------------------------------
  if (AVAIL_WORDS.some((k) => msg.includes(k))) {
    return "availability";
  }

  // -------------------------------------------------------
  // 10) Default → ORDER
  // -------------------------------------------------------
  return "order";
}