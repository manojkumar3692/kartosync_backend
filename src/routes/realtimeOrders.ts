// src/routes/realtimeOrders.ts
import type { Request, Response } from "express";

const clientsByOrg = new Map<string, Set<Response>>();

function safeWrite(res: Response, chunk: string) {
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

export function sseOrders(req: Request, res: Response) {
  const org_id = String(req.query.org_id || "");
  if (!org_id) return res.status(400).json({ ok: false, error: "org_id_required" });

  // ✅ SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // ✅ Register client
  if (!clientsByOrg.has(org_id)) clientsByOrg.set(org_id, new Set());
  const set = clientsByOrg.get(org_id)!;
  set.add(res);

  console.log("[SSE][CONNECT]", { org_id, clients: set.size });

  // ✅ Send an immediate hello + ping so frontend can confirm it’s receiving events
  safeWrite(res, `event: hello\ndata: {"org_id":"${org_id}","ts":"${new Date().toISOString()}"}\n\n`);
  safeWrite(res, `event: ping\ndata: {"ok":true}\n\n`);

  // ✅ Heartbeat
  const heartbeat = setInterval(() => {
    const ok = safeWrite(res, `event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
    if (!ok) {
      // connection likely dead
      clearInterval(heartbeat);
      set.delete(res);
      if (set.size === 0) clientsByOrg.delete(org_id);
      console.log("[SSE][DROP_DEAD]", { org_id, clients: set.size });
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) clientsByOrg.delete(org_id);
    console.log("[SSE][DISCONNECT]", { org_id, clients: set.size });
  });
}

export function emitNewOrder(org_id: string, payload: any) {
  const set = clientsByOrg.get(org_id);

  // ✅ CRITICAL: this log will tell you immediately if org_id mismatch is the problem
  console.log("[SSE][EMIT][new_order]", {
    org_id,
    hasClients: !!set,
    clients: set?.size || 0,
    payloadKeys: payload ? Object.keys(payload) : [],
  });

  if (!set?.size) return;

  const data = JSON.stringify(payload || {});
  const msg = `event: new_order\ndata: ${data}\n\n`;

  for (const res of Array.from(set)) {
    const ok = safeWrite(res, msg);
    if (!ok) {
      set.delete(res);
    }
  }

  if (set.size === 0) clientsByOrg.delete(org_id);
}