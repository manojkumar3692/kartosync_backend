// src/routes/ingest.ts
import express from 'express';
import crypto from 'crypto';
import { supa } from '../db';
import { parseOrder } from '../parser';
import { detectInquiry } from '../util/inquiry';
import { DateTime } from 'luxon';
import { isNotOrderMessage } from '../util/notOrder';

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

  // Debug logs (keep while testing)
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

/** Dedup within the same minute (same org + same text) */
function makeDedupeKey(orgId: string, text: string, ts?: number) {
  const t = ts ? new Date(ts) : new Date();
  const bucket = new Date(Math.floor(t.getTime() / 60000) * 60000).toISOString();
  return crypto.createHash('sha256').update(`${orgId}|${text}|${bucket}`).digest('hex');
}

/** Try AI first (if configured), else fallback to rules */
async function parsePipeline(
  text: string,
  opts?: { org_id?: string; customer_phone?: string }
) {
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
      const ai = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(String(text), undefined, {
        org_id: opts?.org_id,
        customer_phone: opts?.customer_phone, // ← normalized phone (if available)
      });

      const reason = ai?.reason || null;
      const itemCount = Array.isArray(ai?.items) ? ai!.items.length : 0;

      console.log(
        `[AI used] ${process.env.AI_MODEL || 'ai'} items: ${itemCount} reason: ${reason || '—'}`
      );
      console.log('[INGEST][AI result]', {
        is_order_like: ai?.is_order_like,
        items: itemCount,
        reason,
      });

      if (ai && ai.is_order_like !== false && itemCount > 0) {
        return {
          used: 'ai' as const,
          items: ai.items,
          confidence: typeof ai.confidence === 'number' ? ai.confidence : undefined,
          reason,
        };
      }

      return {
        used: 'ai' as const,
        items: [],
        reason: reason || 'ai_decided_not_order',
      };
    } catch (e: any) {
      console.warn('[INGEST] AI parse failed, falling back to rules:', e?.message || e);
    }
  } else {
    console.log('[INGEST][AI skip] useAI=false (hasFn=%s, hasKey=%s)', hasFn, hasKey);
  }

  const items = parseOrder(String(text)) || [];
  console.log('[INGEST][RULES] items:', items?.length || 0);
  return {
    used: 'rules' as const,
    items,
    confidence: undefined,
    reason: 'rule_fallback',
  };
}

/** ───────────────── Session + gating utilities (NEW) ───────────────── **/

const INQUIRY_WINDOW_MIN = Number(process.env.INQUIRY_WINDOW_MIN || 1440); // 24h
const MERGE_WINDOW_MIN = Number(process.env.MERGE_WINDOW_MIN || 90);       // 90m
const ALLOW_DAY_CLUBBING = String(process.env.ALLOW_DAY_CLUBBING || 'true') === 'true';
const TIMEZONE = process.env.TIMEZONE || 'Asia/Dubai';
const CUT_OFF_LOCAL = (process.env.CUT_OFF_LOCAL || '18:00')
  .split(':')
  .map((n) => Number(n));

/** Promo/Spam guard */
function isLikelyPromoOrSpam(text: string) {
  const t = (text || '').toLowerCase();

  // opt-out semantics almost always => broadcast/promo
  if (/\b(unsubscribe|opt[-\s]?out|reply\s*stop|stop\s*to\s*opt[-\s]?out)\b/i.test(t)) return true;
  if (/\bterms\s+and\s+conditions\s+apply\b/i.test(t)) return true;

  // bank/telco/marketing common cues (extend as needed)
  const badWords = [
    'emirates nbd','emirates islamic','adcb','rakbank','mashreq','du','etisalat',
    'personal loan','loan offer','credit card','attractive interest','processing fees','insurance fees',
    'complimentary life insurance','deferment','pre-approved','cashback','special offer'
  ];
  if (badWords.some(w => t.includes(w))) return true;

  // Emoji-heavy promo + offer/sale lexicon
  if (/[🎉🎊📣✨💥🔥]/.test(t) && /\b(offer|deal|sale|discount|voucher)\b/.test(t)) return true;

  return false;
}

