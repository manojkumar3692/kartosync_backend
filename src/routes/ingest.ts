// src/routes/ingest.ts

// === ANCHOR: IMPORTS_TOP ===
import express from "express";
import { ingestCoreFromMessage } from "./ingestCore"; // Shared core pipeline

// (Only needed here for /test-ai)
import { parseOrder } from "../parser"; // (still available if you want to compare)
import { DateTime } from "luxon";
import {
  isObviousPromoOrSpam,
  isPureGreetingOrAck,
  isNotOrderMessage,
} from "../util/notOrder";

console.log("🔥🔥 INGEST INDEX.TS RUNNING routes/ingest.ts");

// Optional AI parser (safe even if not used)
let aiParseOrder:
  | undefined
  | ((
      text: string,
      catalog?: any,
      opts?: { org_id?: string; customer_phone?: string }
    ) => Promise<{
      items: any[];
      confidence?: number;
      reason?: string | null;
      is_order_like?: boolean;
      used?: "ai" | "rules";
    }>);

try {
  // === ANCHOR: AI_WIRE_SETUP ===
  // Loading AI parser module once at startup
  // (If missing, system gracefully falls back to rules-only where used.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../ai/parser");
  aiParseOrder = (mod.aiParseOrder ||
    mod.default?.aiParseOrder) as typeof aiParseOrder;
  console.log(
    "[AI][wire] aiParseOrder loaded?",
    typeof aiParseOrder === "function"
  );
} catch (e) {
  console.warn("[AI][wire] load fail:", (e as any)?.message || e);
  aiParseOrder = undefined;
}

export const ingest = express.Router();

/** ───────────────── helpers (kept minimal here) ───────────────── **/

const asStr = (v: any) =>
  typeof v === "string" ? v : v == null ? "" : String(v);
const trim = (v: any) => asStr(v).trim();

function normPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/[^\d]/g, "");
  return digits.length >= 7 ? plus + digits : null;
}

/** ───────────────── ROUTES ───────────────── **/

// (A) Simple health
// === ANCHOR: ROUTE_HEALTH ===
ingest.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// (B) Test route to directly exercise AI (no ingestCore, no HMAC)
// NOTE: This is mostly for debugging models; it does NOT write orders.
ingest.post("/test-ai", express.json(), async (req, res) => {
  try {
    const { text, org_id, customer_phone } = req.body || {};
    if (!text)
      return res.status(400).json({ ok: false, error: "text required" });

    const hasFn = typeof aiParseOrder === "function";
    const hasKey = !!process.env.OPENAI_API_KEY;
    const useAI = !!(hasFn && hasKey);
    console.log("[TEST-AI][gate]", {
      hasFn,
      hasKey,
      useAI,
      model: process.env.AI_MODEL,
    });

    if (!useAI) {
      return res.json({
        ok: true,
        used: !hasFn
          ? "rules-only (ai function not found)"
          : "rules-only (no OPENAI key)",
      });
    }

    const out = await (aiParseOrder as NonNullable<typeof aiParseOrder>)(
      String(text),
      undefined,
      {
        org_id: org_id || undefined,
        customer_phone: normPhone(customer_phone || "") || undefined,
      }
    );

    console.log("[TEST-AI][result]", {
      is_order_like: out?.is_order_like,
      items: out?.items?.length,
      reason: out?.reason,
    });

    return res.json({
      ok: true,
      used: `ai:${process.env.AI_MODEL || "unknown"}`,
      out,
    });
  } catch (e: any) {
    console.error("[TEST-AI]", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "ai error" });
  }
});

// (C) DIAGNOSTIC: notification listener ping (you can keep or remove)
// === ANCHOR: ROUTE_NL_PING ===
ingest.post("/nl-ping", express.json(), async (_req, res) => {
  return res.json({ ok: true });
});

// (D) Manual / debug entrypoint → calls ingestCoreFromMessage directly
// Useful for Postman testing WITHOUT WABA or local-bridge.
// Example body:
// {
//   "org_id": "b5c1...",
//   "text": "1kg onion 2kg sugar",
//   "from_phone": "9715880....",
//   "from_name": "Test User",
//   "msg_id": "debug-123",
//   "source": "manual"
// }
ingest.post("/manual", express.json(), async (req: any, res: any) => {
  try {
    const {
      org_id,
      text,
      from_phone,
      from_name,
      msg_id,
      edited_at,
      ts,
      source,
    } = req.body || {};

    if (!org_id || !text) {
      return res
        .status(400)
        .json({ ok: false, error: "org_id_and_text_required" });
    }

    const coreResult = await ingestCoreFromMessage({
      org_id: trim(org_id),
      text: trim(text),
      ts: Number.isFinite(ts) ? Number(ts) : Date.now(),
      from_phone: from_phone ? String(from_phone) : null,
      from_name: from_name ? String(from_name) : null,
      msg_id: msg_id ? String(msg_id) : null,
      edited_at: edited_at ? Number(edited_at) : null,
      source: (source as any) || "manual",
    });

    return res.json(coreResult);
  } catch (e: any) {
    console.error("[INGEST][manual]", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "ingest_manual_error" });
  }
});

// NOTE: Old /local Android-bridge route has been removed.
// If some old client still posts there, it will now get 404 from Express.

// === ANCHOR: EXPORT_DEFAULT ===
export default ingest;