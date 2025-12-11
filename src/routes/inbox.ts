// src/routes/inbox.ts
import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import { supa } from "../db";
import { interpretMessage } from "../ai/interpreter";
import { normalizePhoneForKey, findActiveOrderForPhone } 
  from "./waba/clarifyAddress";
import { getConversationState } from "../util/conversationState";

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

// NEW: digits-only normalizer for customer phone keys
// function normalizePhoneForKey(raw: string): string {
//   return String(raw || "").replace(/[^\d]/g, "");
// }

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
// ───────────────── POST /send ─────────────────
inbox.post("/send", express.json(), async (req, res) => {
  try {
    const orgId = getOrgId(req) || String(req.body?.org_id || "");
    // accept either `phone` or legacy `to`
    const phoneRaw = String(req.body?.phone || req.body?.to || "");
    const text = String(req.body?.text || "");

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "no_org" });
    }
    if (!phoneRaw || !text) {
      return res
        .status(400)
        .json({ ok: false, error: "phone_and_text_required" });
    }

    // find org → phone_number_id + wa_access_token + is_disabled
    const { data: orgRow, error: orgErr } = await supa
      .from("orgs")
      .select("id, wa_phone_number_id, wa_access_token, is_disabled")
      .eq("id", orgId)
      .limit(1)
      .maybeSingle();

    if (orgErr) {
      console.error("[INBOX][send] org lookup err", orgErr.message);
      return res.status(500).json({ ok: false, error: "org_lookup_failed" });
    }
    if (!orgRow) {
      return res.status(404).json({ ok: false, error: "org_not_found" });
    }

    const phoneNumberId = (orgRow as any).wa_phone_number_id;
    const waToken = String((orgRow as any).wa_access_token || "").trim();
    const isDisabled = !!(orgRow as any).is_disabled;

    if (!phoneNumberId) {
      return res
        .status(400)
        .json({ ok: false, error: "org_missing_wa_phone_number_id" });
    }

    if (!waToken) {
      console.warn("[INBOX][send] org missing wa_access_token", { orgId });
      return res
        .status(400)
        .json({ ok: false, error: "org_missing_wa_access_token" });
    }

    if (isDisabled) {
      console.log("[INBOX][send] org is_disabled, blocking outbound send", {
        orgId,
      });
      return res
        .status(403)
        .json({ ok: false, error: "org_disabled" });
    }

    const toNorm = normE164(phoneRaw);

    // Send via Cloud API (per-org token)
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
          Authorization: `Bearer ${waToken}`,
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

// ───────────────── GET /messages ─────────────────
// WABA orgs: use `messages` table only (in + out) → no duplicates
// Non-WABA orgs: keep old behaviour (orders as inbound, messages as outbound)
inbox.get("/messages", async (req, res) => {
  try {
    const orgId = getOrgId(req) || String(req.query.org_id || "");
    const phoneRaw = String(req.query.phone || "").trim();

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "no_org" });
    }
    if (!phoneRaw) {
      return res
        .status(400)
        .json({ ok: false, error: "phone_required" });
    }

    const phonePlain = phoneRaw.replace(/[^\d]/g, "");
    const phonePlus = phonePlain ? `+${phonePlain}` : "";

    // 0) Look up org to know ingest_mode
    const { data: orgRow, error: orgErr } = await supa
      .from("orgs")
      .select("id, ingest_mode")
      .eq("id", orgId)
      .maybeSingle();

    if (orgErr) {
      console.error("[INBOX][GET /messages] org lookup err", orgErr.message);
    }

    const ingestMode = (orgRow?.ingest_mode || "").toLowerCase();

    // ─────────────────────────────
    // CASE A: WABA → use `messages` only
    // ─────────────────────────────
    if (ingestMode === "waba") {
      // 1) Find conversation (plain or +)
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

      if (!conversationId) {
        // no chat yet
        return res.json([]);
      }

      // 2) Read ALL messages for this conversation (in + out)
      const { data: msgs, error: msgErr } = await supa
        .from("messages")
        .select("id, body, created_at, direction")
        .eq("org_id", orgId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (msgErr) throw msgErr;

      const merged = (msgs || []).map((m: any) => {
        const dir = (m.direction || "").toLowerCase();
        const from: "customer" | "store" =
          dir === "in" ? "customer" : "store";

        return {
          id: `${dir === "in" ? "in" : "out"}-${m.id}`,
          from,
          text: m.body || "",
          ts: m.created_at,
        };
      });

      return res.json(merged);
    }

    // ─────────────────────────────
    // CASE B: non-WABA → keep old behaviour
    // ─────────────────────────────

    // 1) inbound from orders (legacy)
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
    const { data: conv1b } = await supa
      .from("conversations")
      .select("id")
      .eq("org_id", orgId)
      .eq("customer_phone", phonePlain)
      .limit(1)
      .maybeSingle();

    let conversationIdB = conv1b?.id || null;
    if (!conversationIdB) {
      const { data: conv2b } = await supa
        .from("conversations")
        .select("id")
        .eq("org_id", orgId)
        .eq("customer_phone", phonePlus)
        .limit(1)
        .maybeSingle();
      conversationIdB = conv2b?.id || null;
    }

    let outbound: Array<{ id: string; from: "store"; text: string; ts: string }> = [];
    if (conversationIdB) {
      const { data: msgs, error: msgErr } = await supa
        .from("messages")
        .select("id, body, created_at, direction")
        .eq("org_id", orgId)
        .eq("conversation_id", conversationIdB)
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

    const merged = [...inbound, ...outbound].sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );

    return res.json(merged);
  } catch (e: any) {
    console.error("[INBOX][GET /messages]", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: "inbox_messages_failed" });
  }
});

