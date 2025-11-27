import { supa } from "../../db";
import { sendWabaText } from "../../routes/waba";
import { setConversationStage } from "../../util/conversationState";
import { prettyLabelFromText } from "../../routes/waba/productInquiry";
import { detectAddress } from "../../ai/address"; // ⬅️ NEW
import { recordAliasConfirmation } from "./aliasEngine";
import { computeOrderTotals } from "../ingestCore"; // ⬅️ adjust path if needed

export type VariantChoice = {
  index: number; // item index in order.items
  label: string; // canonical/name (e.g. "Onion")
  variants: string[];
};

export type UserCommand =
  | "new"
  | "cancel"
  | "update"
  | "agent"
  | "address_done"
  | "cancel_select"
  | "cancel_pending"
  | "repeat"
  | null;

const WABA_DEBUG = process.env.WABA_DEBUG === "1";

export const lastCommandByPhone = new Map<string, UserCommand>();

function wabaDebug(...args: any[]) {
  if (!WABA_DEBUG) return;
  console.log("[WABA-DEBUG]", ...args);
}

export async function findAllActiveOrdersForPhone(
  org_id: string,
  from_phone: string
): Promise<any[]> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, created_at")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .in("status", ["pending", "paid"])
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("[WABA][allActiveOrders err]", error.message);
      return [];
    }
    return data || [];
  } catch (e: any) {
    console.warn("[WABA][allActiveOrders catch]", e?.message || e);
    return [];
  }
}

export async function logInboundMessageToInbox(opts: {
  orgId: string;
  from: string; // customer phone (raw)
  text: string;
  msgId?: string;
}) {
  try {
    const { orgId, from, text } = opts;
    const phonePlain = normalizePhoneForKey(from); // digits only
    const phonePlus = phonePlain ? `+${phonePlain}` : "";
    // Find existing conversation by phone
    const { data: conv1 } = await supa
      .from("conversations")
      .select("id")
      .eq("org_id", orgId)
      .eq("customer_phone", phonePlain)
      .limit(1)
      .maybeSingle();

    let conversationId = conv1?.id || null;

    if (!conversationId) {
      const { data: conv2 } = await supa
        .from("conversations")
        .select("id")
        .eq("org_id", orgId)
        .eq("customer_phone", phonePlus)
        .limit(1)
        .maybeSingle();
      conversationId = conv2?.id || null;
    }
    // If still nothing, create a new conversation row
    if (!conversationId) {
      const { data: inserted, error: convErr } = await supa
        .from("conversations")
        .insert({
          org_id: orgId,
          customer_phone: phonePlain,
          customer_name: null,
          source: "waba",
          last_message_at: new Date().toISOString(),
          last_message_preview: text.slice(0, 120),
        })
        .select("id")
        .single();

      if (convErr) {
        console.warn("[INBOX][inbound conv insert err]", convErr.message);
        return;
      }
      conversationId = inserted.id;
    } else {
      // bump preview if conv exists
      await supa
        .from("conversations")
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: text.slice(0, 120),
        })
        .eq("id", conversationId)
        .eq("org_id", orgId);
    }

    // Insert inbound message row
    await supa.from("messages").insert({
      org_id: orgId,
      conversation_id: conversationId,
      direction: "in",
      sender_type: "customer",
      channel: "waba",
      body: text,
      wa_msg_id: opts.msgId || null,
    });
  } catch (e: any) {
    console.warn("[INBOX][inbound log err]", e?.message || e);
  }
}



export async function findActiveOrderForPhoneExcluding(
  org_id: string,
  from_phone: string,
  excludeOrderId: string
): Promise<any | null> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, created_at")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .neq("id", excludeOrderId)
      .in("status", ["pending", "paid"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[WABA][activeOrderExcl err]", error.message);
      return null;
    }
    return data || null;
  } catch (e: any) {
    console.warn("[WABA][activeOrderExcl catch]", e?.message || e);
    return null;
  }
}

