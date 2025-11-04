import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";
export const org = express.Router();
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
org.get("/me", ensureAuth, async (req: any, res) => {
  const { data, error } = await supa
    .from("orgs")
    .select("*")
    .eq("id", req.org_id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
org.post("/map-wa", ensureAuth, async (req: any, res) => {
  const { wa_phone_number_id } = req.body || {};
  const { error } = await supa
    .from("orgs")
    .update({ wa_phone_number_id })
    .eq("id", req.org_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