// ───────────── NEW: per-customer auto-reply APIs ─────────────

// GET /api/inbox/auto_reply?org_id=...&phone=...
// Returns { enabled: boolean, last_inquiry_* fields... }
inbox.get("/auto_reply", async (req, res) => {
  try {
    const orgId = getOrgId(req) || String(req.query.org_id || "");
    const phoneRaw = String(req.query.phone || "").trim();

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "no_org" });
    }
    if (!phoneRaw) {
      return res.status(400).json({ ok: false, error: "phone_required" });
    }

    const phoneKey = normalizePhoneForKey(phoneRaw);

    const { data, error } = await supa
      .from("org_customer_settings")
      .select(
        `
        auto_reply_enabled,
        last_inquiry_text,
        last_inquiry_kind,
        last_inquiry_canonical,
        last_inquiry_at,
        last_inquiry_status
      `
      )
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey)
      .maybeSingle();

    if (error) {
      console.error("[INBOX][auto_reply GET err]", error.message);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    // 👇 Cast to any so TS stops treating this as GenericStringError
    const row: any = data || {};

    const enabled =
      row && typeof row.auto_reply_enabled === "boolean"
        ? !!row.auto_reply_enabled
        : true; // default ON

    return res.json({
      ok: true,
      enabled,
      last_inquiry_text: row.last_inquiry_text ?? null,
      last_inquiry_kind: row.last_inquiry_kind ?? null,
      last_inquiry_canonical: row.last_inquiry_canonical ?? null,
      last_inquiry_at: row.last_inquiry_at ?? null,
      last_inquiry_status: row.last_inquiry_status ?? null,
    });
  } catch (e: any) {
    console.error("[INBOX][auto_reply GET catch]", e?.message || e);
    return res.status(500).json({ ok: false, error: "auto_reply_get_failed" });
  }
});

// POST /api/inbox/auto_reply
// Body: { org_id, phone, enabled }
inbox.post("/auto_reply", express.json(), async (req, res) => {
  try {
    const orgId = getOrgId(req) || String(req.body?.org_id || "");
    const phoneRaw = String(req.body?.phone || "").trim();
    const enabled = req.body?.enabled;

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "no_org" });
    }
    if (!phoneRaw || typeof enabled !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "org_id, phone, enabled(boolean) are required",
      });
    }

    const phoneKey = normalizePhoneForKey(phoneRaw);

    const { data, error } = await supa
      .from("org_customer_settings")
      .upsert(
        {
          org_id: orgId,
          customer_phone: phoneKey,
          auto_reply_enabled: enabled,
        },
        {
          onConflict: "org_id,customer_phone",
        }
      )
      .select("auto_reply_enabled")
      .maybeSingle();

    if (error) {
      console.error("[INBOX][auto_reply POST err]", error.message);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    const finalEnabled =
      data && typeof data.auto_reply_enabled === "boolean"
        ? !!data.auto_reply_enabled
        : enabled;

    return res.json({ ok: true, enabled: finalEnabled });
  } catch (e: any) {
    console.error("[INBOX][auto_reply POST catch]", e?.message || e);
    return res.status(500).json({ ok: false, error: "auto_reply_post_failed" });
  }
});


