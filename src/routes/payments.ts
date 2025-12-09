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
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        details: "org_id and order_id are required",
      });
    }

    // 1) Load org (NOTE: table name = orgs, not org)
    const { data: orgRow, error: orgErr } = await supa
      .from("orgs")
      .select(
        `
        id,
        wa_phone_number_id,
        payment_enabled,
        payment_qr_url,
        payment_instructions,
        default_currency
      `
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

    // 2) Load order (include more fields for rich summary)
    const { data: orderRow, error: orderErr } = await supa
      .from("orders")
      .select(
        `
        id,
        items,
        source_phone,
        status,
        total_amount,
        delivery_fee,
        delivery_distance_km,
        delivery_type
      `
      )
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

    // 3) Build rich line items + totals (similar style to AI payment flow)
    const items: any[] = Array.isArray(order.items) ? order.items : [];
    const lines: string[] = [];
    let subtotal = 0;

    for (const it of items) {
      if (!it) continue;

      const qty = Number(it.qty || 1);
      const name = it.name || it.canonical || "Item";
      const variant = it.variant ? ` (${it.variant})` : "";
      const brand = it.brand ? ` (${it.brand})` : "";

      const lineTotal =
        (it as any).line_total != null
          ? Number((it as any).line_total)
          : 0;

      if (!Number.isNaN(lineTotal)) {
        subtotal += lineTotal;
      }

      const prettyLineTotal =
        !Number.isNaN(lineTotal) && lineTotal > 0
          ? ` — ₹${Math.round(lineTotal)}`
          : "";

      lines.push(
        `• ${name}${brand}${variant} x ${qty}${prettyLineTotal}`
      );
    }

    // Fallback: if subtotal is 0 but total_amount exists, use that
    if (subtotal === 0 && order.total_amount != null) {
      const ta = Number(order.total_amount);
      if (!Number.isNaN(ta)) subtotal = ta;
    }

    const deliveryFeeVal =
      order.delivery_fee != null ? Number(order.delivery_fee) : null;

    const deliveryLabel =
      deliveryFeeVal == null
        ? "will be confirmed"
        : deliveryFeeVal === 0
        ? "FREE"
        : `₹${Math.round(deliveryFeeVal)}`;

    const totalPayable =
      subtotal + (deliveryFeeVal != null ? deliveryFeeVal : 0);

    const linesText =
      lines.length > 0 ? `${lines.join("\n")}\n\n` : "";

    const currency = orgRow.default_currency || "AED";
    const symbol =
      currency === "INR"
        ? "₹"
        : currency === "AED"
        ? "AED "
        : `${currency} `;

    // If you prefer short ID in text, you can still compute it:
    // const shortId = String(order.id).slice(-5);

    const summaryMsg =
      `🧾 *Order Summary (#${order.id})*\n` +
      linesText +
      `Subtotal: ${symbol}${Math.round(subtotal)}\n` +
      `Delivery Fee: ${deliveryLabel}\n` +
      `——————————\n` +
      `*Total Payable: ${symbol}${Math.round(totalPayable)}*\n` +
      `--------------------------------\n` +
      `Total: ${Math.round(totalPayable)}\n\n` +
      `⏱ Estimated delivery: 30–45 minutes (depending on location).\n` +
      `📷 Please scan the QR code below to complete the payment.\n` +
      (orgRow.payment_instructions
        ? String(orgRow.payment_instructions) + "\n"
        : "") +
      `📞 For any changes, just reply here with your message.`;

    const phoneNumberId = orgRow.wa_phone_number_id as string;

    console.log("[payments/send-qr] SENDING", {
      org_id,
      order_id,
      to,
      phoneNumberId,
      qr: orgRow.payment_qr_url,
    });

    // 4) Send ONE WhatsApp message: image + caption (summary)
    await sendWabaText({
      phoneNumberId,
      to,
      orgId: orgRow.id,
      image: orgRow.payment_qr_url as string,
      text: summaryMsg, // used as caption when image is present
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