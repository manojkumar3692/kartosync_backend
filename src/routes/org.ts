import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";

export const org = express.Router();

function ensureAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    req.org_id = d.org_id;
    next();
  } catch (e) {
    res.status(401).json({ error: "unauthorized" });
  }
}

// ─────────────────────────────────────────────
// GET /api/org/me  (EXISTING)
// ─────────────────────────────────────────────
org.get("/me", ensureAuth, async (req: any, res) => {
  const { data, error } = await supa
    .from("orgs")
    .select("*")
    .eq("id", req.org_id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────────
// POST /api/org/map-wa  (EXISTING)
// ─────────────────────────────────────────────
org.post("/map-wa", ensureAuth, async (req: any, res) => {
  const { wa_phone_number_id } = req.body || {};
  const { error } = await supa
    .from("orgs")
    .update({ wa_phone_number_id })
    .eq("id", req.org_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// NEW: POST /api/org/auto-reply
// Body: { enabled: boolean }
// Updates orgs.auto_reply_enabled
// ─────────────────────────────────────────────
org.post("/auto-reply", ensureAuth, express.json(), async (req: any, res) => {
  try {
    const enabled = !!req.body?.enabled;

    const { data, error } = await supa
      .from("orgs")
      .update({ auto_reply_enabled: enabled })
      .eq("id", req.org_id)
      .select("id, auto_reply_enabled")
      .single();

    if (error) {
      console.error("[ORG][auto-reply] update error", error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      ok: true,
      auto_reply_enabled: data?.auto_reply_enabled ?? enabled,
    });
  } catch (e: any) {
    console.error("[ORG][auto-reply] ERR", e?.message || e);
    return res
      .status(500)
      .json({ error: e?.message || "auto_reply_update_failed" });
  }
});

// ─────────────────────────────────────────────
// Helper: normalize phone → digits only
// ─────────────────────────────────────────────
function normalizePhone(raw: string): string {
  return String(raw || "").replace(/[^\d]/g, "");
}

// ─────────────────────────────────────────────
// NEW: POST /api/org/customer-auto-reply
// Body: { phone: string; enabled: boolean }
// Stores per-customer auto-reply override
// Table expected: org_customer_settings
//   - org_id (text)
//   - customer_phone (text)
//   - auto_reply_enabled (boolean)
//   - created_at / updated_at (optional)
// ─────────────────────────────────────────────
org.post(
  "/customer-auto-reply",
  ensureAuth,
  express.json(),
  async (req: any, res) => {
    try {
      const { phone, enabled } = req.body || {};
      if (!phone || typeof enabled === "undefined") {
        return res
          .status(400)
          .json({ ok: false, error: "phone_and_enabled_required" });
      }

      const phoneNorm = normalizePhone(phone);
      if (!phoneNorm) {
        return res
          .status(400)
          .json({ ok: false, error: "invalid_phone_format" });
      }

      const { data, error } = await supa
        .from("org_customer_settings")
        .upsert(
          {
            org_id: req.org_id,
            customer_phone: phoneNorm,
            auto_reply_enabled: !!enabled,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "org_id,customer_phone" }
        )
        .select("org_id, customer_phone, auto_reply_enabled")
        .single();

      if (error) {
        console.error(
          "[ORG][customer-auto-reply] upsert error",
          error.message
        );
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.json({
        ok: true,
        org_id: data.org_id,
        customer_phone: data.customer_phone,
        auto_reply_enabled: data.auto_reply_enabled,
      });
    } catch (e: any) {
      console.error("[ORG][customer-auto-reply] ERR", e?.message || e);
      return res.status(500).json({
        ok: false,
        error: e?.message || "customer_auto_reply_update_failed",
      });
    }
  }
);

// ─────────────────────────────────────────────
// NEW (optional): GET /api/org/customer-auto-reply?phone=...
// Returns per-customer override if it exists
// ─────────────────────────────────────────────
org.get(
  "/customer-auto-reply",
  ensureAuth,
  async (req: any, res) => {
    try {
      const phoneRaw = String(req.query.phone || "");
      if (!phoneRaw) {
        return res
          .status(400)
          .json({ ok: false, error: "phone_query_required" });
      }

      const phoneNorm = normalizePhone(phoneRaw);

      const { data, error } = await supa
        .from("org_customer_settings")
        .select("auto_reply_enabled")
        .eq("org_id", req.org_id)
        .eq("customer_phone", phoneNorm)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error(
          "[ORG][customer-auto-reply][GET] error",
          error.message
        );
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.json({
        ok: true,
        phone: phoneNorm,
        auto_reply_enabled: data?.auto_reply_enabled ?? null,
      });
    } catch (e: any) {
      console.error(
        "[ORG][customer-auto-reply][GET] ERR",
        e?.message || e
      );
      return res.status(500).json({
        ok: false,
        error: e?.message || "customer_auto_reply_fetch_failed",
      });
    }
  }
);

export default org;