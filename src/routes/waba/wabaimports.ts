// src/routes/waba/wabaimports.ts
import { supa } from "../../db";

/**
 * Logs WABA flow events into the `waba_flow_logs` table.
 * This is reused by sendWabaText() and any other routing flows.
 */
export async function logFlowEvent(opts: {
  orgId: string;
  from?: string;
  event: string;
  msgId?: string;
  orderId?: string | null;
  text?: string | null;
  result?: any;
  meta?: any;
}) {
  try {
    await supa.from("waba_flow_logs").insert({
      org_id: opts.orgId,
      customer_phone: opts.from || null,
      event: opts.event,
      msg_id: opts.msgId || null,
      order_id: opts.orderId || null,
      text: opts.text || null,
      result: opts.result ?? null,
      meta: opts.meta ?? null,
      source: "waba",
    });
  } catch (e: any) {
    console.warn("[WABA][FLOW_LOG_ERR]", e?.message || e);
  }
}