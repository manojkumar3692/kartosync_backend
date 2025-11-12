// src/routes/ingest.ts

// === ANCHOR: IMPORTS_TOP ===
import express from 'express';
import crypto from 'crypto';
import { supa } from '../db';
import { ingestCoreFromMessage } from './ingestCore'; // Shared core pipeline

// (Only needed here for /test-ai)
import { parseOrder } from '../parser';
import { DateTime } from 'luxon';
import { isObviousPromoOrSpam, isPureGreetingOrAck, isNotOrderMessage } from '../util/notOrder';

// Optional AI parser (safe even if not used)
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
  // === ANCHOR: AI_WIRE_SETUP ===
  // Loading AI parser module once at startup
  // (If missing, system gracefully falls back to rules-only where used.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../ai/parser');
  aiParseOrder = (mod.aiParseOrder || mod.default?.aiParseOrder) as typeof aiParseOrder;
  console.log('[AI][wire] aiParseOrder loaded?', typeof aiParseOrder === 'function');
} catch (e) {
  console.warn('[AI][wire] load fail:', (e as any)?.message || e);
  aiParseOrder = undefined;
}

export const ingest = express.Router();

/** ───────────────── helpers (kept minimal here) ───────────────── **/

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

/** Verify HMAC over the RAW request body from Android bridge */
// === ANCHOR: VERIFY_HMAC ===
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

/** ───────────────── ROUTES ───────────────── **/

// (A) Simple health
// === ANCHOR: ROUTE_HEALTH ===
ingest.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// (B) Test route to directly exercise AI (no HMAC)
// NOTE: This is mostly for debugging models; it does NOT use ingestCore.
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

// (C) DIAGNOSTIC: notification listener ping
// === ANCHOR: ROUTE_NL_PING ===
ingest.post('/nl-ping', express.json(), async (_req, res) => {
  return res.json({ ok: true });
});

// (D) Primary ingest  [ENTRYPOINT FOR ANDROID BRIDGE]
// Thin wrapper: validate + resolve org → delegate to ingestCoreFromMessage
// === ANCHOR: ROUTE_LOCAL_INGEST_START ===
ingest.post(
  '/local',
  express.raw({ type: 'application/json', limit: '256kb' }),
  async (req: any, res: any) => {
    try {
      // 1) Read raw body bytes exactly as sent from mobile bridge
      let rawBuf: Buffer;
      if (Buffer.isBuffer(req.body)) rawBuf = req.body as Buffer;
      else if (typeof req.body === 'string')
        rawBuf = Buffer.from(req.body, 'utf8');
      else if (req.body && typeof req.body === 'object')
        rawBuf = Buffer.from(JSON.stringify(req.body), 'utf8');
      else
        return res.status(400).json({ error: 'empty_body' });

      const rawBodyStr = rawBuf.toString('utf8');
      console.log('[INGEST][RAW BODY]', rawBodyStr);

      // 2) Verify HMAC over raw body
      if (!verifyHmac(req, rawBuf)) {
        console.log('[INGEST][HMAC FAIL]');
        return res.status(401).json({ error: 'bad_signature' });
      }

      // 3) Parse JSON payload from bridge
      const parsedBody = JSON.parse(rawBodyStr || '{}');

      const org_phone = trim(parsedBody.org_phone);
      const textRaw = trim(parsedBody.text);
      const ts = Number(parsedBody.ts || Date.now());
      const from_name = trim(parsedBody.from_name);
      const from_phone = trim(parsedBody.from_phone);
      const msg_id = trim(parsedBody.msg_id || '');
      const edited_at = Number(parsedBody.edited_at || 0) || 0;

      console.log('[INGEST][RAW PAYLOAD]', {
        org_phone,
        text: parsedBody.text,
        textRaw,
        rawEscaped: (parsedBody.text || '').replace(/\n/g, '\\n'),
      });

      if (!org_phone || !textRaw) {
        return res
          .status(400)
          .json({ error: 'org_phone_and_text_required' });
      }

      // 4) Resolve org by wa_phone_number_id
      // === ANCHOR: ORG_LOOKUP_LOCAL ===
      const { data: orgs, error: orgErr } = await supa
        .from('orgs')
        .select('id, wa_phone_number_id')
        .eq('wa_phone_number_id', String(org_phone))
        .limit(1);

      if (orgErr) throw orgErr;
      const org = orgs?.[0];

      if (!org) {
        console.log('[INGEST][SKIP] org_not_found', {
          org_phone,
          text: textRaw,
        });
        return res.json({
          ok: true,
          stored: false,
          reason: 'org_not_found',
        });
      }

      console.log('[INGEST] org_ok', { orgId: org.id });

      // 5) Delegate to shared ingest core
      // This handles:
      // - AI + rules parsing
      // - multi-line list override
      // - inquiries (price/availability)
      // - merge / edit / dedupe / msg_id uniqueness
      // - learning (bvs + customer prefs)
      // === ANCHOR: CALL_INGEST_CORE_LOCAL ===
      const coreResult = await ingestCoreFromMessage({
        org_id: org.id,
        text: textRaw,
        ts,
        from_phone,
        from_name,
        msg_id: msg_id || null,
        edited_at: edited_at || null,
        source: 'local_bridge',
      });

      // 6) Return exactly what core decided
      return res.status(200).json(coreResult);
    } catch (e: any) {
      console.error('[INGEST][LOCAL]', e?.message || e);
      // Keep 200 so mobile app doesn't retry-loop aggressively
      return res.status(200).json({ ok: false, error: 'ingest_local_error' });
    }
  }
);

// === ANCHOR: EXPORT_DEFAULT ===
export default ingest;