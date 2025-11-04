// src/routes/aiDebug.ts
import express from "express";
import { supa } from "../db";

let aiParseOrder:
  | undefined
  | ((text: string, catalog?: Array<{ name: string; sku: string; aliases?: string[] }>) =>
      Promise<{ items: any[]; confidence?: number; reason?: string | null; is_order_like?: boolean }>);
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  aiParseOrder = require("../ai/parser").aiParseOrder;
} catch {
  aiParseOrder = undefined;
}

const router = express.Router();

// GET /api/ai/env  → quick environment sanity
router.get("/env", async (_req, res) => {
  const cap = Number(process.env.AI_DAILY_USD || 5);
  const perCall = Number(process.env.AI_PER_CALL_USD_MAX || 0) || null;
  res.json({
    ok: true,
    model: process.env.AI_MODEL || "gpt-4o-mini",
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    aiParseOrderLoaded: !!aiParseOrder,
    dailyCapUSD: cap,
    perCallCapUSD: perCall,
    budgetTable: process.env.AI_BUDGET_TABLE || "(default ai_daily_spend)",
  });
});

// GET /api/ai/spend  → today’s spend (tries ai_daily_spend; also shows usage log sum)
router.get("/spend", async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const table = process.env.AI_BUDGET_TABLE || "ai_daily_spend";

  let row: any = null;
  let tableErr: string | null = null;
  try {
    const { data, error } = await supa
      .from(table)
      .select("dt, usd_spent")
      .eq("dt", today)
      .maybeSingle();
    if (error) tableErr = error.message;
    row = data || null;
  } catch (e: any) {
    tableErr = e?.message || String(e);
  }

  // Also sum ai_usage_log cost for today (if present)
  let logSum: number | null = null;
  let logErr: string | null = null;
  try {
    const { data, error } = await supa
      .from("ai_usage_log")
      .select("cost_usd, created_at")
      .gte("created_at", `${today}T00:00:00Z`)
      .lte("created_at", `${today}T23:59:59Z`);
    if (error) logErr = error.message;
    else {
      logSum = (data || []).reduce((acc: number, r: any) => acc + (Number(r?.cost_usd) || 0), 0);
    }
  } catch (e: any) {
    logErr = e?.message || String(e);
  }

  res.json({
    ok: true,
    table,
    tableRow: row,
    tableErr,
    usageLogSumUSD: typeof logSum === "number" ? Number(logSum.toFixed(6)) : null,
    usageLogErr: logErr,
  });
});

// GET /api/ai/usage?limit=20  → last N usage rows
router.get("/usage", async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 20)));
  try {
    const { data, error } = await supa
      .from("ai_usage_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ ok: true, rows: data || [] });
  } catch (e: any) {
    res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/ai/test  → call aiParseOrder directly (no HMAC)
// body: { text: string, catalog?: [{name, sku, aliases[]}] }
router.post("/test", express.json(), async (req, res) => {
  try {
    const { text, catalog } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ ok: false, error: "text (string) required" });
    }
    if (typeof aiParseOrder !== "function") {
      return res.json({ ok: true, used: "rules-only (ai function not found)" });
    }
    const out = await aiParseOrder(String(text), Array.isArray(catalog) ? catalog : undefined);
    return res.json({ ok: true, used: "ai", out });
  } catch (e: any) {
    console.error("[AI TEST]", e?.message || e);
    return res.status(200).json({ ok: false, error: e?.message || "ai error" });
  }
});

export const aiDebug = router;
export default aiDebug;