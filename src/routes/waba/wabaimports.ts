import { supa } from "../../db";
import { META_WA_BASE } from "../waba";
import { UserCommand } from "./clarifyAddress"
import axios from "axios";
import { prettyLabelFromText } from "./productInquiry";

export async function logFlowEvent(opts: {
    orgId: string;
    from?: string;
    event: string;
    msgId?: string;
    orderId?: string | null;
    text?: string | null;
    result?: any;
    meta?: any;
  }) {
    try {
      await supa.from("waba_flow_logs").insert({
        org_id: opts.orgId,
        customer_phone: opts.from || null,
        event: opts.event,
        msg_id: opts.msgId || null,
        order_id: opts.orderId || null,
        text: opts.text || null,
        result: opts.result ?? null,
        meta: opts.meta ?? null,
        source: "waba",
      });
    } catch (e: any) {
      console.warn("[WABA][FLOW_LOG_ERR]", e?.message || e);
    }
  }


  export function detectUserCommand(text: string): UserCommand {
    const lower = text.toLowerCase().trim();
  
    // keep these fairly strict to avoid colliding with normal sentences
    if (
      lower === "new" ||
      lower === "new order" ||
      lower.startsWith("start new order")
    ) {
      return "new";
    }
    if (
      lower === "cancel" ||
      lower === "cancel order" ||
      lower.startsWith("cancel my order")
    ) {
      return "cancel";
    }
    if (
      lower === "update" ||
      lower === "update order" ||
      lower.startsWith("edit order") ||
      lower.startsWith("modify order")
    ) {
      return "update";
    }
    if (
      lower === "agent" ||
      lower === "talk to agent" ||
      lower === "talk to human" ||
      lower === "human" ||
      lower === "support" ||
      lower === "customer care"
    ) {
      return "agent";
    }
  
    if (
      lower === "repeat" ||
      lower === "repeat order" ||
      lower === "repeat last order" ||
      lower.includes("same as last time") ||
      lower.includes("same as yesterday") ||
      lower.includes("same order") ||
      lower.includes("same items")
    ) {
      return "repeat";
    }
  
    return null;
  }




  // ─────────────────────────────
