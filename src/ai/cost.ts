// src/ai/cost.ts
import { supa } from "../db";

const CAP_USD = Number(
  process.env.AI_DAILY_USD ||
  process.env.AI_MAX_DAILY_USD || // fallback env you used earlier
  5
);

// pricing (per 1M tokens). You can override via env.
const PRICE_IN  = Number(process.env.AI_PRICE_IN_USD_PER_1M  || 0.60); // gpt-4o-mini input
const PRICE_OUT = Number(process.env.AI_PRICE_OUT_USD_PER_1M || 2.40); // gpt-4o-mini output

// table name (optional). If missing, we fall back to in-memory counter.
const BUDGET_TABLE = (process.env.AI_BUDGET_TABLE || "ai_daily_spend").trim();

let inMemoryToday = new Date().toISOString().slice(0,10); // UTC yyyy-mm-dd
let inMemorySpent = 0;

// Estimate cost in USD from token usage + model. If usage missing, use a tiny safe floor.
export function estimateCostUSD(
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null,
  _model?: string
): number {
  const inT  = Math.max(0, usage?.prompt_tokens ?? 0);
  const outT = Math.max(0, usage?.completion_tokens ?? 0);
  const costIn  = (inT  / 1_000_000) * PRICE_IN;
  const costOut = (outT / 1_000_000) * PRICE_OUT;
  const total = costIn + costOut;
  return total > 0 ? total : 0.0002; // tiny default so pre-checks have a value
}

// Query or create today's row and return spent so far. If table missing, use in-memory.
async function getTodaySpentUSD(): Promise<number> {
  try {
    const today = new Date().toISOString().slice(0,10); // UTC date
    const { data, error } = await supa
      .from(BUDGET_TABLE)
      .select("usd_spent, dt")
      .eq("dt", today)
      .limit(1);
    if (error) throw error;
    if (data && data[0]) return Number(data[0].usd_spent) || 0;

    // create the row for today
    const ins = await supa.from(BUDGET_TABLE).insert({ dt: today, usd_spent: 0 });
    if (ins.error) throw ins.error;
    return 0;
  } catch (_e) {
    // fallback in-memory
    const today = new Date().toISOString().slice(0,10);
    if (today !== inMemoryToday) { inMemoryToday = today; inMemorySpent = 0; }
    return inMemorySpent;
  }
}

// Increment spend for today (DB if available, else in-memory)
export async function addSpendUSD(delta: number): Promise<void> {
  if (!delta || delta <= 0) return;
  try {
    const today = new Date().toISOString().slice(0,10);
    const { error } = await supa.rpc("ai_daily_spend_add", { p_dt: today, p_delta: delta });
    if (error) {
      // if rpc not present, do naive upsert
      const { data, error: selErr } = await supa
        .from(BUDGET_TABLE)
        .select("usd_spent")
        .eq("dt", today)
        .limit(1);
      if (selErr) throw selErr;

      if (data && data[0]) {
        const spent = Number(data[0].usd_spent) || 0;
        const { error: updErr } = await supa
          .from(BUDGET_TABLE)
          .update({ usd_spent: spent + delta })
          .eq("dt", today);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supa
          .from(BUDGET_TABLE)
          .insert({ dt: today, usd_spent: delta });
        if (insErr) throw insErr;
      }
    }
  } catch (_e) {
    // fallback in-memory
    const today = new Date().toISOString().slice(0,10);
    if (today !== inMemoryToday) { inMemoryToday = today; inMemorySpent = 0; }
    inMemorySpent += delta;
  }
}

// Budget gate: can we spend (approx) more?
export async function canSpendMoreUSD(approx: number): Promise<boolean> {
  if (CAP_USD <= 0) return false;
  const spent = await getTodaySpentUSD();
  const ok = (spent + (approx || 0)) <= CAP_USD;
  console.log(`[AI$] canSpend? spent=${spent.toFixed(4)} + approx=${(approx||0).toFixed(4)} <= cap=${CAP_USD.toFixed(2)} → ${ok}`);
  return ok;
}