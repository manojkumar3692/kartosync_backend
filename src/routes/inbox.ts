// src/routes/inbox.ts
import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import { supa } from "../db";

export const inbox = express.Router();

const META_WA_BASE = "https://graph.facebook.com/v21.0";
const META_WA_TOKEN = process.env.META_WA_TOKEN || process.env.WA_ACCESS_TOKEN || "";

type JwtPayload = {
  org_id?: string;
  org?: { id?: string };
  [key: string]: any;
};

// ───────────────── helpers ─────────────────
function getOrgId(req: any): string | null {
  // 1) explicit (query/body)
  const direct = (req.query.org_id || req.body?.org_id || "").toString().trim();
  if (direct) return direct;

  // 2) from JWT
  const auth = (req.headers.authorization || "").toString();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !process.env.JWT_SECRET) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
    if (decoded?.org_id) return String(decoded.org_id);
    if (decoded?.org?.id) return String(decoded.org.id);
    return null;
  } catch {
    return null;
  }
}

function normE164(s: string): string {
  const t = (s || "").trim();
  if (!t) return t;
  return t.startsWith("+") ? t : `+${t}`;
}

// ───────────────── GET /conversations ─────────────────
// Source of truth: conversations table (created by ingest upserts)
inbox.get("/conversations", async (req, res) => {
  const orgId = getOrgId(req);
  if (!orgId) return res.status(401).json({ ok: false, error: "no_org" });

  try {
    const { data, error } = await supa
      .from("conversations")
      .select("id, customer_phone, customer_name, source, last_message_at, last_message_preview")
      .eq("org_id", orgId)
      .order("last_message_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    return res.json({
      ok: true,
      conversations: (data || []).map((c: any) => ({
        id: c.id,
        customer_phone: c.customer_phone,
        customer_name: c.customer_name,
        source: c.source,
        last_message_at: c.last_message_at,
        last_message_preview: c.last_message_preview,
      })),
    });
  } catch (e: any) {
    console.error("[INBOX][conversations]", e?.message || e);
    return res.status(500).json({ ok: false, error: "inbox_conversations_failed" });
  }
});