// GET /api/inbox/manual_mode?org_id=...&phone=...
inbox.get("/manual_mode", async (req, res) => {
  try {
    const orgId = getOrgId(req) || String(req.query.org_id || "");
    const phoneRaw = String(req.query.phone || "").trim();

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "no_org" });
    }
    if (!phoneRaw) {
      return res.status(400).json({ ok: false, error: "phone_required" });
    }

    const phoneKey = normalizePhoneForKey(phoneRaw);

    const { data, error } = await supa
      .from("org_customer_settings")
      .select("manual_mode, manual_mode_until")
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey)
      .maybeSingle();

    if (error) {
      console.error("[INBOX][manual_mode GET err]", error.message);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    const enabled = !!data?.manual_mode;
    const until = data?.manual_mode_until || null;

    return res.json({ ok: true, enabled, until });
  } catch (e: any) {
    console.error("[INBOX][manual_mode GET catch]", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: "manual_mode_get_failed" });
  }
});


// POST /api/inbox/manual_mode
// Body: { org_id?, phone, enabled: boolean }
inbox.post("/manual_mode", express.json(), async (req, res) => {
  try {
    const orgId = getOrgId(req) || String(req.body?.org_id || "");
    const phoneRaw = String(req.body?.phone || "").trim();
    const enabled = req.body?.enabled;

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "no_org" });
    }
    if (!phoneRaw || typeof enabled !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "org_id, phone, enabled(boolean) are required",
      });
    }

    const phoneKey = normalizePhoneForKey(phoneRaw);

    // If turning ON → Option A: only 1 customer at a time
    if (enabled) {
      await supa
        .from("org_customer_settings")
        .update({ manual_mode: false, manual_mode_until: null })
        .eq("org_id", orgId)
        .eq("manual_mode", true);
    }

    const now = new Date();
    const until = enabled
      ? new Date(now.getTime() + 10 * 60 * 1000).toISOString() // +10 minutes
      : null;

    const { data, error } = await supa
      .from("org_customer_settings")
      .upsert(
        {
          org_id: orgId,
          customer_phone: phoneKey,
          manual_mode: enabled,
          manual_mode_until: until,
        },
        { onConflict: "org_id,customer_phone" }
      )
      .select("manual_mode, manual_mode_until")
      .maybeSingle();

    if (error) {
      console.error("[INBOX][manual_mode POST err]", error.message);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({
      ok: true,
      enabled: !!data?.manual_mode,
      until: data?.manual_mode_until || null,
    });
  } catch (e: any) {
    console.error("[INBOX][manual_mode POST catch]", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: "manual_mode_post_failed" });
  }
});

// POST /api/inbox/inquiry_resolved
// Body: { org_id, phone, inquiry_at?, canonical? }
// Marks the last inquiry as resolved for this customer
// POST /api/inbox/inquiry_resolved
// Body: { org_id, phone, inquiry_at?, canonical? }
inbox.post("/inquiry_resolved", express.json(), async (req, res) => {
  try {
    const orgId = getOrgId(req) || String(req.body?.org_id || "");
    const phoneRaw = String(req.body?.phone || "").trim();
    const inquiryAt = req.body?.inquiry_at ? String(req.body.inquiry_at) : null;
    const canonical = req.body?.canonical ? String(req.body.canonical) : null;

    if (!orgId) {
      return res.status(401).json({ ok: false, error: "no_org" });
    }
    if (!phoneRaw) {
      return res.status(400).json({ ok: false, error: "phone_required" });
    }

    const phoneKey = normalizePhoneForKey(phoneRaw);

    const update: any = {
      last_inquiry_status: "resolved",
    };

    // Optional: only clear if same inquiry
    if (inquiryAt) update.last_inquiry_at = inquiryAt;
    if (canonical) update.last_inquiry_canonical = canonical;

    const { error } = await supa
      .from("org_customer_settings")
      .update(update)
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey);

    if (error) {
      console.error("[INBOX][inquiry_resolved err]", error.message);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[INBOX][inquiry_resolved catch]", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: "inquiry_resolved_failed" });
  }
});


