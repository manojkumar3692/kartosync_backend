// src/routes/waba.ts
import express from "express";
import axios from "axios";
import { supa } from "../db";
import { ingestCoreFromMessage } from "./ingestCore";
import { getLatestPrice } from "../util/products";
import {
  startAddressSessionForOrder,
  formatOrderSummary,
  itemsToOrderText,
  normalizePhoneForKey,
  UserCommand,
  hasAddressForOrder,
  findAmbiguousItemsForOrder,
  buildClarifyQuestionText,
  lastCommandByPhone,
  maybeHandleClarifyReply,
  learnAliasFromInquiry,
  isAutoReplyEnabledForCustomer,
  looksLikeAddToExisting,
  findActiveOrderForPhone,
  findActiveOrderForPhoneExcluding,
  logInboundMessageToInbox,
  findAllActiveOrdersForPhone,
} from "../routes/waba/clarifyAddress";
import {
  getToneFromOrg,
  makeGreeting,
  makeGenericQuestionAck,
} from "../ai/tone";
import {
  getConversationState,
  setConversationStage,
  clearConversationStage,
  type ConversationStage,
} from "../util/conversationState";
import {
  normalizeBusinessType,
  orgNeedsDeliveryAddress,
} from "../routes/waba/business";
import {
  normalizeProductText,
  extractCatalogUnmatched,
  extractCatalogUnmatchedOnly,
  findProductOptionsForText,
  formatPriceLine,
  prettyLabelFromText,
  extractMenuKeywords,
  buildMenuReply,
} from "../routes/waba/productInquiry";
import { interpretMessage } from "../ai/interpreter";
import { saveAiInsight } from "../routes/waba/aiInsights";
import { resolveActiveOrderIdForCustomer } from "../session/sessionEngine";
import { resolveAliasForText } from "../routes/waba/aliasEngine";
// at the top of waba.ts
import { normalizeLabelForFuzzy, fuzzyCharOverlapScore } from "../util/fuzzy";

export const waba = express.Router();
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
const META_WA_BASE = "https://graph.facebook.com/v21.0";
waba.all("/ping", (_req, res) => res.json({ ok: true, where: "waba" }));
// Simple hit logger so you can confirm mount path
waba.use((req, _res, next) => {
  wabaDebug("[WABA][ROUTER HIT]", req.method, req.path);
  next();
});

// Very simple in-memory dedupe for msg IDs (WABA)
const seenMsgIds = new Set<string>();
const MAX_SEEN_MSG_IDS = 5000; // avoid unbounded growth

console.log("VERSION 18AAAA --------");

// ─────────────────────────────
// 1) Webhook verification (GET)
// ─────────────────────────────
waba.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[WABA][VERIFY]", {
    mode,
    token_ok: token === META_VERIFY_TOKEN,
  });

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("[WABA] webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("[WABA] webhook verify failed");
  return res.sendStatus(403);
});

const WABA_DEBUG = process.env.WABA_DEBUG === "1";

function wabaDebug(...args: any[]) {
  if (!WABA_DEBUG) return;
  console.log("[WABA-DEBUG]", ...args);
}
// ─────────────────────────────
// Helper: product options + prices for a text
// ─────────────────────────────
type ProductPriceOption = {
  productId: string;
  name: string;
  variant: string | null;
  unit: string;
  price: number | null;
  currency: string | null;
};
type ProductOptionsResult = {
  best: {
    id: string;
    display_name: string;
    canonical?: string | null;
    base_unit?: string | null;
  };
  options: ProductPriceOption[];
};

// ─────────────────────────────
// Fuzzy helpers for spelling / alias suggestions
// ─────────────────────────────

// Normalize text for fuzzy comparison (lowercase, remove spaces/punctuation)
// function normalizeLabelForFuzzy(raw: string): string {
//   return String(raw || "")
//     .toLowerCase()
//     .normalize("NFKD")
//     .replace(/[\u0300-\u036f]/g, "") // strip accents
//     .replace(/[^a-z0-9]+/g, "") // keep only a-z0-9
//     .trim();
// }

// Very simple similarity: how many chars overlap vs max length
// function fuzzyCharOverlapScore(a: string, b: string): number {
//   const s1 = normalizeLabelForFuzzy(a);
//   const s2 = normalizeLabelForFuzzy(b);
//   if (!s1 || !s2) return 0;

//   const set1 = new Set(s1.split(""));
//   let matches = 0;
//   for (const ch of s2) {
//     if (set1.has(ch)) matches++;
//   }
//   const maxLen = Math.max(s1.length, s2.length);
//   if (!maxLen) return 0;
//   return matches / maxLen; // 0 → no overlap, 1 → perfect
// }

// Look up close product names for a misspelled label
async function findFuzzyProductSuggestions(opts: {
  org_id: string;
  rawLabel: string;
  customer_phone?: string;
  limit?: number;
}): Promise<{ id: string; name: string; score: number }[]> {
  const { org_id, rawLabel } = opts;
  const limit = opts.limit ?? 3;

  const labelNorm = normalizeLabelForFuzzy(rawLabel);
  if (!labelNorm || labelNorm.length < 3) return [];

  // 0️⃣ First try alias memory (customer → org/global)
  try {
    const aliasHit = await resolveAliasForText({
      org_id,
      customer_phone: opts.customer_phone,
      wrong_text: rawLabel,
    });

    if (aliasHit && aliasHit.canonical_product_id) {
      // Load that exact product and return as a "perfect" suggestion
      const { data: prod, error: prodErr } = await supa
        .from("products")
        .select("id, display_name, canonical")
        .eq("org_id", org_id)
        .eq("id", aliasHit.canonical_product_id)
        .maybeSingle();

      if (!prodErr && prod && prod.id) {
        const name = String(prod.display_name || prod.canonical || "").trim();
        if (name) {
          return [
            {
              id: prod.id as string,
              name,
              score: 1.0, // treat as perfect match
            },
          ];
        }
      }
    }
  } catch (e: any) {
    console.warn("[WABA][alias suggestions err]", e?.message || e);
  }

  // 1️⃣ Fallback to your existing fuzzy catalogue scan
  try {
    const { data, error } = await supa
      .from("products")
      .select("id, display_name, canonical")
      .eq("org_id", org_id)
      .limit(200); // keep it small; we only need top few

    if (error || !data || !data.length) return [];

    const scored = data
      .map((p: any) => {
        const name = String(p.display_name || p.canonical || "").trim();
        if (!name) return null;

        const score = fuzzyCharOverlapScore(rawLabel, name);
        return { id: p.id as string, name, score };
      })
      .filter((x: any) => x && x.score >= 0.4)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit);

    return scored as { id: string; name: string; score: number }[];
  } catch (e: any) {
    console.warn("[WABA][fuzzy suggestions err]", e?.message || e);
    return [];
  }
}

// ─────────────────────────────
// Helper: smart reply for price / availability inquiries
// ─────────────────────────────