// ───────────── GET /conversations/:id/messages ─────────────
// Pull full thread from messages table
inbox.get("/conversations/:conversationId/messages", async (req, res) => {
  const orgId = getOrgId(req);
  const conversationId = String(req.params.conversationId || "");
  if (!orgId) return res.status(401).json({ ok: false, error: "no_org" });
  if (!conversationId) return res.status(400).json({ ok: false, error: "conversation_id_required" });

  try {
    const { data, error } = await supa
      .from("messages")
      .select("id, created_at, direction, sender_type, channel, body, wa_msg_id")
      .eq("org_id", orgId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return res.json({ ok: true, messages: data || [] });
  } catch (e: any) {
    console.error("[INBOX][messages]", e?.message || e);
    return res.status(500).json({ ok: false, error: "inbox_messages_failed" });
  }
});


// ───────────────── POST /send ─────────────────
// Body: { org_id, phone, text }  (phone optional if you prefer conversation_id later)
inbox.post("/send", express.json(), async (req, res) => {
    try {
      const orgId = getOrgId(req) || String(req.body?.org_id || "");
      // accept either `phone` or legacy `to`
      const phoneRaw = String(req.body?.phone || req.body?.to || "");
      const text = String(req.body?.text || "");
      if (!orgId) return res.status(401).json({ ok: false, error: "no_org" });
      if (!phoneRaw || !text) {
        return res.status(400).json({ ok: false, error: "phone_and_text_required" });
      }
  
      // find org → phone_number_id
      const { data: orgs, error: orgErr } = await supa
        .from("orgs")
        .select("id, wa_phone_number_id")
        .eq("id", orgId)
        .limit(1)
        .single();
  
      if (orgErr) throw orgErr;
      const phoneNumberId = (orgs as any)?.wa_phone_number_id;
      if (!phoneNumberId) {
        return res.status(400).json({ ok: false, error: "org_missing_wa_phone_number_id" });
      }
  
      if (!META_WA_TOKEN) {
        console.warn("[INBOX][send] META_WA_TOKEN/WA_ACCESS_TOKEN missing");
        return res.status(500).json({ ok: false, error: "wa_token_missing" });
      }
  
      const toNorm = normE164(phoneRaw);
  
      // Send via Cloud API
      const resp = await axios.post(
        `${META_WA_BASE}/${phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to: toNorm,
          type: "text",
          text: { body: text },
        },
        {
          headers: {
            Authorization: `Bearer ${META_WA_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
  
      const wa_msg_id =
        resp.data?.messages && resp.data.messages[0]?.id
          ? String(resp.data.messages[0].id)
          : null;
  
      console.log("[INBOX][SEND]", { orgId, to: toNorm, text });
  
      // Find (or create) conversation row for this phone so the web UI reflects the reply immediately
      const { data: convRow } = await supa
        .from("conversations")
        .select("id")
        .eq("org_id", orgId)
        .eq("customer_phone", toNorm.replace(/^\+/, "")) // most rows stored without '+'
        .limit(1)
        .maybeSingle();
  
      let conversationId: string | null = convRow?.id || null;
      if (!conversationId) {
        const { data: convRow2 } = await supa
          .from("conversations")
          .select("id")
          .eq("org_id", orgId)
          .eq("customer_phone", toNorm)
          .limit(1)
          .maybeSingle();
        conversationId = convRow2?.id || null;
      }
  
      // Log outbound message if we have a conversation
      if (conversationId) {
        await supa.from("messages").insert({
          org_id: orgId,
          conversation_id: conversationId,
          direction: "out",
          sender_type: "store", // or 'ai'
          channel: "waba",
          body: text,
          wa_msg_id,
        });
  
        // bump conversation preview
        await supa
          .from("conversations")
          .update({
            last_message_at: new Date().toISOString(),
            last_message_preview: text.slice(0, 120),
          })
          .eq("id", conversationId)
          .eq("org_id", orgId);
      }
  
      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[INBOX][send][ERR]", e?.response?.data || e?.message || e);
      return res.status(500).json({ ok: false, error: "send_failed" });
    }
  });

// ─────────── GET /latest-order?org_id=..&phone=.. ───────────
// Used by the AI reasoning panel (right side)
inbox.get("/latest-order", async (req, res) => {
  try {
    const org_id = String(req.query.org_id || "");
    const phone = String(req.query.phone || "").replace(/^\+/, "");
    if (!org_id || !phone) return res.status(400).json({ ok: false, error: "missing_fields" });

    const { data, error } = await supa
      .from("orders")
      .select("id, items, parse_reason, parse_confidence, created_at")
      .eq("org_id", org_id)
      .or(`source_phone.eq.${phone},source_phone.eq.+${phone}`)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    return res.json({ ok: true, order: data?.[0] || null });
  } catch (e: any) {
    console.error("[INBOX][latest-order]", e?.message || e);
    return res.json({ ok: false, error: e?.message || "failed" });
  }
});

// ───────────────── GET /messages (compat) ─────────────────
// Returns merged inbound (orders) + outbound (messages) for a phone
inbox.get("/messages", async (req, res) => {
    try {
      const orgId = getOrgId(req) || String(req.query.org_id || "");
      const phoneRaw = String(req.query.phone || "").trim();
      if (!orgId) return res.status(401).json({ ok: false, error: "no_org" });
      if (!phoneRaw) return res.status(400).json({ ok: false, error: "phone_required" });
  
      const phonePlain = phoneRaw.replace(/[^\d]/g, "");
      const phonePlus = phonePlain ? `+${phonePlain}` : "";
  
      // 1) inbound from orders
      const { data: orders, error: ordErr } = await supa
        .from("orders")
        .select("id, raw_text, created_at")
        .eq("org_id", orgId)
        .or(`source_phone.eq.${phonePlain},source_phone.eq.${phonePlus}`)
        .order("created_at", { ascending: true });
  
      if (ordErr) throw ordErr;
  
      const inbound = (orders || []).map((o: any) => ({
        id: `in-${o.id}`,
        from: "customer" as const,
        text: o.raw_text || "",
        ts: o.created_at,
      }));
  
      // 2) outbound from messages (only those tied to this phone’s conversation)
      // find conversation by either plain or + format
      const { data: conv1 } = await supa
        .from("conversations")
        .select("id")
        .eq("org_id", orgId)
        .eq("customer_phone", phonePlain)
        .limit(1)
        .maybeSingle();
  
      let conversationId = conv1?.id || null;
      if (!conversationId) {
        const { data: conv2 } = await supa
          .from("conversations")
          .select("id")
          .eq("org_id", orgId)
          .eq("customer_phone", phonePlus)
          .limit(1)
          .maybeSingle();
        conversationId = conv2?.id || null;
      }
  
      let outbound: Array<{ id: string; from: "store"; text: string; ts: string }> = [];
      if (conversationId) {
        const { data: msgs, error: msgErr } = await supa
          .from("messages")
          .select("id, body, created_at, direction")
          .eq("org_id", orgId)
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true });
  
        if (msgErr) throw msgErr;
  
        outbound = (msgs || [])
          .filter((m: any) => (m.direction || "").toLowerCase() === "out")
          .map((m: any) => ({
            id: `out-${m.id}`,
            from: "store" as const,
            text: m.body || "",
            ts: m.created_at,
          }));
      }
  
      // 3) merge + sort
      const merged = [...inbound, ...outbound].sort(
        (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
      );
  
      return res.json(merged);
    } catch (e: any) {
      console.error("[INBOX][GET /messages]", e?.message || e);
      return res.status(500).json({ ok: false, error: "inbox_messages_failed" });
    }
  });

export default inbox;