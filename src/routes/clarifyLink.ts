// src/routes/clarifyLink.ts
import express from "express";
import { supa } from "../db";
import { makeClarifyLink } from "../util/clarifyLink";
import resolvePhoneForOrder, { normalizePhone } from "../util/normalizePhone";

export const clarifyLink = express.Router();

// small helpers
const asStr = (v: any) => (typeof v === "string" ? v : v == null ? "" : String(v));
const trim = (v: any) => asStr(v).trim();
const toNull = (v: any) => {
  const t = trim(v);
  return t.length ? t : null;
};
const uniqByKey = <T>(arr: T[], keyFn: (t: T) => string) => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
};

clarifyLink.post("/", express.json(), async (req, res) => {
  try {
    const { order_id, line_index, ttlSeconds } = req.body || {};
    if (!order_id || typeof line_index !== "number") {
      return res.status(400).json({ ok: false, error: "order_id_and_line_index_required" });
    }

    // load order
    const { data: order, error } = await supa
      .from("orders")
      .select("id, org_id, items, source_phone, customer_name")
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

    const canonical = trim(item.canonical || item.name || "");
    if (!canonical) {
      return res.status(422).json({ ok: false, error: "line_has_no_name" });
    }

    // decide which fields to ask for
    const needBrand = !trim(item.brand);
    const needVariant = !trim(item.variant);

    // try to get a phone (to pull customer-specific prefs)
    const phoneNorm =
      normalizePhone(order.source_phone || "") ||
      (await resolvePhoneForOrder(order.org_id, order.id, order.customer_name)) ||
      null;

    // --- 1) fetch suggestions from learnings ---
    let cust: Array<{ brand: string | null; variant: string | null; cnt: number }> = [];
    let pop: Array<{ brand: string | null; variant: string | null; cnt: number }> = [];

    try {
      if (phoneNorm) {
        const { data: crows } = await supa
          .from("customer_prefs")
          .select("brand, variant, cnt")
          .eq("org_id", order.org_id)
          .eq("customer_phone", phoneNorm)
          .eq("canonical", canonical)
          .order("cnt", { ascending: false })
          .limit(5);
        cust = (crows || []).map((r: any) => ({
          brand: toNull(r.brand), // tables store '' for generic → convert to null in UI
          variant: toNull(r.variant),
          cnt: Number(r.cnt || 0),
        }));
      }

      const { data: brows } = await supa
        .from("brand_variant_stats")
        .select("brand, variant, cnt")
        .eq("org_id", order.org_id)
        .eq("canonical", canonical)
        .order("cnt", { ascending: false })
        .limit(7);
      pop = (brows || []).map((r: any) => ({
        brand: toNull(r.brand),
        variant: toNull(r.variant),
        cnt: Number(r.cnt || 0),
      }));
    } catch (e) {
      // non-fatal
      console.warn("[clarify-link][learn fetch warn]", (e as any)?.message || e);
    }

    // --- 2) assemble option candidates ---
    type Opt = {
      label: string;
      canonical: string;
      brand?: string | null;
      variant?: string | null;
      rec?: boolean;
    };

    const options: Opt[] = [];

    // always include the current line as-is (first)
    options.push({
      label: canonical,
      canonical,
      brand: toNull(item.brand),
      variant: toNull(item.variant),
    });

    // promote the best per-customer choice (if any) as Recommended
    if (cust.length) {
      const top = cust[0];
      options.push({
        label: canonical,
        canonical,
        brand: top.brand ?? null,
        variant: top.variant ?? null,
        rec: true,
      });
      // add a couple more (non-rec)
      for (const r of cust.slice(1, 3)) {
        options.push({
          label: canonical,
          canonical,
          brand: r.brand ?? null,
          variant: r.variant ?? null,
        });
      }
    }

    // then add a few shop-wide popular combos (skip ones we already added)
    for (const r of pop.slice(0, 4)) {
      options.push({
        label: canonical,
        canonical,
        brand: r.brand ?? null,
        variant: r.variant ?? null,
      });
    }

    // --- 3) sensible fallbacks if we still have very few options ---
    const lowerCanon = canonical.toLowerCase();

    if (options.length < 2) {
      // domain-aware fallback for Milk
      if (lowerCanon === "milk") {
        if (needBrand) {
          options.push({ label: canonical, canonical, brand: "Almarai", variant: toNull(item.variant), rec: !cust.length && !pop.length });
          options.push({ label: canonical, canonical, brand: "Al Rawabi", variant: toNull(item.variant) });
        }
        if (needVariant) {
          // show common variants
          options.push({ label: canonical, canonical, brand: toNull(item.brand), variant: "Full Fat" });
          options.push({ label: canonical, canonical, brand: toNull(item.brand), variant: "Low Fat" });
          // infer pack size if unit suggests liters
          if (/l$|ltr|liter|litre/i.test(asStr(item.unit))) {
            const q = Number(item.qty || 1);
            const sz = q && Number.isFinite(q) ? `${q}L` : "1L";
            options.push({ label: canonical, canonical, brand: toNull(item.brand), variant: sz });
          } else {
            options.push({ label: canonical, canonical, brand: toNull(item.brand), variant: "1L" });
          }
        }
      } else {
        // generic fallback: keep base and add at least one "generic" choice
        options.push({ label: canonical, canonical, brand: toNull(item.brand), variant: toNull(item.variant) });
      }
    }

    // --- 4) de-dupe + cap to 6 options ---
    const deduped = uniqByKey(options, (o) => `${o.canonical}|${o.brand || ""}|${o.variant || ""}`);
    const limited = deduped.slice(0, 6);

    if (!limited.length) {
      return res.status(422).json({ ok: false, error: "no_options_available" });
    }

    // compute which fields we still need
    const ask = {
      brand: needBrand,
      variant: needVariant,
    };

    // include normalized phone in token if available (ignored by older tokens)
    const tokenPhone = phoneNorm || null;

    const url = makeClarifyLink({
      org_id: order.org_id,
      order_id,
      line_index,
      options: limited,
      ask,
      allow_other: true,
      ttlSeconds: typeof ttlSeconds === "number" ? ttlSeconds : undefined,
      // these two are optional extras your makeClarifyLink may or may not accept.
      // if your types already include them (as we updated earlier), they’ll be carried;
      // otherwise they’re ignored without breaking the link.
      // @ts-ignore
      source_phone: tokenPhone,
      // @ts-ignore
      customer_name: order.customer_name || null,
    });

    return res.json({ ok: true, url });
  } catch (e: any) {
    console.error("[clarify-link]", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default clarifyLink;