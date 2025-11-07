// src/routes/ingest.ts
import express from 'express';
import crypto from 'crypto';
import { supa } from '../db';
import { parseOrder } from '../parser';
import { detectInquiry } from '../util/inquiry';
import { DateTime } from 'luxon';
import { isObviousPromoOrSpam, isPureGreetingOrAck, isNotOrderMessage } from '../util/notOrder';

// ⬇️ Optional AI parser (safe even if not used)
let aiParseOrder:
  | undefined
  | ((text: string, catalog?: any, opts?: { org_id?: string; customer_phone?: string }) => Promise<{
      items: any[];
      confidence?: number;
      reason?: string | null;
      is_order_like?: boolean;
      used?: 'ai' | 'rules';
    }>);

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../ai/parser');
  aiParseOrder = (mod.aiParseOrder || mod.default?.aiParseOrder) as typeof aiParseOrder;
  console.log('[AI][wire] aiParseOrder loaded?', typeof aiParseOrder === 'function');
} catch (e) {
  console.warn('[AI][wire] load fail:', (e as any)?.message || e);
  aiParseOrder = undefined;
}

export const ingest = express.Router();

/** ───────────────── helpers ───────────────── **/

const asStr = (v: any) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const trim = (v: any) => asStr(v).trim();

function normPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const plus = s.startsWith('+') ? '+' : '';
  const digits = s.replace(/[^\d]/g, '');
  return digits.length >= 7 ? plus + digits : null;
}

