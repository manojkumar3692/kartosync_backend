import express from "express";
import { supa } from "../db";
import jwt from "jsonwebtoken";
export const payments = express.Router();
function ensureAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    req.org_id = d.org_id;
    next();
  } catch (e) {
    res.status(401).json({ error: "unauthorized" });
  }
}
payments.post("/activate", ensureAuth, async (req: any, res) => {
  await supa.from("orgs").update({ plan: "pro" }).eq("id", req.org_id);
  res.json({ ok: true });
});

//example