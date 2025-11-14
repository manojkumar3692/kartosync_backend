// src/routes/ingestCore.ts
import { supa } from "../db";
import { parseOrder } from "../parser";
import { detectInquiry } from "../util/inquiry";
import {
  isObviousPromoOrSpam,
  isPureGreetingOrAck,
  isNotOrderMessage,
} from "../util/notOrder";

import { IngestInput, IngestResult, IngestSource, IngestItem } from "../types";
import { decideLinking } from "./ingestCore/linking"; // ⬅️ linking decision (append vs new)

// ─────────────────────────────────────────────────────────
// Optional AI parser hook (safe if missing → rules fallback)
// ─────────────────────────────────────────────────────────
let aiParseOrder:
  | undefined
  | ((
      text: string,
      catalog?: any,
      opts?: { org_id?: string; customer_phone?: string }
    ) => Promise<{
      items: any[];
      confidence?: number;
      reason?: string | null;
      is_order_like?: boolean;
      used?: "ai" | "rules";
    }>);

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../ai/parser");
  aiParseOrder = (mod.aiParseOrder ||
    mod.default?.aiParseOrder) as typeof aiParseOrder;
  console.log(
    "[AI][wire][core] aiParseOrder loaded?",
    typeof aiParseOrder === "function"
  );
} catch (e) {
  console.warn("[AI][wire][core] load fail:", (e as any)?.message || e);
  aiParseOrder = undefined;
}

/** ───────────────── helpers ───────────────── **/

const asStr = (v: any) =>
  typeof v === "string" ? v : v == null ? "" : String(v);
const trim = (v: any) => asStr(v).trim();

function normPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/[^\d]/g, "");
  return digits.length >= 7 ? plus + digits : null;
}

/** Dedup within the same minute (same org + same text + phone [+ msgId if present]) */
function makeDedupeKey(
  orgId: string,
  text: string,
  ts?: number,
  phone?: string | null,
  msgId?: string | null
) {
  const t = ts ? new Date(ts) : new Date();
  const bucket = new Date(
    Math.floor(t.getTime() / 60000) * 60000
  ).toISOString();
  const p = (phone || "").trim() || "_no_phone_";
  const m = (msgId || "").trim() || "_no_msg_";
  const crypto = require("crypto") as typeof import("crypto");
  return crypto
    .createHash("sha256")
    .update(`${orgId}|${p}|${m}|${text}|${bucket}`)
    .digest("hex");
}

/** ───────────────── line normalization & qty helpers ───────────────── **/

function stripNonItemPreamble(line: string): string {
  let s = line.trim();

  // Keep “add …” tails
  const addRe = /\b(?:can\s+you\s+)?add\s+(.*)$/i;
  const mAdd = s.match(addRe);
  if (mAdd && mAdd[1]) return mAdd[1].trim();

  // Remove common preambles
  s = s.replace(/^(hi|hello|hey)[,!\s]*/i, "");
  s = s.replace(/^can (you|u)\s+(please\s+)?(send|deliver|bring)\s*/i, "");
  s = s.replace(
    /^(i\s+want|i\s+need|please\s+send|pls\s+send|kindly\s+send)\s*/i,
    ""
  );
  s = s.replace(
    /^(and|also|sorry|one more thing|that's it|thats it)[:,]?\s*/i,
    ""
  );

  return s.trim();
}

// Used ONLY for shape detection & list-based fallback
function splitAndCleanLines(textRaw: string): string[] {
  return String(textRaw)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .map(stripNonItemPreamble)
    .map(
      (l) =>
        l
          .replace(/^[•\-\–—()\s]+/, "") // bullets/dashes/brackets
          .replace(/^\d+[\.\)]\s+/, "") // "1. " / "2) "
    )
    .filter(Boolean);
}

// Extract qty/unit from a single line
function parseInlineQtyUnit(s: string): {
  name: string;
  qty: number | null;
  unit: string | null;
} {
  const str = s.trim();

  // Leading qty: "2 kg rice", "1L milk"
  const lead = str.match(
    /^(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)?\b\s*(.+)$/i
  );
  if (lead) {
    const qty = Number(lead[1]);
    const unit = (lead[2] || "").toLowerCase() || null;
    const name = (lead[3] || "").trim();
    if (name) return { name, qty: Number.isFinite(qty) ? qty : null, unit };
  }

  // Trailing qty+unit: "apples 600 gms"
  const tailWithUnit = str.match(
    /\b(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)\b$/i
  );
  if (tailWithUnit) {
    const qty = Number(tailWithUnit[1]);
    const unit = tailWithUnit[2].toLowerCase();
    const name = str.replace(tailWithUnit[0], "").trim();
    return { name, qty: Number.isFinite(qty) ? qty : null, unit };
  }

  // Trailing bare number: "Idly batter small 3"
  const tailNum = str.match(/\b(\d+)\s*$/);
  if (tailNum) {
    const qty = Number(tailNum[1]);
    const name = str.replace(/\b(\d+)\s*$/, "").trim();
    return { name, qty: Number.isFinite(qty) ? qty : null, unit: null };
  }

  return { name: str, qty: null, unit: null };
}

