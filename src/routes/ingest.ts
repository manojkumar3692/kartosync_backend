// src/routes/ingest.ts
import express from 'express';
import crypto from 'crypto';
import { supa } from '../db';
import { parseOrder } from '../parser';

// ⬇️ Optional AI parser (safe to keep even if you don't use AI yet)
let aiParseOrder:
  | undefined
  | ((text: string) => Promise<{ items: any[]; confidence?: number; reason?: string | null; is_order_like?: boolean }>);
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  aiParseOrder = require('../ai/parser').aiParseOrder;
} catch {
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

  // Debug logs (keep on while testing)
  console.log(
    '[INGEST] hmac recv=',
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
async function parsePipeline(text: string) {
  const useAI = !!(aiParseOrder && process.env.OPENAI_API_KEY);
  if (useAI) {
    try {
      const ai = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(String(text));
      if (ai && ai.is_order_like !== false && Array.isArray(ai.items) && ai.items.length > 0) {
        return { items: ai.items, confidence: ai.confidence, reason: ai.reason ?? null, used: 'ai' as const };
      }
    } catch (e) {
      console.warn('[INGEST] AI parse failed, falling back to rules:', (e as any)?.message || e);
    }
  }
  const items = parseOrder(String(text));
  return { items, confidence: undefined, reason: 'rule_fallback', used: 'rules' as const };
}

/** ───────────────── ROUTES ───────────────── **/

// 1) DIAGNOSTIC: notification-listener ping (called when the Android listener binds)
//    No auth/HMAC needed — it’s only a heartbeat.
ingest.post('/nl-ping', express.json(), async (req, res) => {
  const { org_phone, device, state, pkg, ts } = req.body || {};
  const when = ts ? new Date(ts).toISOString() : new Date().toISOString();
  console.log('[NL-PING]', { org_phone, device, state, pkg, when });
  return res.json({ ok: true });
});

// 2) Primary ingest (HMAC-verified, RAW body required)
ingest.post(
  '/local',
  express.raw({ type: 'application/json', limit: '256kb' }),
  async (req: any, res: any) => {
    try {
      // a) Get raw body bytes (stable for HMAC)
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

      // d) Find org by wa_phone_number_id (mapped to login phone at signup)
      const { data: orgs, error: orgErr } = await supa
        .from('orgs')
        .select('*')
        .eq('wa_phone_number_id', String(org_phone))
        .limit(1);

      if (orgErr) throw orgErr;
      const org = orgs?.[0];
      // in src/routes/ingest.ts, just before "return res.json({ ok: true, stored: false, reason: '...' })"
      console.log('[INGEST][SKIP]', { reason: 'no_items/org_not_found/duplicate', orgId: org?.id, text });
      if (!org) return res.json({ ok: true, stored: false, reason: 'org_not_found' });

      // e) Parse items
      const parsed = await parsePipeline(String(text));
      if (!parsed.items || parsed.items.length === 0) {
        return res.json({ ok: true, stored: false, reason: 'no_items' });
      }

      // f) Deduplicate
      const dedupeKey = makeDedupeKey(org.id, String(text), typeof ts === 'number' ? ts : undefined);
      const { data: existing, error: exErr } = await supa
        .from('orders')
        .select('id')
        .eq('org_id', org.id)
        .eq('dedupe_key', dedupeKey)
        .limit(1);
      if (exErr) throw exErr;
      if (existing && existing[0]) {
        // in src/routes/ingest.ts, just before "return res.json({ ok: true, stored: false, reason: '...' })"
        console.log('[INGEST][SKIP]', { reason: 'no_items/org_not_found/duplicate', orgId: org?.id, text });
        return res.json({ ok: true, stored: false, reason: 'duplicate' });
      }

      // g) Insert
      const { error: insErr } = await supa.from('orders').insert({
        org_id: org.id,
        source_phone: from || null,
        customer_name: null,
        raw_text: text,
        items: parsed.items,
        status: 'pending',
        created_at: ts ? new Date(ts).toISOString() : undefined,
        dedupe_key: dedupeKey,
        parse_confidence: parsed.confidence ?? null,
        parse_reason: parsed.reason ?? null,
      });
      if (insErr) throw insErr;

      return res.json({ ok: true, stored: true, used: parsed.used });
    } catch (e: any) {
      console.error('[INGEST]', e?.message || e);
      // Don’t cause retries/noise — respond 200 with ok:false
      return res.status(200).json({ ok: false });
    }
  }
);