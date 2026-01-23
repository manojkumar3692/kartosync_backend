import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
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
// GET /api/org/me
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
// POST /api/org/map-wa
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
// Returns payment + currency + store location + delivery slot settings
// ─────────────────────────────────────────────
org.get("/settings", ensureAuth, async (req: any, res) => {
  try {
    const { data, error } = await supa
      .from("orgs")
      .select("*") // tolerant: we just pick what exists
      .eq("id", req.org_id)
      .single();

    if (error || !data) {
      console.error("[ORG][settings GET] error:", error?.message);
      return res
        .status(404)
        .json({ ok: false, error: "org_not_found_or_no_settings" });
    }

    // helper: normalize numeric columns that might come as string
    const numOrNull = (v: any): number | null => {
      if (v === null || v === undefined || v === "") return null;
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    return res.json({
      ok: true,
      id: data.id,
      name: data.name,

      // 💳 Payments
      payment_enabled: !!data.payment_enabled,
      payment_qr_url: data.payment_qr_url || null,
      payment_instructions: data.payment_instructions || "",

      // 🆕 Payment mode / footer
      accept_only_cash: !!data.accept_only_cash,
      order_footer_message: data.order_footer_message || "",

      // 💱 Currency
      default_currency: data.default_currency || "AED",

      // 📍 Store location (used by addressEngine + deliveryEngine)
      store_address: data.store_address || "",
      store_lat: numOrNull(data.store_lat),
      store_lng: numOrNull(data.store_lng),

      // 🕒 Store timings / timezone (used by slot + FAQ logic)
      delivery_open_time: data.delivery_open_time || null, // "11:00:00"
      delivery_close_time: data.delivery_close_time || null, // "23:00:00"
      store_timezone: data.store_timezone || "Asia/Kolkata",

      // ✅ Delivery slots (enable/disable + params)
      delivery_slot_enabled: !!data.delivery_slot_enabled,
      delivery_slot_interval_min:
        numOrNull(data.delivery_slot_interval_min) ?? 30,
      delivery_slot_prep_min: numOrNull(data.delivery_slot_prep_min) ?? 45,
      delivery_slot_capacity: numOrNull(data.delivery_slot_capacity) ?? 10,

      // optional JSON config if you want to expose it
      delivery_slots_json: data.delivery_slots_json || null,
    });
  } catch (e: any) {
    console.error("[ORG][settings GET] fatal:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/org/settings
// Body: payment + currency + store location + delivery slot settings
// ─────────────────────────────────────────────
org.post("/settings", ensureAuth, express.json(), async (req: any, res) => {
  try {
    const {
      // existing
      payment_enabled,
      payment_qr_url,
      payment_instructions,
      default_currency,
      store_address,
      store_lat,
      store_lng,

      // 🆕 existing fields
      accept_only_cash,
      order_footer_message,

      // 🕒 timings / timezone
      delivery_open_time,
      delivery_close_time,
      store_timezone,

      // ✅ delivery slots
      delivery_slot_enabled,
      delivery_slot_interval_min,
      delivery_slot_prep_min,
      delivery_slot_capacity,
      delivery_slots_json,
    } = req.body || {};

    const patch: any = {};

    const numOrIgnore = (v: any): number | null | undefined => {
      // undefined => ignore (don’t touch DB)
      // null => set null
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return undefined;
      return n;
    };

    // 💳 Payments
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

    // 🆕 Payment mode / footer
    if (typeof accept_only_cash === "boolean") {
      patch.accept_only_cash = accept_only_cash;
    }
    if (
      typeof order_footer_message === "string" ||
      order_footer_message === null
    ) {
      patch.order_footer_message = order_footer_message;
    }

    // 💱 Currency
    if (typeof default_currency === "string") {
      patch.default_currency = default_currency;
    }

    // 📍 Store address text
    if (typeof store_address === "string" || store_address === null) {
      patch.store_address = store_address;
    }

    // 📍 Store lat/lng (normalize to number | null, ignore bad values)
    const latNum = numOrIgnore(store_lat);
    if (latNum !== undefined) patch.store_lat = latNum;

    const lngNum = numOrIgnore(store_lng);
    if (lngNum !== undefined) patch.store_lng = lngNum;

    // 🕒 timings / timezone
    if (typeof delivery_open_time === "string" || delivery_open_time === null) {
      patch.delivery_open_time = delivery_open_time;
    }
    if (
      typeof delivery_close_time === "string" ||
      delivery_close_time === null
    ) {
      patch.delivery_close_time = delivery_close_time;
    }
    if (typeof store_timezone === "string" || store_timezone === null) {
      patch.store_timezone = store_timezone;
    }

    // ✅ slot enable/disable
    if (typeof delivery_slot_enabled === "boolean") {
      patch.delivery_slot_enabled = delivery_slot_enabled;
    }

    // ✅ slot params
    const intervalNum = numOrIgnore(delivery_slot_interval_min);
    if (intervalNum !== undefined) patch.delivery_slot_interval_min = intervalNum;

    const prepNum = numOrIgnore(delivery_slot_prep_min);
    if (prepNum !== undefined) patch.delivery_slot_prep_min = prepNum;

    const capNum = numOrIgnore(delivery_slot_capacity);
    if (capNum !== undefined) patch.delivery_slot_capacity = capNum;

    // optional JSON config
    if (typeof delivery_slots_json === "string" || delivery_slots_json === null) {
      patch.delivery_slots_json = delivery_slots_json;
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
        `
        id,
        name,

        payment_enabled,
        payment_qr_url,
        payment_instructions,
        accept_only_cash,
        order_footer_message,
        default_currency,

        store_address,
        store_lat,
        store_lng,

        delivery_open_time,
        delivery_close_time,
        store_timezone,

        delivery_slot_enabled,
        delivery_slot_interval_min,
        delivery_slot_prep_min,
        delivery_slot_capacity,

        delivery_slots_json
      `
      )
      .single();

    if (error || !data) {
      console.error("[ORG][settings POST] error:", error?.message);
      return res.status(500).json({ ok: false, error: "update_failed" });
    }

    const numOrNull = (v: any): number | null => {
      if (v === null || v === undefined || v === "") return null;
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    return res.json({
      ok: true,
      id: data.id,
      name: data.name,

      payment_enabled: !!data.payment_enabled,
      payment_qr_url: data.payment_qr_url || null,
      payment_instructions: data.payment_instructions || "",

      accept_only_cash: !!data.accept_only_cash,
      order_footer_message: data.order_footer_message || "",

      default_currency: data.default_currency || "AED",
      store_address: data.store_address || "",
      store_lat: numOrNull((data as any).store_lat),
      store_lng: numOrNull((data as any).store_lng),

      delivery_open_time: (data as any).delivery_open_time || null,
      delivery_close_time: (data as any).delivery_close_time || null,
      store_timezone: (data as any).store_timezone || "Asia/Kolkata",

      delivery_slot_enabled: !!(data as any).delivery_slot_enabled,
      delivery_slot_interval_min:
        numOrNull((data as any).delivery_slot_interval_min) ?? 30,
      delivery_slot_prep_min: numOrNull((data as any).delivery_slot_prep_min) ?? 45,
      delivery_slot_capacity: numOrNull((data as any).delivery_slot_capacity) ?? 10,

      delivery_slots_json: (data as any).delivery_slots_json || null,
    });
  } catch (e: any) {
    console.error("[ORG][settings POST] fatal:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/org/payment-qr (file upload)
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

      const qrDir = path.join(__dirname, "..", "..", "static", "qr");
      if (!fs.existsSync(qrDir)) {
        fs.mkdirSync(qrDir, { recursive: true });
      }

      const ext = path.extname(file.originalname || "") || ".png";
      const filename = `org-${req.org_id}-qr-${Date.now()}${ext}`;
      const finalPath = path.join(qrDir, filename);

      fs.writeFileSync(finalPath, file.buffer);
      console.log("[ORG][payment-qr] saved file at:", finalPath);

      const urlPath = `/static/qr/${filename}`;
      const baseUrl =
        process.env.PUBLIC_BASE_URL ||
        `${req.protocol}://${req.get("host") || ""}`;

      const publicUrl = `${baseUrl}${urlPath}`;
      console.log("[ORG][payment-qr] public URL:", publicUrl);

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
// POST /api/org/auto-reply
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
// POST /api/org/customer-auto-reply
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
// GET /api/org/customer-auto-reply?phone=...
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