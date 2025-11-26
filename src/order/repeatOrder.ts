// src/order/repeatOrder.ts
import { supa } from "../db";

/**
 * Result of "repeat last order" helper.
 */
export type RepeatOrderResult = {
  status: "ok" | "noop" | "error";
  reason: string;
  lastOrderId?: string | null;
  newOrderId?: string | null;
  items?: any[] | null;
};

/**
 * Create a NEW pending order by repeating the customer's last order.
 *
 * - Uses latest order (by created_at) for this phone
 * - Copies items + customer_name + source_phone
 * - New order has status "pending" and order_link_reason = "repeat_last_order"
 *
 * NOTE: This helper does NOT send any WhatsApp messages by itself.
 * Caller (ingestCore / WABA) decides reply & UI.
 */
export async function repeatLastOrderForCustomer(opts: {
  orgId: string;
  phoneNorm: string; // E.164 or plain digits; we will normalise
}): Promise<RepeatOrderResult> {
  const { orgId, phoneNorm } = opts;
  const org_id = String(orgId || "").trim();
  const phone = String(phoneNorm || "").trim();

  if (!org_id || !phone) {
    return {
      status: "noop",
      reason: "org_or_phone_missing",
      lastOrderId: null,
      newOrderId: null,
      items: null,
    };
  }

  const phonePlain = phone.replace(/^\+/, "");

  try {
    // 1) Find latest order for this phone (any status)
    const { data: orders, error: fetchErr } = await supa
      .from("orders")
      .select("id, items, status, source_phone, customer_name")
      .eq("org_id", org_id)
      .or(
        `source_phone.eq.${phonePlain},source_phone.eq.+${phonePlain}` // supabase OR syntax
      )
      .order("created_at", { ascending: false })
      .limit(1);

    if (fetchErr) {
      return {
        status: "error",
        reason: `fetch_last_order_error:${fetchErr.message}`,
        lastOrderId: null,
        newOrderId: null,
        items: null,
      };
    }

    const last = (orders || [])[0];
    if (!last || !last.id) {
      return {
        status: "noop",
        reason: "no_last_order_for_phone",
        lastOrderId: null,
        newOrderId: null,
        items: null,
      };
    }

    const items = Array.isArray(last.items) ? last.items : [];
    if (!items.length) {
      return {
        status: "noop",
        reason: "last_order_has_no_items",
        lastOrderId: last.id,
        newOrderId: null,
        items: null,
      };
    }

    const nowIso = new Date().toISOString();

    // 2) Insert NEW order based on last one
    const { data: created, error: insErr } = await supa
      .from("orders")
      .insert({
        org_id,
        source_phone: last.source_phone,
        customer_name: last.customer_name,
        raw_text: "[auto] repeat last order",
        items,
        status: "pending",
        created_at: nowIso,
        parse_confidence: null,
        parse_reason: `repeat_from:${last.id}`,
        msg_id: null,
        order_link_reason: "repeat_last_order",
      })
      .select("id, items")
      .single();

    if (insErr || !created) {
      return {
        status: "error",
        reason: `repeat_insert_error:${insErr?.message || "no_row"}`,
        lastOrderId: last.id,
        newOrderId: null,
        items: null,
      };
    }

    // 3) Learning writes: treat repeated items as another positive signal
    try {
      for (const it of items) {
        const canon = (it.canonical || it.name || "").toString().trim();
        if (!canon) continue;

        const brand = (it.brand ?? "") + "";
        const variant = (it.variant ?? "") + "";

        const { error: eb } = await supa.rpc("upsert_bvs", {
          p_org_id: org_id,
          p_canonical: canon,
          p_brand: brand,
          p_variant: variant,
          p_inc: 1,
        });
        if (eb) {
          console.warn("[REPEAT][bvs err]", eb.message);
        }

        const phonePlainForPrefs = phonePlain;
        if (phonePlainForPrefs) {
          const { error: ec } = await supa.rpc("upsert_customer_pref", {
            p_org_id: org_id,
            p_phone: phonePlainForPrefs,
            p_canonical: canon,
            p_brand: brand,
            p_variant: variant,
            p_inc: 1,
          });
          if (ec) {
            console.warn("[REPEAT][custpref err]", ec.message);
          }
        }
      }
    } catch (e: any) {
      console.warn("[REPEAT][learn non-fatal]", e?.message || e);
    }

    return {
      status: "ok",
      reason: "repeat_last_order",
      lastOrderId: last.id,
      newOrderId: created.id,
      items: created.items || items,
    };
  } catch (e: any) {
    return {
      status: "error",
      reason: `repeat_unexpected_error:${e?.message || e}`,
      lastOrderId: null,
      newOrderId: null,
      items: null,
    };
  }
}