export function looksLikeAddToExisting(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("add ")) return true;
  if (lower.includes("add on")) return true;
  if (lower.includes("add one more")) return true;
  if (lower.includes("also")) return true;
  if (lower.includes("too")) return true;
  if (lower.includes("more")) return true;
  if (lower.includes("extra")) return true;
  return false;
}

export async function findActiveOrderForPhone(
  org_id: string,
  from_phone: string
): Promise<any | null> {
  try {
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, created_at")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone)
      .in("status", ["pending", "paid"]) // treat shipped as closed
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[WABA][activeOrder err]", error.message);
      return null;
    }
    return data || null;
  } catch (e: any) {
    console.warn("[WABA][activeOrder catch]", e?.message || e);
    return null;
  }
}

export async function isAutoReplyEnabledForCustomer(opts: {
  orgId: string;
  phoneRaw: string;
  orgAutoReplyEnabled: boolean;
}): Promise<boolean> {
  const { orgId, phoneRaw, orgAutoReplyEnabled } = opts;

  // 1) Org-level master switch
  if (!orgAutoReplyEnabled) return false;

  const phoneKey = normalizePhoneForKey(phoneRaw);
  if (!phoneKey) return true; // default ON if we can't normalise

  try {
    const { data, error } = await supa
      .from("org_customer_settings")
      .select("auto_reply_enabled")
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey)
      .maybeSingle();

    if (error) {
      console.warn("[WABA][cust auto-reply lookup err]", error.message);
      return true; // fail-open
    }

    if (!data || typeof data.auto_reply_enabled !== "boolean") {
      return true; // no override row → default ON
    }

    return data.auto_reply_enabled;
  } catch (e: any) {
    console.warn("[WABA][cust auto-reply catch]", e?.message || e);
    return true;
  }
}

