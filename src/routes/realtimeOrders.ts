import type { Request, Response } from "express";

const clientsByOrg = new Map<string, Set<Response>>();

export function sseOrders(req: Request, res: Response) {
  const org_id = String(req.query.org_id || "");
  if (!org_id) return res.status(400).json({ ok: false, error: "org_id_required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // ✅ important in some setups
  res.flushHeaders?.();

  if (!clientsByOrg.has(org_id)) clientsByOrg.set(org_id, new Set());
  clientsByOrg.get(org_id)!.add(res);

  // immediate ping
  res.write(`event: ping\ndata: {"ok":true}\n\n`);

  // ✅ heartbeat (keeps connection alive)
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
    } catch {
      // ignore
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clientsByOrg.get(org_id)?.delete(res);
  });
}

export function emitNewOrder(org_id: string, payload: any) {
  const set = clientsByOrg.get(org_id);
  if (!set?.size) return;

  const data = JSON.stringify(payload || {});
  for (const res of set) {
    res.write(`event: new_order\ndata: ${data}\n\n`);
  }
}