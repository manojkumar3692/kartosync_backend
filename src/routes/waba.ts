// src/routes/waba.ts
import express from "express";
import axios from "axios";
import { supa } from "../db";
import { ingestCoreFromMessage } from "./ingestCore";
import { findBestProductForText, getLatestPrice } from "../util/products";

export const waba = express.Router();

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
const META_WA_BASE = "https://graph.facebook.com/v21.0";

waba.all("/ping", (_req, res) => res.json({ ok: true, where: "waba" }));

// Simple hit logger so you can confirm mount path
waba.use((req, _res, next) => {
  console.log("[WABA][ROUTER HIT]", req.method, req.path);
  next();
});

// ─────────────────────────────
// 1) Webhook verification (GET)
// ─────────────────────────────
waba.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[WABA][VERIFY]", { mode, token_ok: token === META_VERIFY_TOKEN });

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("[WABA] webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("[WABA] webhook verify failed");
  return res.sendStatus(403);
});

// ─────────────────────────────
// Helper: smart reply for price / availability inquiries
// ─────────────────────────────
async function buildSmartInquiryReply(opts: {
  org_id: string;
  text: string;
  inquiryType?: string | null;
}) {
  const { org_id, text } = opts;
  const inquiryType = (opts.inquiryType || "").toLowerCase() || null;

  const product = await findBestProductForText(org_id, text);
  if (!product) {
    if (inquiryType === "price") {
      return "💬 Got your price question. We’ll confirm the exact price shortly.";
    }
    if (inquiryType === "availability") {
      return "💬 Got your availability question. We’ll confirm stock shortly.";
    }
    return null;
  }

  if (inquiryType === "price") {
    const latest = await getLatestPrice(org_id, product.id);
    if (latest) {
      const unit = product.base_unit || "unit";
      return `💸 ${product.display_name} is currently ${latest.price} ${latest.currency} per ${unit}.`;
    }
    return `💸 We do have ${product.display_name}. Today’s price changes often — we’ll confirm it for you now.`;
  }

  if (inquiryType === "availability") {
    return `✅ Yes, we have ${product.display_name} available.`;
  }

  return null;
}

// ─────────────────────────────
// Clarify + Address + Memory helpers
// ─────────────────────────────

type VariantChoice = {
  index: number; // item index in order.items
  label: string; // canonical/name (e.g. "Onion")
  variants: string[];
};

// Normalize phone for session key
function normalizePhoneForKey(raw: string): string {
  return String(raw || "").replace(/[^\d]/g, "");
}

