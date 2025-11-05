// src/routes/admin.ts
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { supa } from "../db";
import { ensureAdmin } from "./_ensureAdmin";

export const admin = express.Router();

/**
 * POST /api/admin/login
 * Body: { username, password }
 * → { token, admin: { id, username } }
 */
admin.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username_password_required" });
    }

    const { data, error } = await supa
      .from("admins")
      .select("id, username, password_hash")
      .eq("username", String(username))
      .limit(1);

    if (error) throw error;

    const row = data?.[0];
    if (!row) return res.status(401).json({ error: "invalid_credentials" });
    if (!row.password_hash) return res.status(401).json({ error: "password_not_set" });

    const ok = await bcrypt.compare(String(password), row.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = jwt.sign(
      { admin_id: row.id, role: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30d" }
    );

    res.json({ token, admin: { id: row.id, username: row.username } });
  } catch (e: any) {
    console.error("admin login error:", e);
    res.status(500).json({ error: e?.message || "login_failed" });
  }
});

/**
 * GET /api/admin/orgs
 * Auth: Bearer <admin-token>
 */
admin.get("/orgs", ensureAdmin, async (_req, res) => {
  try {
    const { data, error } = await supa
      .from("orgs")
      .select("id,name,phone,wa_phone_number_id,plan,is_disabled,created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e: any) {
    console.error("admin /orgs error:", e);
    res.status(500).json({ error: e.message || "orgs_failed" });
  }
});

/**
 * POST /api/admin/orgs/:id/disable
 * Body: { disabled: boolean }
 */
admin.post("/orgs/:id/disable", ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { disabled } = req.body || {};
    const { error } = await supa
      .from("orgs")
      .update({ is_disabled: !!disabled })
      .eq("id", id);
    if (error) throw error;
    res.json({ ok: true, id, is_disabled: !!disabled });
  } catch (e: any) {
    console.error("admin disable org error:", e);
    res.status(500).json({ error: e.message || "toggle_failed" });
  }
});

/**
 * GET /api/admin/orgs/:id/orders?limit=200
 */
admin.get("/orgs/:id/orders", ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
    const { data, error } = await supa
      .from("orders")
      .select("*")
      .eq("org_id", id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json(data || []);
  } catch (e: any) {
    console.error("admin org orders error:", e);
    res.status(500).json({ error: e.message || "orders_failed" });
  }
});

/**
 * GET /api/admin/ai-corrections?org_id=optional
 */
admin.get("/ai-corrections", ensureAdmin, async (req, res) => {
  try {
    const org_id = req.query.org_id as string | undefined;
    let q = supa
      .from("ai_corrections")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (org_id) q = q.eq("org_id", org_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (e: any) {
    console.error("admin ai-corrections error:", e);
    res.status(500).json({ error: e.message || "ai_corrections_failed" });
  }
});

/**
 * GET /api/admin/ai-spend/summary?range=daily|weekly|monthly
 * Falls back to summing ai_usage_log if RPC not available.
 * Returns: { total_usd, since, range, caps }
 */
admin.get("/ai-spend/summary", ensureAdmin, async (req, res) => {
  try {
    const range = String(req.query.range || "daily");
    const now = new Date();
    const since = new Date();
    if (range === "weekly") since.setDate(now.getDate() - 7);
    else if (range === "monthly") since.setMonth(now.getMonth() - 1);
    else since.setDate(now.getDate() - 1); // daily (last 24h)

    // Try RPC first
    let total = 0;
    let triedRpc = false;

    try {
      const { data, error } = await supa.rpc("sum_ai_spend_since", {
        since_ts: since.toISOString(),
      });
      triedRpc = true;
      if (error) throw error;
      total = (data && typeof (data as any).total === "number") ? (data as any).total : 0;
    } catch (rpcErr) {
      // Fallback: sum from table
      const { data, error } = await supa
        .from("ai_usage_log")
        .select("cost_usd, created_at")
        .gte("created_at", since.toISOString());
      if (error) throw error;
      total = (data || []).reduce((sum, r: any) => sum + (Number(r.cost_usd) || 0), 0);
      if (triedRpc) {
        console.warn("[ai-spend] RPC unavailable/failed; using table fallback.");
      }
    }

    const caps = {
      daily_cap: Number(process.env.AI_DAILY_USD || 5),
      monthly_cap: Number(process.env.AI_MONTHLY_USD || 150),
      model: process.env.AI_MODEL || "gpt-4o-mini",
    };

    res.json({
      total_usd: Number(total.toFixed(6)),
      since: since.toISOString(),
      range,
      caps,
    });
  } catch (e: any) {
    console.error("admin ai-spend summary error:", e);
    res.status(500).json({ error: e.message || "ai_spend_failed" });
  }
});

/**
 * POST /api/admin/retrain
 * Body: { org_id?: string, note?: string }
 * → queues a job row your worker can consume later
 */
admin.post("/retrain", ensureAdmin, async (req, res) => {
  try {
    const { org_id, note } = req.body || {};
    const { data, error } = await supa
      .from("ai_retrain_jobs")
      .insert({
        org_id: org_id || null,
        status: "queued",
        note: note || null,
        created_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (error) throw error;
    res.json({ ok: true, job: data });
  } catch (e: any) {
    console.error("admin retrain error:", e);
    res.status(500).json({ error: e.message || "retrain_failed" });
  }
});

export default admin;