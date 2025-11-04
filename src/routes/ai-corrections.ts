import express from "express";
import { supa } from "../db";
import { ensureAuth } from "./_ensureAuth";

export const aiCorrections = express.Router();



aiCorrections.post("/", ensureAuth, async (req: any, res) => {
  const { message_text, model_output, human_fixed } = req.body || {};
  if (!message_text || !model_output || !human_fixed) {
    return res.status(400).json({ error: "bad_request" });
  }
  const { error } = await supa.from("ai_corrections").insert({
    org_id: req.org_id,
    message_text,
    model_output,
    human_fixed,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});