// src/routes/ingest.ts
import express from 'express';
import crypto from 'crypto';
import { supa } from '../db';
import { parseOrder } from '../parser';
import { normalizePhone } from '../util/normalizePhone';

// ⬇️ Optional AI parser (safe to keep even if you don't use AI yet)
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

  // Compare as buffers
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

      console.log(`[AI used] ${process.env.AI_MODEL || 'ai'} items: ${itemCount} reason: ${reason || '—'}`);
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
          is_order_like: true,
        };
      }

      return {
        used: 'ai' as const,
        items: [],
        reason: reason || 'ai_decided_not_order',
        is_order_like: false,
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
    is_order_like: items && items.length > 0 ? true : false,
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
      customer_phone: normalizePhone(customer_phone || '') || undefined,
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
      const { org_phone, from, text, ts } = JSON.parse(rawBuf.toString('utf8') || '{}');
      if (!org_phone || !text) return res.status(400).json({ error: 'org_phone_and_text_required' });

      // d) Find org
      const { data: orgs, error: orgErr } = await supa
        .from('orgs')
        .select('*')
        .eq('wa_phone_number_id', String(org_phone))
        .limit(1);

      if (orgErr) throw orgErr;
      const org = orgs?.[0];

      if (!org) {
        console.log('[INGEST][SKIP] org_not_found', { org_phone, text });
        return res.json({ ok: true, stored: false, reason: 'org_not_found' });
      }
      console.log('[INGEST] org_ok', { orgId: org.id });

      // e) Normalize the "from" into a phone (if possible)
      //    Many senders arrive as contact names; this ensures orders.source_phone never stores a name.
      const phoneNorm = normalizePhone(from || '') || null;
      const customerName = phoneNorm ? null : (String(from || '').trim() || null);
      console.log('[INGEST][phone]', { raw_from: from, phoneNorm, customerName });

      // f) Parse via pipeline (AI preferred) — pass org_id & normalized customer_phone
      const parsed = await parsePipeline(String(text), {
        org_id: org.id,
        customer_phone: phoneNorm || undefined,
      });

      // Strict store gate
      if (parsed.used !== 'ai' || parsed.is_order_like === false || !parsed.items || parsed.items.length === 0) {
        console.log('[INGEST][SKIP] not_ai_or_not_order_like', {
          used: parsed.used,
          is_order_like: parsed.is_order_like,
          items: parsed.items?.length || 0,
          reason: parsed.reason,
        });
        return res.json({ ok: true, stored: false, reason: 'skipped_by_gate' });
      }

      console.log('[INGEST] parsed', {
        used: parsed.used,
        items: parsed.items.length,
        reason: parsed.reason || '—',
      });

      // g) Deduplicate
      const dedupeKey = makeDedupeKey(org.id, String(text), typeof ts === 'number' ? ts : undefined);
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

      // h) Insert order with normalized phone
      const { error: insErr } = await supa.from('orders').insert({
        org_id: org.id,
        source_phone: phoneNorm,            // ✅ store only normalized phone (or null)
        customer_name: customerName,        // ✅ if from was a name, store it here
        raw_text: text,
        items: parsed.items,
        status: 'pending',
        created_at: ts ? new Date(ts).toISOString() : undefined,
        dedupe_key: dedupeKey,
        parse_confidence: parsed.confidence ?? null,
        parse_reason: parsed.reason ?? null,
      });
      if (insErr) throw insErr;

      console.log('[INGEST] stored', { orgId: org.id, dedupeKey });
      return res.json({ ok: true, stored: true, used: parsed.used });
    } catch (e: any) {
      console.error('[INGEST]', e?.message || e);
      return res.status(200).json({ ok: false });
    }
  }
);

export default ingest;