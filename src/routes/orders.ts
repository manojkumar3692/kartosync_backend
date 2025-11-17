// src/routes/orders.ts
import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";
import { parseOrder as ruleParse } from "../parser";
import resolvePhoneForOrder, { normalizePhone } from "../util/normalizePhone";

export const orders = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Status constants (store lowercase in DB; accept any case from client)
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_LIST = ["pending", "shipped", "paid", "cancelled"] as const;
type OrderStatus = (typeof STATUS_LIST)[number];
const STATUS_SET = new Set<string>(STATUS_LIST);

function normStatus(s?: string | null): OrderStatus | null {
  const v = String(s ?? "").trim().toLowerCase();
  return STATUS_SET.has(v) ? (v as OrderStatus) : null;
}

const asStr = (v: any) => (typeof v === "string" ? v : v == null ? "" : String(v));
const trim = (v: any) => asStr(v).trim();
const nz = (v: any) => (v == null ? "" : String(v)); // not-null string ('' allowed for generic)

// ─────────────────────────────────────────────────────────────────────────────
// Optional AI parser (graceful fallback if not present or no OPENAI_API_KEY)
// ─────────────────────────────────────────────────────────────────────────────
let aiParseOrder:
  | undefined
  | ((
      text: string,
      catalog?: Array<{ name: string; sku: string; aliases?: string[] }>,
      opts?: { org_id?: string; customer_phone?: string }
    ) => Promise<{
      items: any[];
      confidence?: number;
      reason?: string | null;
      is_order_like?: boolean;
    }>);
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  aiParseOrder = require("../ai/parser").aiParseOrder;
} catch {
  aiParseOrder = undefined;
}
const ENABLE_AI = !!process.env.OPENAI_API_KEY && !!aiParseOrder;

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware: extracts org_id from JWT
// ─────────────────────────────────────────────────────────────────────────────
function ensureAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    req.org_id = d.org_id;
    next();
  } catch (e) {
    console.error("Auth error:", e);
    res.status(401).json({ error: "unauthorized" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/orders  → list recent orders for this org
// Optional: ?status=pending|shipped|paid|cancelled&limit=100&offset=0
// ─────────────────────────────────────────────────────────────────────────────
orders.get("/", ensureAuth, async (req: any, res) => {
  try {
    const { status, limit = "200", offset = "0" } = req.query || {};
    let q = supa
      .from("orders")
      .select("*")
      .eq("org_id", req.org_id)
      .order("created_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    const ns = normStatus(status as string | undefined);
    if (ns) q = q.eq("status", ns);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    console.error("Orders GET error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/orders/past → list past (closed) orders for this org
// We define "past" as: paid + cancelled
// ─────────────────────────────────────────────────────────────────────────────
orders.get("/past", ensureAuth, async (req: any, res) => {
  try {
    const { limit = "200", offset = "0" } = req.query || {};
    const PAST_STATUSES: OrderStatus[] = ["paid", "cancelled"];

    const { data, error } = await supa
      .from("orders")
      .select("*")
      .eq("org_id", req.org_id)
      .in("status", PAST_STATUSES)
      .order("created_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw error;

    let orders = Array.isArray(data) ? data : [];

    // 🔁 Backfill frozen prices for any past orders that still have null prices
    for (const o of orders) {
      const items = Array.isArray(o.items) ? o.items : [];

      // "Needs freeze" = at least one item with both price_per_unit AND line_total missing
      const needsFreeze = items.some(
        (it: any) =>
          it &&
          (it.price_per_unit === null ||
            it.price_per_unit === undefined) &&
          (it.line_total === null || it.line_total === undefined)
      );

      if (!needsFreeze) continue;

      const frozen = await snapshotPricesFromCatalog(req.org_id, o.id);
      if (!frozen) continue;

      o.items = frozen;

      // fire-and-forget update of DB so next time it's already frozen
      try {
        await supa
          .from("orders")
          .update({ items: frozen })
          .eq("id", o.id)
          .eq("org_id", req.org_id);
      } catch (e: any) {
        console.warn(
          "[orders][GET /past] failed to persist frozen prices for order",
          o.id,
          e?.message || e
        );
      }
    }

    res.json(orders);
  } catch (err: any) {
    console.error("Orders GET /past error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: parse pipeline (AI → rules) with HUMAN-READABLE reason preservation
// Passes customer_phone so the parser can use customer-specific learnings.
// ─────────────────────────────────────────────────────────────────────────────
async function parsePipeline(
  text: string,
  org_id?: string,
  customer_phone?: string
): Promise<{
  items: any[];
  used: "ai" | "rules";
  confidence?: number | null;
  reason?: string | null;
}> {
  const raw = String(text || "").trim();
  if (!raw) return { items: [], used: "rules", confidence: null, reason: "empty" };

  if (ENABLE_AI) {
    try {
      const ai = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(raw, undefined, {
        org_id,
        customer_phone, // ← enables per-customer learning at parse time
      });
      if (ai && ai.is_order_like !== false && Array.isArray(ai.items) && ai.items.length > 0) {
        const r =
          typeof ai.reason === "string" && ai.reason.trim().length > 0
            ? ai.reason
            : "items_detected";
        return {
          items: ai.items,
          used: "ai",
          confidence: typeof ai.confidence === "number" ? ai.confidence : null,
          reason: r,
        };
      }
      console.log("[orders][parsePipeline] AI returned no items/not order-like; using rules.");
    } catch (e: any) {
      console.warn("[orders] AI parse failed, fallback to rules:", e?.message || e);
    }
  }

  const items = ruleParse(raw) || [];
  return { items, used: "rules", confidence: null, reason: "rule_fallback" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: when closing an order (shipped/paid), snapshot prices from catalog
// so future catalog changes don't affect old orders.
// ─────────────────────────────────────────────────────────────────────────────
async function snapshotPricesFromCatalog(
  org_id: string,
  order_id: string
): Promise<any[] | null> {
  try {
    // 1) Load the current order with items
    const { data: order, error: orderErr } = await supa
      .from("orders")
      .select("id, org_id, items")
      .eq("org_id", org_id)
      .eq("id", order_id)
      .single();

    if (orderErr || !order || !Array.isArray(order.items)) {
      if (orderErr) {
        console.warn("[orders][snapshotPrices] load order err:", orderErr.message);
      }
      return null;
    }

    const items: any[] = order.items || [];
    if (!items.length) return items;

    // 2) Load catalog for this org (same shape as /products admin API)
    const { data: catalog, error: catErr } = await supa
    .from("products")
    .select("canonical, variant, price_per_unit, dynamic_price")
    .eq("org_id", org_id);

    if (catErr || !Array.isArray(catalog) || !catalog.length) {
      if (catErr) {
        console.warn("[orders][snapshotPrices] catalog err:", catErr.message);
      }
      return null;
    }

    const normKey = (s?: string | null) =>
      (s || "").trim().toLowerCase();

    const getBaseName = (p: any) => normKey(p.canonical);

    function findMatchingProduct(
      canonical?: string | null,
      variant?: string | null
    ): any | undefined {
      const canonKey = normKey(canonical);
      const varKey = normKey(variant);
      if (!canonKey && !varKey) return undefined;

      // 1) exact canonical match
      let candidates = catalog.filter((p) => getBaseName(p) === canonKey);

      // 2) contains match (e.g. "onion" vs "onion small")
      if (!candidates.length && canonKey) {
        candidates = catalog.filter((p) => {
          const base = getBaseName(p);
          return base && (base.includes(canonKey) || canonKey.includes(base));
        });
      }

      if (!candidates.length) return undefined;

      // 3) if variant known, try to match
      if (varKey) {
        const byVar = candidates.find(
          (p) => normKey(p.variant) === varKey
        );
        if (byVar) return byVar;
      }

      // 4) fallback: first candidate
      return candidates[0];
    }

    // 3) Freeze prices on each item
    const frozen = items.map((it: any) => {
      // if price already set, NEVER overwrite
      if (
        typeof it?.price_per_unit === "number" &&
        !Number.isNaN(it.price_per_unit)
      ) {
        return it;
      }

      const product = findMatchingProduct(
        it?.canonical || it?.name,
        it?.variant
      );

      // ignore dynamic_price flag → always use catalog price when present
      if (
        !product ||
        typeof product.price_per_unit !== "number" ||
        Number.isNaN(product.price_per_unit)
      ) {
        return it; // still no price
      }

      const price = Number(product.price_per_unit);
      const qty =
        typeof it?.qty === "number" && !Number.isNaN(it.qty)
          ? it.qty
          : 1;

      const line_total =
        typeof it?.line_total === "number" && !Number.isNaN(it.line_total)
          ? it.line_total
          : qty * price;

      return {
        ...it,
        price_per_unit: price,
        line_total,
      };
    });

    return frozen;
  } catch (e: any) {
    console.warn("[orders][snapshotPrices] non-fatal error:", e?.message || e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders  → create order for this org
// ─────────────────────────────────────────────────────────────────────────────
orders.post("/", ensureAuth, async (req: any, res) => {
  try {
    const { raw_text, items, source_phone, customer_name, created_at } = req.body || {};

    let finalItems: any[] = [];
    let parse_confidence: number | null = null;
    let parse_reason: string | null = null;

    const phoneNorm = normalizePhone(source_phone || "") || "";

    if (raw_text && String(raw_text).trim()) {
      const parsed = await parsePipeline(String(raw_text), req.org_id, phoneNorm);
      finalItems = parsed.items;
      parse_confidence = parsed.confidence ?? null;
      parse_reason = parsed.reason ?? null;
    } else {
      // 🔹 Manual / UI-created items → normalize + keep pricing fields
      const incoming = Array.isArray(items) ? items : [];

      finalItems = incoming.map((it: any) => ({
        name: typeof it.name === "string" ? it.name : "",
        qty:
          typeof it.qty === "number" && !Number.isNaN(it.qty)
            ? it.qty
            : null,
        unit:
          typeof it.unit === "string" && it.unit.trim()
            ? it.unit.trim()
            : null,
        notes:
          typeof it.notes === "string" && it.notes.trim()
            ? it.notes.trim()
            : null,
        canonical:
          typeof it.canonical === "string" && it.canonical.trim()
            ? it.canonical.trim()
            : null,
        category:
          typeof it.category === "string" && it.category.trim()
            ? it.category.trim()
            : null,
        brand:
          typeof it.brand === "string" && it.brand.trim()
            ? it.brand.trim()
            : null,
        variant:
          typeof it.variant === "string" && it.variant.trim()
            ? it.variant.trim()
            : null,

        // ✅ persist pricing fields
        price_per_unit:
          typeof it.price_per_unit === "number" && !Number.isNaN(it.price_per_unit)
            ? it.price_per_unit
            : null,
        line_total:
          typeof it.line_total === "number" && !Number.isNaN(it.line_total)
            ? it.line_total
            : null,
      }));
    }

    if (!finalItems.length) {
      return res.status(400).json({ error: "no_items_detected" });
    }

    const insert = {
      org_id: req.org_id,
      source_phone: phoneNorm || null, // never store a display name here
      customer_name: customer_name || null,
      raw_text: raw_text || null,
      items: finalItems,
      status: "pending" as OrderStatus,
      parse_confidence,
      parse_reason,
      order_link_reason: "new", // default for manual creations
      ...(created_at ? { created_at: new Date(created_at).toISOString() } : {}),
    };

    const { data, error } = await supa.from("orders").insert(insert).select("*").single();
    if (error) throw error;

    res.json(data);
  } catch (err: any) {
    console.error("Orders CREATE error:", err);
    res.status(500).json({ error: err.message });
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/:id/status  → update status for an order in this org
// ─────────────────────────────────────────────────────────────────────────────
orders.post("/:id/status", ensureAuth, async (req: any, res) => {
  const { id } = req.params;
  const next = normStatus(req.body?.status);
  if (!next) {
    return res
      .status(400)
      .json({ error: "invalid_status", allowed: Array.from(STATUS_LIST) });
  }

  try {
    // When closing the order, snapshot prices so catalog changes don't affect it
    if (next === "shipped" || next === "paid") {
      const frozenItems = await snapshotPricesFromCatalog(req.org_id, id);

      if (frozenItems) {
        const { error } = await supa
          .from("orders")
          .update({ status: next, items: frozenItems })
          .eq("id", id)
          .eq("org_id", req.org_id);

        if (error) throw error;
        return res.json({ ok: true, status: next });
      }
      // If snapshot fails, we fall through and just update status like before
    }

    // Original behaviour (other statuses, or snapshot failure)
    const { error } = await supa
      .from("orders")
      .update({ status: next })
      .eq("id", id)
      .eq("org_id", req.org_id);
    if (error) throw error;

    res.json({ ok: true, status: next });
  } catch (err: any) {
    console.error("Order update error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/:id/ai-fix
// ─────────────────────────────────────────────────────────────────────────────
orders.post("/:id/ai-fix", ensureAuth, async (req: any, res) => {
  const { id } = req.params;

  let human_fixed = req.body?.human_fixed;
  if (!human_fixed) {
    const items = req.body?.items;
    const reason = (req.body?.reason || req.body?.note || "human_fix") as string;
    if (Array.isArray(items)) {
      human_fixed = { items, reason };
    }
  }

  const normalizedItems = Array.isArray(human_fixed?.items)
    ? human_fixed.items
        .map((it: any) => ({
          qty:
            it?.qty === null || it?.qty === undefined || Number.isNaN(Number(it?.qty))
              ? null
              : Number(it.qty),
          unit: trim(it?.unit) || null,
          name: trim(it?.name || it?.canonical || ""),
          canonical: trim(it?.canonical) || null,
          brand: trim(it?.brand) || null,
          variant: trim(it?.variant) || null,
          notes: trim(it?.notes) || null,
          category: trim(it?.category) || null,

          // ✅ keep price fields
          price_per_unit:
            it?.price_per_unit === null ||
            it?.price_per_unit === undefined ||
            Number.isNaN(Number(it?.price_per_unit))
              ? null
              : Number(it.price_per_unit),
          line_total:
            it?.line_total === null ||
            it?.line_total === undefined ||
            Number.isNaN(Number(it?.line_total))
              ? null
              : Number(it.line_total),
        }))
        .filter((it: any) => it.name && it.name.length > 0)
    : [];

  if (!normalizedItems.length) {
    return res.status(400).json({ error: "human_fixed_items_required" });
  }

  const reason = trim(human_fixed?.reason) || "human_fix";

  try {
    const { data: cur, error: e1 } = await supa
      .from("orders")
      .select("*, source_phone")
      .eq("id", id)
      .eq("org_id", req.org_id)
      .limit(1);

    if (e1) throw e1;
    const order = cur?.[0];
    if (!order) return res.status(404).json({ error: "order_not_found" });

    // 1) Log correction event
    const message_text =
      (order.raw_text && String(order.raw_text)) ||
      ((order.items || []).map((i: any) => i?.name || i?.canonical || "").join(", ")) ||
      "";
    const model_output = order.items || [];

    const { error: e2 } = await supa.from("ai_corrections").insert({
      org_id: req.org_id,
      message_text,
      model_output,
      human_fixed: { items: normalizedItems, reason },
    });
    if (e2) throw e2;

    // 1.5) Optional auto-catalog learning
    const enableAutoCatalog =
      String(process.env.AI_AUTOCATALOG || "true").toLowerCase() !== "false";

    if (enableAutoCatalog) {
      for (const it of normalizedItems) {
        const canonical =
          it.canonical ||
          (it.name ? it.name.charAt(0).toUpperCase() + it.name.slice(1) : null);
        if (!canonical) continue;

        const parts = [it.brand || undefined, it.variant || undefined, it.unit || undefined, it.name || undefined].filter(Boolean) as string[];
        const term = parts.join(" ").trim();
        const safeTerm = term || it.name;
        if (!safeTerm) continue;

        try {
          await supa
            .from("product_aliases")
            .upsert(
              {
                org_id: req.org_id,
                term: safeTerm.toLowerCase(),
                canonical,
                brand: it.brand || null,
                variant: it.variant || null,
              },
              { onConflict: "org_id,term" }
            );
        } catch (aliasErr: any) {
          console.warn("alias upsert warn:", aliasErr?.message || aliasErr);
        }
      }
    }

    // 2) Update order
    const { data: upd, error: e3 } = await supa
      .from("orders")
      .update({
        items: normalizedItems,
        parse_confidence: null,
        parse_reason: reason,
      })
      .eq("id", id)
      .eq("org_id", req.org_id)
      .select("*")
      .single();
    if (e3) throw e3;

    // 3) Learning writes
    try {
      const phone = trim(order.source_phone || "");
      for (const it of normalizedItems) {
        const canon = trim(it.canonical || it.name || "");
        if (!canon) continue;

        const brand = nz(it.brand);
        const variant = nz(it.variant);

        const { error: ebvs } = await supa.rpc("upsert_bvs", {
          p_org_id: order.org_id,
          p_canonical: canon,
          p_brand: brand,
          p_variant: variant,
          p_inc: 1,
        });
        if (ebvs) console.warn("[ai-fix][bvs][ERR]", ebvs.message);

        if (phone) {
          const { error: ecp } = await supa.rpc("upsert_customer_pref", {
            p_org_id: order.org_id,
            p_phone: phone,
            p_canonical: canon,
            p_brand: brand,
            p_variant: variant,
            p_inc: 1,
          });
          if (ecp) console.warn("[ai-fix][customer_pref][ERR]", ecp.message);
        } else {
          console.warn("[ai-fix][customer_pref][SKIP] missing phone");
        }
      }
    } catch (e) {
      console.warn("[ai-fix][learn-write] non-fatal:", (e as any)?.message || e);
    }

    res.json({ ok: true, order: upd });
  } catch (err: any) {
    console.error("ai-fix error:", err);
    res.status(500).json({ error: err.message || "ai_fix_failed" });
  }
});
const OPEN_STATUSES = new Set(["pending", "confirmed", "packing"]);
const CLOSED_STATUSES = new Set(["shipped", "paid", "cancelled", "delivered"]);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for UI overrides
// ─────────────────────────────────────────────────────────────────────────────
async function getOrder(org_id: string, order_id: string) {
  const { data, error } = await supa
    .from("orders")
    .select(
      "id, org_id, source_phone, status, items, created_at, parse_reason"
    )
    .eq("org_id", org_id)
    .eq("id", order_id)
    .single(); // `.single()` already limits to 1 row

  if (error || !data) {
    throw new Error(error?.message || "order_not_found");
  }

  return data as {
    id: string;
    org_id: string;
    source_phone: string | null;
    status: string;
    items: any[];
    created_at: string;
    parse_reason?: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/:id/split
// ─────────────────────────────────────────────────────────────────────────────
orders.post("/:id/split", ensureAuth, express.json(), async (req: any, res) => {
  try {
    const order_id = String(req.params.id || "");
    const org_id = req.org_id;
    const indices: number[] = Array.isArray(req.body?.item_indices)
      ? req.body.item_indices.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n))
      : [];

    if (!order_id || !org_id) return res.status(400).json({ ok: false, error: "missing_fields" });

    const cur = await getOrder(org_id, order_id);
    const items = Array.isArray(cur.items) ? cur.items : [];

    if (!items.length) return res.json({ ok: false, error: "no_items_to_split" });

    // Default: last item if nothing selected
    const indicesSet = new Set(indices.length ? indices : [items.length - 1]);
    const move: any[] = [];
    const keep: any[] = [];
    items.forEach((it, idx) => (indicesSet.has(idx) ? move.push(it) : keep.push(it)));

    if (!move.length) return res.json({ ok: false, error: "no_selected_items" });

    // 1) Update original
    const { error: upErr } = await supa
      .from("orders")
      .update({
        items: keep,
        parse_reason: cur.parse_reason || "operator_split",
      })
      .eq("id", cur.id)
      .eq("org_id", org_id);
    if (upErr) throw new Error(upErr.message);

    // 2) Create new order with split items
    const { data: created, error: insErr } = await supa
      .from("orders")
      .insert({
        org_id,
        source_phone: cur.source_phone,
        customer_name: null,
        raw_text: "[operator_split]",
        items: move,
        status: "pending",
        created_at: new Date().toISOString(),
        parse_confidence: null,
        parse_reason: "operator_split",
        order_link_reason: "operator_split",
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);

    return res.json({ ok: true, new_order_id: created?.id });
  } catch (e: any) {
    console.error("[ORDERS][split] ERR", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "split_failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/:id/merge-previous
// ─────────────────────────────────────────────────────────────────────────────
orders.post(
  "/:id/merge-previous",
  ensureAuth,
  express.json(),
  async (req: any, res) => {
    try {
      const order_id = String(req.params.id || "");
      const org_id = req.org_id as string | undefined;

      if (!order_id || !org_id) {
        return res.status(400).json({ ok: false, error: "missing_fields" });
      }

      // Current (the one we want to fold back)
      const cur = await getOrder(org_id, order_id);

      // Guard: current must be OPEN; if already closed we shouldn't be merging it
      if (CLOSED_STATUSES.has(String(cur.status))) {
        return res
          .status(400)
          .json({ ok: false, error: "current_not_open" });
      }

      const phone = normalizePhone(cur.source_phone || "") || "";
      if (!phone) {
        return res.json({ ok: false, error: "no_phone_on_order" });
      }

      // Find the most recent previous order for the same phone (created before current)
      const { data: prevList, error: prevErr } = await supa
        .from("orders")
        .select("id, status, items, created_at")
        .eq("org_id", org_id)
        .eq("source_phone", phone)
        .lt("created_at", cur.created_at)
        .order("created_at", { ascending: false })
        .limit(1);

      if (prevErr) throw new Error(prevErr.message);

      const prev = prevList?.[0];
      if (!prev) {
        return res.json({ ok: false, error: "no_previous_order" });
      }

      // Guard: previous must be OPEN
      if (CLOSED_STATUSES.has(String(prev.status))) {
        return res
          .status(400)
          .json({ ok: false, error: "previous_not_open" });
      }

      // Merge items (append)
      const mergedItems = [...(prev.items || []), ...(cur.items || [])];

      // 1) Append into previous + annotate link reason
      const { error: upPrevErr } = await supa
        .from("orders")
        .update({
          items: mergedItems,
          parse_reason: "operator_merged_previous",
          order_link_reason: "operator_merged_previous",
        })
        .eq("id", prev.id)
        .eq("org_id", org_id);

      if (upPrevErr) throw new Error(upPrevErr.message);

      // 2) Cancel current (never delete—keep audit trail)
      const { error: cancelErr } = await supa
        .from("orders")
        .update({
          status: "cancelled",
          parse_reason: "operator_merged_previous",
        })
        .eq("id", cur.id)
        .eq("org_id", org_id);

      if (cancelErr) throw new Error(cancelErr.message);

      return res.json({ ok: true, merged_into: prev.id });
    } catch (e: any) {
      console.error("[ORDERS][merge-previous] ERR", e?.message || e);
      return res
        .status(500)
        .json({ ok: false, error: e?.message || "merge_failed" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/orders/:id
// ─────────────────────────────────────────────────────────────────────────────
orders.delete("/:id", ensureAuth, async (req:any, res) => {
  try {
    const orderId = req.params.id;
    if (!orderId) return res.status(400).json({ ok: false, error: "order_id_required" });

    const { error } = await supa.from("orders").delete().eq("id", orderId).eq("org_id", req.org_id);
    if (error) {
      console.error("[DELETE ORDER]", error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.json({ ok: true, deleted: orderId });
  } catch (e: any) {
    console.error("[DELETE ORDER]", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "delete_failed" });
  }
});

export default orders;