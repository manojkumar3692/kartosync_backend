// src/ai/cost.ts
import { supa } from "../db";

const DAILY_CAP = Number(process.env.AI_DAILY_USD || 5); // default $5/day
const IS_DEV_LOG = process.env.NODE_ENV !== "production";

// Very rough price map (per 1K tokens)
// Adjust to your actual model pricing when you finalize.
const PRICES_PER_1K: Record<string, number> = {
  // gpt-4o-mini is cheap; adjust if needed
  "gpt-4o-mini": 0.002,     // example blended price
  "gpt-4o": 0.01,           // example
  "gpt-4.1-mini": 0.003,    // example
};

function pricePer1k(model?: string) {
  const m = (model || "").toLowerCase();
  for (const k of Object.keys(PRICES_PER_1K)) {
    if (m.includes(k)) return PRICES_PER_1K[k];
  }
  // default cheap
  return 0.002;
}

export function estimateCostUSD(usage?: { prompt_tokens?: number; completion_tokens?: number }, model?: string) {
  const pt = usage?.prompt_tokens || 0;
  const ct = usage?.completion_tokens || 0;
  const total = pt + ct;
  const usd = (total / 1000) * pricePer1k(model);
  return Number.isFinite(usd) ? usd : 0;
}

export async function canSpendMoreUSD(approxUSD: number) {
  if (DAILY_CAP <= 0) return false;

  try {
    const { data, error } = await supa
      .from("ai_daily_spend")
      .select("usd_spent, dt")
      .eq("dt", new Date().toISOString().slice(0, 10)) // UTC date
      .maybeSingle();

    if (error) {
      if (IS_DEV_LOG) console.warn("[AI budget] select error, allowing spend:", error.message);
      return true; // be permissive if table missing / RLS etc.
    }

    const spent = data?.usd_spent || 0;
    const allowed = spent + approxUSD <= DAILY_CAP;
    if (IS_DEV_LOG) console.log(`[AI budget] spent=$${spent.toFixed(4)} + ~${approxUSD.toFixed(4)} <= cap=$${DAILY_CAP} ?`, allowed);
    return allowed;
  } catch (e: any) {
    if (IS_DEV_LOG) console.warn("[AI budget] exception, allowing spend:", e?.message || e);
    return true; // permissive fallback
  }
}

export async function addSpendUSD(usd: number) {
  if (!(usd > 0)) return;
  const today = new Date().toISOString().slice(0, 10);

  try {
    // upsert: add to existing row or create
    const { error } = await supa.rpc("increment_ai_daily_spend", { p_dt: today, p_amount: usd });
    if (error) {
      // if the function doesn't exist yet, do a fallback upsert
      const { data: row, error: selErr } = await supa
        .from("ai_daily_spend")
        .select("usd_spent")
        .eq("dt", today)
        .maybeSingle();

      if (selErr) throw selErr;

      const newVal = (row?.usd_spent || 0) + usd;
      const { error: upErr } = await supa
        .from("ai_daily_spend")
        .upsert({ dt: today as any, usd_spent: newVal }, { onConflict: "dt" });
      if (upErr) throw upErr;
    }
  } catch (e: any) {
    if (IS_DEV_LOG) console.warn("[AI budget] addSpendUSD failed (ignored):", e?.message || e);
  }
}