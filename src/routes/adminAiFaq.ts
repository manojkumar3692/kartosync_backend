// src/routes/adminAiFaq.ts
import express from "express";
import { supa } from "../db";
import jwt from "jsonwebtoken";

export const adminAiFaq = express.Router();

type JwtPayload = { org_id?: string; org?: { id?: string } };

function getOrgId(req: any): string | null {
  const auth = (req.headers.authorization || "").toString();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !process.env.JWT_SECRET) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as JwtPayload;
    if (decoded.org_id) return String(decoded.org_id);
    if (decoded.org?.id) return String(decoded.org.id);
    return null;
  } catch {
    return null;
  }
}

// GET /admin/ai/faq
adminAiFaq.get("/faq", async (req, res) => {
  const orgId = getOrgId(req);
  if (!orgId) return res.status(401).json({ error: "no_org" });

  const { data, error } = await supa
    .from("orgs")
    .select(
      "faq_delivery_answer, faq_opening_hours_answer, faq_pricing_answer, faq_delivery_area_answer"
    )
    .eq("id", orgId)
    .maybeSingle();

  if (error) {
    console.error("[AI FAQ GET]", error.message);
    return res.status(500).json({ error: "db_error" });
  }

  return res.json({
    faq_delivery_answer: data?.faq_delivery_answer ?? "",
    faq_opening_hours_answer: data?.faq_opening_hours_answer ?? "",
    faq_pricing_answer: data?.faq_pricing_answer ?? "",
    faq_delivery_area_answer: data?.faq_delivery_area_answer ?? "",
  });
});

// POST /admin/ai/faq
adminAiFaq.post("/faq", express.json(), async (req, res) => {
  const orgId = getOrgId(req);
  if (!orgId) return res.status(401).json({ error: "no_org" });

  const {
    faq_delivery_answer,
    faq_opening_hours_answer,
    faq_pricing_answer,
    faq_delivery_area_answer,
  } = req.body || {};

  const { error } = await supa
    .from("orgs")
    .update({
      faq_delivery_answer: faq_delivery_answer ?? null,
      faq_opening_hours_answer: faq_opening_hours_answer ?? null,
      faq_pricing_answer: faq_pricing_answer ?? null,
      faq_delivery_area_answer: faq_delivery_area_answer ?? null,
    })
    .eq("id", orgId);

  if (error) {
    console.error("[AI FAQ POST]", error.message);
    return res.status(500).json({ error: "db_error" });
  }

  return res.json({ ok: true });
});