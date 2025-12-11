// src/ai/cost.ts
import { supa } from "../db";

/**
 * ENV knobs (with sane defaults)
 * --------------------------------------------------------------------
 * AI_DAILY_USD           -> hard daily cap (USD), default 5
 * AI_PER_CALL_USD_MAX    -> max allowed per single call (USD), default 1
 * AI_PRICE_IN_USD_PER_1M -> $ per 1M prompt tokens, default 0.60
 * AI_PRICE_OUT_USD_PER_1M-> $ per 1M completion tokens, default 2.40
 * AI_BUDGET_TABLE        -> table name to store daily spend (default ai_daily_spend)
 *
 * Optional Postgres RPC (if created):
 *   create or replace function public.increment_ai_daily_spend(p_dt date, p_amount numeric) returns void ...
 */

const DAILY_CAP = Number(process.env.AI_DAILY_USD ?? 5);
const PER_CALL_CAP = Number(process.env.AI_PER_CALL_USD_MAX ?? 1);

const PRICE_IN_PER_1M  = Number(process.env.AI_PRICE_IN_USD_PER_1M  ?? 0.60);
const PRICE_OUT_PER_1M = Number(process.env.AI_PRICE_OUT_USD_PER_1M ?? 2.40);

const PRIMARY_TABLE = (process.env.AI_BUDGET_TABLE || "ai_daily_spend").trim();
const FALLBACK_TABLE = "ai_daily_spend"; // used if PRIMARY_TABLE errors
const IS_DEV_LOG = process.env.NODE_ENV !== "production";

// Track which table worked last to avoid spamming fallbacks
let resolvedTable: string | null = null;

// Choose a table, preferring PRIMARY_TABLE but falling back if it errors
async function pickTable(): Promise<string> {
  if (resolvedTable) return resolvedTable;
  // probe PRIMARY_TABLE by a harmless select
  const today = new Date().toISOString().slice(0, 10);
  const probe = await supa.from(PRIMARY_TABLE).select("dt").eq("dt", today).limit(1);
  if (!probe.error) {
    resolvedTable = PRIMARY_TABLE;
    return resolvedTable;
  }
  // fallback
  if (IS_DEV_LOG) console.warn(`[AI$] Falling back to ${FALLBACK_TABLE}:`, probe.error.message);
  resolvedTable = FALLBACK_TABLE;
  return resolvedTable;
}

/** Convert token usage to USD using per-1M pricing. */
export function estimateCostUSD(
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null,
  _model?: string
): number {
  if (!usage) return 0;
  const inT  = usage.prompt_tokens ?? 0;
  const outT = usage.completion_tokens ?? 0;
  const costIn  = (inT  / 1_000_000) * PRICE_IN_PER_1M;
  const costOut = (outT / 1_000_000) * PRICE_OUT_PER_1M;
  const total = costIn + costOut;
  return Number.isFinite(total) ? Number(total.toFixed(6)) : 0;
}

/** Pre-flight estimate when you only have approx tokens. */
export function estimateCostUSDApprox(
  approx: { prompt_tokens: number; completion_tokens: number },
  _model?: string
): number {
  return estimateCostUSD(approx);
}

/** Read today’s spend (UTC date bucket). */
export async function getTodaySpendUSD(): Promise<number> {
  try {
    const table = await pickTable();
    const { data, error } = await supa
      .from(table)
      .select("usd_spent")
      .eq("dt", new Date().toISOString().slice(0, 10))
      .maybeSingle();
    if (error && error.code !== "PGRST116") {
      if (IS_DEV_LOG) console.warn("[AI$] read error:", error.message);
    }
    return Number(data?.usd_spent ?? 0);
  } catch (e: any) {
    if (IS_DEV_LOG) console.warn("[AI$] getTodaySpendUSD exception:", e?.message || e);
    return 0;
  }
}

/**
 * Enforce budgets before calling the LLM.
 * Returns { ok:false, reason, today, cap } if blocked.
 */
