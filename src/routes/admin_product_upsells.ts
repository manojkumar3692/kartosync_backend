import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";

export const adminProductUpsells = express.Router();

function ensureOrgAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);

    if (!d?.org_id) return res.status(401).json({ error: "unauthorized" });

    req.org_id = d.org_id;
    next();
  } catch (e) {
    console.error("[adminProductUpsells][auth] error:", e);
    return res.status(401).json({ error: "unauthorized" });
  }
}

const asStr = (v: any) => (typeof v === "string" ? v : v == null ? "" : String(v));
const trim = (v: any) => asStr(v).trim();

adminProductUpsells.get("/", ensureOrgAuth, async (req: any, res) => {
  try {
    const org_id = req.org_id as string;
    const source_product_id = trim(req.query.source_product_id || "");

    if (!source_product_id) {
      return res.status(400).json({ error: "source_product_id_required" });
    }

    const { data, error } = await supa
      .from("product_upsells")
      .select("source_product_id, upsell_product_id, is_active, max_qty, custom_prompt")
      .eq("org_id", org_id)
      .eq("source_product_id", source_product_id)
      .maybeSingle();

    if (error) throw error;

    return res.json({ item: data || null });
  } catch (e: any) {
    console.error("[adminProductUpsells][GET] err:", e?.message || e);
    return res.status(500).json({ error: e.message || "product_upsell_get_failed" });
  }
});

adminProductUpsells.post("/", ensureOrgAuth, express.json(), async (req: any, res) => {
  try {
    const org_id = req.org_id as string;
    const body = req.body || {};

    const source_product_id = trim(body.source_product_id || "");
    const upsell_product_id = trim(body.upsell_product_id || "");

    if (!source_product_id) return res.status(400).json({ error: "source_product_id_required" });
    if (!upsell_product_id) return res.status(400).json({ error: "upsell_product_id_required" });

    const is_active = body.is_active === false ? false : true;

    let max_qty = Number(body.max_qty);
    if (!Number.isFinite(max_qty) || max_qty <= 0) max_qty = 2;
    if (max_qty > 9) max_qty = 9; // keep sane for WhatsApp

    const custom_prompt =
      typeof body.custom_prompt === "string" && body.custom_prompt.trim()
        ? body.custom_prompt.trim()
        : null;

    // upsert by unique(org_id, source_product_id)
    const row = {
      org_id,
      source_product_id,
      upsell_product_id,
      is_active,
      max_qty,
      custom_prompt,
    };

    const { data, error } = await supa
      .from("product_upsells")
      .upsert(row, { onConflict: "org_id,source_product_id" })
      .select("source_product_id, upsell_product_id, is_active, max_qty, custom_prompt")
      .single();

    if (error) throw error;

    return res.json({ ok: true, item: data });
  } catch (e: any) {
    console.error("[adminProductUpsells][POST] err:", e?.message || e);
    return res.status(500).json({ error: e.message || "product_upsell_upsert_failed" });
  }
});

adminProductUpsells.delete("/:source_product_id", ensureOrgAuth, async (req: any, res) => {
  try {
    const org_id = req.org_id as string;
    const source_product_id = trim(req.params.source_product_id || "");
    if (!source_product_id) return res.status(400).json({ error: "source_product_id_required" });

    const { error } = await supa
      .from("product_upsells")
      .delete()
      .eq("org_id", org_id)
      .eq("source_product_id", source_product_id);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[adminProductUpsells][DELETE] err:", e?.message || e);
    return res.status(500).json({ error: e.message || "product_upsell_delete_failed" });
  }
});

export default adminProductUpsells;