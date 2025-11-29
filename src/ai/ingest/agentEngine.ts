// src/ai/ingest/agentEngine.ts

import { supa } from "../../db";
import { IngestContext, IngestResult } from "./types";
import { setState } from "./stateManager";

export async function handleAgent(
  ctx: IngestContext
): Promise<IngestResult> {
  const { org_id, from_phone } = ctx;

  // ─────────────────────────────────────────────
  // Set state to agent mode
  // ─────────────────────────────────────────────
  await setState(org_id, from_phone, "agent");

  // ─────────────────────────────────────────────
  // Log agent request (dashboard can pick it up)
  // ─────────────────────────────────────────────
  await supa.from("agent_requests").insert({
    org_id,
    customer_phone: from_phone,
    created_at: new Date().toISOString(),
    status: "open",
  });

  // ─────────────────────────────────────────────
  // Reply once — after this, WABA should stop AI replies
  // ─────────────────────────────────────────────
  return {
    used: true,
    kind: "agent",
    reply:
      "👥 Connecting you to a support agent...\n" +
      "Please wait a moment. A human will reply shortly.",
    order_id: null,
  };
}