// src/routes/orders.ts
import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";
import { parseOrder as ruleParse } from "../parser";

export const orders = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Optional AI parser (graceful fallback if not present or no OPENAI_API_KEY)
// ─────────────────────────────────────────────────────────────────────────────
let aiParseOrder:
  | undefined
  | ((text: string) => Promise<{
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
// Supports optional query params: ?status=pending&limit=100&offset=0
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

    if (status) q = q.eq("status", String(status));

    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    console.error("Orders GET error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: parse pipeline (AI → rules)
// ─────────────────────────────────────────────────────────────────────────────
async function parsePipeline(text: string): Promise<{
  items: any[];
  used: "ai" | "rules";
  confidence?: number | null;
  reason?: string | null;
}> {
  const raw = String(text || "").trim();
  if (!raw) return { items: [], used: "rules", confidence: null, reason: "empty" };

  if (ENABLE_AI) {
    try {
      const ai = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(raw);
      if (ai && ai.is_order_like !== false && Array.isArray(ai.items) && ai.items.length > 0) {
        return {
          items: ai.items,
          used: "ai",
          confidence: typeof ai.confidence === "number" ? ai.confidence : null,
          reason: ai.reason ?? null,
        };
      }
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
// ─────────────────────────────────────────────────────────────────────────────
orders.post("/", ensureAuth, async (req: any, res) => {
  try {
    const { raw_text, items, source_phone, customer_name, created_at } = req.body || {};

    let finalItems: any[] = [];
    let parse_confidence: number | null = null;
    let parse_reason: string | null = null;

    if (raw_text && String(raw_text).trim()) {
      const parsed = await parsePipeline(String(raw_text));
      finalItems = parsed.items;
      parse_confidence = parsed.confidence ?? null;
      parse_reason = parsed.reason ?? (parsed.used === "ai" ? "ai" : "rules");
    } else {
      // Accept caller-provided items (validate a little)
      finalItems = Array.isArray(items) ? items : [];
    }

    if (!finalItems.length) {
      return res.status(400).json({ error: "no_items_detected" });
    }

    const insert = {
      org_id: req.org_id, // ← always from JWT
      source_phone: source_phone || null,
      customer_name: customer_name || null,
      raw_text: raw_text || null,
      items: finalItems,
      status: "pending",
      parse_confidence,
      parse_reason,
      // created_at: optional backfill
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
// Body: { status: 'pending' | 'delivered' | 'paid' }
// ─────────────────────────────────────────────────────────────────────────────
orders.post("/:id/status", ensureAuth, async (req: any, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  try {
    const { error } = await supa
      .from("orders")
      .update({ status })
      .eq("id", id)
      .eq("org_id", req.org_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err: any) {
    console.error("Order update error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default orders;