function timingSafeEq(a: Buffer, b: Buffer) {
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Verify HMAC over the RAW request body */
function verifyHmac(req: any, rawBuf: Buffer) {
  const secret = process.env.MOBILE_INGEST_SECRET || '';
  const sig = (req.header('X-Signature') || '').trim();
  if (!secret || !sig) return false;

  const computed = crypto.createHmac('sha256', secret).update(rawBuf).digest('hex');

  console.log(
    '[INGEST] HMAC recv=',
    sig.slice(0, 8),
    '…',
    sig.slice(-6),
    ' calc=',
    computed.slice(0, 8),
    '…',
    computed.slice(-6),
    ' len=',
    rawBuf.length
  );

  return timingSafeEq(Buffer.from(computed), Buffer.from(sig));
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
  const bucket = new Date(Math.floor(t.getTime() / 60000) * 60000).toISOString();
  const p = (phone || '').trim() || '_no_phone_';
  const m = (msgId || '').trim() || '_no_msg_';
  return crypto.createHash('sha256').update(`${orgId}|${p}|${m}|${text}|${bucket}`).digest('hex');
}

/** ───────────────── line normalization & qty helpers ───────────────── **/

function stripNonItemPreamble(line: string): string {
  let s = line.trim();

  // Keep “add …” tails
  const addRe = /\b(?:can\s+you\s+)?add\s+(.*)$/i;
  const mAdd = s.match(addRe);
  if (mAdd && mAdd[1]) return mAdd[1].trim();

  // Remove common preambles
  s = s.replace(/^(hi|hello|hey)[,!\s]*/i, '');
  s = s.replace(/^can (you|u)\s+(please\s+)?(send|deliver|bring)\s*/i, '');
  s = s.replace(/^(i\s+want|i\s+need|please\s+send|pls\s+send|kindly\s+send)\s*/i, '');
  s = s.replace(/^(and|also|sorry|one more thing|that's it|thats it)[:,]?\s*/i, '');

  return s.trim();
}

// IMPORTANT ANCHOR: line cleaning used ONLY for list detection / fallback
function splitAndCleanLines(textRaw: string): string[] {
  return String(textRaw)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .map(stripNonItemPreamble)
    .map((l) =>
      l
        .replace(/^[•\-\–—()\s]+/, '') // bullets/dashes/brackets
        .replace(/^\d+[\.\)]\s+/, '') // enumerators "1. " / "2) "
    )
    .filter(Boolean);
}

// Extract qty/unit from a single line
function parseInlineQtyUnit(
  s: string
): { name: string; qty: number | null; unit: string | null } {
  let str = s.trim();

  // Leading qty (optional unit): "2 kg rice", "2 tea powder", "1L milk"
  const lead = str.match(
    /^(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)?\b\s*(.+)$/i
  );
  if (lead) {
    const qty = Number(lead[1]);
    const unit = (lead[2] || '').toLowerCase() || null;
    const name = (lead[3] || '').trim();
    if (name) return { name, qty: Number.isFinite(qty) ? qty : null, unit };
  }

  // Trailing qty+unit: "apples 600 gms", "milk 1 L"
  const tailWithUnit = str.match(
    /\b(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)\b$/i
  );
  if (tailWithUnit) {
    const qty = Number(tailWithUnit[1]);
    const unit = tailWithUnit[2].toLowerCase();
    const name = str.replace(tailWithUnit[0], '').trim();
    return { name, qty: Number.isFinite(qty) ? qty : null, unit };
  }

  // Trailing bare number: "Idly batter small 3"
  const tailNum = str.match(/\b(\d+)\s*$/);
  if (tailNum) {
    const qty = Number(tailNum[1]);
    const name = str.replace(/\b(\d+)\s*$/, '').trim();
    return { name, qty: Number.isFinite(qty) ? qty : null, unit: null };
  }

  return { name: str, qty: null, unit: null };
}


function isPoliteNoiseLine(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (!t) return true;
  if (
    /^(hi|hello|hey|hlo|ok|okay|k|thanks|thank you|thanx|thx|sorry)$/.test(t)
  ) return true;
  if (/^(gm|gn|good (morning|evening|night|afternoon))$/.test(t)) return true;
  return false;
}

// Build deterministic items from visible list lines
function buildLineItemsFromList(listLines: string[]) {
  return listLines
    .map((l) => {
      if (isPoliteNoiseLine(l)) return null; // extra safety

      const { name, qty, unit } = parseInlineQtyUnit(l);
      const canonical = (name || '').trim();
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

/** ───────────────── Session + gating utilities ───────────────── **/

const INQUIRY_WINDOW_MIN = Number(process.env.INQUIRY_WINDOW_MIN || 1440); // 24h
const MERGE_WINDOW_MIN = Number(process.env.MERGE_WINDOW_MIN || 90); // 90m
const ALLOW_DAY_CLUBBING = String(process.env.ALLOW_DAY_CLUBBING || 'true') === 'true';
const TIMEZONE = process.env.TIMEZONE || 'Asia/Dubai';
const CUT_OFF_LOCAL = (process.env.CUT_OFF_LOCAL || '18:00')
  .split(':')
  .map((n) => Number(n));

function isLikelyPromoOrSpam(text: string) {
  const t = (text || '').toLowerCase();

  if (/\b(unsubscribe|opt[-\s]?out|reply\s*stop|stop\s*to\s*opt[-\s]?out)\b/i.test(t)) return true;
  if (/\bterms\s+and\s+conditions\s+apply\b/i.test(t)) return true;

  const badWords = [
    'emirates nbd',
    'emirates islamic',
    'adcb',
    'rakbank',
    'mashreq',
    'du',
    'etisalat',
    'personal loan',
    'loan offer',
    'credit card',
    'attractive interest',
    'processing fees',
    'insurance fees',
    'complimentary life insurance',
    'deferment',
    'pre-approved',
    'cashback',
    'special offer',
  ];
  if (badWords.some((w) => t.includes(w))) return true;

  if (/[🎉🎊📣✨💥🔥]/.test(t) && /\b(offer|deal|sale|discount|voucher)\b/.test(t)) return true;

  return false;
}

async function findRecentInquiry(orgId: string, phone: string | null, minutes: number) {
  if (!phone) return null;
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data, error } = await supa
    .from('orders')
    .select('id, raw_text, parse_reason, created_at')
    .eq('org_id', orgId)
    .eq('source_phone', phone)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    console.warn('[INGEST][findRecentInquiry]', error.message);
    return null;
  }
  return (data || []).find((r) =>
    String(r.parse_reason || '').toLowerCase().startsWith('inq:')
  );
}

function sameLocalDay(aISO: string, bISO: string, zone: string) {
  const a = DateTime.fromISO(aISO, { zone });
  const b = DateTime.fromISO(bISO, { zone });
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

async function pickMergeTarget(orgId: string, phone: string | null) {
  if (!phone) return null;
  const { data, error } = await supa
    .from('orders')
    .select('id, status, created_at')
    .eq('org_id', orgId)
    .eq('source_phone', phone)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('[INGEST][pickMergeTarget]', error.message);
    return null;
  }
  const o = data?.[0];
  if (!o) return null;
  if (o.status === 'shipped' || o.status === 'paid') return null;

  const now = new Date();
  const created = new Date(o.created_at);
  const deltaMin = (now.getTime() - created.getTime()) / 60000;

  if (deltaMin <= MERGE_WINDOW_MIN) return o;

  if (ALLOW_DAY_CLUBBING) {
    const zone = TIMEZONE;
    const nowL = DateTime.fromJSDate(now, { zone });
    const cutoffL = DateTime.fromObject(
      {
        year: nowL.year,
        month: nowL.month,
        day: nowL.day,
        hour: CUT_OFF_LOCAL[0] || 18,
        minute: CUT_OFF_LOCAL[1] || 0,
      },
      { zone }
    );
    if (sameLocalDay(o.created_at, now.toISOString(), zone) && nowL < cutoffL) return o;
  }

  return null;
}

async function findOrderByMsgId(
  orgId: string,
  phone: string | null,
  msgId: string
) {
  if (!msgId || !phone) return null;

  try {
    const { data, error } = await supa
      .from('orders')
      .select('id, status, created_at, parse_reason, msg_id')
      .eq('org_id', orgId)
      .eq('source_phone', phone)
      .eq('msg_id', msgId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!error && data && data[0]) return data[0];
  } catch (e: any) {
    console.warn(
      '[INGEST][findOrderByMsgId] column path failed, trying legacy like()',
      e?.message || e
    );
  }

  try {
    const like = `msgid:${msgId}%`;
    const { data, error } = await supa
      .from('orders')
      .select('id, status, created_at, parse_reason')
      .eq('org_id', orgId)
      .eq('source_phone', phone)
      .like('parse_reason', like)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!error && data && data[0]) return data[0];
  } catch (e: any) {
    console.warn('[INGEST][findOrderByMsgId legacy]', e?.message || e);
  }

  return null;
}

/** ───────────────── Parser pipeline used by ingest ───────────────── **/

type ParsedPipeline = {
  used: 'ai' | 'rules';
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
  const hasFn = typeof aiParseOrder === 'function';
  const useAI = !!(hasFn && hasKey);

  console.log('[INGEST][AI gate]', {
    hasFn,
    hasKey,
    useAI,
    model: process.env.AI_MODEL,
    org_id: opts?.org_id || null,
    customer_phone: opts?.customer_phone || null,
  });

  if (useAI) {
    try {
      console.log('[INGEST][AI call] invoking aiParseOrder…');
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
        `[AI used] ${process.env.AI_MODEL || 'ai'} items: ${itemCount} reason: ${
          reason || '—'
        }`
      );
      console.log('[INGEST][AI result]', {
        is_order_like: ai?.is_order_like,
        items: itemCount,
        reason,
      });

      return {
        used: 'ai',
        items: ai?.items || [],
        confidence:
          typeof ai?.confidence === 'number' ? ai.confidence : undefined,
        reason: reason || (ai?.is_order_like === false ? 'ai_not_order' : 'ai'),
        is_order_like: ai?.is_order_like,
      };
    } catch (e: any) {
      console.warn(
        '[INGEST] AI parse failed, falling back to rules:',
        e?.message || e
      );
    }
  } else {
    console.log(
      '[INGEST][AI skip] useAI=false (hasFn=%s, hasKey=%s)',
      hasFn,
      hasKey
    );
  }

  const items = parseOrder(String(text)) || [];
  console.log('[INGEST][RULES] items:', items?.length || 0);
  return {
    used: 'rules',
    items,
    confidence: undefined,
    reason: 'rule_fallback',
    is_order_like: items.length > 0,
  };
}

/** ───────────────── ROUTES ───────────────── **/

// (A) Simple health
ingest.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// (B) Test route to directly exercise AI (no HMAC)
ingest.post('/test-ai', express.json(), async (req, res) => {
  try {
    const { text, org_id, customer_phone } = req.body || {};
    if (!text)
      return res.status(400).json({ ok: false, error: 'text required' });

    const hasFn = typeof aiParseOrder === 'function';
    const hasKey = !!process.env.OPENAI_API_KEY;
    const useAI = !!(hasFn && hasKey);
    console.log('[TEST-AI][gate]', {
      hasFn,
      hasKey,
      useAI,
      model: process.env.AI_MODEL,
    });

    if (!useAI) {
      return res.json({
        ok: true,
        used: !hasFn
          ? 'rules-only (ai function not found)'
          : 'rules-only (no OPENAI key)',
      });
    }

    const out = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(
      String(text),
      undefined,
      {
        org_id: org_id || undefined,
        customer_phone: normPhone(customer_phone || '') || undefined,
      }
    );

    console.log('[TEST-AI][result]', {
      is_order_like: out?.is_order_like,
      items: out?.items?.length,
      reason: out?.reason,
    });
    return res.json({
      ok: true,
      used: `ai:${process.env.AI_MODEL || 'unknown'}`,
      out,
    });
  } catch (e: any) {
    console.error('[TEST-AI]', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || 'ai error' });
  }
});

