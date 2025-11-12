// src/routes/waba.ts
import express from 'express';
import axios from 'axios';
import { supa } from '../db';
import { ingestCoreFromMessage } from './ingestCore';
import { findBestProductForText, getLatestPrice } from '../util/products';

export const waba = express.Router();

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const META_WA_BASE = 'https://graph.facebook.com/v21.0';

waba.all('/ping', (_req, res) => res.json({ ok: true, where: 'waba' }));

// Simple hit logger so you can confirm mount path
waba.use((req, _res, next) => {
  console.log('[WABA][ROUTER HIT]', req.method, req.path);
  next();
});

// ─────────────────────────────
// 1) Webhook verification (GET)
// (router is mounted at /webhook/whatsapp or /api/waba/webhook;
// we keep our internal path as "/")
// ─────────────────────────────
waba.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[WABA][VERIFY]', { mode, token_ok: token === META_VERIFY_TOKEN });

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('[WABA] webhook verified');
    return res.status(200).send(challenge);
  }

  console.log('[WABA] webhook verify failed');
  return res.sendStatus(403);
});

// ─────────────────────────────
// Helper: smart reply for price / availability inquiries
// ─────────────────────────────
async function buildSmartInquiryReply(opts: {
  org_id: string;
  text: string;
  inquiryType?: string | null;
}) {
  const { org_id, text } = opts;
  const inquiryType = (opts.inquiryType || '').toLowerCase() || null;

  const product = await findBestProductForText(org_id, text);
  if (!product) {
    if (inquiryType === 'price') {
      return '💬 Got your price question. We’ll confirm the exact price shortly.';
    }
    if (inquiryType === 'availability') {
      return '💬 Got your availability question. We’ll confirm stock shortly.';
    }
    return null;
  }

  if (inquiryType === 'price') {
    const latest = await getLatestPrice(org_id, product.id);
    if (latest) {
      const unit = product.base_unit || 'unit';
      return `💸 ${product.display_name} is currently ${latest.price} ${latest.currency} per ${unit}.`;
    }
    return `💸 We do have ${product.display_name}. Today’s price changes often — we’ll confirm it for you now.`;
  }

  if (inquiryType === 'availability') {
    return `✅ Yes, we have ${product.display_name} available.`;
  }

  return null;
}