export async function canSpendMoreUSD(
  approxUSD: number
): Promise<{ ok: boolean; reason?: string; today?: number; cap?: number }> {
  if (!isFinite(approxUSD) || approxUSD < 0) approxUSD = 0;

  if (PER_CALL_CAP > 0 && approxUSD > PER_CALL_CAP) {
    const reason = `[AI$ BLOCK] single-call est $${approxUSD.toFixed(4)} > per-call cap $${PER_CALL_CAP.toFixed(2)}`;
    console.warn(reason);
    return { ok: false, reason, today: await getTodaySpendUSD(), cap: DAILY_CAP };
  }

  if (DAILY_CAP <= 0) {
    const reason = "[AI$ BLOCK] daily cap is 0";
    console.warn(reason);
    return { ok: false, reason, today: await getTodaySpendUSD(), cap: 0 };
  }

  const today = await getTodaySpendUSD();
  if (today + approxUSD > DAILY_CAP) {
    const reason = `[AI$ BLOCK] daily $${today.toFixed(4)} + est $${approxUSD.toFixed(4)} > cap $${DAILY_CAP.toFixed(2)}`;
    console.warn(reason);
    return { ok: false, reason, today, cap: DAILY_CAP };
  }

  if (IS_DEV_LOG) {
    console.log(`[AI$ OK pre] +$${approxUSD.toFixed(4)} → ${ (today + approxUSD).toFixed(4) } / $${DAILY_CAP.toFixed(2) }`);
  }
  return { ok: true, today, cap: DAILY_CAP };
}

/** Log a nice line when spend is approved (optional cosmetic). */
export function logSpendApproved(approx: number, todayBefore: number, cap = DAILY_CAP) {
  const after = todayBefore + approx;
  console.log(`[AI$ OK] +$${approx.toFixed(4)} → $${after.toFixed(4)} / $${cap.toFixed(2)}`);
}

/**
 * Add actual spend after the call. Tries your RPC first:
 *   increment_ai_daily_spend(p_dt date, p_amount numeric)
 * Falls back to upsert/increment in the resolved table.
 */
export async function addSpendUSD(usd: number) {
  if (!(usd > 0) || !isFinite(usd)) return;
  const today = new Date().toISOString().slice(0, 10);

  // Try RPC if you created it (safe to fail)
  try {
    const { error } = await supa.rpc("increment_ai_daily_spend", { p_dt: today, p_amount: usd });
    if (!error) return;
    if (IS_DEV_LOG) console.warn("[AI$] RPC increment_ai_daily_spend error:", error.message);
  } catch (_) {
    // ignore if missing
  }

  // Fallback: upsert/increment in table
  try {
    const table = await pickTable();

    // Read current
    const cur = await supa
      .from(table)
      .select("usd_spent")
      .eq("dt", today)
      .maybeSingle();

    const prev = Number(cur.data?.usd_spent ?? 0);
    const next = Number((prev + usd).toFixed(6));

    const up = await supa
      .from(table)
      .upsert({ dt: today as any, usd_spent: next }, { onConflict: "dt" });

    if (up.error) {
      console.warn("[AI$] upsert error:", up.error.message);
    }
  } catch (e: any) {
    if (IS_DEV_LOG) console.warn("[AI$] addSpendUSD exception:", e?.message || e);
  }
}


// ⬇️ ADD THIS NEW HELPER
export async function logAiUsageForCall(params: {
  orgId?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number | null } | null;
  model?: string | null;
  raw?: any; // optional: prompt/response metadata
}) {
  try {
    const { orgId, usage, model, raw } = params;
    if (!usage) return;

    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const totalTokens =
      usage.total_tokens ?? promptTokens + completionTokens;

    // 💰 Reuse your existing cost estimator
    const costUsd = estimateCostUSD(
      {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      },
      model || undefined
    );

    // 🔄 Keep your existing daily-budget tracking working
    if (costUsd > 0) {
      await addSpendUSD(costUsd);
    }

    // 🧾 Per-call, per-org log in ai_usage_log
    const payload = {
      org_id: orgId ?? null,
      model: model ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cost_usd: costUsd > 0 ? Number(costUsd.toFixed(4)) : null,
      raw: raw ? JSON.stringify(raw).slice(0, 50000) : null, // avoid insane blobs
    };

    const { error } = await supa.from("ai_usage_log").insert(payload);
    if (error && IS_DEV_LOG) {
      console.warn("[AI_USAGE_LOG] insert error:", error.message);
    }
  } catch (e: any) {
    if (IS_DEV_LOG) {
      console.warn("[AI_USAGE_LOG] exception:", e?.message || e);
    }
  }
}