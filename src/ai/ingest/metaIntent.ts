// src/ai/ingest/metaIntent.ts

export type MetaIntent =
  | "reset"
  | "help"
  | "menu"
  | "agent"
  | "greeting"
  | null;

// Basic phrase map (later can come from DB)
const map = {
  reset: ["back", "go back", "reset", "cancel", "start again", "new order"],
  help: ["help", "how to", "how to order"],
  menu: ["menu", "show menu", "list items"],
  agent: ["agent", "human", "support", "talk to human", "talk to agent"],
  greeting: ["hi", "hello", "hey", "good morning", "good evening"],
};

export function detectMetaIntent(raw: string): MetaIntent {
  const msg = raw.toLowerCase().trim();

  for (const intent of Object.keys(map)) {
    const ph = (map as any)[intent];
    for (const w of ph) {
      if (msg.includes(w)) return intent as MetaIntent;
    }
  }

  return null;
}