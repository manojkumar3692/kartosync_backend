// src/routes/payments.ts
import express from "express";
import { supa } from "../db";
import { sendWabaText } from "../routes/waba";

const router = express.Router();

// POST /api/payments/send-qr
router.post("/send-qr", async (req: any, res) => {
  try {
    const { org_id, order_id } = req.body || {};
    if (!org_id || !order_id) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_fields", details: "org_id and order_id are required" });
    }

    // 1) Load org (NOTE: table name = orgs, not org)
    const { data: orgRow, error: orgErr } = await supa
      .from("orgs")
      .select(
        "id, wa_phone_number_id, payment_enabled, payment_qr_url, payment_instructions, default_currency"
      )
      .eq("id", org_id)
      .single();

    if (orgErr) {
      console.error("[payments/send-qr] org lookup error:", orgErr.message);
      return res.status(500).json({ ok: false, error: "db_error_org" });
    }
    if (!orgRow) {
      return res.status(404).json({ ok: false, error: "org_not_found" });
    }

    if (!orgRow.payment_enabled) {
      return res.json({ ok: false, error: "payments_disabled" });
    }

    if (!orgRow.payment_qr_url) {
      return res.json({ ok: false, error: "missing_qr_url" });
    }

    if (!orgRow.wa_phone_number_id) {
      return res.json({ ok: false, error: "missing_wa_phone_number_id" });
    }

    // 2) Load order
    const { data: orderRow, error: orderErr } = await supa
      .from("orders")
      .select("id, items, source_phone, status")
      .eq("id", order_id)
      .eq("org_id", org_id)
      .single();

    if (orderErr) {
      console.error("[payments/send-qr] order lookup error:", orderErr.message);
      return res.status(500).json({ ok: false, error: "db_error_order" });
    }
    if (!orderRow) {
      return res.status(404).json({ ok: false, error: "order_not_found" });
    }

    const order: any = orderRow;

    const phoneRaw = String(order.source_phone || "");
    const to = phoneRaw.replace(/[^\d]/g, "");
    if (!to) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_customer_phone" });
    }

    // 3) Compute total
    let total = 0;
    for (const it of order.items || []) {
      if (it && (it as any).line_total) {
        total += Number((it as any).line_total);
      }
    }

    const currency = orgRow.default_currency || "AED";
    const shortId = String(order.id).slice(-5);

    // 4) Build message text
    const msg =
      `🧾 *Order #${shortId} Payment*\n\n` +
      `Total: *${total} ${currency}*\n\n` +
      (orgRow.payment_instructions
        ? String(orgRow.payment_instructions) + "\n\n"
        : "") +
      `📌 When paying, please add note: *ORD-${shortId}*\n\n` +
      `Scan the QR below to pay.`;

    const phoneNumberId = orgRow.wa_phone_number_id as string;

    // 5) Send text
    await sendWabaText({
      phoneNumberId,
      to,
      text: msg,
      orgId: orgRow.id,
    });

    // 6) Send QR image with caption
    await sendWabaText({
      phoneNumberId,
      to,
      image: orgRow.payment_qr_url as string,
      caption: `Pay ${total} ${currency} for Order #${shortId}`,
      orgId: orgRow.id,
    });

    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[payments/send-qr] error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "internal_error" });
  }
});

export default router;