/** Greeting/Ack guard */
function isGreetingOrAck(text: string) {
  const t = (text || '').trim().toLowerCase();
  // ultra-short greetings
  if (['hi','hello','hey','ok','okay','thanks','thank you','tq','k','kk'].includes(t)) return true;

  // greeting starts without quantity/intent
  const looksGreeting = /^(hi|hello|hey|good\s+(morning|afternoon|evening)|ok(ay)?|thanks|thank you)\b/i.test(t);
  const hasQtyUnit = /\b(\d+(\.\d+)?)\s?(kg|g|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)\b/i.test(t);
  const hasIntent  = /\b(confirm|place|book|send|need|buy|take|deliver|order)\b/i.test(t);
  return looksGreeting && !(hasQtyUnit || hasIntent);
}

/** 2) Find most recent inquiry from this phone within window */
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
  return (data || []).find((r) => String(r.parse_reason || '').toLowerCase().startsWith('inq:')) || null;
}

/** 3) Decide whether to merge into an existing pending order */
function sameLocalDay(aISO: string, bISO: string, zone: string) {
  const a = DateTime.fromISO(aISO, { zone }); const b = DateTime.fromISO(bISO, { zone });
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
      { year: nowL.year, month: nowL.month, day: nowL.day, hour: CUT_OFF_LOCAL[0] || 18, minute: CUT_OFF_LOCAL[1] || 0 },
      { zone }
    );
    if (sameLocalDay(o.created_at, now.toISOString(), zone) && nowL < cutoffL) return o;
  }

  return null;
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
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });

    const hasFn = typeof aiParseOrder === 'function';
    const hasKey = !!process.env.OPENAI_API_KEY;
    const useAI = !!(hasFn && hasKey);
    console.log('[TEST-AI][gate]', { hasFn, hasKey, useAI, model: process.env.AI_MODEL });

    if (!useAI) {
      return res.json({
        ok: true,
        used: !hasFn ? 'rules-only (ai function not found)' : 'rules-only (no OPENAI key)',
      });
    }

    const out = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(String(text), undefined, {
      org_id: org_id || undefined,
      customer_phone: normPhone(customer_phone || '') || undefined,
    });

    console.log('[TEST-AI][result]', {
      is_order_like: out?.is_order_like,
      items: out?.items?.length,
      reason: out?.reason,
    });
    return res.json({ ok: true, used: `ai:${process.env.AI_MODEL || 'unknown'}`, out });
  } catch (e: any) {
    console.error('[TEST-AI]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'ai error' });
  }
});

// (C) DIAGNOSTIC: notification-listener ping
ingest.post('/nl-ping', express.json(), async (req, res) => {
  const { org_phone, device, state, pkg, ts } = req.body || {};
  const when = ts ? new Date(ts).toISOString() : new Date().toISOString();
  console.log('[NL-PING]', { org_phone, device, state, pkg, when });
  return res.json({ ok: true });
});

