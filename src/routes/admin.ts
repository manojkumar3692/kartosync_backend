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
// GET /api/admin/ai-spend/summary
admin.get("/ai-spend/summary", async (req, res) => {
  try {
    const range = (req.query.range as string) || "daily";
    const orgId = (req.query.org_id as string | undefined) || undefined;

    // ----- 1) Compute time window -----
    let since: Date;
    if (range === "weekly") {
      since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } else if (range === "monthly") {
      since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    } else {
      // daily (last 24 hours)
      since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    }

    const DAILY_CAP = 5;     // USD per org per day
    const MONTHLY_CAP = 150; // USD per org per month

    // ----- 2) Build Supabase query -----
    let q = supa
      .from("ai_usage_log")
      .select("cost_usd, created_at, model")
      .gte("created_at", since.toISOString());

    if (orgId) {
      q = q.eq("org_id", orgId);
    }

    const { data, error } = await q;

    if (error) {
      console.error("[ADMIN][AI_SPEND] supa error", error.message);
      return res.status(500).json({ error: "failed_to_load_ai_spend" });
    }

    // ----- 3) Aggregate in code -----
    let total = 0;
    let firstTs: string | null = null;
    let model: string | null = null;

    for (const r of data || []) {
      total += Number(r.cost_usd || 0);

      if (!firstTs || r.created_at < firstTs) {
        firstTs = r.created_at;
      }

      if (!model && r.model) {
        model = r.model;
      }
    }

    // ----- 4) Response -----
    return res.json({
      total_usd: total,
      since: firstTs || since.toISOString(),
      caps: {
        daily_cap: DAILY_CAP,
        monthly_cap: MONTHLY_CAP,
        model: model || process.env.AI_MODEL || "unknown",
      },
    });
  } catch (e: any) {
    console.error("[ADMIN][AI_SPEND] catch", e?.message || e);
    return res.status(500).json({ error: "unexpected_error" });
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

// GET /api/admin/orgs/:id/stats
admin.get("/orgs/:id/stats", async (req, res) => {
  const orgId = req.params.id;

  try {
    const { data, error } = await supa
      .from("org_stats")
      .select("*")
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      console.error("[ADMIN][ORG_STATS] error", error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: "No stats for this org." });
    }

    return res.json(data);
  } catch (e: any) {
    console.error("[ADMIN][ORG_STATS] catch", e?.message || e);
    return res.status(500).json({ error: "Internal server error" });
  }
});



admin.get("/orgs/:orgId/stats", async (req, res) => {
  const orgId = req.params.orgId;

  try {
    const { data, error } = await supa
      .from("org_stats")
      .select("*")
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      console.error("[ADMIN][ORG_STATS] supa error", error.message);
      return res.status(500).json({ error: "Failed to load org stats" });
    }

    // If no orders yet, return zeroed structure
    if (!data) {
      return res.json({
        org_id: orgId,
        total_orders: 0,
        completed_orders: 0,
        open_orders: 0,
        total_revenue: 0,
        completed_revenue: 0,
        ai_orders: 0,
        ai_completed_orders: 0,
        ai_revenue: 0,
        manual_orders: 0,
        manual_revenue: 0,
        first_order_at: null,
        last_order_at: null,
      });
    }

    return res.json(data);
  } catch (e: any) {
    console.error("[ADMIN][ORG_STATS] catch", e?.message || e);
    return res.status(500).json({ error: "Failed to load org stats" });
  }
});



const AI_DAILY_CAP = Number(process.env.AI_DAILY_USD ?? 5);
const AI_MONTHLY_CAP = Number(process.env.AI_MONTHLY_USD ?? 150);
const AI_MODEL =
  process.env.AI_ORDER_MODEL || process.env.AI_MODEL || "gpt-4o-mini";