function isPoliteNoiseLine(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (!t) return true;
  if (/^(hi|hello|hey|hlo|ok|okay|k|thanks|thank you|thanx|thx|sorry)$/.test(t))
    return true;
  if (/^(gm|gn|good (morning|evening|night|afternoon))$/.test(t)) return true;
  return false;
}

// Deterministic items from list lines
function buildLineItemsFromList(listLines: string[]) {
  return listLines
    .map((l) => {
      if (isPoliteNoiseLine(l)) return null;

      const { name, qty, unit } = parseInlineQtyUnit(l);
      const canonical = (name || "").trim();
      if (!canonical) return null;

      return {
        qty: Number.isFinite(qty as any) ? (qty as number) : 1,
        unit: unit ?? null,
        canonical,
        brand: null,
        variant: null,
        notes: null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

// Fallback for single-line / inline orders when AI under-fires.
// Example: "1kg onion and 0.5kg chicken"
function fallbackQtyItems(text: string): IngestItem[] {
  const items: IngestItem[] = [];
  if (!text) return items;

  // Split on newlines / commas / "and"
  const segments = text
    .split(/[\n,]/)
    .flatMap((s) => s.split(/\band\b/i))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const seg of segments) {
    const { name, qty, unit } = parseInlineQtyUnit(seg);
    const canonical = (name || "").trim();

    // We only treat as fallback order item if:
    //  - we have a name
    //  - AND a numeric qty (to avoid "do you have onion" etc.)
    if (!canonical) continue;
    if (qty == null || !Number.isFinite(qty as any)) continue;

    items.push({
      qty: qty as number,
      unit: unit ?? null,
      canonical,
      name: canonical,
      brand: null,
      variant: null,
      notes: null,
    });
  }

  return items;
}

/** ───────────────── Session + gating utilities ───────────────── **/

const INQUIRY_WINDOW_MIN = Number(process.env.INQUIRY_WINDOW_MIN || 1440); // 24h

function isLikelyPromoOrSpam(text: string) {
  if (isObviousPromoOrSpam(text)) return true;
  const t = (text || "").toLowerCase();
  if (
    /\b(unsubscribe|opt[-\s]?out|reply\s*stop|stop\s*to\s*opt[-\s]?out)\b/i.test(
      t
    )
  )
    return true;
  if (/\bterms\s+and\s+conditions\s+apply\b/i.test(t)) return true;
  if (
    /[🎉🎊📣✨💥🔥]/.test(t) &&
    /\b(offer|deal|sale|discount|voucher)\b/.test(t)
  )
    return true;
  return false;
}

async function findRecentInquiry(
  orgId: string,
  phone: string | null,
  minutes: number
) {
  if (!phone) return null;
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data, error } = await supa
    .from("orders")
    .select("id, raw_text, parse_reason, created_at")
    .eq("org_id", orgId)
    .eq("source_phone", phone)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    console.warn("[INGEST][findRecentInquiry]", error.message);
    return null;
  }
  return (data || []).find((r) =>
    String(r.parse_reason || "")
      .toLowerCase()
      .startsWith("inq:")
  );
}

async function findOrderByMsgId(
  orgId: string,
  phone: string | null,
  msgId: string
) {
  if (!msgId || !phone) return null;

  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, status, created_at, parse_reason, msg_id")
      .eq("org_id", orgId)
      .eq("source_phone", phone)
      .eq("msg_id", msgId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!error && data && data[0]) return data[0];
  } catch (e: any) {
    console.warn(
      "[INGEST][findOrderByMsgId] column path failed, trying legacy like()",
      e?.message || e
    );
  }

  try {
    const like = `msgid:${msgId}%`;
    const { data, error } = await supa
      .from("orders")
      .select("id, status, created_at, parse_reason")
      .eq("org_id", orgId)
      .eq("source_phone", phone)
      .like("parse_reason", like)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!error && data && data[0]) return data[0];
  } catch (e: any) {
    console.warn("[INGEST][findOrderByMsgId legacy]", e?.message || e);
  }

  return null;
}

async function existsOrderByMsgId(msgId: string) {
  if (!msgId) return null;
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id")
      .eq("msg_id", msgId)
      .limit(1);

    if (error) {
      console.warn("[INGEST][existsOrderByMsgId]", error.message);
      return null;
    }

    return data && data[0] ? data[0] : null;
  } catch (e: any) {
    console.warn("[INGEST][existsOrderByMsgId]", e?.message || e);
    return null;
  }
}

