// src/payments/razorpay.ts
import axios from "axios";
import crypto from "crypto";
import { supa } from "../db";

type OrgRzp = {
  razorpay_key_id: string | null;
  razorpay_key_secret: string | null;
  razorpay_webhook_secret: string | null;
  razorpay_enabled?: boolean | null;
};

function maskKeyId(keyId: string | null) {
  if (!keyId) return null;
  const last = keyId.slice(-6);
  return `***${last}`;
}

export async function getOrgRazorpay(org_id: string): Promise<OrgRzp> {
  const { data, error } = await supa
    .from("orgs")
    .select(
      "razorpay_key_id, razorpay_key_secret, razorpay_webhook_secret, razorpay_enabled"
    )
    .eq("id", org_id)
    .maybeSingle();

  if (error || !data) {
    console.warn("[RZP][ORG_FETCH_FAIL]", { org_id, error: error?.message });
    return {
      razorpay_key_id: null,
      razorpay_key_secret: null,
      razorpay_webhook_secret: null,
      razorpay_enabled: null,
    };
  }

  const row = data as any;
  console.log("[RZP][ORG_FETCH_OK]", {
    org_id,
    enabled: !!row.razorpay_enabled,
    key_id: maskKeyId(row.razorpay_key_id),
    has_secret: !!row.razorpay_key_secret,
    has_webhook_secret: !!row.razorpay_webhook_secret,
  });

  return row as OrgRzp;
}

export async function createRazorpayPaymentLink(opts: {
  org_id: string;
  order_id: string;
  amount_inr: number; // rupees
  customer_phone: string;
  customer_name?: string;
  customer_email?: string;
}): Promise<{ id: string; short_url: string }> {
  const org = await getOrgRazorpay(opts.org_id);

  if (!org.razorpay_key_id || !org.razorpay_key_secret) {
    console.error("[RZP][NOT_CONFIGURED]", {
      org_id: opts.org_id,
      key_id: maskKeyId(org.razorpay_key_id),
      has_secret: !!org.razorpay_key_secret,
    });
    throw new Error("Razorpay not configured for this business.");
  }

  const amount_paise = Math.round(Number(opts.amount_inr) * 100);

  // ✅ Razorpay constraint: reference_id length <= 40
  // UUID is 36 chars, so safest is to use order_id directly.
  const reference_id = String(opts.order_id);

  const callback_url = process.env.APP_PUBLIC_URL
    ? `${process.env.APP_PUBLIC_URL.replace(/\/$/, "")}/payment/razorpay/return`
    : null;

  const payload: any = {
    amount: amount_paise,
    currency: "INR",
    description: `KartoOrder payment for order #${opts.order_id}`,
    reference_id,
    customer: {
      contact: opts.customer_phone,
      name: opts.customer_name || "Customer",
      email: opts.customer_email || undefined,
    },
    notify: { sms: true, email: false },
    reminder_enable: true,
    // Helpful for debugging (not used for signature)
    notes: {
      org_id: opts.org_id,
      order_id: opts.order_id,
      product: "kartorder",
    },
  };

  if (callback_url) {
    payload.callback_url = callback_url;
    payload.callback_method = "get";
  }

  console.log("[RZP][CREATE_LINK][REQ]", {
    org_id: opts.org_id,
    order_id: opts.order_id,
    amount_inr: opts.amount_inr,
    amount_paise,
    reference_id,
    callback_url,
    key_id: maskKeyId(org.razorpay_key_id),
  });

  try {
    const res = await axios.post(
      "https://api.razorpay.com/v1/payment_links",
      payload,
      {
        auth: {
          username: org.razorpay_key_id,
          password: org.razorpay_key_secret,
        },
      }
    );

    console.log("[RZP][CREATE_LINK][OK]", {
      org_id: opts.org_id,
      order_id: opts.order_id,
      rzp_id: res.data?.id,
      short_url: res.data?.short_url,
      status: res.data?.status,
    });

    if (!res.data?.id || !res.data?.short_url) {
      console.error("[RZP][CREATE_LINK][BAD_RESPONSE]", {
        org_id: opts.org_id,
        order_id: opts.order_id,
        keys: Object.keys(res.data || {}),
      });
      throw new Error("Razorpay returned unexpected response.");
    }

    return { id: res.data.id, short_url: res.data.short_url };
  } catch (err: any) {
    const status = err?.response?.status;
    const data = err?.response?.data;

    console.error("[RZP][CREATE_LINK][ERR]", {
      org_id: opts.org_id,
      order_id: opts.order_id,
      status,
      data,
      message: err?.message,
    });

    throw err;
  }
}

export function verifyRazorpayWebhookSignature(
  rawBody: Buffer,
  signature: string,
  webhookSecret: string
) {
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  const ok = expected === signature;

  console.log("[RZP][WEBHOOK][SIG]", {
    ok,
    sig_len: signature?.length || 0,
    body_len: rawBody?.length || 0,
  });

  return ok;
}