// src/routes/waba.ts
import express from "express";
import { supa } from "../db";
import { ingestCoreFromMessage } from "./ingestCore";
import axios from "axios";
// ⬇️ Adjust this import to wherever your helper lives

import { logFlowEvent } from "./waba/wabaimports";

export const waba = express.Router();

const seenMsgIds = new Set<string>();
const MAX_SEEN_MSG_IDS = 10_000;

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
export const META_WA_BASE = "https://graph.facebook.com/v21.0";

// ────────────────────────────────────────────
// 1) Webhook verification (GET /waba)
// Meta calls this ONCE when setting webhook URL
// ────────────────────────────────────────────
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

// ─────────────────────────────
// Send via Cloud API + log to inbox
// ─────────────────────────────
export async function sendWabaText(opts: {
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

// Simple inbound → conversations + messages logger
async function logInboundMessageToInbox(args: {
  orgId: string;
  from: string;
  text: string;
  msgId: string;
}) {
  try {
    const { orgId, from, text, msgId } = args;
    const body = (text || "").trim() || "[non-text message]";

    // normalize phone: digits only (same logic as normalizePhoneForKey)
    const phoneKey = from.replace(/[^\d]/g, "");
    if (!orgId || !phoneKey) return;

    const nowIso = new Date().toISOString();

    // 1) Find existing conversation
    const { data: existing, error: convErr } = await supa
      .from("conversations")
      .select("id")
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey)
      .maybeSingle();

    if (convErr) {
      console.warn("[INBOX][logInbound] conv lookup err", convErr.message);
      return;
    }

    let conversationId: string | null = existing?.id ?? null;

    // 2) If no conversation → create one
    if (!conversationId) {
      const { data: created, error: insErr } = await supa
        .from("conversations")
        .insert({
          org_id: orgId,
          customer_phone: phoneKey,
          customer_name: null,
          source: "waba",
          last_message_at: nowIso,
          last_message_preview: body.slice(0, 120),
        })
        .select("id")
        .maybeSingle();

      if (insErr) {
        console.warn("[INBOX][logInbound] conv insert err", insErr.message);
        return;
      }

      conversationId = created?.id ?? null;
    } else {
      // 3) Update existing conversation preview
      const { error: updErr } = await supa
        .from("conversations")
        .update({
          last_message_at: nowIso,
          last_message_preview: body.slice(0, 120),
          source: "waba",
        })
        .eq("id", conversationId)
        .eq("org_id", orgId);

      if (updErr) {
        console.warn("[INBOX][logInbound] conv update err", updErr.message);
      }
    }

    if (!conversationId) return;

    // 4) Insert message row
    const { error: msgErr } = await supa.from("messages").insert({
      org_id: orgId,
      conversation_id: conversationId,
      direction: "in",
      sender_type: "customer",
      channel: "waba",
      body,
      wa_msg_id: msgId,
    });

    if (msgErr) {
      console.warn("[INBOX][logInbound] msg insert err", msgErr.message);
    }
  } catch (e: any) {
    console.warn("[INBOX][logInbound] catch", e?.message || e);
  }
}

waba.post("/", async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.entry) {
      console.log("[WABA] no entry in body");
      return res.sendStatus(200);
    }

    for (const entry of body.entry as any[]) {
      const changes = entry.changes || [];

      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const metadata = value.metadata || {};
        const phoneNumberId = metadata.phone_number_id as string | undefined;

        if (!phoneNumberId || messages.length === 0) continue;

        // 🔍 Find org for this WABA number
        const { data: orgs, error: orgErr } = await supa
          .from("orgs")
          .select("id, name, ingest_mode, auto_reply_enabled")
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

        // Optional: only process if org is in WABA mode
        if (org.ingest_mode && org.ingest_mode !== "waba") {
          console.log("[WABA] org not in waba ingest_mode, skipping", {
            org_id: org.id,
            ingest_mode: org.ingest_mode,
          });
          continue;
        }

        for (const msg of messages) {
          try {
            const from = msg.from as string;
            const msgId = msg.id as string;
            const ts = Number(msg.timestamp || Date.now()) * 1000;
            const msgType = msg.type as string;
        
            // 🔁 Dedup per msgId (do this BEFORE type filtering)
            if (seenMsgIds.has(msgId)) {
              console.log("[WABA][DEDUP] skipping already-seen msg", msgId);
              continue;
            }
            seenMsgIds.add(msgId);
            if (seenMsgIds.size > MAX_SEEN_MSG_IDS) {
              seenMsgIds.clear();
            }
        
            // 🧩 Normalize text + location
            let text: string = "";
            let location_lat: number | null = null;
            let location_lng: number | null = null;
        
            if (msgType === "text") {
              text = (msg.text?.body || "").trim();
              if (!text) {
                // empty text – ignore
                continue;
              }
            } else if (msgType === "location") {
              text = ""; // addressEngine will use coords only
              location_lat = msg.location?.latitude ?? null;
              location_lng = msg.location?.longitude ?? null;
              console.log("[WABA][LOCATION_MSG]", {
                from,
                msgId,
                location_lat,
                location_lng,
              });
            } else {
              // ignore other types for now (image, audio, etc.)
              continue;
            }
        
            console.log("[FLOW][INCOMING][V2]", {
              org_id: org.id,
              from,
              msgId,
              text,
              type: msgType,
              location_lat,
              location_lng,
            });
        
            await logInboundMessageToInbox({
              orgId: org.id,
              from,
              text: text || "[non-text message]",
              msgId,
            });
        
            // If org has auto-reply disabled, just log and stop
            if (!org.auto_reply_enabled) {
              console.log("[WABA] auto_reply disabled for org", org.id);
              continue;
            }
        
            // 🧠 Single call into your AI / order brain
            const result = await ingestCoreFromMessage({
              org_id: org.id,
              text,
              ts,
              from_phone: from,
              from_name: null,
              msg_id: msgId,
              source: "waba",
              location_lat,
              location_lng,
            });
        
            console.log("[WABA][INGEST_RESULT][V2]", {
              org_id: org.id,
              from,
              msgId,
              kind: result?.kind,
              reason: result?.reason,
              order_id: result?.order_id,
              stored: result?.stored,
              image: result?.image || null,   
            });
        
            const reply =
              typeof result?.reply === "string" && result.reply.trim()
                ? result.reply.trim()
                : null;
        
            if (reply) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                orgId: org.id,
                text: reply,
                image: result?.image || null,    
                caption: reply,
              });
        
              console.log("[WABA][AUTO_REPLY][V2]", {
                org_id: org.id,
                from,
                msgId,
                replyPreview: reply.slice(0, 150),
              });
            }
          } catch (msgErr: any) {
            console.error("[WABA][MSG_ERR]", msgErr?.message || msgErr);
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
