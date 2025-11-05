// src/routes/orders.ts
import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";
import { parseOrder as ruleParse } from "../parser";

export const orders = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Status constants (store lowercase in DB; accept any case from client)
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_LIST = ["pending", "shipped", "paid"] as const;
type OrderStatus = (typeof STATUS_LIST)[number];
const STATUS_SET = new Set<string>(STATUS_LIST);

function normStatus(s?: string | null): OrderStatus | null {
  const v = String(s ?? "").trim().toLowerCase();
  return STATUS_SET.has(v) ? (v as OrderStatus) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional AI parser (graceful fallback if not present or no OPENAI_API_KEY)
// ─────────────────────────────────────────────────────────────────────────────
let aiParseOrder:
  | undefined
  | ((
      text: string,
      catalog?: Array<{ name: string; sku: string; aliases?: string[] }>,
      opts?: { org_id?: string }
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
// Optional: ?status=pending|shipped|paid&limit=100&offset=0 (case-insensitive)
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
// Helper: parse pipeline (AI → rules) with HUMAN-READABLE reason preservation
// ─────────────────────────────────────────────────────────────────────────────
async function parsePipeline(text: string, org_id?: string): Promise<{
  items: any[];
  used: "ai" | "rules";
  confidence?: number | null;
  reason?: string | null;
}> {
  const raw = String(text || "").trim();
  if (!raw) return { items: [], used: "rules", confidence: null, reason: "empty" };

  if (ENABLE_AI) {
    try {
      // pass org_id so parser can load org-scoped dynamic few-shots
      const ai = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(raw, undefined, { org_id });
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
      // If AI says not order-like or no items, fall through to rules (caller still may reject)
    } catch (e: any) {
      console.warn("[orders] AI parse failed, fallback to rules:", e?.message || e);
    }
  }

  const items = ruleParse(raw) || [];
  return {
    items,
    used: "rules",
    confidence: null,
    reason: "rule_fallback",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders  → create order for this org
// Body:
//   {
//     raw_text?: string,           // if present, we parse into items
//     items?: any[],               // or pass structured items directly
//     source_phone?: string | null,
//     customer_name?: string | null,
//     created_at?: string | Date   // optional (ISO) for backfill
//   }
// Status defaults to "pending".
// ─────────────────────────────────────────────────────────────────────────────
orders.post("/", ensureAuth, async (req: any, res) => {
  try {
    const { raw_text, items, source_phone, customer_name, created_at } = req.body || {};

    let finalItems: any[] = [];
    let parse_confidence: number | null = null;
    let parse_reason: string | null = null;

    if (raw_text && String(raw_text).trim()) {
      const parsed = await parsePipeline(String(raw_text), req.org_id);
      finalItems = parsed.items;
      parse_confidence = parsed.confidence ?? null;
      // ✅ Preserve human-readable reason, do NOT overwrite with tags.
      parse_reason = parsed.reason ?? null;
    } else {
      finalItems = Array.isArray(items) ? items : [];
    }

    if (!finalItems.length) {
      return res.status(400).json({ error: "no_items_detected" });
    }

    const insert = {
      org_id: req.org_id,
      source_phone: source_phone || null,
      customer_name: customer_name || null,
      raw_text: raw_text || null,
      items: finalItems,
      status: "pending" as OrderStatus,
      parse_confidence,
      parse_reason,
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
// Body: { status: 'pending' | 'shipped' | 'paid' }  // case-insensitive
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
// Body: { human_fixed: { items: Item[], reason?: string } }
// Effect:
//   1) Logs into ai_corrections (for future learning)
//   2) Updates orders.items + parse_reason = 'human_fix' (immediate UI reflect)
// ─────────────────────────────────────────────────────────────────────────────
// orders.post("/:id/ai-fix", ensureAuth, …)
orders.post("/:id/ai-fix", ensureAuth, async (req: any, res) => {
  const { id } = req.params;

  // Accept either { human_fixed } or loose { items, reason/note }
  let human_fixed = req.body?.human_fixed;
  if (!human_fixed) {
    const items = req.body?.items;
    const reason = (req.body?.reason || req.body?.note || "human_fix") as string;
    if (Array.isArray(items)) {
      human_fixed = { items, reason };
    }
  }

  const asStr = (v: any) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const trim = (v: any) => asStr(v).trim();

  // Normalize (incl brand/variant/notes/category)
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
          brand: trim(it?.brand) || null,      // NEW
          variant: trim(it?.variant) || null,  // NEW
          notes: trim(it?.notes) || null,      // NEW
          category: trim(it?.category) || null,
        }))
        .filter((it: any) => it.name && it.name.length > 0)
    : [];

  if (!normalizedItems.length) {
    return res.status(400).json({ error: "human_fixed_items_required" });
  }

  const reason = trim(human_fixed?.reason) || "human_fix";

  try {
    // Load order (ensure org ownership)
    const { data: cur, error: e1 } = await supa
      .from("orders")
      .select("*")
      .eq("id", id)
      .eq("org_id", req.org_id)
      .limit(1);

    if (e1) throw e1;
    const order = cur?.[0];
    if (!order) return res.status(404).json({ error: "order_not_found" });

    // 1) Persist learning row
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

    // 1.5) OPTIONAL auto-catalog growth from fixes (per org)
    // Enable via env (default ON)
    const enableAutoCatalog =
      String(process.env.AI_AUTOCATALOG || "true").toLowerCase() !== "false";

    if (enableAutoCatalog) {
      // For each fixed item that has at least canonical or non-empty name, add alias terms
      // Strategy:
      //  - canonical = item.canonical || Title Case(item.name)
      //  - term = user-facing phrase built from [brand, variant, unit] if present else name
      //  - upsert (org_id, term, canonical, brand, variant)
      for (const it of normalizedItems) {
        const canonical =
          it.canonical ||
          (it.name ? it.name.charAt(0).toUpperCase() + it.name.slice(1) : null);

        if (!canonical) continue;

        const parts = [
          it.brand || undefined,
          it.variant || undefined,
          it.unit || undefined,
          it.name || undefined,
        ].filter(Boolean) as string[];

        const term = parts.join(" ").trim();
        const safeTerm = term || it.name;

        if (!safeTerm) continue;

        // You can also link to products table if you maintain SKUs/categories.
        // For now, we just upsert alias → canonical.
        try {
          await supa
            .from("product_aliases")
            .upsert(
              {
                org_id: req.org_id,
                term: safeTerm.toLowerCase(), // store normalized
                canonical,                    // display canonical
                brand: it.brand || null,
                variant: it.variant || null,
              },
              {
                onConflict: "org_id,term", // ensure a composite unique constraint exists
              }
            );
        } catch (aliasErr: any) {
          console.warn("alias upsert warn:", aliasErr?.message || aliasErr);
        }
      }
    }

    // 2) Update the order immediately so UI reflects the fix
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

    res.json({ ok: true, order: upd });
  } catch (err: any) {
    console.error("ai-fix error:", err);
    res.status(500).json({ error: err.message || "ai_fix_failed" });
  }
});

export default orders;