// (C) DIAGNOSTIC
ingest.post('/nl-ping', express.json(), async (_req, res) => {
  return res.json({ ok: true });
});

// (D) Primary ingest  [ENTRYPOINT FOR WEBHOOK]
ingest.post(
  '/local',
  express.raw({ type: 'application/json', limit: '256kb' }),
  async (req: any, res: any) => {
    try {
      // a) Raw body bytes
      let rawBuf: Buffer;
      if (Buffer.isBuffer(req.body)) rawBuf = req.body as Buffer;
      else if (typeof req.body === 'string') rawBuf = Buffer.from(req.body, 'utf8');
      else if (req.body && typeof req.body === 'object') rawBuf = Buffer.from(JSON.stringify(req.body), 'utf8');
      else return res.status(400).json({ error: 'empty_body' });

      // DEBUG: show exactly what backend received from bridge
      const rawBodyStr = rawBuf.toString('utf8');
      console.log('[INGEST][RAW BODY]', rawBodyStr);

      // b) HMAC (must be over RAW body)
      if (!verifyHmac(req, rawBuf)) {
        console.log('[INGEST][HMAC FAIL]');
        return res.status(401).json({ error: 'bad_signature' });
      }

      // c) Parse payload JSON
      const parsedBody = JSON.parse(rawBodyStr || '{}');

      const org_phone = trim(parsedBody.org_phone);
      const textRaw = trim(parsedBody.text);
      const ts = Number(parsedBody.ts || Date.now());

      // Log parsed fields, including escaped newlines so we can see if multi-line arrived
      console.log('[INGEST][RAW PAYLOAD]', {
        org_phone,
        text: parsedBody.text,
        textRaw,
        rawEscaped: (parsedBody.text || '').replace(/\n/g, '\\n'),
      });

      const from_name = trim(parsedBody.from_name);
      const from_phone = trim(parsedBody.from_phone);
      const msg_id = trim(parsedBody.msg_id || '');
      const edited_at = Number(parsedBody.edited_at || 0);
      const legacy_from = trim(parsedBody.from);

      if (!org_phone || !textRaw) {
        return res.status(400).json({ error: 'org_phone_and_text_required' });
      }

      // ───── 1) Normalize lines for shape detection / list override ─────
      const rawLines0 = splitAndCleanLines(textRaw);
      console.log('[INGEST][dbg] rawLines0=', rawLines0);

      const listLines = rawLines0.filter((s) => {
        if (!s) return false;
        const t = s.trim().toLowerCase();
        if (!t) return false;
      
        // Pure greeting / ack / polite noise lines → do NOT treat as order lines
        if (
          /^(hi|hello|hey|hlo|ok|okay|k|thanks|thank you|thanx|thx|sorry)$/.test(t)
        ) return false;
      
        if (
          /^(gm|gn|good (morning|evening|night|afternoon))$/.test(t)
        ) return false;
      
        return true;
      });
      
      const hasListShape = listLines.length >= 2;

      console.log('[INGEST][dbg] listLines.len=', listLines.length, 'listLines=', listLines);
      console.log('[INGEST][dbg] hasListShape=%s', hasListShape);

      // Squashed version for gates; ORIGINAL textRaw goes to AI
      const textFlat = rawLines0.join(' ') || textRaw;

      // ───── 2) Find org ─────
      const { data: orgs, error: orgErr } = await supa
        .from('orgs')
        .select('id, wa_phone_number_id')
        .eq('wa_phone_number_id', String(org_phone))
        .limit(1);
      if (orgErr) throw orgErr;
      const org = orgs?.[0];
      if (!org) {
        console.log('[INGEST][SKIP] org_not_found', { org_phone, text: textFlat });
        return res.json({ ok: true, stored: false, reason: 'org_not_found' });
      }
      console.log('[INGEST] org_ok', { orgId: org.id });

      // ───── 3) Normalize/resolve phone + name ─────
      let phoneNorm = normPhone(from_phone) || normPhone(legacy_from) || null;

      let customerName: string | null =
        phoneNorm ? (from_name || null) : (from_name || legacy_from || null);

      if (!phoneNorm && customerName) {
        const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const { data: prev, error } = await supa
          .from('orders')
          .select('source_phone')
          .eq('org_id', org.id)
          .ilike('customer_name', customerName)
          .gte('created_at', since)
          .not('source_phone', 'is', null)
          .limit(25);
        if (!error) {
          const uniq = Array.from(
            new Set((prev || []).map((r) => (r.source_phone || '').trim()).filter(Boolean))
          );
          phoneNorm = uniq.length === 1 ? normPhone(uniq[0]) : null;
        }
      }

      console.log('[INGEST][phone]', {
        raw_from: legacy_from || from_name,
        from_name,
        from_phone,
        phoneNorm,
        customerName,
        msg_id: msg_id || undefined,
        edited_at: edited_at || undefined,
      });

      // ───── 4) Fast gates ─────
      if (isLikelyPromoOrSpam(textFlat)) {
        return res.json({ ok: true, stored: false, reason: 'dropped:promo_spam' });
      }
      if (!hasListShape && isPureGreetingOrAck(textFlat)) {
        return res.json({ ok: true, stored: false, reason: 'dropped:greeting_ack' });
      }

      // ───── 5) Parse via pipeline (AI + rules) using ORIGINAL text ─────
      let parsed = await parsePipeline(String(textRaw), {
        org_id: org.id,
        customer_phone: phoneNorm || undefined,
      });

      // ───── 6) Multi-line list override (if AI under-fires) ─────
      if (hasListShape) {
        const lineItems = buildLineItemsFromList(listLines);
        if (lineItems.length >= 2 && (parsed.items?.length || 0) < lineItems.length) {
          const reason = (parsed.reason ? parsed.reason + '; ' : '') + 'list_lines_override';
          parsed = {
            used: parsed.used,
            items: lineItems,
            confidence: parsed.confidence,
            reason,
            is_order_like: true,
          };
          console.log('[INGEST][list_override]', {
            lines: listLines.length,
            items: lineItems.length,
          });
        }
      }

      // ───── 7) Late small-talk gate (only if still no items & not list) ─────
      if (!hasListShape && (!parsed.items || parsed.items.length === 0)) {
        if (parsed.is_order_like === false) {
          // let inquiry detection handle it below
        } else if (await isNotOrderMessage(textFlat, org.id)) {
          console.log('[INGEST] skipped small-talk/non-order (late gate):', textFlat);
          return res.json({
            ok: true,
            stored: false,
            reason: 'small_talk_or_non_order',
          });
        }
      }

      // ───── 8) Inquiry path ─────
      let inquiry = null as ReturnType<typeof detectInquiry>;
      if ((!parsed.items || parsed.items.length === 0) && !hasListShape) {
        inquiry = detectInquiry(String(textFlat));
      }

      if (!parsed.items || parsed.items.length === 0) {
        if (!inquiry) {
          console.log('[INGEST][SKIP] not order & not inquiry', { reason: parsed.reason });
          return res.json({ ok: true, stored: false, reason: 'skipped_by_gate' });
        }

        const dedupeKey = makeDedupeKey(
          org.id,
          String(textFlat),
          Number.isFinite(ts) ? ts : undefined,
          phoneNorm,
          msg_id || null
        );
        const { data: existing2 } = await supa
          .from('orders')
          .select('id')
          .eq('org_id', org.id)
          .eq('dedupe_key', dedupeKey)
          .limit(1);
        if (existing2 && existing2[0]) {
          console.log('[INGEST][SKIP] duplicate-inquiry', { orgId: org.id, dedupeKey });
          return res.json({ ok: true, stored: false, reason: 'duplicate' });
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
          `inq:${inquiry.kind}` + (msg_id ? `; msgid:${msg_id}` : '');

        const { error: insInqErr, data: createdInquiry } = await supa
          .from('orders')
          .insert({
            org_id: org.id,
            source_phone: phoneNorm,
            customer_name: customerName,
            raw_text: textRaw,
            items,
            status: 'pending',
            created_at: Number.isFinite(ts) ? new Date(ts).toISOString() : undefined,
            dedupe_key: dedupeKey,
            parse_confidence: inquiry.confidence ?? null,
            parse_reason: reasonTag,
            msg_id: msg_id || null,
          })
          .select('id')
          .single();
        if (insInqErr) throw insInqErr;

        console.log('[INGEST] inquiry stored', {
          kind: inquiry.kind,
          id: createdInquiry?.id,
        });
        return res.json({
          ok: true,
          stored: true,
          used: 'inquiry',
          inquiry: inquiry.kind,
          order_id: createdInquiry?.id,
        });
      }

      // ───── 9) ORDER path ─────

      // Ignore pure price/money replies from seller
      if (/\b(aed|dirham|dh|dhs|price|₹|rs|\$)\b/i.test(textFlat)) {
        return res.json({
          ok: true,
          stored: false,
          reason: 'seller_money_message',
        });
      }

      // If there is a recent inquiry and this is not explicit confirm, do not auto-create
      const recentInq = await findRecentInquiry(org.id, phoneNorm, INQUIRY_WINDOW_MIN);
      const looksConfirm =
        /\b(ok|okay|yes|confirm|place|book|send|need|take|buy)\b/i.test(textFlat) ||
        /\b(\d+(\.\d+)?)\s?(kg|g|gm|gms|gram|grams|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)\b/i.test(
          textFlat
        );

      if (recentInq && !looksConfirm) {
        return res.json({
          ok: true,
          stored: false,
          reason: 'awaiting_explicit_confirmation',
        });
      }

      console.log('[INGEST] parsed', {
        used: parsed.used,
        items: parsed.items.length,
        reason: parsed.reason || '—',
      });

      // EDIT handling (within EDIT_WINDOW_MIN)
      const EDIT_WINDOW_MIN = 15;
      if (msg_id && phoneNorm && edited_at) {
        const target = await findOrderByMsgId(org.id, phoneNorm, msg_id);
        if (target && target.id) {
          const tCreated = new Date(target.created_at);
          const ageMin = (Date.now() - tCreated.getTime()) / 60000;
          if (ageMin <= EDIT_WINDOW_MIN) {
            const { error: upE } = await supa
              .from('orders')
              .update({
                items: parsed.items,
                parse_reason:
                  (parsed.reason || 'edited_replace') +
                  `; msgid:${msg_id}; edited_at:${edited_at}`,
                parse_confidence: parsed.confidence ?? null,
                msg_id: msg_id,
              })
              .eq('id', target.id)
              .eq('org_id', org.id);
            if (upE) throw upE;

            // learning writes (non-fatal)
            try {
              for (const it of parsed.items) {
                const canon = trim(it.canonical || it.name || '');
                if (!canon) continue;
                const brand = (it.brand ?? '') + '';
                const variant = (it.variant ?? '') + '';
                const { error: eb } = await supa.rpc('upsert_bvs', {
                  p_org_id: org.id,
                  p_canonical: canon,
                  p_brand: brand,
                  p_variant: variant,
                  p_inc: 1,
                });
                if (eb) console.warn('[INGEST][bvs err]', eb.message);
                if (phoneNorm) {
                  const { error: ec } = await supa.rpc('upsert_customer_pref', {
                    p_org_id: org.id,
                    p_phone: phoneNorm,
                    p_canonical: canon,
                    p_brand: brand,
                    p_variant: variant,
                    p_inc: 1,
                  });
                  if (ec) console.warn('[INGEST][custpref err]', ec.message);
                }
              }
            } catch (e: any) {
              console.warn('[INGEST][edit learn warn]', e?.message || e);
            }

            console.log('[INGEST] edit -> replaced items in order', target.id);
            return res.json({
              ok: true,
              stored: true,
              edited_order_id: target.id,
              reason: 'edited_replace',
            });
          }
        }
      }

      // Merge vs new
      const mergeInto = phoneNorm ? await pickMergeTarget(org.id, phoneNorm) : null;

      if (mergeInto) {
        const { data: cur, error: qErr } = await supa
          .from('orders')
          .select('items, created_at')
          .eq('id', mergeInto.id)
          .single();
        if (qErr) throw qErr;

        const newItems = edited_at ? [...parsed.items] : [...(cur?.items || []), ...parsed.items];

        const { error: upErr } = await supa
          .from('orders')
          .update({
            items: newItems,
            parse_reason:
              (parsed.reason ??
                (edited_at ? 'edited_replace' : 'merged_append')) +
              (msg_id ? `; msgid:${msg_id}` : ''),
            parse_confidence: parsed.confidence ?? null,
            ...(msg_id ? { msg_id } : {}),
          })
          .eq('id', mergeInto.id);
        if (upErr) throw upErr;

        // cleanup same-day inquiries
        if (phoneNorm) {
          const dayStart = DateTime.fromISO(
            cur?.created_at || new Date().toISOString(),
            { zone: TIMEZONE }
          )
            .startOf('day')
            .toISO();
          const { error: delInqErr } = await supa
            .from('orders')
            .delete()
            .eq('org_id', org.id)
            .eq('source_phone', phoneNorm)
            .like('parse_reason', 'inq:%')
            .gte(
              'created_at',
              dayStart ||
                new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
            );
          if (delInqErr)
            console.warn('[INGEST][merge] inquiry cleanup warn:', delInqErr.message);
        }

        // learning writes (non-fatal)
        try {
          for (const it of parsed.items) {
            const canon = trim(it.canonical || it.name || '');
            if (!canon) continue;
            const brand = (it.brand ?? '') + '';
            const variant = (it.variant ?? '') + '';
            const { error: eb } = await supa.rpc('upsert_bvs', {
              p_org_id: org.id,
              p_canonical: canon,
              p_brand: brand,
              p_variant: variant,
              p_inc: 1,
            });
            if (eb) console.warn('[INGEST][bvs err]', eb.message);
            if (phoneNorm) {
              const { error: ec } = await supa.rpc('upsert_customer_pref', {
                p_org_id: org.id,
                p_phone: phoneNorm,
                p_canonical: canon,
                p_brand: brand,
                p_variant: variant,
                p_inc: 1,
              });
              if (ec) console.warn('[INGEST][custpref err]', ec.message);
            }
          }
        } catch (e: any) {
          console.warn('[INGEST][merge learn warn]', e?.message || e);
        }

        console.log(
          '[INGEST] merged into',
          mergeInto.id,
          edited_at ? '(REPLACED due to edit)' : '(APPENDED)'
        );
        return res.json({
          ok: true,
          stored: true,
          merged_into: mergeInto.id,
          reason: edited_at ? 'edited_replace' : 'merged_append',
        });
      }

      // New order dedupe
      const dedupeKey = makeDedupeKey(
        org.id,
        String(textFlat),
        Number.isFinite(ts) ? ts : undefined,
        phoneNorm,
        msg_id || null
      );
      const { data: existing, error: exErr } = await supa
        .from('orders')
        .select('id')
        .eq('org_id', org.id)
        .eq('dedupe_key', dedupeKey)
        .limit(1);
      if (exErr) throw exErr;
      if (existing && existing[0]) {
        console.log('[INGEST][SKIP] duplicate', { orgId: org.id, dedupeKey });
        return res.json({ ok: true, stored: false, reason: 'duplicate' });
      }

      // Insert NEW order
      const reasonTag =
        (parsed.reason ?? '') + (msg_id ? `; msgid:${msg_id}` : '');
      const { error: insErr, data: created } = await supa
        .from('orders')
        .insert({
          org_id: org.id,
          source_phone: phoneNorm,
          customer_name: customerName,
          raw_text: textRaw,
          items: parsed.items,
          status: 'pending',
          created_at: Number.isFinite(ts) ? new Date(ts).toISOString() : undefined,
          dedupe_key: dedupeKey,
          parse_confidence: parsed.confidence ?? null,
          parse_reason: reasonTag || null,
          msg_id: msg_id || null,
        })
        .select('id')
        .single();
      if (insErr) throw insErr;

      console.log('[INGEST] stored', { orgId: org.id, dedupeKey });

      // learning writes (non-fatal)
      try {
        for (const it of parsed.items) {
          const canon = trim(it.canonical || it.name || '');
          if (!canon) continue;
          const brand = (it.brand ?? '') + '';
          const variant = (it.variant ?? '') + '';
          const { error: eb } = await supa.rpc('upsert_bvs', {
            p_org_id: org.id,
            p_canonical: canon,
            p_brand: brand,
            p_variant: variant,
            p_inc: 1,
          });
          if (eb) console.warn('[INGEST][bvs err]', eb.message);
          if (phoneNorm) {
            const { error: ec } = await supa.rpc('upsert_customer_pref', {
              p_org_id: org.id,
              p_phone: phoneNorm,
              p_canonical: canon,
              p_brand: brand,
              p_variant: variant,
              p_inc: 1,
            });
            if (ec) console.warn('[INGEST][custpref err]', ec.message);
          }
        }
      } catch (e: any) {
        console.warn('[INGEST][learn non-fatal]', e?.message || e);
      }

      return res.json({
        ok: true,
        stored: true,
        order_id: created?.id,
        used: parsed.used,
        reason: parsed.reason,
      });
    } catch (e: any) {
      console.error('[INGEST]', e?.message || e);
      return res.status(200).json({ ok: false });
    }
  }
);

export default ingest;