export function normalizeAliasText(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function learnAliasFromInquiry(opts: {
  org_id: string;
  from_phone: string;
  text: string;
  result: any;
}) {
  const { org_id, from_phone, text, result } = opts;

  try {
    // Heuristic: only learn when NLU is confident and we have a clear product id
    const confidence =
      typeof result.confidence === "number" ? result.confidence : 1.0;

    if (
      result.kind !== "inquiry" ||
      confidence < 0.8
    ) {
      return;
    }

    // You may already be returning product_id in result — adapt this as needed.
    const productId =
      (result.inquiry_product_id as string) ||
      (result.product_id as string) ||
      null;

    if (!productId) return;

    // "wrong" text: best-effort from reason or text
    // e.g. reason = "inq:availability:panner biriyani"
    let wrongText = "";
    if (typeof result.alias_raw === "string") {
      wrongText = result.alias_raw;
    } else if (typeof result.reason === "string") {
      const m = result.reason.match(/^inq:[^:]+:(.+)$/i);
      if (m && m[1]) wrongText = m[1];
    }

    if (!wrongText) {
      wrongText = text;
    }

    await recordAliasConfirmation({
      org_id,
      customer_phone: from_phone,
      wrong_text: wrongText,
      canonical_product_id: productId,
      confidence,
    });
  } catch (e: any) {
    console.warn("[learnAliasFromInquiry err]", e?.message || e);
  }
}

export function extractCanonicalFromReason(
  reason: string | null | undefined
): string | null {
  if (!reason) return null;
  const m = String(reason).match(/^inq:[^:]+:(.+)$/i);
  if (m && m[1]) {
    return m[1].trim();
  }
  return null;
}

export function itemsToOrderText(items: any[]): string {
  return (items || [])
    .map((it: any) => {
      const qty = it.qty ?? 1;
      const unit = it.unit ? String(it.unit).trim() : "";
      const name = String(it.canonical || it.name || "").trim();
      const variant = it.variant ? String(it.variant).trim() : "";
      if (!name) return "";

      const qtyPart = unit ? `${qty}${unit}` : `${qty}`;
      const variantPart = variant ? ` ${variant}` : "";
      return `${qtyPart} ${name}${variantPart}`.trim();
    })
    .filter(Boolean)
    .join(", ");
}

export function buildClarifyQuestionText(choice: VariantChoice): string {
  const pretty = choice.label;
  return (
    "Thanks! Just need a quick confirmation:\n" +
    `• ${pretty}: which one do you prefer? (${choice.variants.join(", ")})`
  );
}

export async function startAddressSessionForOrder(opts: {
  org_id: string;
  order_id: string;
  from_phone: string;
}) {
  const { org_id, order_id, from_phone } = opts;
  const phoneKey = normalizePhoneForKey(from_phone);

  // close prior sessions
  await supa
    .from("order_clarify_sessions")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("org_id", org_id)
    .eq("customer_phone", phoneKey)
    .eq("status", "open");

  const { error } = await supa.from("order_clarify_sessions").insert({
    org_id,
    order_id,
    customer_phone: phoneKey,
    status: "open",
    current_index: -1, // SPECIAL: -1 = waiting for address
  });

  // L9: mark stage as waiting for address
  await setConversationStage(org_id, from_phone, "awaiting_address", {
    active_order_id: order_id,
    last_action: "ask_address",
  });

  if (error) {
    console.warn("[WABA][address session insert err]", error.message);
  }
}

export function normalizePhoneForKey(raw: string): string {
  return String(raw || "").replace(/[^\d]/g, "");
}

export function formatOrderSummary(items: any[]): string {
  const lines = (items || []).map((it: any) => {
    const qty = it.qty ?? 1;
    const unit = it.unit ? ` ${it.unit}` : "";
    const name = it.canonical || it.name || "item";
    const brand = it.brand ? ` · ${it.brand}` : "";
    const variant = it.variant ? ` · ${it.variant}` : "";
    return `* ${qty}${unit} ${name}${brand}${variant}`.trim();
  });
  return lines.join("\n");
}

function looksLikeOrderLineText(raw: string): boolean {
  const text = (raw || "").toLowerCase().trim();

  if (!text) return false;

  // Has a number (1, 2, 3…)
  const hasNumber = /\d/.test(text);

  // Has common units / item markers
  const hasUnit =
    /kg|g|gram|gm|ml|ltr|liter|litre|piece|pc|pcs|pack|plate|bottle|box|dozen/i.test(
      text
    );

  // Has a comma-separated list (often "1kg onion, 2L milk")
  const hasCommaList = text.includes(",");

  // If it has a number and a typical unit OR comma list,
  // it's *very* likely to be items, not an address.
  if ((hasNumber && hasUnit) || hasCommaList) return true;

  return false;
}

export async function hasAddressForOrder(
  org_id: string,
  from_phone: string,
  order_id: string
): Promise<boolean> {
  // 1) Prefer checking the order itself
  try {
    const { data: orderRow, error: orderErr } = await supa
      .from("orders")
      .select("shipping_address")
      .eq("id", order_id)
      .single();

    if (!orderErr && orderRow) {
      const addr = (orderRow as any).shipping_address;
      if (addr && String(addr).trim().length > 0) {
        return true;
      }
    }
  } catch (e: any) {
    console.warn("[WABA][hasAddress order check err]", e?.message || e);
  }

  // 2) Fallback: legacy session-based check
  try {
    const phoneKey = normalizePhoneForKey(from_phone);

    const { data, error } = await supa
      .from("order_clarify_sessions")
      .select("id")
      .eq("org_id", org_id)
      .eq("customer_phone", phoneKey)
      .eq("status", "address_done")
      .limit(1);

    if (error) {
      console.warn("[WABA][hasAddress err]", error.message);
      return false;
    }
    return !!(data && data.length);
  } catch (e: any) {
    console.warn("[WABA][hasAddress catch]", e?.message || e);
    return false;
  }
}

export async function findAmbiguousItemsForOrder(
  org_id: string,
  items: any[]
): Promise<VariantChoice[]> {
  const out: VariantChoice[] = [];
  const seenCanon = new Set<string>();

  for (let i = 0; i < (items || []).length; i++) {
    const it = items[i] || {};
    const labelRaw = String(it.canonical || it.name || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!labelRaw) continue;

    const canonKey = labelRaw.toLowerCase();
    if (seenCanon.has(canonKey)) continue;
    seenCanon.add(canonKey);

    const { data, error } = await supa
      .from("products")
      .select("canonical, variant")
      .eq("org_id", org_id)
      .ilike("canonical", labelRaw); // case-insensitive

    if (error) {
      console.warn("[WABA][ambig products err]", error.message);
      continue;
    }

    const unique = Array.from(
      new Set(
        (data || [])
          .map((r: any) => String(r?.variant || "").trim())
          .filter(Boolean)
      )
    );

    if (unique.length >= 2) {
      out.push({
        index: i,
        label: labelRaw,
        variants: unique,
      });
    }
  }

  return out;
}

export async function maybeHandleClarifyReply(opts: {
  org_id: string;
  phoneNumberId: string;
  from: string;
  text: string;
  needsAddress?: boolean;
}): Promise<boolean> {
  const { org_id, phoneNumberId, from, text, needsAddress = true } = opts;
  const phoneKey = normalizePhoneForKey(from);
  const lower = text.toLowerCase().trim();

  // Look up latest open session
  const { data: session, error: sessErr } = await supa
    .from("order_clarify_sessions")
    .select("id, order_id, current_index, status")
    .eq("org_id", org_id)
    .eq("customer_phone", phoneKey)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sessErr) {
    console.warn("[WABA][clarify session err]", sessErr.message);
    return false;
  }
  if (!session) return false;

  // Escape hatch during clarify / address flow
  if (/cancel|ignore previous|new order/i.test(lower)) {
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    await sendWabaText({
      phoneNumberId,
      to: from,
      text: "No problem 👍 You can send a new order whenever you’re ready.",
      orgId: org_id,
    });

    return true;
  }

  if (/talk to agent|talk to human/i.test(lower)) {
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "👨‍💼 Okay, we’ll connect you to a store agent.\n" +
        "Please wait a moment — a human will reply.",
      orgId: org_id,
    });

    return true;
  }

  // ─────────────────────────────
  // ADDRESS STAGE (current_index = -1)
  // ─────────────────────────────
  if (session.current_index === -1) {
    // 1) Tiny acks like "ok", "thanks" should NOT be treated as address
    const ackTokens = lower
      .replace(/[^a-z0-9\s]/gi, " ")
      .split(/\s+/)
      .filter(Boolean);
    const tinyAckSet = new Set([
      "ok",
      "okay",
      "k",
      "kk",
      "thanks",
      "thank",
      "thankyou",
      "thx",
      "tnx",
      "no",
      "yes",
      "yup",
      "ya",
      "yeah",
    ]);
    const isTinyAck =
      ackTokens.length > 0 && ackTokens.every((t) => tinyAckSet.has(t));

    if (isTinyAck) {
      await sendWabaText({
        phoneNumberId,
        to: from,
        orgId: org_id,
        text:
          "👍 Got it.\nPlease send your full delivery address in one message (building, street, area) so we can complete your order.",
      });
      // keep session OPEN, do NOT save address
      return true;
    }

    // 2) If message clearly looks like more items → let main handler treat it as order lines
    if (looksLikeOrderLineText(text)) {
      wabaDebug("[WABA][ADDRESS GUARD] looks like items, not address", {
        org_id,
        order_id: session.order_id,
        customer: from,
        text,
      });

      await sendWabaText({
        phoneNumberId,
        to: from,
        orgId: org_id,
        text:
          "Looks like you’re adding more items 👍\n" +
          "I’ll add these to your order.\n" +
          "After that, please send your delivery address in a separate message.",
      });

      // Returning false → goes back to main flow and parses this as items
      return false;
    }

    // 3) Run Address AI
    let addrResult: Awaited<ReturnType<typeof detectAddress>> | null = null;
    try {
      addrResult = await detectAddress(text);
    } catch (e: any) {
      console.warn("[WABA][address AI error]", e?.message || e);
    }

    const isAiAddress =
      addrResult &&
      addrResult.is_address &&
      (addrResult.confidence ?? 0) >= 0.6;

    if (!isAiAddress) {
      // Not confident → ask for clearer address (don't save)
      await sendWabaText({
        phoneNumberId,
        to: from,
        orgId: org_id,
        text:
          "I’m not fully sure this is a complete delivery address.\n" +
          "Please send building name/number, street/area and city in one message.",
      });
      return true;
    }

    const normalized = addrResult!.normalized || text.trim();

    // 4) Save address on the order
    try {
      await supa
        .from("orders")
        .update({ shipping_address: normalized })
        .eq("id", session.order_id);
    } catch (e: any) {
      console.warn("[WABA][address save err]", e?.message || e);
    }

    // 5) Mark session as address_done
    // 5) Mark session as address_done
    await supa
      .from("order_clarify_sessions")
      .update({
        status: "address_done",
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id);

    lastCommandByPhone.set(from, "address_done");

    await setConversationStage(org_id, from, "building_order", {
      active_order_id: session.order_id,
      last_action: "address_captured_ai",
    });

    // 6) Build smart confirmation: order summary + ETA + total
    let summaryText = "";
    try {
      const { data: orderRow, error: orderErr } = await supa
        .from("orders")
        .select("id, items")
        .eq("id", session.order_id)
        .single();

      if (!orderErr && orderRow && Array.isArray(orderRow.items)) {
        const { subtotal, lines } = computeOrderTotals(orderRow.items);

        // TODO: later read from org settings; for now hard-code 60 mins
        const etaMinutes = 60;
        const etaText = etaMinutes
          ? `⏰ Estimated delivery: ~${etaMinutes} minutes.\n`
          : "";

        const summaryBlock =
          lines.length > 0
            ? `\n\n🧾 *Order summary:*\n` + lines.join("\n")
            : "";

        const totalBlock =
          subtotal > 0
            ? `\n\n💰 *Estimated total*: ₹${Math.round(subtotal)}`
            : "";

        summaryText =
          "\n\n✅ Your order is now confirmed.\n" +
          etaText +
          summaryBlock +
          totalBlock;
      }
    } catch (e: any) {
      console.warn("[WABA][address summary err]", e?.message || e);
      // If anything fails, we just fallback to simple "got address" text below
    }

    await sendWabaText({
      phoneNumberId,
      to: from,
      orgId: org_id,
      text:
        "📍 Got your address:\n" +
        normalized +
        summaryText +
        "\n\nIf anything is wrong, please send the correct address or changes.",
    });

    return true;
  }

  // ──────────────────────
  // ITEM VARIANT CLARIFY STAGE
  // ──────────────────────
  const { data: orderRow, error: orderErr } = await supa
    .from("orders")
    .select("id, items")
    .eq("id", session.order_id)
    .single();

  if (orderErr || !orderRow) {
    console.warn("[WABA][clarify reply] order not found", orderErr?.message);

    // Close the stale session and LET the main handler treat this
    // as a fresh message (no confusing error to customer)
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    return false;
  }

  const order: any = orderRow;
  const items: any[] = order.items || [];
  if (
    !Array.isArray(items) ||
    session.current_index < 0 ||
    session.current_index >= items.length
  ) {
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "Sorry, something went wrong with that confirmation. " +
        "Please send your order again.",
      orgId: org_id,
    });
    return true;
  }

  const currentIndex = session.current_index;
  const currentItem = items[currentIndex] || {};
  const labelRaw = String(
    currentItem.canonical || currentItem.name || ""
  ).trim();
  const labelKey = labelRaw.toLowerCase();

  // Load variants for this item
  const { data: productRows, error: prodErr } = await supa
    .from("products")
    .select("canonical, variant")
    .eq("org_id", org_id)
    .ilike("canonical", labelRaw);

  if (prodErr) {
    console.warn("[WABA][clarify reply products err]", prodErr.message);
  }
  const variants = Array.from(
    new Set(
      (productRows || [])
        .map((r: any) => String(r?.variant || "").trim())
        .filter(Boolean)
    )
  );

  if (!variants.length) {
    // nothing to choose, stop clarify and fall back to manual
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "Got your message 👍 We’ll adjust the order manually for this item " +
        "and continue processing.",
      orgId: org_id,
    });
    return true;
  }

  // Try to match answer to one of the variants
  const answer = lower;
  let chosen: string | null = null;

  for (const v of variants) {
    const vLower = v.toLowerCase();
    if (answer === vLower || answer.includes(vLower)) {
      chosen = v;
      break;
    }
  }

  if (!chosen) {
    const optionsStr = variants.join(" / ");
    await sendWabaText({
      phoneNumberId,
      to: from,
      text: `Sorry, I didn’t catch that. Please reply with one of: ${optionsStr}`,
      orgId: org_id,
    });
    return true;
  }

  // Update variant in order items
  items[currentIndex] = {
    ...currentItem,
    variant: chosen,
  };

  const { error: updErr } = await supa
    .from("orders")
    .update({ items })
    .eq("id", order.id);

  if (updErr) {
    console.warn("[WABA][clarify reply update err]", updErr.message);
    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "I couldn’t update that item just now. " +
        "We’ll adjust it manually and confirm your order.",
      orgId: org_id,
    });
    return true;
  }

  // Check if more ambiguous items remain (still without variant)
  const remainingChoices = await findAmbiguousItemsForOrder(org_id, items);
  const stillAmbiguous = remainingChoices.filter((c) => {
    const it = items[c.index];
    return !it || !it.variant;
  });

  if (!stillAmbiguous.length) {
    // All clarified → close clarify session
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    const summary = formatOrderSummary(items);

    // Should this org ask for address at all?
    if (!needsAddress) {
      const finalText = "✅ Order confirmed:\n" + summary;

      // L9: post_order, no address needed
      await setConversationStage(org_id, from, "post_order", {
        active_order_id: order.id,
        last_action: "clarify_done_no_address",
      });

      await sendWabaText({
        phoneNumberId,
        to: from,
        text: finalText,
        orgId: org_id,
      });

      return true;
    }

    // Check if customer already provided address (any previous address_done)
    const alreadyHasAddress = await hasAddressForOrder(org_id, from, order.id);

    if (alreadyHasAddress) {
      const finalText = "✅ Updated order:\n" + summary;

      // L9: order fully known + address present → post_order
      await setConversationStage(org_id, from, "post_order", {
        active_order_id: order.id,
        last_action: "clarify_done_address_already",
      });

      await sendWabaText({
        phoneNumberId,
        to: from,
        text: finalText,
        orgId: org_id,
      });

      return true;
    }

    // If no address yet → open address session ONCE
    await startAddressSessionForOrder({
      org_id,
      order_id: order.id,
      from_phone: from,
    });

    const finalText =
      "✅ Order confirmed:\n" +
      summary +
      "\n\n📍 Please share your delivery address (or send location) if you haven’t already.";

    await sendWabaText({
      phoneNumberId,
      to: from,
      text: finalText,
      orgId: org_id,
    });

    return true;
  }

  // Move to next item and ask again
  const next = stillAmbiguous[0];
  await supa
    .from("order_clarify_sessions")
    .update({
      current_index: next.index,
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  const prettyCurrent = labelRaw || labelKey || "item";
  const confirmLine = `Got it: ${prettyCurrent} → ${chosen} ✅`;
  const nextQuestion = buildClarifyQuestionText(next);

  await sendWabaText({
    phoneNumberId,
    to: from,
    text: `${confirmLine}\n\n${nextQuestion}`,
    orgId: org_id,
  });

  return true;
}