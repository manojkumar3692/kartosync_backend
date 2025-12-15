import express from "express";
import axios from "axios";
import { supa } from "../db";
import { getOrgRazorpay, verifyRazorpayWebhookSignature } from "../payments/razorpay";

export const razorpayWebhookRouter = express.Router();

// ─────────────────────────────
// Helpers
// ─────────────────────────────
function digitsOnly(s: string) {
  return String(s || "").replace(/[^\d]/g, "");
}

async function sendWhatsAppText(opts: {
  wa_phone_number_id: string;
  wa_access_token: string;
  to_phone: string; // digits only
  text: string;
}) {
  const url = `https://graph.facebook.com/v20.0/${opts.wa_phone_number_id}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: opts.to_phone,
    type: "text",
    text: { body: opts.text },
  };

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${opts.wa_access_token}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  return res.data;
}

// ─────────────────────────────
// Debug routes (to confirm Render deployment & mount)
// ─────────────────────────────
razorpayWebhookRouter.get("/", (_req, res) => {
  return res.json({ ok: true, router: "razorpayWebhookRouter" });
});

razorpayWebhookRouter.get("/ping", (_req, res) => {
  console.log("[RZP_PING] hit");
  return res.json({ ok: true, ts: new Date().toISOString() });
});

razorpayWebhookRouter.get("/webhook", (_req, res) => {
  return res.status(405).json({ ok: false, message: "Use POST (Razorpay webhook)." });
});

// ─────────────────────────────
// Webhook (RAW body required for signature verification)
// ─────────────────────────────
razorpayWebhookRouter.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig = String(req.headers["x-razorpay-signature"] || "");
      console.log("[RZP_WEBHOOK][HIT]", new Date().toISOString(), "url=", req.originalUrl);

      const rawBody = req.body as any;

      // If bodyParser.json ran before this route -> rawBody won't be Buffer -> signature fails
      if (!Buffer.isBuffer(rawBody)) {
        console.error("[RZP_WEBHOOK][FATAL] req.body is not Buffer.");
        console.error("[RZP_WEBHOOK][FIX] Mount /api/razorpay BEFORE bodyParser.json() in server.ts");
        return res.status(400).send("webhook misconfigured: raw body not available");
      }

      const event = JSON.parse(rawBody.toString("utf8"));
      const payload = event?.payload;

      console.log("[RZP_WEBHOOK][INCOMING]", { event: event?.event, hasSig: !!sig });

      // reference_id can be either:
      // A) "<order_uuid>" (your current implementation)
      // B) "org:<org_id>:order:<order_id>" (older pattern)
      const ref =
        payload?.payment_link?.entity?.reference_id ||
        payload?.payment?.entity?.notes?.reference_id ||
        null;

      const plinkId =
        payload?.payment_link?.entity?.id ||
        payload?.payment?.entity?.payment_link_id ||
        null;

      console.log("[RZP_WEBHOOK][REF]", { ref, plinkId });

      // Only act on paid events
      const isPaidEvent =
        event?.event === "payment_link.paid" ||
        event?.event === "payment.captured";

      if (!isPaidEvent) {
        console.log("[RZP_WEBHOOK][SKIP] Not a paid event:", event?.event);
        return res.status(200).send("ok");
      }

      // 1) Identify order + org
      let order_id: string | null = null;
      let org_id: string | null = null;

      // Pattern B: org:<org>:order:<id>
      if (ref && String(ref).includes("org:") && String(ref).includes(":order:")) {
        org_id = String(ref).split("org:")[1].split(":order:")[0];
        order_id = String(ref).split(":order:")[1];
      }
      // Pattern A: ref is order UUID
      else if (ref && /^[0-9a-fA-F-]{36}$/.test(String(ref))) {
        order_id = String(ref);
      }

      // If only order_id, load org_id from DB
      if (order_id && !org_id) {
        const { data: ordRow, error: ordErr } = await supa
          .from("orders")
          .select("id, org_id")
          .eq("id", order_id)
          .maybeSingle();

        if (ordErr || !ordRow) {
          console.warn("[RZP_WEBHOOK][ORDER_NOT_FOUND_BY_REF]", {
            order_id,
            ordErr: ordErr?.message,
          });
          order_id = null; // fallback to plink
        } else {
          org_id = (ordRow as any).org_id;
        }
      }

      // Fallback: find by payment_link_id
      if (!order_id && plinkId) {
        const { data: ordRow, error: ordErr } = await supa
          .from("orders")
          .select("id, org_id")
          .eq("razorpay_payment_link_id", String(plinkId))
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (ordErr || !ordRow) {
          console.warn("[RZP_WEBHOOK][ORDER_NOT_FOUND_BY_PLINK]", {
            plinkId,
            ordErr: ordErr?.message,
          });
          return res.status(200).send("ignored");
        }

        order_id = (ordRow as any).id;
        org_id = (ordRow as any).org_id;
      }

      if (!order_id || !org_id) {
        console.warn("[RZP_WEBHOOK][NO_MATCH]", { ref, plinkId });
        return res.status(200).send("ignored");
      }

      console.log("[RZP_WEBHOOK][MATCHED]", { org_id, order_id });

      // 2) Verify signature using org-wise webhook secret
      const org = await getOrgRazorpay(org_id);
      if (!org.razorpay_webhook_secret) {
        console.warn("[RZP_WEBHOOK][ORG_SECRET_MISSING]", { org_id });
        return res.status(400).send("org webhook secret missing");
      }

      const ok = verifyRazorpayWebhookSignature(rawBody, sig, org.razorpay_webhook_secret);
      console.log("[RZP_WEBHOOK][SIG_VERIFY]", { ok });

      if (!ok) return res.status(400).send("bad signature");

      // 3) Mark paid (idempotent)
      const { data: updatedOrders, error: updErr } = await supa
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
          status: "confirmed",
        } as any)
        .eq("id", order_id)
        .eq("org_id", org_id)
        .neq("payment_status", "paid")
        .select("id, source_phone, items, total_amount");

      if (updErr) {
        console.error("[RZP_WEBHOOK][ORDER_UPDATE_ERR]", updErr);
        return res.status(200).send("ok");
      }

      if (!updatedOrders || updatedOrders.length === 0) {
        console.log("[RZP_WEBHOOK][ALREADY_PAID] skipping send");
        return res.status(200).send("ok");
      }

      const paidOrder = updatedOrders[0] as any;
      const phone = digitsOnly(paidOrder?.source_phone);

      // 4) Load org pickup details + WA config
      const { data: orgRow } = await supa
        .from("orgs")
        .select([
          "wa_phone_number_id",
          "wa_access_token",
          "pickup_address",
          "pickup_maps_url",
          "pickup_phone",
          "pickup_hours",
          "store_address_text",
        ].join(","))
        .eq("id", org_id)
        .maybeSingle();

      const wa_phone_number_id = (orgRow as any)?.wa_phone_number_id || null;
      const wa_access_token = (orgRow as any)?.wa_access_token || null;

      const pickup_address =
        (orgRow as any)?.pickup_address ||
        (orgRow as any)?.store_address_text ||
        null;

      const pickup_maps_url = (orgRow as any)?.pickup_maps_url || null;
      const pickup_phone = (orgRow as any)?.pickup_phone || null;
      const pickup_hours = (orgRow as any)?.pickup_hours || null;

      // Optional order summary
      let summary = "";
      if (Array.isArray(paidOrder?.items) && paidOrder.items.length > 0) {
        const lines: string[] = [];
        for (const it of paidOrder.items) {
          const name = it?.name || "Item";
          const variant = it?.variant ? ` (${it.variant})` : "";
          const qty = Number(it?.qty) || 0;
          const price = Number(it?.price) || 0;
          if (qty > 0) lines.push(`• ${name}${variant} x ${qty}${price ? ` — ₹${qty * price}` : ""}`);
        }
        const total =
          paidOrder?.total_amount != null
            ? `\n💰 Total: ₹${Number(paidOrder.total_amount).toFixed(0)}\n`
            : "";
        summary = lines.length ? `🧾 *Order Summary*\n${lines.join("\n")}${total}\n` : "";
      }

      const msg =
        "✅ *Payment received!*\n\n" +
        `Your order *#${order_id}* is confirmed for *Store Pickup*.\n\n` +
        (summary ? summary + "\n" : "") +
        (pickup_address ? `📍 Address: ${pickup_address}\n` : "") +
        (pickup_maps_url ? `🗺 Map: ${pickup_maps_url}\n` : "") +
        (pickup_hours ? `🕒 Pickup time: ${pickup_hours}\n` : "") +
        (pickup_phone ? `📞 Contact: ${pickup_phone}\n` : "") +
        "\nShow this message at pickup. Thanks!";

      // 5) Send WhatsApp message
      if (!phone) {
        console.warn("[RZP_WEBHOOK][NO_PHONE] Cannot send WhatsApp message");
      } else if (!wa_phone_number_id || !wa_access_token) {
        console.warn("[RZP_WEBHOOK][WA_CONFIG_MISSING]", {
          org_id,
          wa_phone_number_id: !!wa_phone_number_id,
          wa_access_token: !!wa_access_token,
        });
      } else {
        try {
          const waRes = await sendWhatsAppText({
            wa_phone_number_id,
            wa_access_token,
            to_phone: phone,
            text: msg,
          });

          console.log("[RZP_WEBHOOK][WA_SENT]", {
            to: phone,
            order_id,
            wa_message_id: waRes?.messages?.[0]?.id,
          });
        } catch (e: any) {
          console.error("[RZP_WEBHOOK][WA_SEND_ERR]", e?.response?.data || e?.message || e);
        }
      }

      // 6) Clear conversation state
      if (phone) {
        await supa.from("ai_conversation_state").delete().eq("org_id", org_id).eq("customer_phone", phone);
        console.log("[RZP_WEBHOOK][STATE_CLEARED]", { org_id, phone });
      }

      return res.status(200).send("ok");
    } catch (e: any) {
      console.error("[RZP_WEBHOOK_ERR]", e?.message || e);
      return res.status(200).send("ok");
    }
  }
);