// GET /api/inbox/ai_insight?org_id=...&phone=...
inbox.get("/ai_insight", async (req, res) => {
  try {
    const orgId = String(req.query.org_id || "").trim();
    const phoneRaw = String(req.query.phone || "").trim();

    if (!orgId || !phoneRaw) {
      return res.status(400).json({ error: "org_id and phone are required" });
    }

    const phoneKey = normalizePhoneForKey(phoneRaw);

    // 1) Find conversation for this org + phone
    const { data: conv, error: convErr } = await supa
      .from("conversations")
      .select("id")
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (convErr) {
      console.warn("[INBOX][ai_insight conv err]", convErr.message);
    }

    if (!conv) {
      // No conversation yet → no insight
      return res.json({ insight: null });
    }

    // 2) Load last ~30 messages for that conversation
    const { data: msgs, error: msgErr } = await supa
      .from("messages")
      .select("id, created_at, direction, body")
      .eq("org_id", orgId)
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: false })
      .limit(30);

    if (msgErr) {
      console.warn("[INBOX][ai_insight msg err]", msgErr.message);
      return res.json({ insight: null });
    }

    if (!msgs || !msgs.length) {
      return res.json({ insight: null });
    }

    // Sort ascending for interpreter context, and pick last message as "current"
    const sorted = [...msgs].sort(
      (a, b) =>
        new Date(a.created_at).getTime() -
        new Date(b.created_at).getTime()
    );

    const lastMsg = sorted[sorted.length - 1];

    // 3) Check active order + conversation stage
    const activeOrder = await findActiveOrderForPhone(orgId, phoneKey);
    const convoState = await getConversationState(orgId, phoneKey);
    const stage = (convoState?.stage as
      | "idle"
      | "awaiting_clarification"
      | "awaiting_address"
      | "post_order"
      | undefined) || "idle";

    // 4) Ask interpreter for a high-level read of this situation
    const interpretation = await interpretMessage({
      orgId,
      phone: phoneKey,
      text: lastMsg.body || "",
      hasOpenOrder: !!activeOrder,
      lastOrderStatus: activeOrder?.status ?? null,
      lastOrderCreatedAt: activeOrder?.created_at ?? null,
      state: stage,
      channel: "waba", // or "local_bridge" depending on your source
    });

    const insight = {
      org_id: orgId,
      customer_phone: phoneKey,
      last_msg_id: lastMsg.id,
      last_msg_at: lastMsg.created_at,
      kind: interpretation.kind ?? "unknown",     // ← use kind
      confidence: interpretation.confidence ?? null,
      summary: interpretation.summary ?? null,    // if summary exists on the type
      raw: interpretation,
    };

    return res.json({ insight });
  } catch (e: any) {
    console.error("[INBOX][ai_insight ERR]", e?.message || e);
    return res.json({ insight: null });
  }
});


// GET /api/inbox/customer-insight?org_id=...&phone=...
inbox.get("/customer-insight", async (req, res) => {
  try {
    const org_id = String(req.query.org_id || "");
    const phoneRaw = String(req.query.phone || "").trim();

    if (!org_id || !phoneRaw) {
      return res.status(400).json({ error: "org_id and phone are required" });
    }

    const phoneKey = normalizePhoneForKey(phoneRaw);

    // 1) Latest AI insight row
    const { data: insight, error: insightErr } = await supa
    .from("ai_insights")
    .select(
      "id, kind, confidence, reason, raw_text, created_at"
    )
    .eq("org_id", org_id)
    .eq("customer_phone", phoneKey)   // 🔹 use existing column
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

    if (insightErr) {
      console.warn("[INBOX][customer-insight ai_insights err]", insightErr.message);
    }

    // 2) Snapshot from org_customer_settings (last inquiry info)
    const { data: custSettings, error: custErr } = await supa
      .from("org_customer_settings")
      .select(
        "last_inquiry_text, last_inquiry_kind, last_inquiry_canonical, last_inquiry_at, last_inquiry_status"
      )
      .eq("org_id", org_id)
      .eq("customer_phone", phoneKey)
      .maybeSingle();

    if (custErr) {
      console.warn(
        "[INBOX][customer-insight settings err]",
        custErr.message
      );
    }

    return res.json({
      insight: insight || null,
      lastInquiry: custSettings || null,
    });
  } catch (e: any) {
    console.error("[INBOX][customer-insight ERR]", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});


export default inbox;