async function buildSmartInquiryReply(opts: {
  org_id: string;
  text: string;
  inquiryType?: string | null;
}) {
  const { org_id, text } = opts;
  const inquiryType = (opts.inquiryType || "").toLowerCase() || null;

  // 1) Try to resolve product + variants + prices
  let optionsResult: ProductOptionsResult | null = null;
  try {
    optionsResult = await findProductOptionsForText(org_id, text);
  } catch (e: any) {
    console.warn("[WABA][buildSmartInquiryReply options err]", e?.message || e);
  }

  // NEW LAYER-5: family-level match (biryani → chicken/mutton/egg biryani)
  try {
    if (!optionsResult) {
      const raw = normalizeProductText(text).trim();
      // extract meaningful keywords
      const words = raw.split(/\s+/).filter(Boolean);
      const stop = new Set([
        "do",
        "you",
        "have",
        "any",
        "is",
        "there",
        "a",
        "the",
        "price",
        "rate",
        "list",
        "please",
        "pls",
        "kindly",
        "today",
        "what",
        "whats",
        "tell",
        "me",
        "my",
        "your",
        "much",
        "how",
        "available",
        "availability",
        "stock",
        "send",
        "show",
        "give",
        "need",
        "want",
        "can",
        "could",
        "this",
        "that",
      ]);

      const kws = words.filter((w) => !stop.has(w) && w.length >= 3);
      if (kws.length) {
        // fetch richer product info so we can show prices if needed
        const { data: all } = await supa
          .from("products")
          .select(
            "id, canonical, display_name, variant, base_unit, price_per_unit"
          )
          .eq("org_id", org_id);

        if (all && all.length) {
          // family hits: any product whose name contains one of the keywords
          const familyHits = all.filter((p) => {
            const name = String(
              p.display_name || p.canonical || ""
            ).toLowerCase();
            return kws.some((kw) => name.includes(kw));
          });

          if (familyHits.length >= 2) {
            // If this is a PRICE inquiry, try to show a small price menu
            if (inquiryType === "price") {
              const MAX_ITEMS = 10;
              const options: ProductPriceOption[] = [];

              for (const row of familyHits.slice(0, MAX_ITEMS)) {
                const id = row.id;
                if (!id) continue;

                const latest = await getLatestPrice(org_id, id).catch(
                  (e: any) => {
                    console.warn(
                      "[WABA][family_price latest err]",
                      e?.message || e
                    );
                    return null;
                  }
                );

                const price =
                  latest && typeof latest.price === "number"
                    ? latest.price
                    : typeof row.price_per_unit === "number"
                    ? row.price_per_unit
                    : null;

                const currency = latest ? latest.currency : null;

                options.push({
                  productId: id,
                  name: row.display_name || row.canonical || "item",
                  variant: row.variant
                    ? String(row.variant).trim() || null
                    : null,
                  unit: row.base_unit || "unit",
                  price,
                  currency,
                });
              }

              if (options.length) {
                const lines = options.map((opt, idx) => {
                  const num = idx + 1;
                  const line = formatPriceLine(opt);
                  return `${num}) ${line}`;
                });

                const kwLabel = kws.length === 1 ? ` for ${kws[0]}` : "";

                return (
                  `💸 Here are the prices${kwLabel}:\n` +
                  lines.join("\n") +
                  "\n\nTo order, reply with the item and quantity."
                );
              }

              // no price data → fall back to just listing variants
              const names = Array.from(
                new Set(
                  familyHits.map((p) =>
                    p.variant
                      ? `${p.display_name || p.canonical} ${p.variant}`.trim()
                      : p.display_name || p.canonical
                  )
                )
              ).filter(Boolean);

              if (names.length >= 2) {
                return (
                  "We have these options:\n" +
                  names.map((n, i) => `${i + 1}) ${n}`).join("\n") +
                  "\n\nPrices change often — we’ll confirm the exact price for the one you choose."
                );
              }

              // let normal fallback handle if nothing useful
            } else {
              // AVAILABILITY / GENERIC inquiry → same behaviour as Patch 1
              const names = Array.from(
                new Set(
                  familyHits.map((p) =>
                    p.variant
                      ? `${p.display_name || p.canonical} ${p.variant}`.trim()
                      : p.display_name || p.canonical
                  )
                )
              ).filter(Boolean);

              if (names.length >= 2) {
                return (
                  "Here are the options we have:\n" +
                  names.map((n, i) => `${i + 1}) ${n}`).join("\n") +
                  "\n\nWhich one would you like?"
                );
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[WABA][family_match_err]", e);
  }

  // FINAL fallback when we still couldn't map to any product
  if (!optionsResult) {
    try {
      // Try to show a few example items so user can be more specific
      const { data, error } = await supa
        .from("products")
        .select("display_name, canonical")
        .eq("org_id", org_id)
        .limit(5);

      const names =
        !error && data
          ? Array.from(
              new Set(
                data
                  .map((p: any) =>
                    String(p.display_name || p.canonical || "").trim()
                  )
                  .filter(Boolean)
              )
            )
          : [];

      const exampleLines =
        names.length > 0
          ? "\n\nFor example, you can type:\n" +
            names
              .slice(0, 3)
              .map((n) => `• ${n} 1kg`)
              .join("\n")
          : "";

      if (inquiryType === "price") {
        return (
          "💬 I got that you’re asking for a *price*, but I’m not sure which item.\n" +
          "Please mention the exact item name and quantity in one line." +
          exampleLines
        );
      }

      if (inquiryType === "availability") {
        return (
          "💬 I got that you’re asking about *availability*, but I’m not sure which item.\n" +
          "Please mention the exact item name." +
          exampleLines
        );
      }

      // Generic inquiry with no clear type
      return (
        "💬 I’m not fully sure which item you mean.\n" +
        "Please type the exact item name and quantity in one message (e.g. “2kg onion, 1L milk”)." +
        exampleLines
      );
    } catch (e: any) {
      console.warn("[WABA][inquiry final fallback err]", e?.message || e);

      // If Supabase fails, keep the old safe behaviour
      if (inquiryType === "price") {
        return "💬 Got your price question. We’ll confirm the exact price shortly.";
      }
      if (inquiryType === "availability") {
        return "💬 Got your availability question. We’ll confirm stock shortly.";
      }
      return null;
    }
  }

  const { best, options } = optionsResult;

  // 2) PRICE inquiry
  if (inquiryType === "price") {
    const priced = options.filter((o) => o.price != null);

    // 2a) Multiple variants with prices → show menu
    if (priced.length >= 2) {
      const lines = priced.map((opt, idx) => {
        const line = formatPriceLine(opt);
        const num = idx + 1;
        return `${num}\uFE0F\u20E3 ${line}`; // 1️⃣, 2️⃣, ...
      });

      const title =
        `We have a few options for ${best.display_name}:\n` +
        lines.join("\n") +
        "\n\nTo order, reply with the option number and quantity.\n";

      return title;
    }

    // 2b) Single option with price
    if (priced.length === 1) {
      const line = formatPriceLine(priced[0]);
      return `💸 ${line}\n\nWould you like to place the order?`;
    }

    // 2c) No price data but products exist
    if (options.length > 0) {
      // Show variants names, but admit price is changing
      const variantNames = options.map((o) =>
        o.variant ? `${o.name} ${o.variant}`.trim() : o.name
      );
      const unique = Array.from(new Set(variantNames)).filter(Boolean);

      if (unique.length >= 2) {
        return (
          `We do have ${best.display_name} in multiple options:\n` +
          unique.map((v, idx) => `${idx + 1}) ${v}`).join("\n") +
          "\n\n💸 Today’s prices change often — we’ll confirm the exact price now."
        );
      }

      return (
        `💸 We do have ${best.display_name}. ` +
        "Today’s price changes often — we’ll confirm it for you now."
      );
    }

    // Last fallback if somehow no options
    return (
      `💸 We do have ${best.display_name}. ` +
      "Today’s price changes often — we’ll confirm it for you now."
    );
  }

  // 3) AVAILABILITY inquiry
  if (inquiryType === "availability") {
    const names = Array.from(
      new Set(
        options.map((o) =>
          o.variant ? `${o.name} ${o.variant}`.trim() : o.name
        )
      )
    ).filter(Boolean);

    // Use same keyword extractor as menu logic
    const keywords = extractMenuKeywords(text);
    const lowerNames = names.map((n) => n.toLowerCase());

    const hasOverlap = keywords.some((kw) =>
      lowerNames.some((name) => name.includes(kw))
    );
    const missingKeywords = keywords.filter(
      (kw) => !lowerNames.some((name) => name.includes(kw))
    );

    const requestedLabel = prettyLabelFromText(text);
// 🧠 Partial match case:
// Example: user -> "panner biriyani"
// Catalog -> only "Mutton Biryani", "Chicken Biryani"
// → we matched "biryani" but not "panner" → don't lie,
//   but show ALL related biryani variants from DB.
if (
    names.length > 0 &&
    keywords.length > 0 &&
    hasOverlap &&
    missingKeywords.length > 0
  ) {
    try {
      // Look for all "family" items in this org that contain any keyword
      const { data: allProducts, error: allErr } = await supa
        .from("products")
        .select(
          "id, display_name, canonical, variant, base_unit, price_per_unit"
        )
        .eq("org_id", org_id);
  
      let familyNames: string[] = [];
  
      if (!allErr && allProducts && allProducts.length) {
        const familyHits = (allProducts as any[]).filter((p) => {
          const baseName = String(
            p.display_name || p.canonical || ""
          ).toLowerCase();
          const variantName = String(p.variant || "").toLowerCase();
          const haystack = `${baseName} ${variantName}`.trim();
          if (!haystack) return false;
  
          // match any of the meaningful keywords (e.g. "paneer", "biryani")
          return keywords.some((kw) => haystack.includes(kw));
        });
  
        familyNames = Array.from(
          new Set(
            familyHits
              .map((p) => {
                const base = p.display_name || p.canonical || "item";
                return p.variant
                  ? `${base} ${String(p.variant).trim()}`
                  : base;
              })
              .filter(Boolean)
          )
        );
      }
  
      // If no extra family hits, fall back to the original 'names'
      const finalNames =
        familyNames.length > 0
          ? familyNames
          : names;
  
      const header =
        `I couldn’t find *${requestedLabel}* exactly in today’s menu.\n` +
        `We do have:\n`;
  
      const lines = finalNames.map((n, i) => `${i + 1}) ${n}`);
      const footer = "\n\nWould you like to choose one of these instead?";
  
      return header + lines.join("\n") + footer;
    } catch (e: any) {
      console.warn(
        "[WABA][availability family suggestions err]",
        e?.message || e
      );
  
      // Safe fallback: keep the old behaviour
      const header =
        `I couldn’t find *${requestedLabel}* exactly in today’s menu.\n` +
        `We do have:\n`;
      const lines = names.map((n, i) => `${i + 1}) ${n}`);
      const footer = "\n\nWould you like to choose one of these instead?";
  
      return header + lines.join("\n") + footer;
    }
  }

    // Normal happy path: full match
    if (names.length >= 1) {
      if (names.length >= 2) {
        return (
          "✅ Yes, we have this available. Some options:\n" +
          names.map((n, i) => `${i + 1}) ${n}`).join("\n")
        );
      }

      // Single option but still matched cleanly
      return `✅ Yes, we have ${names[0]} available.`;
    }

    // Fallback when no variants
    return `✅ Yes, we have ${best.display_name} available.`;
  }

  // 4) Unknown inquiry type → soft generic reply
  return "💬 Got your question. We’ll confirm the details shortly.";
}

// ─────────────────────────────
// L11: AI-learned alias helpers
// ─────────────────────────────

// Most recent order for a customer (ANY status)
// Used as a fallback for cancel if nothing is "active"
async function findMostRecentOrderForPhone(
  org_id: string,
  from_phone: string
): Promise<any | null> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, created_at")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[WABA][mostRecentOrder err]", error.message);
      return null;
    }
    return data || null;
  } catch (e: any) {
    console.warn("[WABA][mostRecentOrder catch]", e?.message || e);
    return null;
  }
}

// ─────────────────────────────
// Debug flow logger (non-invasive)
// ─────────────────────────────
async function logFlowEvent(opts: {
  orgId: string;
  from?: string;
  event: string;
  msgId?: string;
  orderId?: string | null;
  text?: string | null;
  result?: any;
  meta?: any;
}) {
  try {
    await supa.from("waba_flow_logs").insert({
      org_id: opts.orgId,
      customer_phone: opts.from || null,
      event: opts.event,
      msg_id: opts.msgId || null,
      order_id: opts.orderId || null,
      text: opts.text || null,
      result: opts.result ?? null,
      meta: opts.meta ?? null,
      source: "waba",
    });
  } catch (e: any) {
    console.warn("[WABA][FLOW_LOG_ERR]", e?.message || e);
  }
}

// Start MULTI-TURN CLARIFY session (for items)
// - returns first question text, or null if nothing to clarify.
async function startClarifyForOrder(opts: {
  org_id: string;
  order_id: string;
  from_phone: string;
}): Promise<string | null> {
  const { org_id, order_id, from_phone } = opts;
  const phoneKey = normalizePhoneForKey(from_phone);

  const { data: orderRow, error: orderErr } = await supa
    .from("orders")
    .select("id, items, source_phone")
    .eq("id", order_id)
    .single();

  if (orderErr || !orderRow) {
    console.warn("[WABA][clarify start] order not found", orderErr?.message);
    return null;
  }

  const items = ((orderRow as any).items || []) as any[];

  // 🔹 No more auto-filling variants from history here.
  // If the catalog has 2+ variants for a canonical,
  // we will ALWAYS clarify instead of guessing.

  let choices = await findAmbiguousItemsForOrder(org_id, items);
  choices = choices.filter((c) => !items[c.index].variant);

  if (!choices.length) return null;

  const first = choices[0];

  // Close older sessions
  await supa
    .from("order_clarify_sessions")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("org_id", org_id)
    .eq("customer_phone", phoneKey)
    .eq("status", "open");

  await supa.from("order_clarify_sessions").insert({
    org_id,
    order_id,
    customer_phone: phoneKey,
    status: "open",
    current_index: first.index,
  });
  // L9: stage = awaiting_clarification for this order
  await setConversationStage(org_id, from_phone, "awaiting_clarification", {
    active_order_id: order_id,
    last_action: "clarify_item_variant",
  });

  return buildClarifyQuestionText(first);
}
// Start ADDRESS session (no more item clarifications needed)
// - next text from this customer will be treated as address, not order.

// Handle a message while clarify/address session is open
// Returns true if the message was consumed by this handler.

// Edit-like messages we *don’t* support in V1 (we answer safely)
function isLikelyEditRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("change ")) return true;
  if (lower.includes("instead of")) return true;
  if (lower.includes("make it ")) return true;
  if (lower.includes("make my ")) return true;
  if (lower.includes("remove ")) return true;
  if (lower.startsWith("no ")) return true;
  if (lower.includes("reduce ")) return true;
  if (lower.includes("increase ")) return true;

  // NEW patterns for "only X", "stop adding", etc.
  if (lower.includes("only biryani") || lower.includes("only biriyani"))
    return true;
  if (lower.includes("only this")) return true;
  if (lower.includes("dont add") || lower.includes("don't add")) return true;
  if (lower.includes("no need") && lower.includes("item")) return true;
  if (lower.includes("wrong") && lower.includes("order")) return true;
  if (
    lower.includes("why are u adding") ||
    lower.includes("why are you adding")
  )
    return true;

  return false;
}

