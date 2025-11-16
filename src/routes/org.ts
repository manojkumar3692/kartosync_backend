import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";        // ⬅️ added
import path from "path";           // ⬅️ added
import { supa } from "../db";
import fs from "fs";

export const org = express.Router();

// Simple in-memory file storage for QR uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

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
// GET /api/org/settings
// Returns payment + currency settings for current org
// ─────────────────────────────────────────────
org.get("/settings", ensureAuth, async (req: any, res) => {
  try {
    const { data, error } = await supa
      .from("orgs")
      .select("*") // 👈 tolerant: don't require new columns to exist
      .eq("id", req.org_id)
      .single();

    if (error || !data) {
      console.error("[ORG][settings GET] error:", error?.message);
      return res
        .status(404)
        .json({ ok: false, error: "org_not_found_or_no_settings" });
    }

    return res.json({
      ok: true,
      id: data.id,
      name: data.name,
      payment_enabled: !!data.payment_enabled,
      payment_qr_url: data.payment_qr_url || null,
      payment_instructions: data.payment_instructions || "",
      default_currency: data.default_currency || "AED",
    });
  } catch (e: any) {
    console.error("[ORG][settings GET] fatal:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ─────────────────────────────────────────────
// NEW: POST /api/org/settings
// Body: { payment_enabled?, payment_qr_url?, payment_instructions?, default_currency? }
// Updates those columns on orgs table
// ─────────────────────────────────────────────
org.post("/settings", ensureAuth, express.json(), async (req: any, res) => {
  try {
    const {
      payment_enabled,
      payment_qr_url,
      payment_instructions,
      default_currency,
    } = req.body || {};

    const patch: any = {};

    if (typeof payment_enabled === "boolean") {
      patch.payment_enabled = payment_enabled;
    }
    if (typeof payment_qr_url === "string" || payment_qr_url === null) {
      patch.payment_qr_url = payment_qr_url;
    }
    if (
      typeof payment_instructions === "string" ||
      payment_instructions === null
    ) {
      patch.payment_instructions = payment_instructions;
    }
    if (typeof default_currency === "string") {
      patch.default_currency = default_currency;
    }

    // Nothing to update
    if (!Object.keys(patch).length) {
      return res.json({ ok: true });
    }

    const { data, error } = await supa
      .from("orgs")
      .update(patch)
      .eq("id", req.org_id)
      .select(
        "id, name, payment_enabled, payment_qr_url, payment_instructions, default_currency"
      )
      .single();

    if (error || !data) {
      console.error("[ORG][settings POST] error:", error?.message);
      return res.status(500).json({ ok: false, error: "update_failed" });
    }

    return res.json({
      ok: true,
      id: data.id,
      name: data.name,
      payment_enabled: !!data.payment_enabled,
      payment_qr_url: data.payment_qr_url || null,
      payment_instructions: data.payment_instructions || "",
      default_currency: data.default_currency || "AED",
    });
  } catch (e: any) {
    console.error("[ORG][settings POST] fatal:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ─────────────────────────────────────────────
// NEW: POST /api/org/payment-qr (file upload)
// Frontend: uploadPaymentQr(file) → multipart/form-data with "file"
// ─────────────────────────────────────────────
org.post(
  "/payment-qr",
  ensureAuth,
  upload.single("file"),
  async (req: any, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ ok: false, error: "file_required" });
      }

      const file = req.file;

      // ensure directory
      const qrDir = path.join(__dirname, "..", "..", "static", "qr");
      if (!fs.existsSync(qrDir)) {
        fs.mkdirSync(qrDir, { recursive: true });
      }

      // give the file a nicer name (optional)
      const ext = path.extname(file.originalname || "") || ".png";
      const filename = `org-${req.org_id}-qr-${Date.now()}${ext}`;
      const finalPath = path.join(qrDir, filename);

      // ⬇️ IMPORTANT: memoryStorage → write buffer to disk
      fs.writeFileSync(finalPath, file.buffer);
      console.log("[ORG][payment-qr] saved file at:", finalPath);

      const urlPath = `/static/qr/${filename}`;

      // IMPORTANT: build a full public URL for WhatsApp
      const baseUrl =
        process.env.PUBLIC_BASE_URL ||
        `${req.protocol}://${req.get("host") || ""}`;

      const publicUrl = `${baseUrl}${urlPath}`;
      console.log("[ORG][payment-qr] public URL:", publicUrl);

      // store on org row
      const { error } = await supa
        .from("orgs")
        .update({ payment_qr_url: publicUrl, payment_enabled: true })
        .eq("id", req.org_id);

      if (error) {
        console.error("[ORG][payment-qr] update error", error.message);
        return res
          .status(500)
          .json({ ok: false, error: "update_failed" });
      }

      // return URL to frontend (OrgSettings preview)
      return res.json({ ok: true, url: publicUrl });
    } catch (e: any) {
      console.error("[ORG][payment-qr] ERR", e?.message || e);
      return res
        .status(500)
        .json({ ok: false, error: "internal_error" });
    }
  }
);

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
org.get("/customer-auto-reply", ensureAuth, async (req: any, res) => {
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
      console.error("[ORG][customer-auto-reply][GET] error", error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({
      ok: true,
      phone: phoneNorm,
      auto_reply_enabled: data?.auto_reply_enabled ?? null,
    });
  } catch (e: any) {
    console.error("[ORG][customer-auto-reply][GET] ERR", e?.message || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "customer_auto_reply_fetch_failed",
    });
  }
});

export default org;