admin.get("/ai/spend/:orgId/daily", async (req, res) => {
  try {
    const orgId = req.params.orgId;
    if (!orgId) {
      return res.status(400).json({ error: "Missing orgId in path" });
    }

    // Today in UTC (date bucket)
    const now = new Date();
    const dayStartUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const dayEndUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    );

    const dayStartIso = dayStartUTC.toISOString();
    const dayEndIso = dayEndUTC.toISOString();

    // Fetch all today's rows for this org and sum cost_usd
    const { data, error } = await supa
      .from("ai_usage_log")
      .select("cost_usd, created_at")
      .eq("org_id", orgId)
      .gte("created_at", dayStartIso)
      .lt("created_at", dayEndIso);

    if (error) {
      console.error("[ADMIN][AI_SPEND_DAILY] DB error:", error.message);
      return res.status(500).json({ error: "DB error", details: error.message });
    }

    const totalUsd = (data || []).reduce((sum, row: any) => {
      const n = Number(row.cost_usd ?? 0);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);

    return res.json({
      org_id: orgId,
      range: "daily",
      dt: dayStartIso.slice(0, 10),
      total_usd: Number(totalUsd.toFixed(6)),
      caps: {
        daily_cap: AI_DAILY_CAP,
        monthly_cap: AI_MONTHLY_CAP,
        model: AI_MODEL,
      },
      since: dayStartIso,
    });
  } catch (e: any) {
    console.error("[ADMIN][AI_SPEND_DAILY] exception:", e?.message || e);
    return res.status(500).json({ error: "Server error" });
  }
});

async function getOrgSpendInRange(orgId: string, from: Date, to: Date) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const { data, error } = await supa
    .from("ai_usage_log")
    .select("cost_usd")
    .eq("org_id", orgId)
    .gte("created_at", fromIso)
    .lte("created_at", toIso);

  if (error) {
    console.warn("[ADMIN][AI_SPEND] range query error:", error.message);
    return 0;
  }

  const total = (data || []).reduce((sum, row: any) => {
    const v = Number(row.cost_usd ?? 0);
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);

  // keep numeric stable
  return Number(total.toFixed(6));
}

admin.get("/ai/spend/:orgId/weekly", async (req, res) => {
  try {
    const orgId = req.params.orgId;
    if (!orgId) {
      return res.status(400).json({ error: "orgId is required" });
    }

    const now = new Date();
    // last 7 days INCLUDING today
    const from = new Date(now);
    from.setDate(from.getDate() - 6); // 6 days back + today = 7

    const totalUsd = await getOrgSpendInRange(orgId, from, now);

    return res.json({
      org_id: orgId,
      range: "weekly",
      since: from.toISOString(),
      until: now.toISOString(),
      total_usd: totalUsd,
      caps: {
        daily_cap: AI_DAILY_CAP,
        monthly_cap: AI_MONTHLY_CAP,
        model: AI_MODEL,
      },
    });
  } catch (e: any) {
    console.error("[ADMIN][AI_SPEND][weekly] error:", e?.message || e);
    return res.status(500).json({ error: "Failed to fetch weekly AI spend" });
  }
});


admin.get("/ai/spend/:orgId/monthly", async (req, res) => {
  try {
    const orgId = req.params.orgId;
    if (!orgId) {
      return res.status(400).json({ error: "orgId is required" });
    }

    const now = new Date();
    // last 30 days INCLUDING today
    const from = new Date(now);
    from.setDate(from.getDate() - 29); // 29 days back + today = 30

    const totalUsd = await getOrgSpendInRange(orgId, from, now);

    return res.json({
      org_id: orgId,
      range: "monthly",
      since: from.toISOString(),
      until: now.toISOString(),
      total_usd: totalUsd,
      caps: {
        daily_cap: AI_DAILY_CAP,
        monthly_cap: AI_MONTHLY_CAP,
        model: AI_MODEL,
      },
    });
  } catch (e: any) {
    console.error("[ADMIN][AI_SPEND][monthly] error:", e?.message || e);
    return res.status(500).json({ error: "Failed to fetch monthly AI spend" });
  }
});


export default admin;