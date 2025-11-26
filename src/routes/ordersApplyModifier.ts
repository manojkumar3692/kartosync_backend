// src/routes/ordersApplyModifier.ts (example)
import express from "express";
import { supa } from "../db";
import { applyModifierToItems } from "../order/modifierEngine";
import type { ParsedModifier } from "../ai/modifierParser";

const router = express.Router();

router.post("/:orderId/apply-modifier", async (req, res) => {
  const org_id = String(req.body.org_id || "");
  const orderId = String(req.params.orderId || "");
  const modifier = req.body.modifier as ParsedModifier;

  if (!org_id || !orderId || !modifier) {
    return res.status(400).json({ ok: false, error: "missing_params" });
  }

  const { data: order, error } = await supa
    .from("orders")
    .select("id, items, parse_reason")
    .eq("org_id", org_id)
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return res.status(404).json({ ok: false, error: "order_not_found" });
  }

  const result = applyModifierToItems(order.items || [], modifier);

  if (result.status !== "applied") {
    return res.json({
      ok: false,
      status: result.status,
      summary: result.summary,
      candidates: result.candidates || [],
    });
  }

  const { error: upErr } = await supa
    .from("orders")
    .update({
      items: result.items,
      parse_reason:
        (order.parse_reason || "") + `; modifier:${result.summary}`,
    })
    .eq("id", orderId)
    .eq("org_id", org_id);

  if (upErr) {
    return res.status(500).json({ ok: false, error: "update_failed" });
  }

  return res.json({
    ok: true,
    status: "applied",
    summary: result.summary,
    items: result.items,
  });
});

export default router;