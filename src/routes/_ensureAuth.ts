// src/routes/_ensureAuth.ts
import jwt from "jsonwebtoken";

export function ensureAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    req.org_id = d.org_id;
    next();
  } catch (e) {
    console.error("Auth error:", e);
    res.status(401).json({ error: "unauthorized" });
  }
}