// Send via Cloud API + log to inbox
// ─────────────────────────────
export async function sendWabaText(opts: {
  phoneNumberId: string;
  to: string;
  text?: string;
  image?: string; // <── NEW
  caption?: string; // <── NEW
  orgId?: string;
}) {
  const token = process.env.WA_ACCESS_TOKEN || process.env.META_WA_TOKEN;
  if (!token) {
    console.warn("[WABA] WA_ACCESS_TOKEN missing, cannot send reply");
    return;
  }

  const toNorm = opts.to.startsWith("+") ? opts.to : `+${opts.to}`;

  console.log("[FLOW][OUTGOING]", {
    org_id: opts.orgId || null,
    to: toNorm,
    phoneNumberId: opts.phoneNumberId,
    text: opts.text || null,
    image: opts.image || null,
  });

  // -------------------------------------------
  // 🚀 1) SEND IMAGE (NEW)
  // -------------------------------------------
  let payload: any;

  if (opts.image) {
    payload = {
      messaging_product: "whatsapp",
      to: toNorm,
      type: "image",
      image: {
        link: opts.image, // direct URL
        caption: opts.caption || opts.text || "",
      },
    };
  } else {
    // -------------------------------------------
    // 🚀 2) FALLBACK → TEXT (EXACT OLD LOGIC)
    // -------------------------------------------
    payload = {
      messaging_product: "whatsapp",
      to: toNorm,
      type: "text",
      text: { body: opts.text || "" },
    };
  }

  try {
    const resp = await axios.post(
      `${META_WA_BASE}/${opts.phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    // ------------------------------------------------
    // FLOW LOG (unchanged)
    // ------------------------------------------------
    if (opts.orgId) {
      try {
        await logFlowEvent({
          orgId: opts.orgId,
          from: toNorm.replace(/^\+/, ""),
          event: "auto_reply_sent",
          msgId:
            resp.data?.messages && resp.data.messages[0]?.id
              ? String(resp.data.messages[0].id)
              : undefined,
          text: opts.text,
          meta: {
            phoneNumberId: opts.phoneNumberId,
            image: opts.image || null,
          },
        });
      } catch (e: any) {
        console.warn("[WABA][FLOW_LOG_OUT_ERR]", e?.message || e);
      }
    }

    // ------------------------------------------------
    // INBOX MESSAGE LOGGING (unchanged)
    // ------------------------------------------------
    if (opts.orgId) {
      try {
        const { data: conv } = await supa
          .from("conversations")
          .select("id")
          .eq("org_id", opts.orgId)
          .eq("customer_phone", toNorm.replace(/^\+/, ""))
          .limit(1)
          .maybeSingle();

        let convId = conv?.id || null;

        if (!convId) {
          const { data: conv2 } = await supa
            .from("conversations")
            .select("id")
            .eq("org_id", opts.orgId)
            .eq("customer_phone", toNorm)
            .limit(1)
            .maybeSingle();
          convId = conv2?.id || null;
        }

        if (convId) {
          const wa_msg_id =
            resp.data?.messages && resp.data.messages[0]?.id
              ? String(resp.data.messages[0].id)
              : null;

          const bodyToStore = opts.image
            ? `[image sent] ${opts.caption || opts.text || ""}`
            : opts.text;

          const { error: msgErr } = await supa.from("messages").insert({
            org_id: opts.orgId,
            conversation_id: convId,
            direction: "out",
            sender_type: "ai",
            channel: "waba",
            body: bodyToStore,
            wa_msg_id,
          });

          if (msgErr) {
            console.warn("[INBOX][MSG out err]", msgErr.message);
          }
        }
      } catch (e: any) {
        console.warn("[INBOX][outbound log err]", e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn("[WABA][SEND_ERR]", e?.response?.data || e?.message || e);
  }
}


  // Small helper: only ask if wrong ≠ canonical and text is not tiny
export function shouldAskAliasConfirm(wrong: string, canonical: string): boolean {
  const w = wrong.trim().toLowerCase();
  const c = canonical.trim().toLowerCase();
  if (!w || !c) return false;
  if (w === c) return false;
  if (w.length < 3) return false;
  return true;
}

  // Helper: product options + prices for a text
export type ProductPriceOption = {
  productId: string;
  name: string;
  variant: string | null;
  unit: string;
  price: number | null;
  currency: string | null;
};
export type ProductOptionsResult = {
  best: {
    id: string;
    display_name: string;
    canonical?: string | null;
    base_unit?: string | null;
  };
  options: ProductPriceOption[];
};

// For alias confirmation (per phone)
export type PendingAlias = {
  orgId: string;
  customerPhone: string; // raw WhatsApp phone (no +)
  wrongText: string;
  normalizedWrong: string;
  canonicalProductId: string;
  canonicalName: string;
};

// For soft-cancel flow (L8): phone → target order id
export const pendingSoftCancel = new Map<string, string>();



export function detectSoftCancelIntent(text: string): boolean {
    const lower = text.toLowerCase().trim();
    // Pure "stop" style
    if (
      lower === "stop" ||
      lower === "stop it" ||
      lower === "stop this" ||
      lower.startsWith("stop order") ||
      lower.startsWith("stop this order") ||
      lower.startsWith("stop my order")
    ) {
      return true;
    }
  
    // "no need" patterns
    if (
      lower.startsWith("no need") ||
      lower.includes("no need this") ||
      lower.includes("no need now")
    ) {
      return true;
    }
  
    // "don't want" patterns
    if (
      lower.startsWith("dont want") ||
      lower.startsWith("don't want") ||
      lower.includes("dont want this") ||
      lower.includes("don't want this")
    ) {
      return true;
    }
  
    // Anything containing "cancel" that is NOT the strict "cancel" command
    if (lower.includes("cancel")) {
      return true;
    }
  
    return false;
  }


  // Edit-like messages we *don’t* support in V1 (we answer safely)
export function isLikelyEditRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("change ")) return true;
  if (lower.includes("instead of")) return true;
  if (lower.includes("make it ")) return true;
  if (lower.includes("make my ")) return true;
  if (lower.includes("remove ")) return true;
  if (lower.startsWith("no ")) return true;
  if (lower.includes("reduce ")) return true;
  if (lower.includes("increase ")) return true;

  // NEW patterns for "only X", "stop adding", etc.
  if (lower.includes("only biryani") || lower.includes("only biriyani"))
    return true;
  if (lower.includes("only this")) return true;
  if (lower.includes("dont add") || lower.includes("don't add")) return true;
  if (lower.includes("no need") && lower.includes("item")) return true;
  if (lower.includes("wrong") && lower.includes("order")) return true;
  if (
    lower.includes("why are u adding") ||
    lower.includes("why are you adding")
  )
    return true;

  return false;
}


export function cleanRequestedLabel(text: string, keywords: string[]): string {
  const STOPWORDS = new Set([
    "add",
    "have",
    "want",
    "need",
    "give",
    "please",
    "hi",
    "hello",
    "can",
    "u",
    "you",
  ]);

  const labelKeywords = keywords.filter(
    (kw) => !STOPWORDS.has(kw.toLowerCase())
  );

  return (
    (labelKeywords.length
      ? labelKeywords.join(" ")
      : keywords.length
      ? keywords.join(" ")
      : ""
    ).trim() || prettyLabelFromText(text)
  );
}