// (D) Primary ingest (HMAC-verified, RAW body required)
// Accepts BOTH the old shape { from } and the new shape { from_name, from_phone }
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

      // b) HMAC
      if (!verifyHmac(req, rawBuf)) return res.status(401).json({ error: 'bad_signature' });

      // c) Parse payload
      const parsedBody = JSON.parse(rawBuf.toString('utf8') || '{}');

      const org_phone = trim(parsedBody.org_phone);
      const text = trim(parsedBody.text);
      if (isNotOrderMessage(text)) {
        console.log('[INGEST] skipped small-talk:', text);
        return res.json({ ok: true, stored: false, reason: 'small_talk' });
      }
      const ts = Number(parsedBody.ts || Date.now());

      // NEW fields (preferred)
      const from_name = trim(parsedBody.from_name);
      const from_phone = trim(parsedBody.from_phone);

      // Back-compat field
      const legacy_from = trim(parsedBody.from);

      if (!org_phone || !text) {
        return res.status(400).json({ error: 'org_phone_and_text_required' });
      }

      // d) Find org (keep your existing column mapping)
      const { data: orgs, error: orgErr } = await supa
        .from('orgs')
        .select('id, wa_phone_number_id')
        .eq('wa_phone_number_id', String(org_phone))
        .limit(1);

      if (orgErr) throw orgErr;
      const org = orgs?.[0];

      if (!org) {
        console.log('[INGEST][SKIP] org_not_found', { org_phone, text });
        return res.json({ ok: true, stored: false, reason: 'org_not_found' });
      }
      console.log('[INGEST] org_ok', { orgId: org.id });

      // e) Normalize/resolve phone + name
      let phoneNorm =
        normPhone(from_phone) ||
        normPhone(legacy_from) || // sometimes old clients send number in "from"
        null;

      let customerName: string | null =
        phoneNorm ? (from_name || null) /* keep the pretty name if present */ : (from_name || legacy_from || null);

      // Fallback: if still no phone but we have a name, reuse last known phone for that name
      if (!phoneNorm && customerName) {
        const { data: prev } = await supa
          .from('orders')
          .select('source_phone')
          .eq('org_id', org.id)
          .ilike('customer_name', customerName)
          .order('created_at', { ascending: false })
          .limit(5);
        for (const r of prev || []) {
          const p = normPhone(r.source_phone);
          if (p) {
            phoneNorm = p;
            break;
          }
        }
      }

      console.log('[INGEST][phone]', {
        raw_from: legacy_from || from_name,
        from_name,
        from_phone,
        phoneNorm,
        customerName,
      });

      // ─────────────────────────────
      // NEW: hard gates (promo/greeting)
      // ─────────────────────────────
      if (isLikelyPromoOrSpam(text)) {
        return res.json({ ok: true, stored: false, reason: 'dropped:promo_spam' });
      }
      if (isGreetingOrAck(text)) {
        return res.json({ ok: true, stored: false, reason: 'dropped:greeting_ack' });
      }

      // f) Parse via pipeline (AI preferred) — pass org_id & normalized customer_phone
      const parsed = await parsePipeline(String(text), {
        org_id: org.id,
        customer_phone: phoneNorm || undefined,
      });

      // ───────────────────────────────────────────────────────────────────────
      // g) If NOT an order → try INQUIRY detection and store as inquiry row
      // ───────────────────────────────────────────────────────────────────────
      let inquiry = null as ReturnType<typeof detectInquiry>;
      if (!parsed.items || parsed.items.length === 0) {
        inquiry = detectInquiry(String(text));
      }

      if (!parsed.items || parsed.items.length === 0) {
        if (!inquiry) {
          console.log('[INGEST][SKIP] not order & not inquiry', { reason: parsed.reason });
          return res.json({ ok: true, stored: false, reason: 'skipped_by_gate' });
        }

        // dedupe on the same minute bucket
        const dedupeKey = makeDedupeKey(org.id, String(text), Number.isFinite(ts) ? ts : undefined);
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
            canonical: inquiry.canonical, // show in UI
            brand: null,
            variant: null,
            notes: null,
          },
        ];

        const { error: insInqErr, data: createdInquiry } = await supa
          .from('orders')
          .insert({
            org_id: org.id,
            source_phone: phoneNorm,     // may be null if we only had a name
            customer_name: customerName, // keep pretty name for WA reply UX
            raw_text: text,
            items,
            status: 'pending',
            created_at: Number.isFinite(ts) ? new Date(ts).toISOString() : undefined,
            dedupe_key: dedupeKey,
            parse_confidence: inquiry.confidence ?? null,
            parse_reason: `inq:${inquiry.kind}`, // <-- key flag the UI looks for
          })
          .select('id')
          .single();
        if (insInqErr) throw insInqErr;

        console.log('[INGEST] inquiry stored', {
          kind: inquiry.kind,
          canonical: inquiry.canonical,
          id: createdInquiry?.id,
        });

        // No learning writes for inquiries (they're not orders)
        return res.json({ ok: true, stored: true, used: 'inquiry', inquiry: inquiry.kind, order_id: createdInquiry?.id });
      }

      // ───────────────────────────────────────────────────────────────────────
      // h) ORDER path – gating + merge or new
      // ───────────────────────────────────────────────────────────────────────

      // 1) Seller money/price message should never create orders
      if (/\b(aed|dirham|dh|dhs|price|₹|rs|\$)\b/i.test(text)) {
        return res.json({ ok: true, stored: false, reason: 'seller_money_message' });
      }

      // 2) If there is a recent inquiry but this is NOT a confirmation, ignore as order
      const recentInq = await findRecentInquiry(org.id, phoneNorm, INQUIRY_WINDOW_MIN);
      const looksConfirm =
        /\b(ok|okay|yes|confirm|place|book|send|need|take|buy)\b/i.test(text) ||
        /\b(\d+(\.\d+)?)\s?(kg|g|l|ml|pack|packs|pc|pcs|piece|pieces|dozen)\b/i.test(text);

      if (recentInq && !looksConfirm) {
        return res.json({ ok: true, stored: false, reason: 'awaiting_explicit_confirmation' });
      }

      console.log('[INGEST] parsed', {
        used: parsed.used,
        items: parsed.items.length,
        reason: parsed.reason || '—',
      });

      // 3) Decide merge vs new
      const mergeInto = await pickMergeTarget(org.id, phoneNorm);

      if (mergeInto) {
        // Append to existing pending order
        const { data: cur, error: qErr } = await supa
          .from('orders')
          .select('items, created_at')
          .eq('id', mergeInto.id)
          .single();
        if (qErr) throw qErr;

        const newItems = [...(cur?.items || []), ...parsed.items];

        const { error: upErr } = await supa
          .from('orders')
          .update({
            items: newItems,
            parse_reason: parsed.reason ?? 'merged_append',
            parse_confidence: parsed.confidence ?? null,
          })
          .eq('id', mergeInto.id);
        if (upErr) throw upErr;

        // OPTIONAL CLEANUP: remove same-day inquiry rows for this phone (de-clutter board)
        if (phoneNorm) {
          const dayStart = DateTime.fromISO(cur?.created_at || new Date().toISOString(), { zone: TIMEZONE })
            .startOf('day')
            .toISO();
          const { error: delInqErr } = await supa
            .from('orders')
            .delete()
            .eq('org_id', org.id)
            .eq('source_phone', phoneNorm)
            .like('parse_reason', 'inq:%')
            .gte('created_at', dayStart || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
          if (delInqErr) console.warn('[INGEST][merge] inquiry cleanup warn:', delInqErr.message);
        }

        // Learning writes for appended items
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

        console.log('[INGEST] merged into', mergeInto.id);
        return res.json({ ok: true, stored: true, merged_into: mergeInto.id });
      }

      // i) Deduplicate for a NEW order insert
      const dedupeKey = makeDedupeKey(org.id, String(text), Number.isFinite(ts) ? ts : undefined);
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

      // j) Insert NEW order with normalized phone + name
      const { error: insErr, data: created } = await supa
        .from('orders')
        .insert({
          org_id: org.id,
          source_phone: phoneNorm,     // ✅ normalized phone (or null)
          customer_name: customerName, // ✅ display name when available
          raw_text: text,
          items: parsed.items,
          status: 'pending',
          created_at: Number.isFinite(ts) ? new Date(ts).toISOString() : undefined,
          dedupe_key: dedupeKey,
          parse_confidence: parsed.confidence ?? null,
          parse_reason: parsed.reason ?? null,
        })
        .select('id')
        .single();
      if (insErr) throw insErr;

      console.log('[INGEST] stored', { orgId: org.id, dedupeKey });

      // k) Learning writes (store-level + per-customer if phone known)
      try {
        for (const it of parsed.items) {
          const canon = trim(it.canonical || it.name || '');
          if (!canon) continue;
          const brand = (it.brand ?? '') + '';     // '' = generic ok
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