// Find ambiguous items (2+ variants configured) for this order
async function findAmbiguousItemsForOrder(
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

// Build a question text for one item
function buildClarifyQuestionText(choice: VariantChoice): string {
  const pretty = choice.label;
  return (
    "Thanks! Just need a quick confirmation:\n" +
    `• ${pretty}: which one do you prefer? (${choice.variants.join(", ")})`
  );
}

// Format summary list for final confirmation
function formatOrderSummary(items: any[]): string {
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

// Last-variant memory: find last chosen variant for this customer+canonical
async function getCustomerLastVariant(
  org_id: string,
  from_phone: string,
  canonical: string
): Promise<string | null> {
  try {
    const canonKey = canonical.toLowerCase().trim();

    const { data, error } = await supa
      .from("orders")
      .select("items")
      .eq("org_id", org_id)
      .eq("source_phone", from_phone) // IMPORTANT: orders.source_phone, not customer_phone
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("[WABA][lastVariant err]", error.message);
      return null;
    }
    if (!data || !data.length) return null;

    for (const row of data) {
      const items = (row as any).items || [];
      for (const it of items) {
        const labelRaw = String(it?.canonical || it?.name || "")
          .toLowerCase()
          .trim();
        if (labelRaw === canonKey && it?.variant) {
          return String(it.variant);
        }
      }
    }
    return null;
  } catch (e: any) {
    console.warn("[WABA][lastVariant catch]", e?.message || e);
    return null;
  }
}

// 🔹 check if we already captured address for this customer (any order)
// Once address_done exists for a phone, we never ask again.
async function hasAddressForOrder(
  org_id: string,
  from_phone: string,
  _order_id: string // not used anymore
): Promise<boolean> {
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

// Active open order per customer (for reference / edit decisions)
async function findActiveOrderForPhone(
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

// Active open order but excluding a specific order_id (for merge)
async function findActiveOrderForPhoneExcluding(
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

// All active orders for a phone (pending + paid), newest first
async function findAllActiveOrdersForPhone(
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

// Most recent order for a customer (ANY status)
// Used as a fallback for cancel if nothing is "active"
async function findMostRecentOrderForPhone(
    org_id: string,
    from_phone: string
  ): Promise<any | null> {
    try {
      const { data, error } = await supa
        .from("orders")
        .select("id, items, status, source_phone, created_at")
        .eq("org_id", org_id)
        .eq("source_phone", from_phone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
  
      if (error) {
        console.warn("[WABA][mostRecentOrder err]", error.message);
        return null;
      }
      return data || null;
    } catch (e: any) {
      console.warn("[WABA][mostRecentOrder catch]", e?.message || e);
      return null;
    }
  }


  function shortOrderLine(order: any, index: number): string {
    const items = (order.items || []) as any[];
    const first = items[0];
    const firstName = first
      ? (first.canonical || first.name || "item").toString()
      : "item";
    const extraCount = Math.max(items.length - 1, 0);
    const extraText = extraCount > 0 ? ` + ${extraCount} more` : "";
    return `${index}. ${firstName}${extraText}`;
  }

// Start MULTI-TURN CLARIFY session (for items)
// - applies last-variant memory first
// - returns first question text, or null if nothing to clarify.
async function startClarifyForOrder(opts: {
    org_id: string;
    order_id: string;
    from_phone: string;
  }): Promise<string | null> {
    const { org_id, order_id, from_phone } = opts;
    const phoneKey = normalizePhoneForKey(from_phone);
  
    const { data: orderRow, error: orderErr } = await supa
      .from("orders")
      .select("id, items, source_phone")
      .eq("id", order_id)
      .single();
  
    if (orderErr || !orderRow) {
      console.warn("[WABA][clarify start] order not found", orderErr?.message);
      return null;
    }
  
    let items = ((orderRow as any).items || []) as any[];
    let modified = false;
  
    // 1) Apply last variant memory
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      if (it.variant) continue;
  
      const labelRaw = String(it.canonical || it.name || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!labelRaw) continue;
  
      const lastVariant = await getCustomerLastVariant(
        org_id,
        from_phone,
        labelRaw
      );
      if (lastVariant) {
        modified = true;
        items[i] = { ...it, variant: lastVariant };
      }
    }
  
    if (modified) {
      await supa.from("orders").update({ items }).eq("id", order_id);
    }
  
    // 2) Find remaining ambiguous items
    let choices = await findAmbiguousItemsForOrder(org_id, items);
    choices = choices.filter((c) => !items[c.index].variant);
  
    if (!choices.length) return null;
  
    const first = choices[0];
  
    // Close older sessions
    await supa
      .from("order_clarify_sessions")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("org_id", org_id)
      .eq("customer_phone", phoneKey)
      .eq("status", "open");
  
    // Create new session
    await supa.from("order_clarify_sessions").insert({
      org_id,
      order_id,
      customer_phone: phoneKey,
      status: "open",
      current_index: first.index,
    });
  
    return buildClarifyQuestionText(first);
  }

// Start ADDRESS session (no more item clarifications needed)
// - next text from this customer will be treated as address, not order.
async function startAddressSessionForOrder(opts: {
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

  if (error) {
    console.warn("[WABA][address session insert err]", error.message);
  }
}

// Handle a message while clarify/address session is open
// Returns true if the message was consumed by this handler.
async function maybeHandleClarifyReply(opts: {
  org_id: string;
  phoneNumberId: string;
  from: string;
  text: string;
}): Promise<boolean> {
  const { org_id, phoneNumberId, from, text } = opts;
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

  // ──────────────────────
  // ADDRESS STAGE (current_index === -1)
  // ──────────────────────
  if (session.current_index === -1) {
    console.log("[WABA][ADDRESS CAPTURE]", {
      org_id,
      order_id: session.order_id,
      customer: from,
      address: text,
    });

    await supa
      .from("order_clarify_sessions")
      .update({ status: "address_done", updated_at: new Date().toISOString() })
      .eq("id", session.id);

      // 🔹 Mark that we JUST finished an address flow
    //    → next order-like message should be treated as "add to same order"
    lastCommandByPhone.set(from, "address_done");

    // v1: just acknowledge; optionally later we can persist address on order
    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "📍 Thanks! We’ve noted your address.\n" +
        "If you’d like to add more items, just send them here.",
      orgId: org_id,
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
  const labelRaw = String(currentItem.canonical || currentItem.name || "").trim();
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

// Check if customer already provided address (any previous address_done)
const alreadyHasAddress = await hasAddressForOrder(org_id, from, order.id);

const summary = formatOrderSummary(items);

if (alreadyHasAddress) {
// Customer has given address before → DO NOT ask again
const finalText =
  "✅ Updated order:\n" + summary;

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

// Edit-like messages we *don’t* support in V1 (we answer safely)
function isLikelyEditRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("change ")) return true;
  if (lower.includes("instead of")) return true;
  if (lower.includes("make it ")) return true;
  if (lower.includes("make my ")) return true;
  if (lower.includes("remove ")) return true;
  if (lower.startsWith("no ")) return true;
  if (lower.includes("reduce ")) return true;
  if (lower.includes("increase ")) return true;
  return false;
}

// Looks like "add more items to existing order"
function looksLikeAddToExisting(text: string): boolean {
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

// ─────────────────────────────
// Explicit user commands: NEW / CANCEL / UPDATE / AGENT
// ─────────────────────────────

type UserCommand = "new" | "cancel" | "update" | "agent" | "address_done" | "cancel_select" | null;

// last action per phone (in-memory, per Node process)
const lastCommandByPhone = new Map<string, UserCommand>();

// when we show "you have multiple active orders, reply 1/2/3",
// we store the order IDs here for that phone
const pendingCancelOptions = new Map<
  string,
  { orderIds: string[] }
>();

// Track if we already showed the commands tip for this phone (per process)
const commandsTipShown = new Set<string>();

async function maybeSendCommandsTip(opts: {
  phoneNumberId: string;
  to: string;
  orgId?: string;
}) {
  const key = normalizePhoneForKey(opts.to || "");
  if (!key) return;

  if (commandsTipShown.has(key)) return;
  commandsTipShown.add(key);

  await sendWabaText({
    phoneNumberId: opts.phoneNumberId,
    to: opts.to,
    orgId: opts.orgId,
    text:
      "📝 Tip: You can use quick commands anytime:\n" +
      "• *new* – start a fresh order\n" +
      "• *cancel* – cancel your last order\n" +
      "• *agent* – talk to a human\n" +
      "• *order summary* – see your last order",
  });
}

function detectUserCommand(text: string): UserCommand {
  const lower = text.toLowerCase().trim();

  // keep these fairly strict to avoid colliding with normal sentences
  if (lower === "new" || lower === "new order" || lower.startsWith("start new order")) {
    return "new";
  }
  if (lower === "cancel" || lower === "cancel order" || lower.startsWith("cancel my order")) {
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

  return null;
}

// ─────────────────────────────
// 2) Incoming messages (POST)
// ─────────────────────────────
waba.post("/", async (req, res) => {
    
  try {
    console.log("[WABA][RAW BODY]", JSON.stringify(req.body));

    const body = req.body;
    if (!body || !body.entry) {
      console.log("[WABA] no entry in body");
      return res.sendStatus(200);
    }

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const metadata = value.metadata || {};
        const phoneNumberId = metadata.phone_number_id as string | undefined;

        console.log("[WABA][ENTRY]", {
          phoneNumberId,
          messages_len: messages.length,
        });

        if (!phoneNumberId || messages.length === 0) continue;

        // Find org by WABA phone_number_id
        const { data: orgs, error: orgErr } = await supa
          .from("orgs")
          .select("id, name, ingest_mode, auto_reply_enabled")
          .eq("wa_phone_number_id", phoneNumberId)
          .limit(1);

        if (orgErr) {
          console.warn("[WABA] org lookup error", orgErr.message);
          continue;
        }
        const org = orgs?.[0];
        if (!org) {
          console.warn("[WABA] no org for phone_number_id", phoneNumberId);
          continue;
        }

        if (org.ingest_mode !== "waba") {
          console.log("[WABA] org not in waba mode, skipping", {
            org_id: org.id,
            ingest_mode: org.ingest_mode,
          });
          continue;
        }

        for (const msg of messages) {
          if (msg.type !== "text") continue;

          const from = msg.from as string;
          const text = msg.text?.body?.trim() || "";
          const msgId = msg.id as string;
          const ts = Number(msg.timestamp || Date.now()) * 1000;

          if (!text) continue;

          const lowerText = text.toLowerCase().trim();

          console.log("---------- WABA DEBUG START ----------");
          console.log("TEXT:", text);
          console.log("FROM:", from);
          console.log(
            "HAS ACTIVE ORDER:",
            Boolean(await findActiveOrderForPhone(org.id, from))
          );
          console.log("IS EDIT-LIKE:", isLikelyEditRequest(text));
          console.log("LOOKS LIKE ADD:", looksLikeAddToExisting(text));
          console.log("---------- WABA DEBUG END ----------");

          console.log("[WABA][IN]", {
            org_id: org.id,
            from,
            msgId,
            text,
          });

          // 0.15) If we are waiting for the user to choose WHICH order to cancel
// const lastCmd = lastCommandByPhone.get(from);
const lastCmd = lastCommandByPhone.get(from);
if (lastCmd === "cancel_select") {
  const choiceNum = parseInt(lowerText, 10);

  const options = pendingCancelOptions.get(from);
  if (!options || !options.orderIds.length) {
    // nothing to select anymore → reset and let normal flow handle
    lastCommandByPhone.delete(from);
  } else if (!Number.isNaN(choiceNum)) {
    const idx = choiceNum - 1;
    const orderId = options.orderIds[idx];

    if (idx < 0 || idx >= options.orderIds.length || !orderId) {
      await sendWabaText({
        phoneNumberId,
        to: from,
        text:
          "Please reply with a valid number from the list (for example 1 or 2).",
        orgId: org.id,
      });
      continue;
    }

    // Cancel the chosen order
    const { data: ordRow, error: ordErr } = await supa
      .from("orders")
      .select("id, items, status")
      .eq("id", orderId)
      .single();

    if (ordErr || !ordRow) {
      await sendWabaText({
        phoneNumberId,
        to: from,
        text:
          "I couldn’t find that order anymore. It may have already been updated by the store.",
        orgId: org.id,
      });
    } else {
      // mark as cancelled
      await supa
        .from("orders")
        .update({ status: "cancelled_by_customer" })
        .eq("id", orderId);

      const summary = formatOrderSummary(ordRow.items || []);

      const txt =
        "❌ The selected order has been cancelled:\n" +
        summary +
        "\n\nIf this was a mistake, you can send a new order.";
      await sendWabaText({
        phoneNumberId,
        to: from,
        text: txt,
        orgId: org.id,
      });
    }

    // clear state
    lastCommandByPhone.delete(from);
    pendingCancelOptions.delete(from);
    continue;
  } else {
    await sendWabaText({
      phoneNumberId,
      to: from,
      text:
        "Please reply with the number of the order you want to cancel (for example 1 or 2).",
      orgId: org.id,
    });
    continue;
  }
}

          // 0) If we’re in clarify/address session → consume here and SKIP ingestCore
          const handledByClarify = await maybeHandleClarifyReply({
            org_id: org.id,
            phoneNumberId,
            from,
            text,
          });

          // 0.15) Commands menu: help / menu / commands / options
          if (/^(help|menu|commands|options)$/i.test(lowerText)) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "📝 Quick commands you can use:\n" +
                "• *new* – start a fresh order\n" +
                "• *cancel* – cancel your last order\n" +
                "• *agent* – talk to a human\n" +
                "• *order summary* – show your last order\n\n" +
                "You can also just type your items, e.g. “2kg onion, 1L milk”.",
              orgId: org.id,
            });
            continue;
          }


          if (handledByClarify) {
            continue;
          }

          // 0.1) "order summary" → show ALL active (pending/paid) orders
if (
    /order summary|my order|my orders|show my order|show my orders/i.test(
      lowerText
    )
  ) {
    const activeOrders = await findAllActiveOrdersForPhone(org.id, from);
  
    if (!activeOrders.length) {
      await sendWabaText({
        phoneNumberId,
        to: from,
        text:
          "📦 You don’t have any active orders right now.\n" +
          "If you’d like to place a new order, just send your items here.",
        orgId: org.id,
      });
    } else {
      const blocks = activeOrders.map((o, idx) => {
        const n = idx + 1;
        const summary = formatOrderSummary(o.items || []);
        const status = String(o.status || "pending");
        return (
          `#${n} — status: ${status}\n` +
          (summary || "(no items found)")
        );
      });
  
      const textOut =
        "📦 Your active orders:\n\n" +
        blocks.join("\n\n") +
        "\n\nTo cancel one, you can type *cancel* and choose the order.";
  
      await sendWabaText({
        phoneNumberId,
        to: from,
        text: textOut,
        orgId: org.id,
      });
    }
  
    continue;
  }

          // 0.2) Explicit commands: NEW / CANCEL / UPDATE / AGENT
          const cmd = detectUserCommand(text);

                    // 0.18) Show last order summary (read-only)
                    if (
                        /order summary/i.test(lowerText) ||
                        /show (my )?order/i.test(lowerText) ||
                        /last order/i.test(lowerText)
                      ) {
                        const last = await findMostRecentOrderForPhone(org.id, from);
            
                        if (!last || !Array.isArray(last.items) || last.items.length === 0) {
                          await sendWabaText({
                            phoneNumberId,
                            to: from,
                            text: "I couldn’t find any previous orders for this number.",
                            orgId: org.id,
                          });
                        } else {
                          const summary = formatOrderSummary(last.items || []);
            
                          const rawStatus = String(last.status || "pending");
                          let statusText = `Status: ${rawStatus}`;
                          if (rawStatus === "pending") statusText = "🟡 Status: pending";
                          else if (rawStatus === "paid") statusText = "🟢 Status: paid";
                          else if (rawStatus.startsWith("cancelled")) statusText = "🔴 Status: cancelled";
            
                          const text =
                            "📦 Your last order:\n" +
                            summary +
                            "\n\n" +
                            statusText;
            
                          await sendWabaText({
                            phoneNumberId,
                            to: from,
                            text,
                            orgId: org.id,
                          });
                        }
            
                        continue;
                      }

          if (cmd === "agent") {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "👨‍💼 Okay, we’ll connect you to a store agent.\n" +
                "Please wait a moment — a human will reply.",
              orgId: org.id,
            });
            // here you could also flag the conversation row in DB
            continue;
          }

          if (cmd === "cancel") {
            const activeOrders = await findAllActiveOrdersForPhone(org.id, from);
          
            if (!activeOrders.length) {
              await sendWabaText({
                phoneNumberId,
                to: from,
                text:
                  "You don’t have any active orders right now.\n" +
                  "If you’d like to place a new order, please send your items.",
                orgId: org.id,
              });
              continue;
            }
          
            if (activeOrders.length === 1) {
              // Same behaviour as before (Option A) – cancel the single active order
              const activeOrderForCancel = activeOrders[0];
          
              await supa
                .from("orders")
                .update({ status: "cancelled_by_customer" })
                .eq("id", activeOrderForCancel.id);
          
              const summary = formatOrderSummary(activeOrderForCancel.items || []);
          
              const textOut =
                "❌ Your last order has been cancelled:\n" +
                summary +
                "\n\nIf this was a mistake, you can send a new order.";
          
              await sendWabaText({
                phoneNumberId,
                to: from,
                text: textOut,
                orgId: org.id,
              });
          
              // remember last action (if you still want it)
              lastCommandByPhone.set(from, "cancel");
              continue;
            }
          
            // Multiple active orders → ask user to choose
            lastCommandByPhone.set(from, "cancel_select");
          
            const orderIds = activeOrders.map((o) => o.id);
            pendingCancelOptions.set(from, { orderIds });
          
            const lines = activeOrders.map((o, idx) => {
              const n = idx + 1;
              const items = (o.items || []) as any[];
              const first = items[0];
              const firstName = first
                ? String(first.canonical || first.name || "item")
                : "item";
              const extra =
                items.length > 1 ? ` + ${items.length - 1} more item(s)` : "";
              const status = String(o.status || "pending");
              return `${n}) ${firstName}${extra}  [${status}]`;
            });
          
            const textOut =
              "You have multiple active orders:\n" +
              lines.join("\n") +
              "\n\nReply with the number of the order you want to cancel (for example 1 or 2).";
          
            await sendWabaText({
              phoneNumberId,
              to: from,
              text: textOut,
              orgId: org.id,
            });
          
            continue;
          }

          if (cmd === "new") {
            // remember last command
            lastCommandByPhone.set(from, "new");
          
            // 1) Close all active orders for this phone
            await supa
              .from("orders")
              .update({ status: "archived_for_new" })
              .eq("org_id", org.id)
              .eq("source_phone", from)
              .in("status", ["pending", "paid"]);
          
            // 2) Close clarify/address sessions
            const phoneKey = normalizePhoneForKey(from);
            await supa
              .from("order_clarify_sessions")
              .update({ status: "closed", updated_at: new Date().toISOString() })
              .eq("org_id", org.id)
              .eq("customer_phone", phoneKey)
              .eq("status", "open");
          
            // 3) Respond
            await sendWabaText({
              phoneNumberId,
              to: from,
              text: "👍 Starting a fresh order. Please send the items you’d like to buy.",
              orgId: org.id,
            });
          
            continue;
          }

          if (cmd === "update") {
            // We do *not* auto-edit any existing order in V1.
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "I can’t update specific items automatically yet.\n" +
                "Please type your changes clearly (e.g., “change 1kg onion to 2kg onion”) and the store will review it.",
              orgId: org.id,
            });
            continue;
          }

          // 0.8) Edit-like messages while an order is open → safe fallback (no auto edit in V1)
          const activeOrderForEdit = await findActiveOrderForPhone(org.id, from);
          if (activeOrderForEdit && isLikelyEditRequest(text)) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text:
                "I’m not sure which part of your order to change.\n" +
                "Please send the updated order clearly, or talk to the store directly.\n" +
                "If you want, you can cancel this order and create a new one from the beginning.",
              orgId: org.id,
            });
            continue;
          }

          // 1) Normal path: parse + store
          const result: any = await ingestCoreFromMessage({
            org_id: org.id,
            text,
            ts,
            from_phone: from,
            from_name: null,
            msg_id: msgId,
            source: "waba",
          });

          console.log("[WABA][INGEST-RESULT]", {
            org_id: org.id,
            from,
            msgId,
            used: result.used,
            kind: result.kind,
            inquiry: result.inquiry || result.inquiry_type,
            order_id: result.order_id,
            reason: result.reason,
            stored: result.stored,
          });

          if (!org.auto_reply_enabled) continue;

          let reply: string | null = null;

          
          const shouldForceMergeAfterAddress = lastCmd === "address_done";

          const canMerge =
          lastCmd !== "cancel" &&
          lastCmd !== "new" &&
          (looksLikeAddToExisting(text) || shouldForceMergeAfterAddress);

          // 1.5) If this is an order and there is a PREVIOUS open order,
          // MERGE when:
          //   - text clearly looks like "add more", OR
          //   - we JUST finished an address flow for this phone
          if (
            canMerge &&
            result.kind === "order" &&
            result.stored &&
            result.order_id &&
            Array.isArray(result.items)
          ) {
            const previousOpen = await findActiveOrderForPhoneExcluding(
              org.id,
              from,
              result.order_id
            );

            if (previousOpen && previousOpen.id) {
              const baseItems = (previousOpen.items || []) as any[];
              const newItems = (result.items || []) as any[];

              const mergedItems = [...baseItems, ...newItems];

              const { error: updErr } = await supa
                .from("orders")
                .update({ items: mergedItems })
                .eq("id", previousOpen.id);

              if (updErr) {
                console.warn("[WABA][merge update err]", updErr.message);
              } else {
                // Try to delete the temporary new order (best effort)
                const { error: delErr } = await supa
                  .from("orders")
                  .delete()
                  .eq("id", result.order_id);
                if (delErr) {
                  console.warn("[WABA][merge delete err]", delErr.message);
                }

                // Point the result at the merged/base order
                result.order_id = previousOpen.id;
                result.items = mergedItems;
              }
            }
          }

          // 2) Order path → either start multi-turn clarify OR
          //    (if no clarify) confirm + maybe open address session
          if (result.kind === "order" && result.stored && result.order_id) {
            lastCommandByPhone.delete(from);
            const items = (result.items || []) as any[];

            const alreadyHasAddress = await hasAddressForOrder(
              org.id,
              from,
              result.order_id
            );

            const clarifyStart = await startClarifyForOrder({
              org_id: org.id,
              order_id: result.order_id,
              from_phone: from,
            });

            if (clarifyStart) {
              reply = clarifyStart;
            } else {
              const summary = formatOrderSummary(items);

              if (alreadyHasAddress) {
                // customer already shared address → never ask again
                reply = "✅ Updated order:\n" + summary;
              } else {
                // ask address only if never given
                await startAddressSessionForOrder({
                  org_id: org.id,
                  order_id: result.order_id,
                  from_phone: from,
                });

                reply =
                  "✅ We’ve got your order:\n" +
                  summary +
                  "\n\n📍 Please share your delivery address (or send location) if you haven’t already.";
              }
            }
          }

          // 3) Inquiry path → smart price/availability
          if (!reply && result.kind === "inquiry") {
            const inquiryType = result.inquiry || result.inquiry_type || null;
            reply = await buildSmartInquiryReply({
              org_id: org.id,
              text,
              inquiryType,
            });
            if (!reply) {
              reply = "💬 Got your question. We’ll confirm the details shortly.";
            }
          }

          // 4) Heuristic question fallback
          if (
            !reply &&
            /price|rate|how much|available|stock|do you have/i.test(
              lowerText
            )
          ) {
            reply = "💬 Got your question. We’ll check and reply in a moment.";
          }

          // 5) Skip obvious small-talk
          if (
            !reply &&
            !result.stored &&
            result.reason === "small_talk_or_non_order"
          ) {
            reply = null;
          }

          // 6) Final fail-soft ack (polite default)
          if (!reply) {
            reply =
              "✅ Thanks! We’ve got your order. We’ll follow up if we need any clarification.";
          }

          if (reply) {
            await sendWabaText({
              phoneNumberId,
              to: from,
              text: reply,
              orgId: org.id,
            });
          }
        }
      }
    }

    return res.sendStatus(200);
  } catch (e: any) {
    console.error("[WABA][ERR]", e?.message || e);
    return res.sendStatus(200);
  }
});

// ─────────────────────────────
// Send via Cloud API + log to inbox
// ─────────────────────────────
async function sendWabaText(opts: {
  phoneNumberId: string;
  to: string;
  text: string;
  orgId?: string;
}) {
  const token = process.env.WA_ACCESS_TOKEN || process.env.META_WA_TOKEN;
  if (!token) {
    console.warn("[WABA] WA_ACCESS_TOKEN missing, cannot send reply");
    return;
  }

  const toNorm = opts.to.startsWith("+") ? opts.to : `+${opts.to}`;

  try {
    const resp = await axios.post(
      `${META_WA_BASE}/${opts.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: toNorm,
        type: "text",
        text: { body: opts.text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("[WABA][SEND]", { to: toNorm, text: opts.text });

    if (opts.orgId) {
      try {
        const { data: conv, error: convErr } = await supa
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

          const { error: msgErr } = await supa.from("messages").insert({
            org_id: opts.orgId,
            conversation_id: convId,
            direction: "out",
            sender_type: "ai",
            channel: "waba",
            body: opts.text,
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



export default waba;