// src/routes/_ensureAuth.ts
import jwt from "jsonwebtoken";
import { supa } from "../db";

export async function ensureAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    req.org_id = d.org_id;

    // Check if org exists and not disabled
    const { data: org, error } = await supa
      .from("orgs")
      .select("is_disabled")
      .eq("id", req.org_id)
      .single();

    if (error) {
      console.error("[ensureAuth] org lookup error:", error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!org) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (org.is_disabled) {
      return res.status(403).json({ error: "org_disabled" });
    }

    return next();
  } catch (e) {
    // invalid/missing token, or jwt.verify failed
    return res.status(401).json({ error: "unauthorized" });
  }
}