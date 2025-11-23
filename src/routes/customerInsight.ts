// src/routes/customerInsight.ts
import express from "express";
import { normalizePhoneForKey } from "../routes/waba/clarifyAddress";
import {
  getCustomerSession,
  buildCustomerInsight,
} from "../session/sessionEngine";

export const customerInsight = express.Router();

/**
 * GET /customer-insight?org_id=...&phone=...
 *
 * phone can be raw WhatsApp number (with or without +); we normalize it.
 */
customerInsight.get("/", async (req, res) => {
  try {
    const orgId = String(req.query.org_id || "").trim();
    const phoneRaw = String(req.query.phone || "").trim();

    if (!orgId || !phoneRaw) {
      return res.status(400).json({
        ok: false,
        error: "org_id and phone are required",
      });
    }

    const phoneKey = normalizePhoneForKey(phoneRaw);

    const session = await getCustomerSession(orgId, phoneKey);
    const insight = buildCustomerInsight(session);

    return res.json({
      ok: true,
      org_id: orgId,
      phone_key: phoneKey,
      insight,
    });
  } catch (e: any) {
    console.error("[CUSTOMER_INSIGHT][ERR]", e?.message || e);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: e?.message || String(e),
    });
  }
});

export default customerInsight;