// ─────────────────────────────
// Helper: auto-clarification for ambiguous items (per org)
// • Asks ONLY when the org has 2+ non-empty variants for that canonical
// • Asks ONLY if the item actually appears in the user's original text
// • De-dupes by canonical and caps to 3 prompts
// ─────────────────────────────
async function buildClarifyTextForItems(
  result: any,
  originalText: string
): Promise<string | null> {
  if (!result || result.kind !== 'order' || !Array.isArray(result.items) || !result.org_id) {
    return null;
  }

  const org_id = String(result.org_id);
  const t = (originalText || '').toLowerCase();
  const prompts: string[] = [];
  const seenCanon = new Set<string>();
  const MAX_ASK = 3;

  for (const it of result.items) {
    const label = String(it?.canonical || it?.name || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    if (!label || seenCanon.has(label)) continue;
    seenCanon.add(label);

    // Only clarify if user actually mentioned this token in the text
    const mentioned =
      t.includes(` ${label} `) ||
      t.startsWith(`${label} `) ||
      t.endsWith(` ${label}`) ||
      t === label;
    if (!mentioned) continue;

    // Query variants scoped to org & canonical; ignore null/blank variants
    const { data, error } = await supa
      .from('products')
      .select('variant')
      .eq('org_id', org_id)
      .eq('canonical', label)
      .not('variant', 'is', null);

    if (error) {
      console.warn('[WABA][clarify products err]', error.message);
      continue;
    }

    const unique = Array.from(
      new Set(
        (data || [])
          .map((r: any) => String(r?.variant || '').trim())
          .filter(Boolean)
      )
    );

    // Only ask if we truly have choices configured
    if (unique.length >= 2) {
      prompts.push(`For ${label}, which one do you prefer? (${unique.join(', ')})`);
      if (prompts.length >= MAX_ASK) break; // avoid long walls of text
    }
  }

  if (!prompts.length) return null;

  return `Quick question before we pack your order:\n${prompts.map((p) => `• ${p}`).join('\n')}`;
}

// ─────────────────────────────
// 2) Incoming messages (POST)
// ─────────────────────────────
waba.post('/', async (req, res) => {
  try {
    console.log('[WABA][RAW BODY]', JSON.stringify(req.body));

    const body = req.body;
    if (!body || !body.entry) {
      console.log('[WABA] no entry in body');
      return res.sendStatus(200);
    }

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const metadata = value.metadata || {};
        const phoneNumberId = metadata.phone_number_id as string | undefined;

        console.log('[WABA][ENTRY]', {
          phoneNumberId,
          messages_len: messages.length,
        });

        if (!phoneNumberId || messages.length === 0) continue;

        // Find org by WABA phone_number_id
        const { data: orgs, error: orgErr } = await supa
          .from('orgs')
          .select('id, name, ingest_mode, auto_reply_enabled')
          .eq('wa_phone_number_id', phoneNumberId)
          .limit(1);

        if (orgErr) {
          console.warn('[WABA] org lookup error', orgErr.message);
          continue;
        }
        const org = orgs?.[0];
        if (!org) {
          console.warn('[WABA] no org for phone_number_id', phoneNumberId);
          continue;
        }

        if (org.ingest_mode !== 'waba') {
          console.log('[WABA] org not in waba mode, skipping', {
            org_id: org.id,
            ingest_mode: org.ingest_mode,
          });
          continue;
        }

        for (const msg of messages) {
          if (msg.type !== 'text') continue;

          const from = msg.from as string;
          const text = msg.text?.body?.trim() || '';
          const msgId = msg.id as string;
          const ts = Number(msg.timestamp || Date.now()) * 1000;

          if (!text) continue;

          console.log('[WABA][IN]', {
            org_id: org.id,
            from,
            msgId,
            text,
          });

          // Parse and store
          const result: any = await ingestCoreFromMessage({
            org_id: org.id,
            text,
            ts,
            from_phone: from,
            from_name: null,
            msg_id: msgId,
            source: 'waba',
          });

          console.log('[WABA][INGEST-RESULT]', {
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

          if (!org.auto_reply_enabled) continue;

          let reply: string | null = null;

          // 1) Order path → either clarify OR confirm (never both)
          if (result.kind === 'order' && result.stored) {
            const clarify = await buildClarifyTextForItems(result, text); // pass original text
            if (clarify) {
              reply = clarify; // ask only the necessary questions
            } else {
              reply = '✅ Thanks! We’ve got your order and started processing. If anything is unclear or out of stock, we’ll message you.';
            }
          }

          // 2) Inquiry path → smart price/availability
          if (!reply && result.kind === 'inquiry') {
            const inquiryType = result.inquiry || result.inquiry_type || null;
            reply = await buildSmartInquiryReply({
              org_id: org.id,
              text,
              inquiryType,
            });
            if (!reply) {
              reply = '💬 Got your question. We’ll confirm the details shortly.';
            }
          }

          // 3) Heuristic question fallback
          if (
            !reply &&
            /price|rate|how much|available|stock|do you have/i.test(text.toLowerCase())
          ) {
            reply = '💬 Got your question. We’ll check and reply in a moment.';
          }

          // 4) Skip obvious small-talk
          if (!reply && !result.stored && result.reason === 'small_talk_or_non_order') {
            reply = null;
          }

          // 5) Final fail-soft ack (polite default)
          if (!reply) {
            reply = '✅ Thanks! We’ve got your message. We’ll follow up if we need any clarification.';
          }

          if (reply) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text: reply,
              orgId: org.id,
            });
          }
        }
      }
    }

    return res.sendStatus(200);
  } catch (e: any) {
    console.error('[WABA][ERR]', e?.message || e);
    return res.sendStatus(200);
  }
});

// ─────────────────────────────
// Send via Cloud API + log to inbox
// ─────────────────────────────
async function sendWabaText(opts: {
  phoneNumberId: string;
  to: string;
  text: string;
  orgId?: string;
}) {
  const token = process.env.WA_ACCESS_TOKEN || process.env.META_WA_TOKEN;
  if (!token) {
    console.warn('[WABA] WA_ACCESS_TOKEN missing, cannot send reply');
    return;
  }

  const toNorm = opts.to.startsWith('+') ? opts.to : `+${opts.to}`;

  try {
    const resp = await axios.post(
      `${META_WA_BASE}/${opts.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toNorm,
        type: 'text',
        text: { body: opts.text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('[WABA][SEND]', { to: toNorm, text: opts.text });

    if (opts.orgId) {
      try {
        const { data: conv, error: convErr } = await supa
          .from('conversations')
          .select('id')
          .eq('org_id', opts.orgId)
          .eq('customer_phone', toNorm.replace(/^\+/, ''))
          .limit(1)
          .maybeSingle();

        let convId = conv?.id || null;

        if (!convId) {
          const { data: conv2 } = await supa
            .from('conversations')
            .select('id')
            .eq('org_id', opts.orgId)
            .eq('customer_phone', toNorm)
            .limit(1)
            .maybeSingle();
          convId = conv2?.id || null;
        }

        if (convId) {
          const wa_msg_id =
            resp.data?.messages && resp.data.messages[0]?.id
              ? String(resp.data.messages[0].id)
              : null;

          const { error: msgErr } = await supa.from('messages').insert({
            org_id: opts.orgId,
            conversation_id: convId,
            direction: 'out',
            sender_type: 'ai',
            channel: 'waba',
            body: opts.text,
            wa_msg_id,
          });
          if (msgErr) {
            console.warn('[INBOX][MSG out err]', msgErr.message);
          }
        }
      } catch (e: any) {
        console.warn('[INBOX][outbound log err]', e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn('[WABA][SEND_ERR]', e?.response?.data || e?.message || e);
  }
}

export default waba;