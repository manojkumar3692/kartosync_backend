// src/routes/analytics.ts
import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";

export const analytics = express.Router();

// ─────────────────────────────────────────────
// Auth middleware (same logic as orders.ts)
// ─────────────────────────────────────────────
function ensureAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    req.org_id = d.org_id;
    next();
  } catch (e) {
    console.error("[analytics] Auth error:", e);
    res.status(401).json({ error: "unauthorized" });
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function parseDateParam(v: any): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function normalizePhone(v: string | null | undefined): string {
  if (!v) return "";
  return String(v).replace(/[^\d]/g, "");
}

function computeOrderTotal(items: any[]): number {
  if (!Array.isArray(items)) return 0;
  let sum = 0;
  for (const it of items) {
    const qtyRaw = it?.qty;
    const qty =
      typeof qtyRaw === "number" && !Number.isNaN(qtyRaw) ? qtyRaw : 1;

    const lineTotal =
      typeof it?.line_total === "number" && !Number.isNaN(it.line_total)
        ? it.line_total
        : null;

    const pricePerUnit =
      typeof it?.price_per_unit === "number" &&
      !Number.isNaN(it.price_per_unit)
        ? it.price_per_unit
        : null;

    if (lineTotal != null) {
      sum += lineTotal;
    } else if (pricePerUnit != null) {
      sum += pricePerUnit * qty;
    }
  }
  return sum;
}

// ─────────────────────────────────────────────
// GET /api/analytics/summary
// Query: ?from=ISO&to=ISO
// ─────────────────────────────────────────────
analytics.get("/summary", ensureAuth, async (req: any, res) => {
  try {
    const org_id = req.org_id as string | undefined;
    if (!org_id) {
      return res.status(400).json({ error: "missing_org" });
    }

    // 1) Resolve date range
    const fromParam = parseDateParam(req.query.from);
    const toParam = parseDateParam(req.query.to);
    const now = new Date();

    const to = toParam || now;
    const from =
      fromParam ||
      new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000); // last 7 days by default

    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    // 2) Load org currency
    const { data: orgRow, error: orgErr } = await supa
      .from("orgs")
      .select("id, currency_code")
      .eq("id", org_id)
      .single();

    if (orgErr || !orgRow) {
      throw new Error(orgErr?.message || "org_not_found");
    }

    const currency: string = orgRow.currency_code || "AED";

    // 3) Fetch orders in range
    const { data: orders, error: ordErr } = await supa
      .from("orders")
      .select("id, status, items, created_at, source_phone, customer_name")
      .eq("org_id", org_id)
      .gte("created_at", fromIso)
      .lte("created_at", toIso);

    if (ordErr) throw ordErr;

    const list = Array.isArray(orders) ? orders : [];

    let totalSales = 0;
    let totalOrders = list.length;
    let paidOrders = 0;

    const itemMap = new Map<
      string,
      { label: string; qty: number; sales: number }
    >();
    const customerMap = new Map<
      string,
      {
        customer_key: string;
        phone: string;
        name: string | null;
        orders: number;
        sales: number;
        last_order_at: string | null;
      }
    >();

    for (const o of list as any[]) {
      const status = String(o.status || "").toLowerCase();
      const items = Array.isArray(o.items) ? o.items : [];
      const orderTotal = computeOrderTotal(items);

      if (status === "paid") {
        paidOrders += 1;
        totalSales += orderTotal;
      }

      // Aggregate items (for top products)
      for (const it of items) {
        const qtyRaw = it?.qty;
        const qty =
          typeof qtyRaw === "number" && !Number.isNaN(qtyRaw)
            ? qtyRaw
            : 1;

        const lineTotal =
          typeof it?.line_total === "number" && !Number.isNaN(it.line_total)
            ? it.line_total
            : null;
        const pricePerUnit =
          typeof it?.price_per_unit === "number" &&
          !Number.isNaN(it.price_per_unit)
            ? it.price_per_unit
            : null;
        const lineSales =
          lineTotal != null
            ? lineTotal
            : pricePerUnit != null
            ? pricePerUnit * qty
            : 0;

        const canon = (it?.canonical || it?.name || "Item") as string;
        const brand = (it?.brand || "") as string;
        const variant = (it?.variant || "") as string;
        const labelParts = [canon, variant, brand].filter((x) =>
          String(x).trim()
        );
        const label = labelParts.join(" · ") || canon;
        const key = label.toLowerCase();

        const prev = itemMap.get(key) || {
          label,
          qty: 0,
          sales: 0,
        };
        prev.qty += qty;
        prev.sales += lineSales;
        itemMap.set(key, prev);
      }

      // Aggregate customers (top customers)
      const phone = normalizePhone(o.source_phone);
      const name = (o.customer_name as string | null) || null;
      const cKey = phone || (name || "").toLowerCase() || o.id;

      const prevCust = customerMap.get(cKey) || {
        customer_key: cKey,
        phone,
        name,
        orders: 0,
        sales: 0,
        last_order_at: null as string | null,
      };
      prevCust.orders += 1;
      if (status === "paid") {
        prevCust.sales += orderTotal;
      }
      const createdAt = String(o.created_at || "");
      if (
        !prevCust.last_order_at ||
        new Date(createdAt).getTime() >
          new Date(prevCust.last_order_at).getTime()
      ) {
        prevCust.last_order_at = createdAt;
      }
      customerMap.set(cKey, prevCust);
    }

    const paidRate = totalOrders === 0 ? 0 : paidOrders / totalOrders;
    const avgOrderValue =
      paidOrders === 0 ? 0 : totalSales / paidOrders;

    // Top items (sorted by sales desc)
    const topItems = Array.from(itemMap.values())
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 20);

    // Top customers (sorted by sales desc)
    const topCustomers = Array.from(customerMap.values())
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 20);

    return res.json({
      org_id,
      currency,
      range: {
        from: fromIso,
        to: toIso,
      },
      totals: {
        total_sales: totalSales,
        total_orders: totalOrders,
        paid_orders: paidOrders,
        paid_rate: paidRate,
        avg_order_value: avgOrderValue,
      },
      items: {
        top_items: topItems,
      },
      customers: {
        top_customers: topCustomers,
      },
    });
  } catch (e: any) {
    console.error("[analytics][summary] ERR", e?.message || e);
    return res
      .status(500)
      .json({ error: e?.message || "analytics_summary_failed" });
  }
});

export default analytics;