/** ───────────────── SMART ENRICH & CLARIFY ─────────────────
 *  1) enrichWithPrefs: BEFORE clarify — hydrate brand/variant
 *  2) maybeAutoSendClarify: AFTER storing — only for WABA
 *  These are small + safe. Skipped if tables/env not present.
 *  Where to call:
 *    - enrichWithPrefs → just after we know it's an ORDER (items exist),
 *      before append/new decision.
 *    - maybeAutoSendClarify → after APPEND and after NEW INSERT.
 *  ───────────────────────────────────────────────────────── */

function blank(v?: string | null) {
  return !v || !String(v).trim();
}

function itemNeedsClarify(it: any) {
  return blank(it?.brand) || blank(it?.variant);
}

async function enrichWithPrefs(
  orgId: string,
  phone: string | null,
  items: any[]
): Promise<{ items: any[]; applied: number }> {
  const out: any[] = [];
  let applied = 0;

  for (const it of items || []) {
    const base = { ...it };
    const canon = (base.canonical || base.name || "").trim();
    if (!canon) {
      out.push(base);
      continue;
    }

    let brandPref: string | null = null;
    let variantPref: string | null = null;

    // 1) per-customer pref (phone normalized w/o '+')
    if (phone) {
      const phonePlain = String(phone).replace(/^\+/, "");
      try {
        const { data: cp } = await supa
          .from("customer_prefs")
          .select("brand, variant, score")
          .eq("org_id", orgId)
          .eq("phone", phonePlain)
          .eq("canonical", canon)
          .order("score", { ascending: false })
          .limit(1);
        if (cp && cp[0]) {
          brandPref = (cp[0].brand || "").trim() || null;
          variantPref = (cp[0].variant || "").trim() || null;
        }
      } catch {}
    }

    // 2) global default (most common) if still missing
    if (!brandPref || !variantPref) {
      try {
        const { data: bvs } = await supa
          .from("brand_variant_stats")
          .select("brand, variant, score")
          .eq("org_id", orgId)
          .eq("canonical", canon)
          .order("score", { ascending: false })
          .limit(1);
        if (bvs && bvs[0]) {
          brandPref = brandPref || ((bvs[0].brand || "").trim() || null);
          variantPref = variantPref || ((bvs[0].variant || "").trim() || null);
        }
      } catch {}
    }

    // Apply only when missing—never override explicit inputs
    const hadBrand = (base.brand || "").trim() || null;
    const hadVar = (base.variant || "").trim() || null;
    if (!hadBrand && brandPref) {
      base.brand = brandPref;
      applied++;
    }
    if (!hadVar && variantPref) {
      base.variant = variantPref;
      applied++;
    }

    out.push(base);
  }

  return { items: out, applied };
}

async function maybeAutoSendClarify(
  orgId: string,
  orderId: string,
  source: IngestSource
) {
  try {
    // Only WABA should auto-send clarify (avoid spamming via personal WA)
    if (String(source) !== "waba") return;

    // debounce in last 15m
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    try {
      const { data: already } = await supa
        .from("outbound_logs")
        .select("id")
        .eq("org_id", orgId)
        .eq("order_id", orderId)
        .eq("kind", "clarify_bundle")
        .gte("created_at", fifteenMinAgo)
        .limit(1);
      if (already && already[0]) return;
    } catch {}

    const { data: order } = await supa
      .from("orders")
      .select("id, items, source_phone, customer_name, status, created_at")
      .eq("org_id", orgId)
      .eq("id", orderId)
      .single();

    if (!order || !Array.isArray(order.items)) return;
    if (!order.items.some(itemNeedsClarify)) return;
    if (!order.source_phone) return;

    // Build clarify text using your existing clarify-prompt endpoint (internal)
    if (!process.env.BASE_URL || !process.env.INTERNAL_JWT) return;
    // @ts-ignore (Node 18+ global fetch; otherwise skip)
    const resp = await fetch(
      `${process.env.BASE_URL}/api/orders/${orderId}/clarify-prompt`,
      { headers: { Authorization: `Bearer ${process.env.INTERNAL_JWT}` } }
    ).catch(() => null as any);

    const data = await resp?.json().catch(() => null as any);
    if (!data?.ok || !data?.text) return;

    // Log enqueue (replace with your WABA sender if wired)
    await supa.from("outbound_logs").insert({
      org_id: orgId,
      order_id: orderId,
      kind: "clarify_bundle",
      payload: { text: data.text, phone: order.source_phone },
    });

    // If you have a sender microservice, call it here instead of just logging.
    // e.g., await wabaSendText({ org_id: orgId, to: order.source_phone, text: data.text });
  } catch (e: any) {
    console.warn("[INGEST][autosend clarify] skipped:", e?.message || e);
  }
}