// ─────────────────────────────
// Explicit user commands: NEW / CANCEL / UPDATE / AGENT
// ─────────────────────────────

// when we show "you have multiple active orders, reply 1/2/3",
// we store the order IDs here for that phone
const pendingCancelOptions = new Map<string, { orderIds: string[] }>();

// Track if we already showed the commands tip for this phone (per process)
const commandsTipShown = new Set<string>();

// For alias confirmation (per phone)
type PendingAlias = {
  orgId: string;
  customerPhone: string; // raw WhatsApp phone (no +)
  wrongText: string;
  normalizedWrong: string;
  canonicalProductId: string;
  canonicalName: string;
};

const pendingAliasConfirm = new Map<string, PendingAlias>();

async function saveAliasConfirmation(alias: PendingAlias) {
  try {
    // GLOBAL alias memory (per org)
    await supa.from("product_aliases").upsert(
      {
        org_id: alias.orgId,
        wrong_text: alias.wrongText,
        normalized_wrong_text: alias.normalizedWrong,
        canonical_product_id: alias.canonicalProductId,
        occurrence_count: 1,
      },
      {
        onConflict: "org_id,normalized_wrong_text",
      }
    );

    // CUSTOMER-level alias memory
    await supa.from("customer_aliases").upsert(
      {
        org_id: alias.orgId,
        customer_phone: alias.customerPhone,
        wrong_text: alias.wrongText,
        normalized_wrong_text: alias.normalizedWrong,
        canonical_product_id: alias.canonicalProductId,
        occurrence_count: 1,
      },
      {
        onConflict: "org_id,customer_phone,normalized_wrong_text",
      }
    );
  } catch (e: any) {
    console.warn("[ALIAS][saveAliasConfirmation err]", e?.message || e);
  }
}

// Small helper: only ask if wrong ≠ canonical and text is not tiny
function shouldAskAliasConfirm(wrong: string, canonical: string): boolean {
  const w = wrong.trim().toLowerCase();
  const c = canonical.trim().toLowerCase();
  if (!w || !c) return false;
  if (w === c) return false;
  if (w.length < 3) return false;
  return true;
}

// For soft-cancel flow (L8): phone → target order id
const pendingSoftCancel = new Map<string, string>();

function detectUserCommand(text: string): UserCommand {
  const lower = text.toLowerCase().trim();

  // keep these fairly strict to avoid colliding with normal sentences
  if (
    lower === "new" ||
    lower === "new order" ||
    lower.startsWith("start new order")
  ) {
    return "new";
  }
  if (
    lower === "cancel" ||
    lower === "cancel order" ||
    lower.startsWith("cancel my order")
  ) {
    return "cancel";
  }
  if (
    lower === "update" ||
    lower === "update order" ||
    lower.startsWith("edit order") ||
    lower.startsWith("modify order")
  ) {
    return "update";
  }
  if (
    lower === "agent" ||
    lower === "talk to agent" ||
    lower === "talk to human" ||
    lower === "human" ||
    lower === "support" ||
    lower === "customer care"
  ) {
    return "agent";
  }

  if (
    lower === "repeat" ||
    lower === "repeat order" ||
    lower === "repeat last order" ||
    lower.includes("same as last time") ||
    lower.includes("same as yesterday") ||
    lower.includes("same order") ||
    lower.includes("same items")
  ) {
    return "repeat";
  }

  return null;
}
function detectSoftCancelIntent(text: string): boolean {
  const lower = text.toLowerCase().trim();
  // Pure "stop" style
  if (
    lower === "stop" ||
    lower === "stop it" ||
    lower === "stop this" ||
    lower.startsWith("stop order") ||
    lower.startsWith("stop this order") ||
    lower.startsWith("stop my order")
  ) {
    return true;
  }

  // "no need" patterns
  if (
    lower.startsWith("no need") ||
    lower.includes("no need this") ||
    lower.includes("no need now")
  ) {
    return true;
  }

  // "don't want" patterns
  if (
    lower.startsWith("dont want") ||
    lower.startsWith("don't want") ||
    lower.includes("dont want this") ||
    lower.includes("don't want this")
  ) {
    return true;
  }

  // Anything containing "cancel" that is NOT the strict "cancel" command
  if (lower.includes("cancel")) {
    return true;
  }

  return false;
}

