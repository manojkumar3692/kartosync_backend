// src/routes/webhook.ts
import express from 'express';
import fetch from 'node-fetch'; // npm i node-fetch@2 (or use undici/fetch in Node18+)
import { createClient } from '@supabase/supabase-js';
import { supa as supaQuery } from '../db';
import { parseOrder } from '../parser';

export const webhook = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;
const supaAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);




// --- 1) Verify endpoint (Meta setup) ---
webhook.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Helpers ---
async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; contentType: string; ext: string }> {
  // Step A: get media URL
  const metaToken = process.env.WA_ACCESS_TOKEN!;
  const metaBase = 'https://graph.facebook.com/v21.0'; // check your app version; v21.0 latest as of late 2025
  const metaResp = await fetch(`${metaBase}/${mediaId}`, {
    headers: { Authorization: `Bearer ${metaToken}` }
  });
  if (!metaResp.ok) {
    const txt = await metaResp.text();
    throw new Error(`WA media lookup failed: ${metaResp.status} ${txt}`);
  }
  const mediaInfo: any = await metaResp.json(); // { url, mime_type, ... }

  // Step B: download binary
  const binResp = await fetch(mediaInfo.url, { headers: { Authorization: `Bearer ${metaToken}` } });
  if (!binResp.ok) {
    const txt = await binResp.text();
    throw new Error(`WA media download failed: ${binResp.status} ${txt}`);
  }
  const arrayBuf = await binResp.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const mime = mediaInfo.mime_type || 'audio/webm';
  const ext =
    mime.includes('ogg') ? 'ogg' :
    mime.includes('mpeg') ? 'mp3' :
    mime.includes('mp4') ? 'mp4' :
    mime.includes('amr') ? 'amr' :
    mime.includes('aac') ? 'aac' :
    mime.includes('wav') ? 'wav' : 'webm';

  return { buffer, contentType: mime, ext };
}

async function uploadToVoices(orgId: string, blob: Buffer, contentType: string, ext: string) {
  const path = `${orgId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supaAdmin.storage.from('voices').upload(path, blob, {
    contentType,
    upsert: false
  });
  if (error) throw error;
  const { data } = supaAdmin.storage.from('voices').getPublicUrl(path);
  return data.publicUrl;
}

// --- 2) Receive messages ---
webhook.post('/whatsapp', async (req, res) => {
  
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages || [];
    const metadata = value?.metadata;

    if (!messages.length) return res.sendStatus(200);

    const phone_number_id = metadata?.phone_number_id;
    if (!phone_number_id) return res.sendStatus(200);

    // Map WA phone_number_id -> org
    const { data: orgs, error: orgErr } = await supaQuery
      .from('orgs')
      .select('*')
      .eq('wa_phone_number_id', phone_number_id)
      .limit(1);
    if (orgErr) throw orgErr;
    const org = orgs?.[0];
    if (!org) {
      console.warn('No org matched for phone_number_id', phone_number_id);
      return res.sendStatus(200);
    }

    // Only handle first message for now
    const msg = messages[0];
    console.log('[WH] from=', msg.from, 'type=', msg.type, 'hasText=', !!msg.text?.body);
    const from = msg.from; // customer phone
    const type = msg.type; // 'text' | 'audio' | 'voice' | etc.

        // 🔹 Normalize phone exactly like Dashboard / /api/inbox/auto_reply
        const phoneKey = String(from || '').replace(/[^\d]/g, '');

        // 🔹 Check per-customer + org-level auto-reply flags
        // 1) Try customer-specific org_customer_settings
        const { data: custSettings, error: custErr } = await supaQuery
          .from('org_customer_settings')
          .select('auto_reply_enabled')
          .eq('org_id', org.id)
          .eq('phone_key', phoneKey)
          .maybeSingle();
    
        let allowAutoReply: boolean;
    
        if (!custErr && custSettings) {
          // per-customer setting exists
          allowAutoReply = !!custSettings.auto_reply_enabled;
        } else {
          // 2) Fallback to org-level default (orgs.auto_reply_enabled)
          const { data: orgRow, error: orgErr2 } = await supaQuery
            .from('orgs')
            .select('auto_reply_enabled')
            .eq('id', org.id)
            .maybeSingle();
    
          if (orgErr2) throw orgErr2;
          // default ON if not set
          allowAutoReply = orgRow?.auto_reply_enabled ?? true;
        }
    
        // 🔹 If auto-reply is OFF for this customer/org:
        //     → DO NOT parse into orders, just acknowledge to WhatsApp.
        if (!allowAutoReply) {
          console.log('[WH] auto-reply disabled, skipping parse for', phoneKey);
          return res.sendStatus(200);
        }
    

    if (msg.text?.body) {                        // ✅ key change
      const text = msg.text.body;
      const items = parseOrder(text);
      await supaQuery.from('orders').insert({
        org_id: org.id,
        source_phone: from,
        customer_name: null,
        raw_text: text,
        items,
        audio_url: null,
        status: 'pending'
      });
      return res.sendStatus(200);
    }

    // voice and audio are delivered slightly differently
    // audio messages: msg.audio.id / voice notes: msg.audio?.id or msg.voice?.id depending on WhatsApp format
    const mediaId =
      msg.audio?.id ||
      msg.voice?.id ||
      (msg.document?.id && msg.document?.mime_type?.startsWith('audio/') ? msg.document.id : null);

    if (mediaId) {
      // download media from WhatsApp → upload to Supabase Storage
      const media = await downloadWhatsAppMedia(mediaId);
      const publicUrl = await uploadToVoices(org.id, media.buffer, media.contentType, media.ext);

      // (Optional) If you add transcription later, fill raw_text with the transcript.
      await supaQuery.from('orders').insert({
        org_id: org.id,
        source_phone: from,
        customer_name: null,
        raw_text: '',         // will be empty until you add STT
        items: [],            // same here; you can run STT + parse to fill items
        audio_url: publicUrl,
        status: 'pending'
      });
      return res.sendStatus(200);
    }

    // Fallback: unsupported type → save raw as text if exists
    const rawText =
      msg.caption ||
      msg.interactive?.button_reply?.title ||
      msg.interactive?.list_reply?.title ||
      '';
    if (rawText) {
      const items = parseOrder(rawText);
      await supaQuery.from('orders').insert({
        org_id: org.id,
        source_phone: from,
        customer_name: null,
        raw_text: rawText,
        items,
        audio_url: null,
        status: 'pending'
      });
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error', e);
    return res.sendStatus(200); // don’t cause retries storm; log instead
  }
});