/** ───────────────── Parser pipeline ───────────────── **/

type ParsedPipeline = {
  used: "ai" | "rules";
  items: any[];
  confidence?: number;
  reason: string;
  is_order_like?: boolean;
};

async function parsePipeline(
  text: string,
  opts?: { org_id?: string; customer_phone?: string }
): Promise<ParsedPipeline> {
  const hasKey = !!process.env.OPENAI_API_KEY;
  const hasFn = typeof aiParseOrder === "function";
  const useAI = !!(hasFn && hasKey);

  console.log("[INGEST][AI gate]", {
    hasFn,
    hasKey,
    useAI,
    model: process.env.AI_MODEL,
    org_id: opts?.org_id || null,
    customer_phone: opts?.customer_phone || null,
  });

  if (useAI) {
    try {
      console.log("[INGEST][AI call] invoking aiParseOrder…");
      const ai = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(
        String(text),
        undefined,
        {
          org_id: opts?.org_id,
          customer_phone: opts?.customer_phone,
        }
      );

      const reason = ai?.reason || null;
      const itemCount = Array.isArray(ai?.items) ? ai.items.length : 0;

      console.log(
        `[AI used] ${
          process.env.AI_MODEL || "ai"
        } items: ${itemCount} reason: ${reason || "—"}`
      );
      console.log("[INGEST][AI result]", {
        is_order_like: ai?.is_order_like,
        items: itemCount,
        reason,
      });

      return {
        used: "ai",
        items: ai?.items || [],
        confidence:
          typeof ai?.confidence === "number" ? ai.confidence : undefined,
        reason: reason || (ai?.is_order_like === false ? "ai_not_order" : "ai"),
        is_order_like: ai?.is_order_like,
      };
    } catch (e: any) {
      console.warn(
        "[INGEST] AI parse failed, falling back to rules:",
        e?.message || e
      );
    }
  } else {
    console.log(
      "[INGEST][AI skip] useAI=false (hasFn=%s, hasKey=%s)",
      hasFn,
      hasKey
    );
  }

  const items = parseOrder(String(text)) || [];
  console.log("[INGEST][RULES] items:", items?.length || 0);
  return {
    used: "rules",
    items,
    confidence: undefined,
    reason: "rule_fallback",
    is_order_like: items.length > 0,
  };
}

async function upsertConversationAndInboundMessage(opts: {
  orgId: string;
  phoneNorm: string | null;
  customerName: string | null;
  source: IngestSource;
  text: string;
  msg_id?: string | null;
  raw?: any;
}) {
  try {
    // Without a phone we can't key a conversation reliably
    if (!opts.phoneNorm) {
      return;
    }

    // 1) Upsert conversation (one per org + phone)
    const { data: conv, error: convErr } = await supa
      .from("conversations")
      .upsert(
        {
          org_id: opts.orgId,
          customer_phone: opts.phoneNorm,
          customer_name: opts.customerName,
          source: opts.source,
          last_message_at: new Date().toISOString(),
          last_message_preview: opts.text.slice(0, 120),
        },
        { onConflict: "org_id,customer_phone" }
      )
      .select("id")
      .single();

    if (convErr || !conv) {
      console.warn("[INBOX][CONV upsert err]", convErr?.message);
      return;
    }

    // 2) Insert inbound message
    const { error: msgErr } = await supa.from("messages").insert({
      org_id: opts.orgId,
      conversation_id: conv.id,
      direction: "in",
      sender_type: "customer",
      channel: opts.source, // 'waba' | 'local_bridge' | ...
      body: opts.text,
      wa_msg_id: opts.msg_id || null,
      raw: opts.raw || null,
    });

    if (msgErr) {
      console.warn("[INBOX][MSG in err]", msgErr.message);
    }
  } catch (e: any) {
    console.warn("[INBOX][inbound err]", e?.message || e);
  }
}

/** ───────────────── CORE INGEST FUNCTION ───────────────── **/

/**
 * Core pipeline used by:
 *  - /api/ingest/local   (Android notification bridge)
 *  - /api/ingest/waba    (Meta Cloud API)
 *
 * Caller:
 *  1. Resolves org_id (e.g. from org_phone / WABA phone).
 *  2. Passes message payload into ingestCoreFromMessage.
 *  3. Uses returned IngestResult for HTTP response / UI.
 */