// ─────────────────────────────
// 2) Incoming messages (POST)
// ─────────────────────────────
waba.post("/", async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.entry) {
      console.log("[WABA] no entry in body");
      return res.sendStatus(200);
    }

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const metadata = value.metadata || {};
        const phoneNumberId = metadata.phone_number_id as string | undefined;

        if (!phoneNumberId || messages.length === 0) continue;

        // Find org by WABA phone_number_id
        const { data: orgs, error: orgErr } = await supa
          .from("orgs")
          .select(
            `
    id,
    name,
    ingest_mode,
    auto_reply_enabled,
    primary_business_type,
    supports_delivery,
    wa_menu_image_url,
    wa_menu_caption
  `
          )
          .eq("wa_phone_number_id", phoneNumberId)
          .limit(1);

        if (orgErr) {
          console.warn("[WABA] org lookup error", orgErr.message);
          continue;
        }
        const org = orgs?.[0];
        if (!org) {
          console.warn("[WABA] no org for phone_number_id", phoneNumberId);
          continue;
        }

        if (org.ingest_mode !== "waba") {
          console.log("[WABA] org not in waba mode, skipping", {
            org_id: org.id,
            ingest_mode: org.ingest_mode,
          });
          continue;
        }

        const tone = getToneFromOrg(org);

        for (const msg of messages) {
          if (msg.type !== "text") continue;

          const from = msg.from as string;
          let text: string = msg.text?.body?.trim() || "";
          const msgId = msg.id as string;
          const ts = Number(msg.timestamp || Date.now()) * 1000;

          if (seenMsgIds.has(msgId)) {
            console.log("[WABA][DEDUP] skipping already-seen msg", msgId);
            continue;
          }
          seenMsgIds.add(msgId);
          if (seenMsgIds.size > MAX_SEEN_MSG_IDS) {
            // crude GC: clear when too big
            seenMsgIds.clear();
          }

          if (!text) continue;

          // 👇 SIMPLE INCOMING LOG
          console.log("[FLOW][INCOMING]", {
            org_id: org.id,
            from, // raw WhatsApp number (no +)
            msgId,
            text,
          });

          await logInboundMessageToInbox({
            orgId: org.id,
            from,
            text,
            msgId,
          });

          // Normalize phone once (for session + AI)
          const phoneKey = normalizePhoneForKey(from);

          // 🔹 Compute active order row (old helper)…
          const activeOrder = await findActiveOrderForPhone(org.id, from);

          // 🔹 …but let the session engine decide which order ID is "active"
          const sessionActiveOrderId =
            (await resolveActiveOrderIdForCustomer({
              org_id: org.id,
              phone_key: phoneKey,
            })) || null;

          const activeOrderId = sessionActiveOrderId || activeOrder?.id || null;

          // 🔹 Check per-customer auto-reply *before* going into AI
          const autoReplyForCustomer = await isAutoReplyEnabledForCustomer({
            orgId: org.id,
            phoneRaw: from,
            orgAutoReplyEnabled: !!org.auto_reply_enabled,
          });

          if (!autoReplyForCustomer) {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "auto_reply_disabled_for_customer_inbound",
              msgId,
              text,
            });

            continue; // 🛑 skip clarify, commands, ingestCore, auto-replies
          }

          const convoState = await getConversationState(org.id, from);
          const convoStage = (convoState?.stage as ConversationStage) || "idle";

          if (!text) continue;

          let lowerText = text.toLowerCase().trim();

          wabaDebug("ROUTER HIT", req.method, req.path);
          wabaDebug("RAW BODY", JSON.stringify(req.body));

          wabaDebug("MSG DEBUG", {
            text,
            from,
            hasActiveOrder: Boolean(activeOrder),
            isEditLike: isLikelyEditRequest(text),
            looksLikeAdd: looksLikeAddToExisting(text),
          });

          // 🔹 LAYER X: run high-level AI interpreter (Option C – sidecar only)
          // Map our broader ConversationStage → interpreter's narrower state
          const stateForInterpreter:
            | "idle"
            | "awaiting_clarification"
            | "awaiting_address"
            | "post_order" =
            convoStage === "awaiting_clarification" ||
            convoStage === "awaiting_address" ||
            convoStage === "post_order"
              ? convoStage
              : "idle";

          let interpretation: any = null;

          try {
            interpretation = await interpretMessage({
              orgId: org.id,
              phone: phoneKey, // we already computed this above
              text,
              hasOpenOrder: !!activeOrder,
              lastOrderStatus: activeOrder?.status ?? null,
              lastOrderCreatedAt: activeOrder?.created_at ?? null,
              state: stateForInterpreter,
              channel: "waba",
            });

            // 🧠 1) Log into flow logs (already there)
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "ai_interpretation",
              msgId,
              orderId: activeOrderId,
              text,
              result: interpretation,
            });

            // 🧠 2) Snapshot latest AI insight per customer
            await saveAiInsight({
              orgId: org.id,
              phoneKey,
              msgId,
              msgAt: new Date(ts),
              interpretation,
            });
          } catch (e: any) {
            console.warn("[WABA][AI_INTERPRET_ERR]", e?.message || e);
          }

          // 🔹 AI soft-cancel signal (used later in L8)
          const aiThinksSoftCancel =
            interpretation &&
            typeof interpretation === "object" &&
            (interpretation.kind === "order_cancel_soft" ||
              interpretation.kind === "order_cancel_hard") &&
            typeof interpretation.confidence === "number" &&
            interpretation.confidence >= 0.8;

          // ---------------------------------------------
          // 🔹 Shortcut: Pure smalltalk (no active order)
          // ---------------------------------------------
          if (
            interpretation &&
            interpretation.kind === "smalltalk" &&
            typeof interpretation.confidence === "number" &&
            interpretation.confidence >= 0.8 &&
            !activeOrder
          ) {
            const greet = makeGreeting(tone);

            await sendWabaText({
              phoneNumberId,
              to: from,
              text: greet,
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "ai_smalltalk_handled",
              msgId,
              orderId: null,
              text,
              result: {
                kind: interpretation.kind,
                confidence: interpretation.confidence,
                reason: (interpretation as any).reason ?? null,
              },
            });

            // Stop further processing for this message
            continue;
          }

          // ---------------------------------------------
          // 🔹 AI: detect "talk to human" (meta_handoff)
          // ---------------------------------------------
          const wantsHumanByAI =
            interpretation &&
            interpretation.kind === "meta_handoff" &&
            typeof interpretation.confidence === "number" &&
            interpretation.confidence >= 0.7;

          // 🔹 AI → human handoff executor
          if (
            interpretation &&
            typeof interpretation === "object" &&
            interpretation.kind === "meta_handoff" &&
            typeof interpretation.confidence === "number" &&
            interpretation.confidence >= 0.8
          ) {
            // High-confidence "talk to human" intent → same as `agent` command
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "👨‍💼 Okay, we’ll connect you to a store agent.\n" +
                "Please wait a moment — a human will reply.",
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "ai_meta_handoff_executed",
              msgId,
              orderId: activeOrderId,
              text,
              result: {
                kind: interpretation.kind,
                confidence: interpretation.confidence,
                reason: (interpretation as any).reason ?? null,
              },
            });

            // Don't go through normal flow for this message
            continue;
          }

          const lastCmd = lastCommandByPhone.get(from);

          // ─────────────────────────────
          // ALIAS CONFIRMATION YES/NO
          // ─────────────────────────────
          const aliasPending = pendingAliasConfirm.get(from);
          if (aliasPending && !lastCmd) {
            const ans = lowerText;

            const isYes =
              ans === "yes" ||
              ans === "y" ||
              ans === "ya" ||
              ans === "yeah" ||
              ans === "yup" ||
              ans === "yes please" ||
              ans.startsWith("yes,") ||
              ans.startsWith("ok") ||
              ans === "k" ||
              ans === "kk";

            const isNo =
              ans === "no" ||
              ans === "n" ||
              ans === "nope" ||
              ans.startsWith("dont") ||
              ans.startsWith("don't") ||
              ans.startsWith("do not") ||
              ans.includes("no need") ||
              ans.includes("not now");

            if (!isYes && !isNo) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text:
                  `Please reply *YES* or *NO* for:\n` +
                  `"${aliasPending.wrongText}" → "${aliasPending.canonicalName}".`,
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "alias_confirm_ask_again",
                msgId,
                orderId: null,
                text,
                result: {
                  wrongText: aliasPending.wrongText,
                  canonicalName: aliasPending.canonicalName,
                },
              });

              continue;
            }

            // decision made → clear pending
            pendingAliasConfirm.delete(from);

            if (isNo) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text:
                  "👍 Got it — I won’t remember that spelling.\n" +
                  "You can always type the item name exactly next time.",
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "alias_confirm_rejected",
                msgId,
                orderId: null,
                text,
                result: {
                  wrongText: aliasPending.wrongText,
                  canonicalName: aliasPending.canonicalName,
                },
              });

              continue;
            }

            // YES → save alias globally + per customer
            await saveAliasConfirmation(aliasPending);

            await sendWabaText({
              phoneNumberId,
              to: from,
              orgId: org.id,
              text:
                `✅ Done. When you say *${aliasPending.wrongText}*, ` +
                `I’ll treat it as *${aliasPending.canonicalName}* for this store.`,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "alias_confirm_accepted",
              msgId,
              orderId: null,
              text,
              result: {
                wrongText: aliasPending.wrongText,
                canonicalName: aliasPending.canonicalName,
              },
            });

            continue;
          }

          // 0.12) L8: waiting for YES/NO to confirm soft cancel
          if (lastCmd === "cancel_pending") {
            const targetOrderId =
              pendingSoftCancel.get(from) || activeOrderId || null;

            if (!targetOrderId) {
              // nothing to cancel anymore → clear state and fall through to normal flow
              lastCommandByPhone.delete(from);
              pendingSoftCancel.delete(from);
            } else {
              const ans = lowerText;

              const isYes =
                ans === "yes" ||
                ans === "y" ||
                ans === "ya" ||
                ans === "yeah" ||
                ans === "yup" ||
                ans === "yes cancel" ||
                ans === "ok" ||
                ans === "okay" ||
                ans === "k" ||
                ans === "kk" ||
                ans === "cancel" ||
                ans.startsWith("yes, cancel") ||
                ans.startsWith("pls cancel") ||
                ans.startsWith("please cancel");

              const isNo =
                ans === "no" ||
                ans === "n" ||
                ans === "nope" ||
                ans.startsWith("dont cancel") ||
                ans.startsWith("don't cancel") ||
                ans.startsWith("keep") ||
                ans.startsWith("continue");

              if (!isYes && !isNo) {
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "⚠️ Please reply *YES* to cancel your last order, or *NO* to keep it as is.",
                  orgId: org.id,
                });

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "soft_cancel_ask_again",
                  msgId,
                  orderId: targetOrderId,
                  text,
                });

                continue;
              }

              if (isNo) {
                lastCommandByPhone.delete(from);
                pendingSoftCancel.delete(from);

                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "✅ Got it — we’ll keep your order as it is.\nIf you ever want to cancel, just type *cancel*.",
                  orgId: org.id,
                });

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "soft_cancel_rejected",
                  msgId,
                  orderId: targetOrderId,
                  text,
                });

                continue;
              }

              // YES → cancel the order
              const { data: ordRow, error: ordErr } = await supa
                .from("orders")
                .select("id, items, status")
                .eq("id", targetOrderId)
                .single();

              if (ordErr || !ordRow) {
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "I couldn’t find that order anymore. It may have already been updated by the store.",
                  orgId: org.id,
                });

                lastCommandByPhone.delete(from);
                pendingSoftCancel.delete(from);

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "soft_cancel_missing_order",
                  msgId,
                  orderId: targetOrderId,
                  text,
                });

                continue;
              }

              await supa
                .from("orders")
                .update({ status: "cancelled_by_customer" })
                .eq("id", targetOrderId);

              const summary = formatOrderSummary(ordRow.items || []);

              const txt =
                "❌ Your last order has been cancelled:\n" +
                summary +
                "\n\nIf this was a mistake, you can send a new order.";

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: txt,
                orgId: org.id,
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "soft_cancel_confirmed",
                msgId,
                orderId: targetOrderId,
                text,
                result: { summary },
              });

              lastCommandByPhone.delete(from);
              pendingSoftCancel.delete(from);
              await clearConversationStage(org.id, from);

              continue;
            }
          }

          // 0.15) If we are waiting for the user to choose WHICH order to cancel
          if (lastCmd === "cancel_select") {
            const choiceNum = parseInt(lowerText, 10);

            const options = pendingCancelOptions.get(from);
            if (!options || !options.orderIds.length) {
              // nothing to select anymore → reset and let normal flow handle
              lastCommandByPhone.delete(from);
            } else if (!Number.isNaN(choiceNum)) {
              const idx = choiceNum - 1;
              const orderId = options.orderIds[idx];

              if (idx < 0 || idx >= options.orderIds.length || !orderId) {
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "Please reply with a valid number from the list (for example 1 or 2).",
                  orgId: org.id,
                });
                continue;
              }

              // Cancel the chosen order
              const { data: ordRow, error: ordErr } = await supa
                .from("orders")
                .select("id, items, status")
                .eq("id", orderId)
                .single();

              if (ordErr || !ordRow) {
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: "I couldn’t find that order anymore. It may have already been updated by the store.",
                  orgId: org.id,
                });
              } else {
                // mark as cancelled
                await supa
                  .from("orders")
                  .update({ status: "cancelled_by_customer" })
                  .eq("id", orderId);

                const summary = formatOrderSummary(ordRow.items || []);

                const txt =
                  "❌ The selected order has been cancelled:\n" +
                  summary +
                  "\n\nIf this was a mistake, you can send a new order.";

                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  text: txt,
                  orgId: org.id,
                });

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "cancel_select_done",
                  msgId,
                  orderId,
                  text,
                  result: { summary },
                });
              }

              // clear state
              lastCommandByPhone.delete(from);
              pendingCancelOptions.delete(from);
              continue;
            } else {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text: "Please reply with the number of the order you want to cancel (for example 1 or 2).",
                orgId: org.id,
              });
              continue;
            }
          }

          const needsAddressForOrg = orgNeedsDeliveryAddress(org);

          // 0) If we’re in clarify/address session → consume here and SKIP ingestCore
          const handledByClarify = await maybeHandleClarifyReply({
            org_id: org.id,
            phoneNumberId,
            from,
            text,
            needsAddress: needsAddressForOrg,
          });

          if (handledByClarify) {
            continue;
          }

          // 🔹 After address flow, treat small "no/ok/thanks" as final confirmation, not as an item
          if (lastCmd === "address_done" || convoStage === "building_order") {
            // Normalise once
            const soft = lowerText;

            // Phrases that usually mean "nothing more"
            const isSoftAck =
              soft === "no" ||
              soft === "nope" ||
              soft === "ok" ||
              soft === "okay" ||
              soft === "k" ||
              soft === "fine" ||
              soft === "thanks" ||
              soft === "thank you" ||
              soft === "tnx" ||
              soft === "thx" ||
              soft === "nothing" ||
              soft === "nothing else" ||
              soft === "nothing more" ||
              soft === "thats all" ||
              soft === "that's all" ||
              soft === "thats it" ||
              soft === "that's it" ||
              soft.startsWith("no more") ||
              soft.startsWith("no need") ||
              soft.startsWith("no other") ||
              soft.startsWith("no items");

            // Rough heuristic: if it looks like an item list, don't treat as ack
            const looksLikeItemText =
              /\d/.test(soft) || // has numbers
              /kg|g|gram|ml|ltr|liter|litre|piece|pcs|pc|pack|plate|bottle|box/i.test(
                soft
              ) ||
              soft.includes(",");

            if (isSoftAck && !looksLikeItemText) {
              // Build a generic final confirmation that works for all business types
              const bt = normalizeBusinessType(org.primary_business_type);
              let finalText: string;

              if (bt === "salon") {
                finalText =
                  "✅ Your booking request is confirmed. We’ll schedule it and update you shortly.\n" +
                  "If you need anything else, just message here.";
              } else {
                // grocery, restaurant, cloud_kitchen, pharmacy, generic, etc.
                finalText =
                  "✅ Your order is confirmed. We’ll start processing it now.\n" +
                  "If you need anything else, just message here.";
              }

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: finalText,
                orgId: org.id,
              });

              // We handled this "no/ok/thanks" message fully
              lastCommandByPhone.delete(from);

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "address_done_soft_ack",
                msgId,
                orderId: activeOrder?.id || null,
                text,
                result: { finalText },
              });

              continue; // 👉 DO NOT go to ingestCore / AI
            }
          }

          // 0.15) Commands menu: help / menu / commands / options
          if (/^(help|commands|options)$/i.test(lowerText)) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "📝 Quick commands you can use:\n" +
                "• *new* – start a fresh order\n" +
                "• *cancel* – cancel your last order\n" +
                "• *agent* – talk to a human\n" +
                "• *order summary* – show your last order\n\n" +
                "You can also just type your items, e.g. “2kg onion, 1L milk”.",
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "commands_menu_shown",
              msgId,
              text,
            });

            continue;
          }
          // 0.1) "order summary" → show ALL active (pending/paid) orders
          if (
            /\b(my orders|orders summary|active orders|show my orders)\b/i.test(
              lowerText
            )
          ) {
            const activeOrders = await findAllActiveOrdersForPhone(
              org.id,
              from
            );

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "order_summary_active",
              msgId,
              text,
              meta: { activeCount: activeOrders.length },
            });

            if (!activeOrders.length) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "📦 You don’t have any active orders right now.\n" +
                  "If you’d like to place a new order, just send your items here.",
                orgId: org.id,
              });
            } else {
              const blocks = activeOrders.map((o, idx) => {
                const n = idx + 1;
                const summary = formatOrderSummary(o.items || []);
                const status = String(o.status || "pending");
                return (
                  `#${n} — status: ${status}\n` +
                  (summary || "(no items found)")
                );
              });

              const textOut =
                "📦 Your active orders:\n\n" +
                blocks.join("\n\n") +
                "\n\nTo cancel one, you can type *cancel* and choose the order.";

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: textOut,
                orgId: org.id,
              });
            }

            continue;
          }

          // 0.2) Explicit commands: NEW / CANCEL / UPDATE / AGENT
          const cmd = detectUserCommand(text);

          // 0.25) Repeat last order → convert last items into synthetic text
          if (cmd === "repeat") {
            const last = await findMostRecentOrderForPhone(org.id, from);

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_repeat",
              msgId,
              text,
              orderId: last?.id || null,
            });

            if (
              !last ||
              !Array.isArray(last.items) ||
              last.items.length === 0
            ) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "I couldn’t find any previous orders to repeat for this number.\n" +
                  "You can send a new order by typing the items.",
                orgId: org.id,
              });
              continue;
            }

            const synthetic = itemsToOrderText(last.items || []);

            if (!synthetic) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "Your last order looks empty in our system.\n" +
                  "Please send the items you’d like to order again.",
                orgId: org.id,
              });
              continue;
            }

            // Overwrite text so the normal parser sees a clean item list
            text = synthetic;
            lowerText = text.toLowerCase().trim();

            // Treat this like starting a fresh order
            lastCommandByPhone.set(from, "new");

            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "👍 Repeating your last order with the same items.\n" +
                "If you want to change anything, please type it now.",
              orgId: org.id,
            });
          }

          // 0.18) Show last order summary (read-only)
          if (
            /\border summary\b/i.test(lowerText) ||
            /\bshow (my )?order\b/i.test(lowerText) ||
            /\blast order\b/i.test(lowerText) ||
            /\bprevious order\b/i.test(lowerText)
          ) {
            const last = await findMostRecentOrderForPhone(org.id, from);

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "order_summary_last",
              msgId,
              text,
              orderId: last?.id || null,
            });

            if (
              !last ||
              !Array.isArray(last.items) ||
              last.items.length === 0
            ) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text: "I couldn’t find any previous orders for this number.",
                orgId: org.id,
              });
            } else {
              const summary = formatOrderSummary(last.items || []);

              const rawStatus = String(last.status || "pending");
              let statusText = `Status: ${rawStatus}`;
              if (rawStatus === "pending") statusText = "🟡 Status: pending";
              else if (rawStatus === "paid") statusText = "🟢 Status: paid";
              else if (rawStatus.startsWith("cancelled"))
                statusText = "🔴 Status: cancelled";

              const textOut =
                "📦 Your last order:\n" + summary + "\n\n" + statusText;

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: textOut,
                orgId: org.id,
              });
            }

            continue;
          }

          if (cmd === "agent") {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_agent",
              msgId,
              text,
            });

            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "👨‍💼 Okay, we’ll connect you to a store agent.\n" +
                "Please wait a moment — a human will reply.",
              orgId: org.id,
            });
            // here you could also flag the conversation row in DB
            continue;
          }

          if (cmd === "cancel") {
            const activeOrders = await findAllActiveOrdersForPhone(
              org.id,
              from
            );

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_cancel",
              msgId,
              text,
              meta: { activeCount: activeOrders.length },
            });

            if (!activeOrders.length) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "You don’t have any active orders right now.\n" +
                  "If you’d like to place a new order, please send your items.",
                orgId: org.id,
              });
              await clearConversationStage(org.id, from);
              continue;
            }

            if (activeOrders.length === 1) {
              // 🔹 Use the same soft-cancel YES/NO flow even for explicit "cancel"
              const activeOrderForCancel = activeOrders[0];

              const summary = formatOrderSummary(
                activeOrderForCancel.items || []
              );

              const promptText =
                "⚠️ Are you sure you want to cancel this order?\n" +
                (summary || "(no items found)") +
                "\n\nReply *YES* to cancel it, or *NO* to keep it.";

              pendingSoftCancel.set(from, activeOrderForCancel.id);
              lastCommandByPhone.set(from, "cancel_pending");

              await sendWabaText({
                phoneNumberId,
                to: from,
                text: promptText,
                orgId: org.id,
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "command_cancel_single_prompt",
                msgId,
                orderId: activeOrderForCancel.id,
                text,
                result: { summary },
              });

              continue;
            }

            // Multiple active orders → ask user to choose
            lastCommandByPhone.set(from, "cancel_select");

            const orderIds = activeOrders.map((o) => o.id);
            pendingCancelOptions.set(from, { orderIds });

            const lines = activeOrders.map((o, idx) => {
              const n = idx + 1;
              const items = (o.items || []) as any[];
              const first = items[0];
              const firstName = first
                ? String(first.canonical || first.name || "item")
                : "item";
              const extra =
                items.length > 1 ? ` + ${items.length - 1} more item(s)` : "";
              const status = String(o.status || "pending");
              return `${n}) ${firstName}${extra}  [${status}]`;
            });

            const textOut =
              "You have multiple active orders:\n" +
              lines.join("\n") +
              "\n\nReply with the number of the order you want to cancel (for example 1 or 2).";

            await sendWabaText({
              phoneNumberId,
              to: from,
              text: textOut,
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_cancel_multi",
              msgId,
              text,
              meta: { orderIds },
            });

            continue;
          }

          if (cmd === "new") {
            // remember last command
            lastCommandByPhone.set(from, "new");

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_new",
              msgId,
              text,
            });

            // 1) Close all active orders for this phone
            await supa
              .from("orders")
              .update({ status: "archived_for_new" })
              .eq("org_id", org.id)
              .eq("source_phone", from)
              .in("status", ["pending", "paid"]);

            // 2) Close clarify/address sessions
            const phoneKey = normalizePhoneForKey(from);
            await supa
              .from("order_clarify_sessions")
              .update({
                status: "closed",
                updated_at: new Date().toISOString(),
              })
              .eq("org_id", org.id)
              .eq("customer_phone", phoneKey)
              .eq("status", "open");

            // 3) Respond
            await sendWabaText({
              phoneNumberId,
              to: from,
              text: "👍 Starting a fresh order. Please send the items you’d like to buy.",
              orgId: org.id,
            });

            await clearConversationStage(org.id, from);

            continue;
          }

          if (cmd === "update") {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "command_update",
              msgId,
              text,
            });

            // We do *not* auto-edit any existing order in V1.
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "I can’t update specific items automatically yet.\n" +
                "Please type your changes clearly (e.g., “change 1kg onion to 2kg onion”) and the store will review it.",
              orgId: org.id,
            });
            continue;
          }

          // 0.3) L8 — Soft cancel intent (stop / no need / cancel it pls / don't want)
          const isSoftCancelByText = detectSoftCancelIntent(text);
          const isSoftCancelByAI = aiThinksSoftCancel;

          if (
            !cmd &&
            activeOrderId &&
            (isSoftCancelByText || isSoftCancelByAI)
          ) {
            // Target the latest active order for soft-cancel
            pendingSoftCancel.set(from, activeOrderId);
            lastCommandByPhone.set(from, "cancel_pending");

            // Safely load items for summary
            let itemsForSummary: any[] = [];

            if (activeOrder && Array.isArray(activeOrder.items)) {
              itemsForSummary = activeOrder.items;
            } else {
              try {
                const { data: ordRow, error: ordErr } = await supa
                  .from("orders")
                  .select("items")
                  .eq("id", activeOrderId)
                  .single();

                if (!ordErr && ordRow && Array.isArray((ordRow as any).items)) {
                  itemsForSummary = (ordRow as any).items;
                }
              } catch (e: any) {
                console.warn("[WABA][soft_cancel load err]", e?.message || e);
              }
            }

            const summary = formatOrderSummary(itemsForSummary || []);

            const promptText =
              "⚠️ It looks like you want to cancel your last order:\n" +
              (summary || "(no items found)") +
              "\n\nReply *YES* to cancel it, or *NO* to keep it.";

            await sendWabaText({
              phoneNumberId,
              to: from,
              text: promptText,
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "soft_cancel_prompt",
              msgId,
              orderId: activeOrderId,
              text,
              result: {
                summary,
                byText: isSoftCancelByText,
                byAI: isSoftCancelByAI,
                aiKind: interpretation ? (interpretation as any).kind : null,
                aiConfidence: interpretation
                  ? (interpretation as any).confidence ?? null
                  : null,
              },
            });

            continue;
          }

          // 0.8) Edit-like messages while an order is open → safe fallback (no auto edit in V1)
          const activeOrderForEdit = activeOrder;
          if (activeOrderForEdit && isLikelyEditRequest(text)) {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "edit_like_message",
              msgId,
              text,
              orderId: activeOrderForEdit.id,
            });

            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "I’m not sure which part of your order to change.\n" +
                "Please send the updated order clearly, or talk to the store directly.\n" +
                "If you want, you can cancel this order and create a new one from the beginning.",
              orgId: org.id,
            });
            continue;
          }

          /// ─────────────────────────────
          // LAYER 12: ingestCore (safe)
          // ─────────────────────────────
          let result: any;

          // --- Address update detection (override bad parse) ---
          const looksLikeAddressUpdateText =
            /address/.test(lowerText) &&
            /(update|change|correct|new|my address is)/i.test(lowerText);

          if (looksLikeAddressUpdateText && activeOrderId) {
            const targetOrder =
              activeOrder || (await findMostRecentOrderForPhone(org.id, from));

            if (!targetOrder) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text:
                  "📍 Got your message about the address.\n" +
                  "We don’t see any recent order to update right now, " +
                  "but the store will note your new address for future orders.",
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "address_update_no_order_text_detected",
                msgId,
                orderId: null,
                text,
                result,
              });

              continue;
            }

            await startAddressSessionForOrder({
              org_id: org.id,
              order_id: targetOrder.id,
              from_phone: from,
            });

            await sendWabaText({
              phoneNumberId,
              to: from,
              orgId: org.id,
              text:
                "📍 Sure, please send your correct delivery address now " +
                "(building, street, area). We’ll update it for your current order.",
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "address_update_text_detected",
              msgId,
              orderId: targetOrder.id,
              text,
              result,
            });

            continue; // ✅ do not treat this as an item / order
          }

          try {
            result = await ingestCoreFromMessage({
              org_id: org.id,
              text,
              ts,
              from_phone: from,
              from_name: null,
              msg_id: msgId,
              source: "waba",
              active_order_id: activeOrderId || undefined,
            });

            console.log("[WABA][INGEST-RESULT]", {
              org_id: org.id,
              from,
              msgId,
              used: result.used,
              kind: result.kind,
              inquiry: result.inquiry || result.inquiry_type,
              order_id: result.order_id,
              reason: result.reason,
              stored: result.stored,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "ingest_result",
              msgId,
              orderId: result.order_id || null,
              text,
              result,
              meta: {
                kind: result.kind,
                reason: result.reason,
                stored: result.stored,
                lastCmd,
              },
            });
          } catch (e: any) {
            console.error("[WABA][INGEST_EXCEPTION]", e?.message || e);

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "ingest_exception",
              msgId,
              orderId: null,
              text,
              result: { error: e?.message || String(e) },
            });

            // Fail-soft message to customer
            await sendWabaText({
              phoneNumberId,
              to: from,
              orgId: org.id,
              text:
                "⚠️ There was a technical issue while processing your message.\n" +
                "The team will reply shortly.",
            });

            // Skip everything below (NO auto reply, NO logic)
            continue;
          }

          // L11: learn aliases from inquiries (user text → canonical)
          try {
            if (result && result.kind === "inquiry") {
              await learnAliasFromInquiry({
                org_id: org.id,
                from_phone: from,
                text,
                result,
              });
            }
          } catch (e: any) {
            console.warn("[L11][learnAliasFromInquiry err]", e?.message || e);
          }

          // ─────────────────────────────
          // ORDER MODIFIER / CORRECTION (Option C from ingestCore NLU)
          // e.g. "make biriyani spicy", "only boneless", "remove coke"
          // ─────────────────────────────
          if (result && result.kind === "modifier") {
            await logFlowEvent({
              orgId: org.id,
              from,
              event: "modifier_message",
              msgId,
              orderId: activeOrder?.id || null,
              text,
              result,
            });

            if (!activeOrder) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text:
                  "I got that you want to change something in the order, " +
                  "but I don’t see any recent order for this number.\n" +
                  "Please send a new order, or talk to the store directly.",
              });

              // do NOT fall through to generic flow
              continue;
            }

            await sendWabaText({
              phoneNumberId,
              to: from,
              orgId: org.id,
              text: "👍 Got your change request. The store will review it and update your current order if possible.",
            });

            // In V1 we don’t auto-edit line items; we just pass it to store
            // and stop here.
            continue;
          }

          // ─────────────────────────────
          // ADDRESS UPDATE FLOW (human-like)
          // ─────────────────────────────
          const isAddressUpdate =
            result &&
            result.kind === "none" &&
            typeof result.reason === "string" &&
            (result.reason === "nlu:address_update" ||
              result.reason.includes("address update request") ||
              result.reason.includes("request for address update") ||
              result.reason.includes("update my address"));
          if (isAddressUpdate) {
            // Pick target order: prefer active, else most recent
            const targetOrder =
              activeOrder || (await findMostRecentOrderForPhone(org.id, from));

            if (!targetOrder) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text:
                  "📍 Got your message about the address.\n" +
                  "We don’t see any recent order to update right now, " +
                  "but the store will note your new address for future orders.",
              });
              await logFlowEvent({
                orgId: org.id,
                from,
                event: "address_update_no_order",
                msgId,
                orderId: null,
                text,
                result,
              });
              continue;
            }

            await startAddressSessionForOrder({
              org_id: org.id,
              order_id: targetOrder.id,
              from_phone: from,
            });

            await sendWabaText({
              phoneNumberId,
              to: from,
              orgId: org.id,
              text:
                "📍 Sure, please send your correct delivery address now " +
                "(building, street, area). We’ll update it for your current order.",
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "address_update_requested",
              msgId,
              orderId: targetOrder.id,
              text,
              result,
            });

            continue; // ✅ stop normal flow
          }

          let reply: string | null = null;

          // ─────────────────────────────
          // SIMPLE PREFERENCE NOTE FALLBACK
          // (e.g. "some spice to my biriyani")
          // ─────────────────────────────
          const isPreferenceByAI =
            result &&
            typeof result.reason === "string" &&
            result.reason.startsWith("ai:not_order:preference");

          if (
            !reply &&
            activeOrderId &&
            (isPreferenceByAI ||
              /spice|spicy|no onion|less oil|less chilli|no chilli/i.test(
                lowerText
              ))
          ) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              orgId: org.id,
              text:
                "👍 Got it — we’ve noted your special request for the store.\n" +
                "They’ll adjust your order accordingly.",
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "preference_note_manual",
              msgId,
              orderId: activeOrderId,
              text,
              result,
            });

            continue; // ✅ do NOT treat this as order/inquiry
          }

          // ─────────────────────────────
          // MENU HEURISTIC: convert to inquiry:menu when appropriate
          // ─────────────────────────────
          const menuRegex =
            /\b(menu|price list|pricelist|rate card|ratecard|services list|service menu)\b/i;

          const looksLikeMenu = menuRegex.test(lowerText);

          if (looksLikeMenu && result.kind !== "order") {
            result.kind = "inquiry";
            if (!result.inquiry && !result.inquiry_type) {
              (result as any).inquiry_type = "menu";
            }
          }
          // ────────────────────────────
          // NEW: snapshot last inquiry for Inbox center card
          // ─────────────────────────────
          try {
            if (result && result.kind === "inquiry") {
              const phoneKey = normalizePhoneForKey(from);

              // Normalize inquiry type ("availability", "price", "menu", etc.)
              const inquiryRaw = result.inquiry || result.inquiry_type || null;
              const inquiryType = inquiryRaw
                ? String(inquiryRaw).toLowerCase()
                : null;

              // Try to guess a canonical name for the product being asked about
              let canonical: string | null = null;

              if (typeof (result as any).inquiry_canonical === "string") {
                canonical = (result as any).inquiry_canonical;
              } else if (typeof (result as any).canonical === "string") {
                canonical = (result as any).canonical;
              } else if (typeof result.reason === "string") {
                // e.g. "inq:availability:paneer biryani"
                const m = result.reason.match(/^inq:[^:]+:(.+)$/i);
                if (m && m[1]) {
                  canonical = m[1];
                }
              }
              await supa.from("org_customer_settings").upsert(
                {
                  org_id: org.id,
                  customer_phone: phoneKey,
                  last_inquiry_text: text, // "Do you have panner biriyani"
                  last_inquiry_kind: inquiryType, // "availability" / "price" / "menu" / ...
                  last_inquiry_canonical: canonical, // "paneer biryani" (best effort)
                  last_inquiry_at: new Date().toISOString(),
                  last_inquiry_status: "unresolved",
                },
                { onConflict: "org_id,customer_phone" }
              );
            }
          } catch (e: any) {
            console.warn(
              "[WABA][inquiry snapshot upsert err]",
              e?.message || e
            );
          }

          // ─────────────────────────────
          // PREFERENCE / SPECIAL REQUEST FLOW
          // (e.g. "make the biriyani spicy", "no onion in biriyani")
          // ─────────────────────────────
          if (
            result &&
            result.kind === "order" &&
            typeof result.reason === "string" &&
            result.reason.toLowerCase().includes("preference") &&
            activeOrderId &&
            Array.isArray(result.items) &&
            result.items.length === 1
          ) {
            const prefItem = result.items[0] || {};
            const prefCanonical = String(
              prefItem.canonical || prefItem.name || ""
            )
              .toLowerCase()
              .trim();
            const prefNotes = String(prefItem.notes || "").trim();

            if (!prefCanonical || !prefNotes) {
              // Not enough info → just treat as manual note for store
              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text:
                  "👍 Got it — we’ve noted your request for the store.\n" +
                  "They’ll adjust your order accordingly.",
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "preference_note_no_details",
                msgId,
                orderId: activeOrderId,
                text,
                result,
              });

              continue;
            }

            const { data: ordRow, error: ordErr } = await supa
              .from("orders")
              .select("id, items")
              .eq("id", activeOrderId)
              .single();

            if (ordErr || !ordRow) {
              console.warn(
                "[WABA][preference_update order load err]",
                ordErr?.message
              );

              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text: "👍 Got your preference. The store will review it with your order.",
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "preference_note_order_missing",
                msgId,
                orderId: activeOrderId,
                text,
                result,
              });

              continue;
            }

            const itemsArr: any[] = (ordRow as any).items || [];
            let chosenIndex = -1;

            // 1) Try exact canonical match
            for (let i = 0; i < itemsArr.length; i++) {
              const it = itemsArr[i] || {};
              const canon = String(it.canonical || it.name || "")
                .toLowerCase()
                .trim();
              if (canon === prefCanonical) {
                chosenIndex = i;
                break;
              }
            }

            // 2) If not found, try partial match (e.g. "biryani" vs "Mutton Biryani")
            if (chosenIndex === -1 && prefCanonical.length >= 3) {
              for (let i = 0; i < itemsArr.length; i++) {
                const it = itemsArr[i] || {};
                const canon = String(it.canonical || it.name || "")
                  .toLowerCase()
                  .trim();
                if (
                  canon.includes(prefCanonical) ||
                  prefCanonical.includes(canon)
                ) {
                  chosenIndex = i;
                  break;
                }
              }
            }

            if (chosenIndex === -1) {
              // Can't safely map to a single line → keep it as manual note
              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text:
                  "👍 Got it — we’ve added this note for the store to see.\n" +
                  "They’ll adjust your order accordingly.",
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "preference_note_unmapped",
                msgId,
                orderId: activeOrderId,
                text,
                result,
              });

              continue;
            }

            const targetItem = itemsArr[chosenIndex] || {};
            const existingNotes = String(targetItem.notes || "").trim();
            const newNotes = existingNotes
              ? `${existingNotes}; ${prefNotes}`
              : prefNotes;

            itemsArr[chosenIndex] = {
              ...targetItem,
              notes: newNotes,
            };

            const { error: updErr } = await supa
              .from("orders")
              .update({ items: itemsArr })
              .eq("id", activeOrderId);

            if (updErr) {
              console.warn(
                "[WABA][preference_update save err]",
                updErr.message
              );

              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text: "👍 Got your preference. The store will review it with your order.",
              });

              await logFlowEvent({
                orgId: org.id,
                from,
                event: "preference_note_save_failed",
                msgId,
                orderId: activeOrderId,
                text,
                result,
              });

              continue;
            }

            const itemName =
              targetItem.canonical || targetItem.name || "that item";

            await sendWabaText({
              phoneNumberId,
              to: from,
              orgId: org.id,
              text: `👍 Got it — we’ll make your ${itemName} ${prefNotes}.`,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "preference_note_attached",
              msgId,
              orderId: activeOrderId,
              text,
              result: {
                prefCanonical,
                prefNotes,
                updatedIndex: chosenIndex,
              },
            });

            // IMPORTANT: do NOT treat this as a fresh order below
            continue;
          }

          //   if (!org.auto_reply_enabled) continue;

          const unmatchedOnly = extractCatalogUnmatchedOnly(
            result?.reason || ""
          );

          // Tiny acks like "ok", "no", "thanks" should not become fake items
          const tinyAckWords = new Set([
            "ok",
            "okay",
            "k",
            "kk",
            "thanks",
            "thank you",
            "thx",
            "no",
            "yes",
            "yup",
            "ya",
            "yeah",
          ]);
          const isTinyAck = tinyAckWords.has(lowerText);
          // 🔸 Prefer AI canonical (Egg Rice) over the shorter catalog label (Rice)
          function pickNiceUnmatchedLabel(
            result: any,
            unmatchedOnly: string[]
          ): string {
            const canonFromInquiry =
              typeof result.inquiry_canonical === "string"
                ? result.inquiry_canonical.trim()
                : "";

            if (canonFromInquiry) return canonFromInquiry;

            const fromReason = unmatchedOnly.join(", ").trim();
            if (fromReason) return fromReason;

            // Last fallback: use raw text if nothing else
            return (result.raw_text || "").slice(0, 80) || "that item";
          }

          if (
            !reply &&
            result.kind === "inquiry" &&
            unmatchedOnly.length &&
            !isTinyAck
          ) {
            const label = pickNiceUnmatchedLabel(result, unmatchedOnly);

            // 🔍 Try to suggest close product names (handles biryani/biriyani, sprit/sprite, etc.)
            const suggestions = await findFuzzyProductSuggestions({
              org_id: org.id,
              rawLabel: label,
              customer_phone: from,
              limit: 3,
            });

            if (suggestions.length) {
              const lines = suggestions.map(
                (s, idx) => `${idx + 1}) ${s.name}`
              );

              reply =
                `⚠️ I couldn’t find “${label}” exactly in today’s items.\n` +
                `Did you mean:\n` +
                lines.join("\n") +
                `\n\nIf none of these are correct, please type the exact item name, ` +
                `or type *agent* to talk to a human.`;
            } else {
              // Old fallback + gentle “talk to agent”
              if (activeOrderId) {
                reply =
                  `⚠️ Sorry, I couldn’t find “${label}” in today’s items.\n` +
                  "Your existing order is unchanged — the store will confirm if they can add it or suggest alternatives.\n\n" +
                  "If you’d like, type *agent* to talk to a human.";
              } else {
                reply =
                  `⚠️ Sorry, I couldn’t find “${label}” in today’s items.\n` +
                  "Please send a different item name or check the menu, and the store will help you.\n\n" +
                  "You can also type *agent* to talk to a human.";
              }
            }
          }

          const shouldForceMergeAfterAddress = lastCmd === "address_done";
          const canMerge =
            lastCmd !== "cancel" &&
            lastCmd !== "new" &&
            (looksLikeAddToExisting(text) || shouldForceMergeAfterAddress);
          // 1.5) If this is an order and there is a PREVIOUS open order,
          // MERGE when:
          //   - text clearly looks like "add more", OR
          //   - we JUST finished an address flow for this phone
          if (
            canMerge &&
            result.kind === "order" &&
            result.stored &&
            result.order_id &&
            Array.isArray(result.items)
          ) {
            const previousOpen = await findActiveOrderForPhoneExcluding(
              org.id,
              from,
              result.order_id
            );

            if (previousOpen && previousOpen.id) {
              const baseItems = (previousOpen.items || []) as any[];
              const newItems = (result.items || []) as any[];

              const mergedItems = [...baseItems, ...newItems];

              const { error: updErr } = await supa
                .from("orders")
                .update({ items: mergedItems })
                .eq("id", previousOpen.id);

              if (updErr) {
                console.warn("[WABA][merge update err]", updErr.message);
              } else {
                // Try to delete the temporary new order (best effort)
                const { error: delErr } = await supa
                  .from("orders")
                  .delete()
                  .eq("id", result.order_id);
                if (delErr) {
                  console.warn("[WABA][merge delete err]", delErr.message);
                }

                // Point the result at the merged/base order
                result.order_id = previousOpen.id;
                result.items = mergedItems;

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "merged_into_existing_order",
                  msgId,
                  orderId: previousOpen.id,
                  text,
                  result: {
                    mergedInto: previousOpen.id,
                    newOrderId: result.order_id,
                    addedItems: newItems.length,
                    baseItems: baseItems.length,
                  },
                });
              }
            }
          }
          // 2) Order path → either start multi-turn clarify OR
          //    (if no clarify) confirm + maybe open address session
          if (result.kind === "order" && result.stored && result.order_id) {
            lastCommandByPhone.delete(from);
            const items = (result.items || []) as any[];

            const needsAddress = needsAddressForOrg;

            const unmatchedItems = extractCatalogUnmatched(result.reason);
            const unmatchedNote =
              unmatchedItems.length > 0
                ? "\n\n⚠️ We couldn’t find these items in our list: " +
                  unmatchedItems.join(", ") +
                  ". The store will confirm or suggest alternatives."
                : "";

            const clarifyStart = await startClarifyForOrder({
              org_id: org.id,
              order_id: result.order_id,
              from_phone: from,
            });
            if (clarifyStart) {
              // L9: stage is already set to "awaiting_clarification" inside startClarifyForOrder
              reply = clarifyStart + unmatchedNote;
            } else {
              const summary = formatOrderSummary(items);

              if (!needsAddress) {
                reply = "✅ We’ve got your order:\n" + summary + unmatchedNote;

                // L9: order confirmed, no address → post_order
                await setConversationStage(org.id, from, "post_order", {
                  active_order_id: result.order_id,
                  last_action: "order_created_no_address_needed",
                });
              } else {
                const alreadyHasAddress = await hasAddressForOrder(
                  org.id,
                  from,
                  result.order_id
                );

                if (alreadyHasAddress) {
                  reply = "✅ Updated order:\n" + summary + unmatchedNote;

                  // L9: order + address → post_order
                  await setConversationStage(org.id, from, "post_order", {
                    active_order_id: result.order_id,
                    last_action: "order_created_address_already",
                  });
                } else {
                  await startAddressSessionForOrder({
                    org_id: org.id,
                    order_id: result.order_id,
                    from_phone: from,
                  });

                  reply =
                    "✅ We’ve got your order:\n" +
                    summary +
                    unmatchedNote +
                    "\n\n📍 Please share your delivery address (or send location) if you haven’t already.";
                  // stage for address is already set to "awaiting_address" in startAddressSessionForOrder
                }
              }
            }

            // ─────────────────────────────
            // Alias confirm: ONLY for clean single-item orders
            // ─────────────────────────────
            if (
              reply &&
              items.length === 1 &&
              !clarifyStart &&
              unmatchedItems.length === 0
            ) {
              try {
                const item = items[0] || {};

                // What the user actually typed for this item (best effort)
                const requestedLabelRaw =
                  (typeof item.raw_text === "string" && item.raw_text.trim()) ||
                  prettyLabelFromText(text);
                const requestedLabel = requestedLabelRaw
                  ? requestedLabelRaw.trim()
                  : "";

                // Canonical / product info from parser
                const canonicalFromItem =
                  typeof item.canonical === "string"
                    ? item.canonical.trim()
                    : "";
                const nameFromItem =
                  typeof item.name === "string" ? item.name.trim() : "";
                const productIdFromItem =
                  typeof item.product_id === "string" ? item.product_id : null;

                const canonical =
                  canonicalFromItem ||
                  nameFromItem ||
                  (result as any).canonical ||
                  "";

                // If we don't have a usable label or canonical, skip alias prompt
                if (!requestedLabel || !canonical) {
                  // do nothing
                } else if (!shouldAskAliasConfirm(requestedLabel, canonical)) {
                  // spelling is already close enough (biryani vs biriyani etc.)
                  // don't annoy user with YES/NO
                } else {
                  // 🔍 Prefer lookup by product_id from the item, then fall back to canonical search
                  let prod: any = null;
                  let prodErr: any = null;

                  if (productIdFromItem) {
                    const res = await supa
                      .from("products")
                      .select("id, display_name, canonical")
                      .eq("org_id", org.id)
                      .eq("id", productIdFromItem)
                      .maybeSingle();

                    prod = res.data;
                    prodErr = res.error;
                  } else {
                    const res = await supa
                      .from("products")
                      .select("id, display_name, canonical")
                      .eq("org_id", org.id)
                      .ilike("canonical", canonical)
                      .limit(1)
                      .maybeSingle();

                    prod = res.data;
                    prodErr = res.error;
                  }

                  if (!prodErr && prod && prod.id) {
                    const canonicalName = (
                      prod.display_name ||
                      prod.canonical ||
                      canonical ||
                      requestedLabel
                    ).trim();

                    const phoneKey = normalizePhoneForKey(from);
                    const wrongText = requestedLabel;
                    const normalizedWrong = normalizeLabelForFuzzy(wrongText);

                    pendingAliasConfirm.set(from, {
                      orgId: org.id,
                      customerPhone: phoneKey,
                      wrongText,
                      normalizedWrong,
                      canonicalProductId: prod.id,
                      canonicalName,
                    });

                    const aliasPrompt =
                      `When you say *${wrongText}*, should I treat it as ` +
                      `*${canonicalName}* from now on? Reply *YES* or *NO*.`;

                    reply = reply + "\n\n" + aliasPrompt;

                    await logFlowEvent({
                      orgId: org.id,
                      from,
                      event: "alias_confirm_prompted_order",
                      msgId,
                      orderId: result.order_id,
                      text,
                      result: {
                        wrongText,
                        canonicalName,
                        canonicalId: prod.id,
                      },
                    });
                  }
                }
              } catch (e: any) {
                console.warn("[ALIAS][prompt_order err]", e?.message || e);
              }
            }
          }

          // 3) Inquiry path → MENU or smart price/availability
          if (!reply && result.kind === "inquiry") {
            const inquiryRaw = result.inquiry || result.inquiry_type || null;
            const inquiryType = inquiryRaw
              ? String(inquiryRaw).toLowerCase()
              : null;

            // keep these in this scope so we can use them everywhere in this block
            const menuRegex =
              /\b(menu|price list|pricelist|rate card|ratecard|services list|service menu)\b/i;
            const looksLikeMenu = menuRegex.test(lowerText);

            // Quick special case: delivery time questions
            if (
              /deliver|delivery time|how much time.*deliver/i.test(lowerText)
            ) {
              reply =
                "⏱️ Delivery time depends on your area and current orders. The store will confirm an approximate time.";
            }

            // (A) --- MENU FLOW ---
            else if (inquiryType === "menu" || looksLikeMenu) {
              const menuText = await buildMenuReply({
                org_id: org.id,
                text,
                businessType: normalizeBusinessType(org.primary_business_type),
              });

              const fallbackText =
                menuText ||
                "📋 Our menu / price list changes often. We’ll share the latest options with you shortly.";

              const menuImageUrl = (org as any).wa_menu_image_url as
                | string
                | null;
              const menuCaption = (org as any).wa_menu_caption as string | null;

              if (menuImageUrl) {
                // Send menu image + caption
                await sendWabaText({
                  phoneNumberId,
                  to: from,
                  orgId: org.id,
                  image: menuImageUrl,
                  caption: menuCaption || fallbackText,
                });

                await logFlowEvent({
                  orgId: org.id,
                  from,
                  event: "menu_image_sent",
                  msgId,
                  text,
                  result: {
                    image: menuImageUrl,
                    caption: menuCaption || fallbackText,
                  },
                });

                // We already replied with the image
                reply = null;
              } else {
                // No image configured → text-only menu
                reply = fallbackText;
              }
            }

            // (B) --- SMART INQUIRY FLOW (price / availability / generic) ---
            else {
              reply = await buildSmartInquiryReply({
                org_id: org.id,
                text,
                inquiryType,
              });

              if (!reply) {
                reply =
                  "💬 Got your question. We’ll confirm the details shortly.";
              }
            }
          }

          // 3.9) If ingestCore already produced a direct reply, use it as fallback
          if (!reply && result && typeof result.reply === "string") {
            const trimmed = result.reply.trim();
            if (trimmed) {
              reply = trimmed;
            }
          }

          // 4) Heuristic question fallback (looks like inquiry but parser didn’t classify cleanly)
          if (
            !reply &&
            /price|rate|how much|available|stock|do you have/i.test(lowerText)
          ) {
            reply = makeGenericQuestionAck(tone);
          }
          // 5) Skip obvious small-talk
          if (
            !reply &&
            !result.stored &&
            result.reason === "small_talk_or_non_order"
          ) {
            reply = null;
          }

          // 5.5) If there is an active order and user text looks like "add more"
          // but parser didn't recognise it as a proper order,
          // guide them instead of sending a generic greeting.
          if (!reply && activeOrderId && looksLikeAddToExisting(text)) {
            reply =
              "👍 Got it — you want to add more items to your current order.\n" +
              "Please send the new items and quantities in one message";
          }

          // 6) Final fail-soft ack (safe + generic + commands)
          if (!reply) {
            const phoneKey = normalizePhoneForKey(from);
            const alreadySawTip = commandsTipShown.has(phoneKey);

            if (result.kind === "order") {
              // Only when parser really saw an order
              reply =
                "✅ We’ve received your order. We’ll follow up if anything needs clarification.";
            } else if (result.reason === "dropped:greeting_ack") {
              // short messages like "hi", "ok", "thanks"
              if (activeOrderId) {
                // 🔇 After an order is already active: don't spam another intro
                reply = null; // no WhatsApp message
              } else {
                // First-time greeting (no active order) → behave like intro
                const greet = makeGreeting(tone);
                if (!alreadySawTip) {
                  commandsTipShown.add(phoneKey);
                  reply =
                    greet +
                    "\n\n" +
                    "• To place an order, just type what you want in one message.\n" +
                    "• To see your orders, type: order summary\n" +
                    "• To talk to a human, type: agent\n" +
                    "• To cancel your last order, type: cancel";
                } else {
                  reply = greet;
                }
              }
            } else {
              // Other non-order, non-greeting messages → keep old generic behaviour
              const greet = makeGreeting(tone);

              if (!alreadySawTip) {
                commandsTipShown.add(phoneKey);
                reply =
                  greet +
                  "\n\n" +
                  "• To place an order, just type what you want in one message.\n" +
                  "• To see your orders, type: order summary\n" +
                  "• To talk to a human, type: agent\n" +
                  "• To cancel your last order, type: cancel";
              } else {
                reply = greet;
              }
            }
          }
          if (reply) {
            // 👇 PAIR: customer text + reply + core result
            console.log("[FLOW][PAIR]", {
              org_id: org.id,
              from,
              msgId,
              customer_text: text,
              bot_reply: reply,
              ingest_kind: result?.kind,
              ingest_reason: result?.reason,
              order_id: result?.order_id || null,
            });

            await sendWabaText({
              phoneNumberId,
              to: from,
              text: reply,
              orgId: org.id,
            });

            await logFlowEvent({
              orgId: org.id,
              from,
              event: "auto_reply_decided",
              msgId,
              orderId: result.order_id || null,
              text: reply,
              result: {
                kind: result.kind,
                reason: result.reason,
              },
            });
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (e: any) {
    console.error("[WABA][ERR]", e?.message || e);
    return res.sendStatus(200);
  }
});

