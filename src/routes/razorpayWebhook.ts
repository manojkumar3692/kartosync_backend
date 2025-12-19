import express from "express";
import axios from "axios";
import { supa } from "../db";
import {
  getOrgRazorpay,
  verifyRazorpayWebhookSignature,
} from "../payments/razorpay";
import { emitNewOrder } from "./realtimeOrders";

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
  return res
    .status(405)
    .json({ ok: false, message: "Use POST (Razorpay webhook)." });
});

razorpayWebhookRouter.get("/debug-org/:orgId", async (req, res) => {
  const orgId = String(req.params.orgId);

  const { data, error } = await supa
    .from("orgs")
    .select("id, wa_phone_number_id, wa_access_token")
    .eq("id", orgId)
    .maybeSingle();

  return res.json({
    ok: !error,
    error: error?.message || null,
    id: data?.id || null,
    wa_phone_number_id: data?.wa_phone_number_id || null,
    wa_access_token_len: (data?.wa_access_token || "").length,
  });
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
      console.log(
        "[RZP_WEBHOOK][HIT]",
        new Date().toISOString(),
        "url=",
        req.originalUrl
      );

      const rawBody = req.body as any;

      // If bodyParser.json ran before this route -> rawBody won't be Buffer -> signature fails
      if (!Buffer.isBuffer(rawBody)) {
        console.error("[RZP_WEBHOOK][FATAL] req.body is not Buffer.");
        console.error(
          "[RZP_WEBHOOK][FIX] Mount /api/razorpay BEFORE bodyParser.json() in server.ts"
        );
        return res
          .status(400)
          .send("webhook misconfigured: raw body not available");
      }

      const event = JSON.parse(rawBody.toString("utf8"));
      const payload = event?.payload;

      console.log("[RZP_WEBHOOK][INCOMING]", {
        event: event?.event,
        hasSig: !!sig,
      });

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
      const isPaidEvent = event?.event === "payment_link.paid";

      if (!isPaidEvent) {
        console.log("[RZP_WEBHOOK][SKIP] Not a paid event:", event?.event);
        return res.status(200).send("ok");
      }

      // 1) Identify order + org
      let order_id: string | null = null;
      let org_id: string | null = null;

      // Pattern B: org:<org>:order:<id>
      if (
        ref &&
        String(ref).includes("org:") &&
        String(ref).includes(":order:")
      ) {
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

      const ok = verifyRazorpayWebhookSignature(
        rawBody,
        sig,
        org.razorpay_webhook_secret
      );
      console.log("[RZP_WEBHOOK][SIG_VERIFY]", { ok });

      if (!ok) return res.status(400).send("bad signature");

      // 3) Mark paid (idempotent)
      const paymentId =
      payload?.payment?.entity?.id ||
      payload?.payment_link?.entity?.payments?.[0]?.payment_id ||
      null;
    
    const { data: updatedOrders, error: updErr } = await supa
      .from("orders")
      .update({
        payment_provider: "razorpay",
        payment_mode: "online",
        payment_status: "paid",
        paid_at: new Date().toISOString(),
    
        // ✅ only after paid
        status: "awaiting_store_action",
    
        // optional if you have this column already
        razorpay_payment_id: paymentId,
      } as any)
      .eq("id", order_id)
      .eq("org_id", org_id)
    
      // ✅ THIS IS THE KEY GUARD
      .eq("status", "awaiting_customer_action")
    
      // keep idempotent
      .neq("payment_status", "paid")
      .select("id, source_phone, items, total_amount, delivery_type, created_at, currency_code");

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

      // 🔔 Notify dashboard now (status moved to awaiting_store_action)
      try {
        emitNewOrder(org_id, {
          id: paidOrder.id,
          org_id,
          source_phone: paidOrder.source_phone,
          status: "awaiting_store_action",
          created_at: paidOrder.created_at,
          total_amount: paidOrder.total_amount ?? null,
          items: paidOrder.items ?? [],
        });
      } catch (e) {
        console.warn("[RZP_WEBHOOK][SSE_EMIT_ERR]", e);
      }

      // 4) Load org WA config + store details (ONLY columns that exist in your orgs table)
      const { data: orgRow, error: orgRowErr } = await supa
        .from("orgs")
        .select(
          [
            "wa_phone_number_id",
            "wa_access_token",
            "store_address_text",
            "store_address",
            "store_lat",
            "store_lng",
            "phone",
            "store_timezone",
          ].join(",")
        )
        .eq("id", org_id)
        .maybeSingle();

      console.log("[RZP_WEBHOOK][ORG_ROW_RAW]", {
        org_id,
        orgRowErr: orgRowErr?.message || null,
        has_orgRow: !!orgRow,
        orgRow_keys: orgRow ? Object.keys(orgRow) : [],
        wa_phone_number_id: (orgRow as any)?.wa_phone_number_id || null,
        wa_access_token_len: ((orgRow as any)?.wa_access_token || "").length,
      });

      // If orgRow query failed -> stop (otherwise WA_CONFIG_MISSING becomes misleading)
      if (orgRowErr || !orgRow) {
        console.error("[RZP_WEBHOOK][ORG_LOAD_FAILED]", {
          org_id,
          message: orgRowErr?.message || "orgRow null",
        });
        return res.status(200).send("ok");
      }

      const wa_phone_number_id = (orgRow as any).wa_phone_number_id || null;
      const wa_access_token = (orgRow as any).wa_access_token || null;

      const storeAddress =
        (orgRow as any)?.store_address_text ||
        (orgRow as any)?.store_address ||
        null;

      const storePhone = (orgRow as any)?.phone || null;

      const lat = (orgRow as any)?.store_lat;
      const lng = (orgRow as any)?.store_lng;
      const mapsUrl =
        lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : null;

      // Optional order summary
      let summary = "";
      if (Array.isArray(paidOrder?.items) && paidOrder.items.length > 0) {
        const lines: string[] = [];
        for (const it of paidOrder.items) {
          const name = it?.name || "Item";
          const variant = it?.variant ? ` (${it.variant})` : "";
          const qty = Number(it?.qty) || 0;
          const price = Number(it?.price) || 0;
          if (qty > 0)
            lines.push(
              `• ${name}${variant} x ${qty}${price ? ` — ₹${qty * price}` : ""}`
            );
        }
        const total =
          paidOrder?.total_amount != null
            ? `\n💰 Total: ₹${Number(paidOrder.total_amount).toFixed(0)}\n`
            : "";
        summary = lines.length
          ? `🧾 *Order Summary*\n${lines.join("\n")}${total}\n`
          : "";
      }

      const msg =
        "✅ *Payment received!*\n\n" +
        `Your order *#${order_id}* is confirmed for *Store Pickup*.\n\n` +
        (summary ? summary + "\n" : "") +
        (storeAddress ? `📍 Address: ${storeAddress}\n` : "") +
        (mapsUrl ? `🗺 Map: ${mapsUrl}\n` : "") +
        (storePhone ? `📞 Contact: ${storePhone}\n` : "") +
        "\nShow this message at pickup. Thanks!";

      // 5) Send WhatsApp message
      if (!phone) {
        console.warn("[RZP_WEBHOOK][NO_PHONE] Cannot send WhatsApp message");
        return res.status(200).send("ok");
      }

      if (!wa_phone_number_id || !wa_access_token) {
        console.warn("[RZP_WEBHOOK][WA_CONFIG_MISSING]", {
          org_id,
          wa_phone_number_id: !!wa_phone_number_id,
          wa_access_token: !!wa_access_token,
        });
        return res.status(200).send("ok");
      }

      try {
        console.log("[RZP_WEBHOOK][WA_SEND_ATTEMPT]", {
          org_id,
          order_id,
          to: phone,
          wa_phone_number_id,
          token_len: (wa_access_token || "").length,
        });

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

        // 6) Clear conversation state ONLY after WA send success
        await supa
          .from("ai_conversation_state")
          .delete()
          .eq("org_id", org_id)
          .eq("customer_phone", phone);

        console.log("[RZP_WEBHOOK][STATE_CLEARED]", { org_id, phone });
      } catch (e: any) {
        console.error("[RZP_WEBHOOK][WA_SEND_ERR]", {
          status: e?.response?.status,
          data: e?.response?.data,
          message: e?.message,
        });
      }

      return res.status(200).send("ok");
    } catch (e: any) {
      console.error("[RZP_WEBHOOK_ERR]", e?.message || e);
      return res.status(200).send("ok");
    }
  }
);
