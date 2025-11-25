// src/ai/cleanText.ts
import { supa } from "../db";

export type CleanForOrderResult = {
  cleanedText: string;
  removedTokens: string[];
  strategy: string; // e.g. "static", "dynamic", "none"
};

/**
 * Very lightweight semantic cleaner for ORDER-like text.
 *
 * Goals:
 *  - Strip slang / politeness at the edges: "bro", "da", "macha", "pls", etc.
 *  - Keep numbers, product words, and punctuation (for qty parsing).
 *  - Be SAFE: only touch the beginning & end of the message.
 *
 * Phase 1:
 *  - Use a static slang/polite dictionary.
 *  - Log what we remove (for future learning).
 *
 * Phase 2 (future):
 *  - Promote frequently-removed tokens to org-specific ignore list.
 *  - Use that list in addition to static words.
 */
export async function cleanForOrderPipeline(opts: {
  text: string;
  orgId?: string | null;
}): Promise<CleanForOrderResult> {
  const original = (opts.text || "").trim();
  const orgId = (opts.orgId || "").trim() || null;

  if (!original) {
    return { cleanedText: "", removedTokens: [], strategy: "empty" };
  }

  // ─────────────────────────────
  // 0) Basic emoji / control-char strip (keep punctuation, digits)
  // ─────────────────────────────
  let working = original.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27FF}]/gu,
    " "
  );
  working = working.replace(/[\u0000-\u001F\u007F]/g, " ");

  // We'll operate on token-level but keep punctuation tokens.
  const rawTokens = working.split(/\s+/).filter(Boolean);

  if (!rawTokens.length) {
    return { cleanedText: original, removedTokens: [], strategy: "none" };
  }

  // ─────────────────────────────
  // 1) Static slang / politeness dictionary
  //    (safe, language-agnostic-ish, and only applied at edges)
  // ─────────────────────────────
  const STATIC_SLANG = new Set([
    "bro",
    "bros",
    "broo",
    "brother",
    "macha",
    "machan",
    "maga",
    "dai",
    "da",
    "dei",
    "boss",
    "bhai",
    "bhaiya",
    "anna",
    "dude",
    "buddy",
    "yara",
    "mama",
    "bhava",
  ]);

  const STATIC_POLITE = new Set([
    "pls",
    "plz",
    "please",
    "kindly",
    "sir",
    "madam",
    "mam",
    "dear",
    "thanks",
    "thank",
    "thankyou",
    "ty",
    "sorry",
    "sry",
  ]);

  const GREETINGS = new Set([
    "hi",
    "hello",
    "hey",
    "hlo",
    "yo",
    "gm",
    "gn",
    "goodmorning",
    "goodnight",
    "goodafternoon",
    "goodevening",
  ]);

  const IGNORE_AT_START = new Set([
    ...STATIC_SLANG,
    ...STATIC_POLITE,
    ...GREETINGS,
  ]);

  const IGNORE_AT_END = new Set([...STATIC_SLANG, ...STATIC_POLITE]);

  const removedTokens: string[] = [];
  const tokens = [...rawTokens];

  const normalize = (t: string) =>
    t
      .toLowerCase()
      .replace(/[.,!?;:]+$/g, "")
      .trim();

  // Helper: how many "content" signals inside message?
  const hasQtyPattern = /\b\d+(\.\d+)?\b/.test(working);
  const hasAndOrCommaSplit =
    /,/.test(working) || /\band\b/i.test(working) || /\bor\b/i.test(working);

  // ─────────────────────────────
  // 2) Strip leading noise: "bro", "hey bro", "hello sir", etc.
  //    Only while:
  //      - token is in IGNORE_AT_START
  //      - AND there is still some content left
  // ─────────────────────────────
  while (tokens.length > 1) {
    const t0 = tokens[0];
    const n0 = normalize(t0);
    if (!n0) break;

    if (!IGNORE_AT_START.has(n0)) break;

    // Make sure we are not deleting the only "content"
    if (tokens.length <= 2 && !hasQtyPattern && !hasAndOrCommaSplit) break;

    removedTokens.push(t0);
    tokens.shift();
  }

  // ─────────────────────────────
  // 3) Strip trailing polite noise: "pls", "da", "bro", "thanks"
  // ─────────────────────────────
  while (tokens.length > 1) {
    const lastIdx = tokens.length - 1;
    const tLast = tokens[lastIdx];
    const nLast = normalize(tLast);
    if (!nLast) break;

    if (!IGNORE_AT_END.has(nLast)) break;

    removedTokens.push(tLast);
    tokens.pop();
  }

  // ─────────────────────────────
  // 4) Collapse extra spaces
  // ─────────────────────────────
  let cleaned = tokens.join(" ").replace(/\s+/g, " ").trim();
  if (!cleaned) cleaned = original; // safety

  const strategy = removedTokens.length ? "static_edge_trim" : "none";

  // ─────────────────────────────
  // 5) Phase 1 "learning" hook:
  //    - log removed tokens per org
  //    - later you can promote frequent ones into org-specific ignore list
  // ─────────────────────────────
  if (orgId && removedTokens.length) {
    try {
      const uniq = Array.from(
        new Set(
          removedTokens
            .map((t) => normalize(t))
            .filter((t) => !!t && t.length <= 12)
        )
      );

      if (uniq.length) {
        const now = new Date().toISOString();

        // Table suggestion:
        // create table cleaner_learned_tokens (
        //   org_id uuid not null,
        //   token  text not null,
        //   removal_count int not null default 0,
        //   last_seen_at timestamptz not null default now(),
        //   primary key (org_id, token)
        // );
        const rows = uniq.map((t) => ({
          org_id: orgId,
          token: t,
          removal_count: 1,
          last_seen_at: now,
        }));

        await supa
          .from("cleaner_learned_tokens")
          .upsert(rows, { onConflict: "org_id,token" });
      }
    } catch (e: any) {
      console.warn("[CLEANER][learn-log warn]", e?.message || e);
    }
  }

  if (strategy !== "none") {
    console.log("[CLEANER][order]", {
      orgId,
      original,
      cleaned,
      removedTokens,
      strategy,
    });
  }

  return {
    cleanedText: cleaned,
    removedTokens,
    strategy,
  };
}