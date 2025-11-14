// src/routes/admin_products.ts
import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";

export const adminProducts = express.Router();

// ─────────────────────────────────────────────────────────
// Auth: normal org user (store owner) – not super admin
// Requires JWT with { org_id }
// ─────────────────────────────────────────────────────────
function ensureOrgAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);

    if (!d?.org_id) {
      return res.status(401).json({ error: "unauthorized" });
    }

    req.org_id = d.org_id;
    next();
  } catch (e) {
    console.error("[adminProducts][auth] error:", e);
    return res.status(401).json({ error: "unauthorized" });
  }
}

// Small helpers
const asStr = (v: any) =>
  typeof v === "string" ? v : v == null ? "" : String(v);
const trim = (v: any) => asStr(v).trim();

// ─────────────────────────────────────────────────────────
// GET /api/admin/products
// Query: ?limit=&offset=&search=&category=
// Returns: { items: AdminProduct[], total: number }
// ─────────────────────────────────────────────────────────
adminProducts.get("/", ensureOrgAuth, async (req: any, res) => {
  try {
    const org_id = req.org_id as string;
    const { limit, offset, search, category } = req.query as {
      limit?: string;
      offset?: string;
      search?: string;
      category?: string;
    };

    const lim = Number.isFinite(Number(limit)) ? Number(limit) : 50;
    const off = Number.isFinite(Number(offset)) ? Number(offset) : 0;

    let q = supa
      .from("products")
      .select("*", { count: "exact" })
      .eq("org_id", org_id)
      .order("canonical", { ascending: true })
      .order("brand", { ascending: true })
      .order("variant", { ascending: true })
      .range(off, off + lim - 1);

    const s = trim(search || "");
    if (s) {
      // Search across canonical, display_name, brand, variant
      const pattern = `%${s}%`;
      q = q.or(
        `canonical.ilike.${pattern},display_name.ilike.${pattern},brand.ilike.${pattern},variant.ilike.${pattern}`
      );
    }

    const cat = trim(category || "");
    if (cat && cat.toLowerCase() !== "all") {
      q = q.eq("category", cat);
    }

    const { data, error, count } = await q;
    if (error) throw error;

    const items = (data || []) as any[];
    const total = typeof count === "number" ? count : items.length;

    return res.json({ items, total });
  } catch (e: any) {
    console.error("[adminProducts][GET] err:", e?.message || e);
    return res
      .status(500)
      .json({ error: e.message || "products_list_failed" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/admin/products
// Body: AdminProduct (id optional)
//  - if id present → update
//  - else → insert
// Returns: { ok: boolean, product: AdminProduct }
// ─────────────────────────────────────────────────────────
adminProducts.post(
  "/",
  ensureOrgAuth,
  express.json(),
  async (req: any, res) => {
    try {
      const org_id = req.org_id as string;
      const body = req.body || {};

      const id = trim(body.id || "");
      const canonical = trim(body.canonical || "");
      const display_name = trim(body.display_name || "") || canonical;

      if (!canonical) {
        return res.status(400).json({ error: "canonical_required" });
      }

      // price_per_unit: accept number or string, normalize to number | null
      const priceRaw = trim(
        body.price_per_unit !== undefined && body.price_per_unit !== null
          ? body.price_per_unit
          : ""
      );
      let price_per_unit: number | null = null;
      if (priceRaw) {
        const n = Number(priceRaw);
        if (!Number.isNaN(n)) price_per_unit = n;
      }

      const row = {
        org_id,
        canonical,
        display_name,
        category: trim(body.category || "") || null,
        base_unit: trim(body.base_unit || "") || null,
        brand: trim(body.brand || "") || null,
        variant: trim(body.variant || "") || null,
        dynamic_price: !!body.dynamic_price,
        is_active: body.is_active === false ? false : true,
        price_per_unit, // 👈 NEW
      };

      if (id) {
        // Update existing
        const { data, error } = await supa
          .from("products")
          .update(row)
          .eq("org_id", org_id)
          .eq("id", id)
          .select("*")
          .single();

        if (error) throw error;
        return res.json({ ok: true, product: data });
      } else {
        // Insert new
        const { data, error } = await supa
          .from("products")
          .insert(row)
          .select("*")
          .single();

        if (error) throw error;
        return res.json({ ok: true, product: data });
      }
    } catch (e: any) {
      console.error("[adminProducts][POST] err:", e?.message || e);
      return res
        .status(500)
        .json({ error: e.message || "product_upsert_failed" });
    }
  }
);

// ─────────────────────────────────────────────────────────
// DELETE /api/admin/products/:id
// ─────────────────────────────────────────────────────────
adminProducts.delete("/:id", ensureOrgAuth, async (req: any, res) => {
  try {
    const org_id = req.org_id as string;
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: "id_required" });
    }

    const { error } = await supa
      .from("products")
      .delete()
      .eq("org_id", org_id)
      .eq("id", id);

    if (error) throw error;
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[adminProducts][DELETE] err:", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: e.message || "product_delete_failed" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/admin/products/:id/add-alias
// Body: { alias: string }
// Uses Postgres function add_product_alias(p_id, new_alias)
// ─────────────────────────────────────────────────────────
adminProducts.post(
  "/:id/add-alias",
  ensureOrgAuth,
  express.json(),
  async (req: any, res) => {
    try {
      const { id } = req.params;
      const { alias } = req.body || {};
      if (!alias || !String(alias).trim()) {
        return res.status(400).json({ error: "alias_required" });
      }

      const aliasStr = String(alias).trim().toLowerCase();
      const { error } = await supa.rpc("add_product_alias", {
        p_id: id,
        new_alias: aliasStr,
      });
      if (error) throw error;

      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[adminProducts][add-alias] err:", e?.message || e);
      return res
        .status(500)
        .json({ error: e.message || "add_alias_failed" });
    }
  }
);

// ─────────────────────────────────────────────────────────
// POST /api/admin/products/import
// Body: { csvText: string, mode?: 'upsert' | 'insert' }
// Simple CSV: header row + records with columns:
// canonical,display_name,category,base_unit,brand,variant,dynamic_price,is_active,price_per_unit?
// ─────────────────────────────────────────────────────────
adminProducts.post(
  "/import",
  ensureOrgAuth,
  express.json(),
  async (req: any, res) => {
    try {
      const org_id = req.org_id as string;
      const { csvText, mode } = req.body || {};
      if (!csvText || !String(csvText).trim()) {
        return res.status(400).json({ error: "csvText_required" });
      }

      const lines = String(csvText)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      if (!lines.length) {
        return res.status(400).json({ error: "csv_empty" });
      }

      const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
      const findIdx = (name: string) => header.indexOf(name);

      const idxCanonical = findIdx("canonical");
      if (idxCanonical === -1) {
        return res
          .status(400)
          .json({ error: "canonical_column_required" });
      }

      const idxDisplay = findIdx("display_name");
      const idxCategory = findIdx("category");
      const idxBaseUnit = findIdx("base_unit");
      const idxBrand = findIdx("brand");
      const idxVariant = findIdx("variant");
      const idxDyn = findIdx("dynamic_price");
      const idxActive = findIdx("is_active");
      const idxPrice = findIdx("price_per_unit"); // 👈 NEW (optional column)

      let imported = 0;
      let updated = 0;

      for (let i = 1; i < lines.length; i++) {
        const rowRaw = lines[i];
        if (!rowRaw.trim()) continue;

        const cols = rowRaw.split(",").map((c) => c.trim());
        const canonical = trim(cols[idxCanonical] || "");
        if (!canonical) continue;

        const display_name = trim(
          idxDisplay >= 0 ? cols[idxDisplay] || "" : canonical
        );

        const category =
          idxCategory >= 0 ? trim(cols[idxCategory] || "") || null : null;
        const base_unit =
          idxBaseUnit >= 0 ? trim(cols[idxBaseUnit] || "") || null : null;
        const brand =
          idxBrand >= 0 ? trim(cols[idxBrand] || "") || null : null;
        const variant =
          idxVariant >= 0 ? trim(cols[idxVariant] || "") || null : null;

        const dynamic_price =
          idxDyn >= 0 ? /^true|1|yes$/i.test(cols[idxDyn] || "") : false;
        const is_active =
          idxActive >= 0
            ? !/^false|0|no$/i.test(cols[idxActive] || "")
            : true;

        let price_per_unit: number | null = null;
        if (idxPrice >= 0) {
          const rawP = trim(cols[idxPrice] || "");
          if (rawP) {
            const n = Number(rawP);
            if (!Number.isNaN(n)) price_per_unit = n;
          }
        }

        if (mode === "insert") {
          const { error } = await supa.from("products").insert({
            org_id,
            canonical,
            display_name,
            category,
            base_unit,
            brand,
            variant,
            dynamic_price,
            is_active,
            price_per_unit,
          });
          if (error) {
            console.warn(
              "[adminProducts][import][insert warn]",
              error.message
            );
            continue;
          }
          imported++;
        } else {
          // upsert by (org_id, canonical, brand, variant)
          const { data: existing, error: exErr } = await supa
            .from("products")
            .select("id")
            .eq("org_id", org_id)
            .eq("canonical", canonical)
            .eq("brand", brand)
            .eq("variant", variant)
            .limit(1)
            .maybeSingle();

          if (exErr) {
            console.warn(
              "[adminProducts][import][lookup warn]",
              exErr.message
            );
          }

          if (existing && (existing as any).id) {
            const { error: upErr } = await supa
              .from("products")
              .update({
                display_name,
                category,
                base_unit,
                dynamic_price,
                is_active,
                price_per_unit,
              })
              .eq("id", (existing as any).id)
              .eq("org_id", org_id);
            if (upErr) {
              console.warn(
                "[adminProducts][import][update warn]",
                upErr.message
              );
              continue;
            }
            updated++;
          } else {
            const { error: insErr } = await supa.from("products").insert({
              org_id,
              canonical,
              display_name,
              category,
              base_unit,
              brand,
              variant,
              dynamic_price,
              is_active,
              price_per_unit,
            });
            if (insErr) {
              console.warn(
                "[adminProducts][import][insert warn]",
                insErr.message
              );
              continue;
            }
            imported++;
          }
        }
      }

      return res.json({ ok: true, imported, updated });
    } catch (e: any) {
      console.error("[adminProducts][import] err:", e?.message || e);
      return res
        .status(500)
        .json({ error: e.message || "import_failed" });
    }
  }
);

export default adminProducts;