// Log inbound-only message (when auto-reply is OFF for this customer)

// ─────────────────────────────
// Send via Cloud API + log to inbox
// ─────────────────────────────
async function sendWabaText(opts: {
  phoneNumberId: string;
  to: string;
  text?: string;
  image?: string; // <── NEW
  caption?: string; // <── NEW
  orgId?: string;
}) {
  const token = process.env.WA_ACCESS_TOKEN || process.env.META_WA_TOKEN;
  if (!token) {
    console.warn("[WABA] WA_ACCESS_TOKEN missing, cannot send reply");
    return;
  }

  const toNorm = opts.to.startsWith("+") ? opts.to : `+${opts.to}`;

  // 👇 SIMPLE OUTGOING LOG
  console.log("[FLOW][OUTGOING]", {
    org_id: opts.orgId || null,
    to: toNorm,
    phoneNumberId: opts.phoneNumberId,
    text: opts.text || null,
    image: opts.image || null,
  });

  // -------------------------------------------
  // 🚀 1) SEND IMAGE (NEW)
  // -------------------------------------------
  let payload: any;

  if (opts.image) {
    payload = {
      messaging_product: "whatsapp",
      to: toNorm,
      type: "image",
      image: {
        link: opts.image, // direct URL
        caption: opts.caption || opts.text || "",
      },
    };
  } else {
    // -------------------------------------------
    // 🚀 2) FALLBACK → TEXT (EXACT OLD LOGIC)
    // -------------------------------------------
    payload = {
      messaging_product: "whatsapp",
      to: toNorm,
      type: "text",
      text: { body: opts.text || "" },
    };
  }

  try {
    const resp = await axios.post(
      `${META_WA_BASE}/${opts.phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    // ------------------------------------------------
    // FLOW LOG (unchanged)
    // ------------------------------------------------
    if (opts.orgId) {
      try {
        await logFlowEvent({
          orgId: opts.orgId,
          from: toNorm.replace(/^\+/, ""),
          event: "auto_reply_sent",
          msgId:
            resp.data?.messages && resp.data.messages[0]?.id
              ? String(resp.data.messages[0].id)
              : undefined,
          text: opts.text,
          meta: {
            phoneNumberId: opts.phoneNumberId,
            image: opts.image || null,
          },
        });
      } catch (e: any) {
        console.warn("[WABA][FLOW_LOG_OUT_ERR]", e?.message || e);
      }
    }

    // ------------------------------------------------
    // INBOX MESSAGE LOGGING (unchanged)
    // ------------------------------------------------
    if (opts.orgId) {
      try {
        const { data: conv } = await supa
          .from("conversations")
          .select("id")
          .eq("org_id", opts.orgId)
          .eq("customer_phone", toNorm.replace(/^\+/, ""))
          .limit(1)
          .maybeSingle();

        let convId = conv?.id || null;

        if (!convId) {
          const { data: conv2 } = await supa
            .from("conversations")
            .select("id")
            .eq("org_id", opts.orgId)
            .eq("customer_phone", toNorm)
            .limit(1)
            .maybeSingle();
          convId = conv2?.id || null;
        }

        if (convId) {
          const wa_msg_id =
            resp.data?.messages && resp.data.messages[0]?.id
              ? String(resp.data.messages[0].id)
              : null;

          const bodyToStore = opts.image
            ? `[image sent] ${opts.caption || opts.text || ""}`
            : opts.text;

          const { error: msgErr } = await supa.from("messages").insert({
            org_id: opts.orgId,
            conversation_id: convId,
            direction: "out",
            sender_type: "ai",
            channel: "waba",
            body: bodyToStore,
            wa_msg_id,
          });

          if (msgErr) {
            console.warn("[INBOX][MSG out err]", msgErr.message);
          }
        }
      } catch (e: any) {
        console.warn("[INBOX][outbound log err]", e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn("[WABA][SEND_ERR]", e?.response?.data || e?.message || e);
  }
}
export default waba;
export { sendWabaText };