export async function ingestCoreFromMessage(
  input: IngestInput
): Promise<IngestResult> {
  console.log(
    `[INGEST-CORE] ← source=${input.source || "unknown"} org=${
      input.org_id
    } phone=${input.from_phone || "-"}`
  );
  try {
    const orgId = trim(input.org_id);
    const textRaw = trim(input.text);
    const ts = Number.isFinite(input.ts as any)
      ? (input.ts as number)
      : Date.now();
    const msg_id = trim(input.msg_id || "");
    const edited_at = Number(input.edited_at || 0) || 0;
    const from_name = trim(input.from_name || "");
    const from_phone_raw = trim(input.from_phone || "");
    const source = input.source || "other";

    if (!orgId || !textRaw) {
      return {
        ok: false,
        stored: false,
        kind: "none",
        error: "org_id_and_text_required",
        reason: "org_id_and_text_required",
      };
    }

    // 1) Line normalization and shape detection
    const rawLines0 = splitAndCleanLines(textRaw);
    console.log("[INGEST][core][dbg] rawLines0=", rawLines0);

    const listLines = rawLines0.filter((s) => {
      if (!s) return false;
      const t = s.trim().toLowerCase();
      if (!t) return false;
      if (
        /^(hi|hello|hey|hlo|ok|okay|k|thanks|thank you|thanx|thx|sorry)$/.test(
          t
        )
      )
        return false;
      if (/^(gm|gn|good (morning|evening|night|afternoon))$/.test(t))
        return false;
      return true;
    });

    const hasListShape = listLines.length >= 2;

    console.log(
      "[INGEST][core][dbg] listLines.len=",
      listLines.length,
      "listLines=",
      listLines
    );
    console.log("[INGEST][core][dbg] hasListShape=%s", hasListShape);

    const textFlat = rawLines0.join(" ") || textRaw;

    // 2) Normalize phone + customer name
    let phoneNorm = normPhone(from_phone_raw);

    let customerName: string | null = phoneNorm
      ? from_name || null
      : from_name || null;

    if (!phoneNorm && customerName) {
      const since = new Date(
        Date.now() - 14 * 24 * 60 * 60 * 1000
      ).toISOString();
      const { data: prev, error } = await supa
        .from("orders")
        .select("source_phone")
        .eq("org_id", orgId)
        .ilike("customer_name", customerName)
        .gte("created_at", since)
        .not("source_phone", "is", null)
        .limit(25);
      if (!error) {
        const uniq = Array.from(
          new Set(
            (prev || [])
              .map((r) => (r.source_phone || "").trim())
              .filter(Boolean)
          )
        );
        phoneNorm = uniq.length === 1 ? normPhone(uniq[0]) : null;
      }
    }

    console.log("[INGEST][core][phone]", {
      source,
      from_name,
      from_phone_raw,
      phoneNorm,
      customerName,
      msg_id: msg_id || undefined,
      edited_at: edited_at || undefined,
    });

    // 3) Fast gates
    if (isLikelyPromoOrSpam(textFlat)) {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: "none",
        reason: "dropped:promo_spam",
      };
    }

    if (!hasListShape && isPureGreetingOrAck(textFlat)) {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: "none",
        reason: "dropped:greeting_ack",
      };
    }

    // ─────────────────────────────────────────
    // [INBOX] Record inbound message for unified view
    // ─────────────────────────────────────────
    await upsertConversationAndInboundMessage({
      orgId,
      phoneNorm,
      customerName,
      source,
      text: textRaw,
      msg_id,
      raw: { source, ts },
    });

    // 4) Parse via hybrid pipeline (AI + rules) on ORIGINAL text
    let parsed = await parsePipeline(String(textRaw), {
      org_id: orgId,
      customer_phone: phoneNorm || undefined,
    });

    // 5) Multi-line list preference: if it looks like a list, prefer deterministic parsing
    if (hasListShape) {
      const lineItems = buildLineItemsFromList(listLines);
      if (lineItems.length >= 1) {
        parsed = {
          used: "rules",
          items: lineItems,
          confidence: 1,
          reason: "list_lines_preferred",
          is_order_like: true,
        };
        console.log("[INGEST][core][list_preferred]", {
          lines: listLines.length,
          items: lineItems.length,
        });
      }
    }

    // 5b) Single-line qty fallback
    if (!parsed.items || parsed.items.length === 0) {
      const fbItems = fallbackQtyItems(textFlat);
      if (fbItems.length) {
        parsed = {
          ...parsed,
          used: parsed.used || "rules",
          items: fbItems,
          is_order_like: true,
          reason: ((parsed.reason || "") + "; fallback_qty_parse").trim(),
        };
        console.log("[INGEST][core][fallback_qty]", {
          items: fbItems.length,
          text: textFlat,
        });
      }
    }

    // 6) Late small-talk gate (only when items still empty)
    if (!hasListShape && (!parsed.items || parsed.items.length === 0)) {
      if (parsed.is_order_like === false) {
        // let inquiry detection run next
      } else if (await isNotOrderMessage(textFlat, orgId)) {
        console.log(
          "[INGEST][core] skipped small-talk/non-order (late gate):",
          textFlat
        );
        return {
          ok: true,
          stored: false,
          kind: "none",
          used: parsed.used,
          reason: "small_talk_or_non_order",
        };
      }
    }

    // 7) Inquiry path
    let inquiry = null as ReturnType<typeof detectInquiry>;
    if ((!parsed.items || parsed.items.length === 0) && !hasListShape) {
      inquiry = detectInquiry(String(textFlat));
    }

    if (!parsed.items || parsed.items.length === 0) {
      if (!inquiry) {
        console.log("[INGEST][core][SKIP] not order & not inquiry", {
          reason: parsed.reason,
        });
        return {
          ok: true,
          stored: false,
          kind: "none",
          used: parsed.used,
          reason: "skipped_by_gate",
        };
      }

      // Avoid msg_id uniqueness collision on inquiry inserts
      if (msg_id) {
        const existingByMsg = await existsOrderByMsgId(msg_id);
        if (existingByMsg) {
          console.log("[INGEST][core][SKIP] duplicate-inquiry-msgid", {
            msg_id,
            order_id: existingByMsg.id,
          });
          return {
            ok: true,
            stored: false,
            kind: "none",
            used: "inquiry",
            reason: "duplicate_msgid",
            order_id: existingByMsg.id,
          };
        }
      }

      const dedupeKey = makeDedupeKey(
        orgId,
        String(textFlat),
        ts,
        phoneNorm,
        msg_id || null
      );
      const { data: existing2 } = await supa
        .from("orders")
        .select("id")
        .eq("org_id", orgId)
        .eq("dedupe_key", dedupeKey)
        .limit(1);
      if (existing2 && existing2[0]) {
        console.log("[INGEST][core][SKIP] duplicate-inquiry", {
          orgId,
          dedupeKey,
        });
        return {
          ok: true,
          stored: false,
          kind: "none",
          used: "inquiry",
          reason: "duplicate",
        };
      }

      const items = [
        {
          qty: null,
          unit: null,
          canonical: inquiry.canonical,
          brand: null,
          variant: null,
          notes: null,
        },
      ];

      const reasonTag =
        `inq:${inquiry.kind}` + (msg_id ? `; msgid:${msg_id}` : "");

      const { error: insInqErr, data: createdInquiry } = await supa
        .from("orders")
        .insert({
          org_id: orgId,
          source_phone: phoneNorm,
          customer_name: customerName,
          raw_text: textRaw,
          items,
          status: "pending",
          created_at: new Date(ts).toISOString(),
          dedupe_key: dedupeKey,
          parse_confidence: inquiry.confidence ?? null,
          parse_reason: reasonTag,
          msg_id: msg_id || null,
        })
        .select("id")
        .single();
      if (insInqErr) throw insInqErr;

      console.log("[INGEST][core] inquiry stored", {
        kind: inquiry.kind,
        id: createdInquiry?.id,
      });

      return {
        ok: true,
        stored: true,
        kind: "inquiry",
        used: "inquiry",
        inquiry: inquiry.kind,
        order_id: createdInquiry!.id,
        org_id: orgId,
        items,
        reason: reasonTag,
      };
    }

    // 8) ORDER path starts here

    // ⬇️ NEW: BEFORE anything, hydrate brand/variant from prefs (auto-learned)
    // WHY: If we can resolve brand/variant, we want to avoid sending clarify at all.
    try {
      const { items: hydrated, applied } = await enrichWithPrefs(
        orgId,
        phoneNorm,
        parsed.items || []
      );
      if (applied > 0) {
        parsed.items = hydrated;
        parsed.reason = ((parsed.reason || "") + "; prefs_hydrated").trim();
      }
    } catch (e: any) {
      console.warn("[INGEST][prefs_enrich warn]", e?.message || e);
    }
    // ⬆️ INSERTION POINT: right after items exist, before append/new decision.

    // Ignore seller-style money messages (heuristic)
    if (/\b(aed|dirham|dh|dhs|price|₹|rs|\$)\b/i.test(textFlat)) {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: parsed.used,
        reason: "seller_money_message",
      };
    }

    // If there is a recent inquiry and this isn't explicit confirmation, don't auto-place
    const recentInq = await findRecentInquiry(
      orgId,
      phoneNorm,
      INQUIRY_WINDOW_MIN
    );
    const looksConfirm =
      /\b(ok|okay|yes|confirm|place|book|send|need|take|buy)\b/i.test(
        textFlat
      ) ||
      /\b(\d+(\.\d+)?)\s?(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)\b/i.test(
        textFlat
      );

    if (recentInq && !looksConfirm) {
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: parsed.used,
        reason: "awaiting_explicit_confirmation",
      };
    }

    console.log("[INGEST][core] parsed order", {
      used: parsed.used,
      items: parsed.items.length,
      reason: parsed.reason || "—",
    });

    // EDIT handling (must run BEFORE append/new decision)
    const EDIT_WINDOW_MIN = 15;
    if (msg_id && phoneNorm && edited_at) {
      const target = await findOrderByMsgId(orgId, phoneNorm, msg_id);
      if (target && target.id) {
        const tCreated = new Date(target.created_at);
        const ageMin = (Date.now() - tCreated.getTime()) / 60000;
        if (ageMin <= EDIT_WINDOW_MIN) {
          const { error: upE } = await supa
            .from("orders")
            .update({
              items: parsed.items,
              parse_reason:
                (parsed.reason || "edited_replace") +
                `; msgid:${msg_id}; edited_at:${edited_at}`,
              parse_confidence: parsed.confidence ?? null,
              msg_id: msg_id,
            })
            .eq("id", target.id)
            .eq("org_id", orgId);
          if (upE) throw upE;

          // learning writes (non-fatal)
          try {
            for (const it of parsed.items) {
              const canon = trim(it.canonical || it.name || "");
              if (!canon) continue;
              const brand = (it.brand ?? "") + "";
              const variant = (it.variant ?? "") + "";
              const { error: eb } = await supa.rpc("upsert_bvs", {
                p_org_id: orgId,
                p_canonical: canon,
                p_brand: brand,
                p_variant: variant,
                p_inc: 1,
              });
              if (eb) console.warn("[INGEST][core][bvs err]", eb.message);
              if (phoneNorm) {
                const { error: ec } = await supa.rpc("upsert_customer_pref", {
                  p_org_id: orgId,
                  p_phone: phoneNorm,
                  p_canonical: canon,
                  p_brand: brand,
                  p_variant: variant,
                  p_inc: 1,
                });
                if (ec)
                  console.warn("[INGEST][core][custpref err]", ec.message);
              }
            }
          } catch (e: any) {
            console.warn("[INGEST][core][edit learn warn]", e?.message || e);
          }

          console.log(
            "[INGEST][core] edit -> replaced items in order",
            target.id
          );
          return {
            ok: true,
            stored: true,
            kind: "order",
            used: parsed.used,
            edited_order_id: target.id,
            order_id: target.id,
            items: parsed.items,
            org_id: orgId,
            reason: "edited_replace",
          };
        }
      }
    }

    // ─────────────────────────────────────────────────────────
    // Decide append vs new using last order snapshot
    // ─────────────────────────────────────────────────────────
    const phonePlain = String(phoneNorm || "").replace(/^\+/, "");
    const { data: lastRowsAny } = await supa
    .from("orders")
    .select("id, status, created_at")
    .eq("org_id", orgId)
    .or(`source_phone.eq.${phonePlain},source_phone.eq.+${phonePlain}`)
    .not("status", "in", ["cancelled_by_customer", "archived_for_new"])
    .order("created_at", { ascending: false })
    .limit(1);

    const lastAny = lastRowsAny?.[0] || null;

    const { action: linkAction, reason: linkReason } = decideLinking(
      lastAny
        ? {
            status: lastAny.status as any,
            last_inbound_at: lastAny.created_at,
            created_at: lastAny.created_at,
          }
        : null,
      textFlat
    );

    console.log(
      "[INGEST][link] action=%s last=%s",
      linkAction,
      lastAny?.id || "none"
    );

    // ─────────────────────────────────────────────────────────
    // Apply decision: append to last open order OR create a new one
    // ─────────────────────────────────────────────────────────
    if (
      linkAction === "append" &&
      lastAny &&
      !["shipped", "paid"].includes(String(lastAny.status))
    ) {
      // Append into lastAny
      const { data: curRow, error: curErr } = await supa
        .from("orders")
        .select("items, created_at")
        .eq("id", lastAny.id)
        .single();
      if (curErr) throw curErr;

      const newItems = [...(curRow?.items || []), ...parsed.items];

      const { error: upErr } = await supa
        .from("orders")
        .update({
          items: newItems,
          parse_reason:
            (parsed.reason ?? "merged_append") +
            (msg_id ? `; msgid:${msg_id}` : ""),
          parse_confidence: parsed.confidence ?? null,
          ...(msg_id ? { msg_id } : {}),
          order_link_reason: linkReason || "merged_append",
        })
        .eq("id", lastAny.id);

      if (upErr) throw upErr;

      // learning writes (non-fatal)
      try {
        for (const it of parsed.items) {
          const canon = trim(it.canonical || it.name || "");
          if (!canon) continue;
          const brand = (it.brand ?? "") + "";
          const variant = (it.variant ?? "") + "";
          const { error: eb } = await supa.rpc("upsert_bvs", {
            p_org_id: orgId,
            p_canonical: canon,
            p_brand: brand,
            p_variant: variant,
            p_inc: 1,
          });
          if (eb) console.warn("[INGEST][core][bvs err]", eb.message);
          if (phoneNorm) {
            const { error: ec } = await supa.rpc("upsert_customer_pref", {
              p_org_id: orgId,
              p_phone: phoneNorm, // normalized for consistency
              p_canonical: canon,
              p_brand: brand,
              p_variant: variant,
              p_inc: 1,
            });
            if (ec) console.warn("[INGEST][core][custpref err]", ec.message);
          }
        }
      } catch (e: any) {
        console.warn("[INGEST][core][append learn warn]", e?.message || e);
      }

      console.log("[INGEST][core] merged into", lastAny.id, "(APPENDED)");

      // ⬇️ NEW: AFTER append, maybe auto-send clarify (WABA only)
      await maybeAutoSendClarify(orgId, lastAny.id, source);

      return {
        ok: true,
        stored: true,
        kind: "order",
        used: parsed.used,
        merged_into: lastAny.id,
        order_id: lastAny.id,
        items: newItems,
        org_id: orgId,
        reason: "merged_append",
      };
    }

    // Otherwise → NEW order path (falls through to dedupe + insert)

    // New order dedupe
    const dedupeKey = makeDedupeKey(
      orgId,
      String(textFlat),
      ts,
      phoneNorm,
      msg_id || null
    );
    const { data: existing, error: exErr } = await supa
      .from("orders")
      .select("id")
      .eq("org_id", orgId)
      .eq("dedupe_key", dedupeKey)
      .limit(1);
    if (exErr) throw exErr;
    if (existing && existing[0]) {
      console.log("[INGEST][core][SKIP] duplicate", { orgId, dedupeKey });
      return {
        ok: true,
        stored: false,
        kind: "none",
        used: parsed.used,
        reason: "duplicate",
      };
    }

    // Guard against msg_id duplicate for orders
    if (msg_id) {
      const existingByMsg = await existsOrderByMsgId(msg_id);
      if (existingByMsg) {
        console.log("[INGEST][core][SKIP] duplicate-order-msgid", {
          msg_id,
          order_id: existingByMsg.id,
        });
        return {
          ok: true,
          stored: false,
          kind: "none",
          used: parsed.used,
          reason: "duplicate_msgid",
          order_id: existingByMsg.id,
        };
      }
    }

    // Insert NEW order
    const reasonTag =
      (parsed.reason ?? "") + (msg_id ? `; msgid:${msg_id}` : "");
    const { error: insErr, data: created } = await supa
      .from("orders")
      .insert({
        org_id: orgId,
        source_phone: phoneNorm,
        customer_name: customerName,
        raw_text: textRaw,
        items: parsed.items,
        status: "pending",
        created_at: new Date(ts).toISOString(),
        dedupe_key: dedupeKey,
        parse_confidence: parsed.confidence ?? null,
        parse_reason: reasonTag || null,
        msg_id: msg_id || null,
        order_link_reason: linkReason || "new",
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    console.log("[INGEST][core] stored NEW", { orgId, dedupeKey });

    // learning writes (non-fatal)
    try {
      for (const it of parsed.items) {
        const canon = trim(it.canonical || it.name || "");
        if (!canon) continue;
        const brand = (it.brand ?? "") + "";
        const variant = (it.variant ?? "") + "";
        const { error: eb } = await supa.rpc("upsert_bvs", {
          p_org_id: orgId,
          p_canonical: canon,
          p_brand: brand,
          p_variant: variant,
          p_inc: 1,
        });
        if (eb) console.warn("[INGEST][core][bvs err]", eb.message);
        if (phoneNorm) {
          const { error: ec } = await supa.rpc("upsert_customer_pref", {
            p_org_id: orgId,
            p_phone: phoneNorm,
            p_canonical: canon,
            p_brand: brand,
            p_variant: variant,
            p_inc: 1,
          });
          if (ec) console.warn("[INGEST][core][custpref err]", ec.message);
        }
      }
    } catch (e: any) {
      console.warn("[INGEST][core][learn non-fatal]", e?.message || e);
    }

    // ⬇️ NEW: AFTER new insert, maybe auto-send clarify (WABA only)
    await maybeAutoSendClarify(orgId, created!.id, source);

    return {
      ok: true,
      stored: true,
      kind: "order",
      used: parsed.used,
      order_id: created!.id,
      items: parsed.items,
      org_id: orgId,
      reason: parsed.reason,
    };
  } catch (e: any) {
    console.error("[INGEST][core] ERROR", e?.message || e);
    return {
      ok: false,
      stored: false,
      kind: "none",
      error: e?.message || "ingest_core_error",
      reason: "ingest_core_error",
    };
  }
}

// ─────────────────────────────────────────
// [INBOX] helpers: conversations + messages
// (intentionally placed elsewhere in your codebase)
// ─────────────────────────────────────────