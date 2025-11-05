// src/routes/admin_products.ts
import express from "express";
import { supa } from "../db";
import { ensureAdmin } from "./_ensureAdmin";

export const adminProducts = express.Router();

adminProducts.get("/", ensureAdmin, async (req, res) => {
  try {
    const { org_id } = req.query as { org_id?: string };
    let q = supa.from("products").select("*").order("created_at", { ascending: false }).limit(500);
    if (org_id) q = q.eq("org_id", org_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

adminProducts.post("/:id/add-alias", ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { alias } = req.body || {};
    if (!alias || !String(alias).trim()) return res.status(400).json({ error: "alias_required" });
    const { error } = await supa.rpc("add_product_alias", { p_id: id, new_alias: String(alias).trim().toLowerCase() });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default adminProducts;