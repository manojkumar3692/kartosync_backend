// src/routes/clarifyLink.ts
import express from "express";
import { supa } from "../db";
import { makeClarifyLink } from "../util/clarifyLink";

export const clarifyLink = express.Router();

clarifyLink.post("/", express.json(), async (req, res) => {
  try {
    const { order_id, line_index, ttlSeconds } = req.body || {};
    if (!order_id || typeof line_index !== "number") {
      return res.status(400).json({ ok: false, error: "order_id_and_line_index_required" });
    }

    const { data: order, error } = await supa
      .from("orders")
      .select("id, org_id, items, source_phone")
      .eq("id", order_id)
      .limit(1)
      .single();

    if (error || !order) {
      return res.status(404).json({ ok: false, error: "order_not_found" });
    }

    const items: any[] = Array.isArray(order.items) ? order.items : [];
    const item = items[line_index];
    if (!item) {
      return res.status(400).json({ ok: false, error: "line_index_invalid" });
    }

    const baseName = String(item.canonical || item.name || "").trim();
    if (!baseName) {
      return res.status(422).json({ ok: false, error: "line_has_no_name" });
    }

    // Decide what we need to ask for
    const needBrand = !item.brand || !String(item.brand).trim();
    const needVariant = !item.variant || !String(item.variant).trim();

    // Build options (you can replace this with product search / BVS / customer prefs)
    const rawOptions = [
      {
        label: baseName,
        canonical: baseName,
        brand: item.brand ?? null,
        variant: item.variant ?? null,
      },
      ...(needBrand
        ? [
            { label: `${baseName} (Maggi)`, canonical: baseName, brand: "Maggi", variant: item.variant ?? null, rec: true },
            { label: `${baseName} (Indomie)`, canonical: baseName, brand: "Indomie", variant: item.variant ?? null },
          ]
        : []),
      ...(needVariant
        ? [
            { label: `${baseName} Masala 70g`, canonical: baseName, brand: item.brand ?? null, variant: "Masala 70g", rec: true },
            { label: `${baseName} Chicken 70g`, canonical: baseName, brand: item.brand ?? null, variant: "Chicken 70g" },
          ]
        : []),
    ];

    // De-dupe by (label|brand|variant)
    const seen = new Set<string>();
    const options = rawOptions.filter((opt) => {
      const key = `${opt.label}|${opt.brand || ""}|${opt.variant || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!options.length) {
      return res.status(422).json({ ok: false, error: "no_options_available" });
    }

    const url = makeClarifyLink({
      org_id: order.org_id,
      order_id,
      line_index,
      options,
      ask: { brand: needBrand, variant: needVariant }, // ✅ tell page which inputs to show
      allow_other: true,                                // ✅ show the “Other” section
      ttlSeconds: typeof ttlSeconds === "number" ? ttlSeconds : undefined,
    });

    return res.json({ ok: true, url });
  } catch (e: any) {
    console.error("[clarify-link]", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default clarifyLink;