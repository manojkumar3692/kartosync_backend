// src/session/sessionEngine.ts
import { supa } from "../db";
import { InquiryKind } from "../types";

// 🔹 NEW: typed snapshot for last modifier
export type SessionModifierSnapshot = {
  text: string;
  intent: "order_correction" | "modifier";
  ts: number;
  payload?: any;
  confidence?: number;
};

// Keep this in ONE place so ingestCore / WABA / dashboards
// all see the SAME idea of "active order" + last inquiry.
export type CustomerSession = {
  org_id: string;
  phone_key: string;

  // Order tracking
  active_order_id: string | null;
  last_order_id: string | null;
  last_order_status: string | null;
  last_order_at: string | null; // ISO string

  // Inquiry snapshot
  last_inquiry_text: string | null;
  last_inquiry_kind: InquiryKind | null;
  last_inquiry_canonical: string | null;
  last_inquiry_at: string | null;
  last_inquiry_status: string | null;

  // For future use (modifiers, address updates, etc.)
  last_modifier_json: SessionModifierSnapshot | null;
  last_modifier_at: string | null;

  // Generic activity
  last_seen_at: string | null;
};

// Small helper so we never explode on missing row
function emptySession(org_id: string, phone_key: string): CustomerSession {
  const now = new Date().toISOString();
  return {
    org_id,
    phone_key,
    active_order_id: null,
    last_order_id: null,
    last_order_status: null,
    last_order_at: null,

    last_inquiry_text: null,
    last_inquiry_kind: null,
    last_inquiry_canonical: null,
    last_inquiry_at: null,
    last_inquiry_status: null,

    last_modifier_json: null,
    last_modifier_at: null,

    last_seen_at: now,
  };
}

/**
 * Load current session row for (org, phone_key).
 *
 * 🔑 IMPORTANT:
 * - We always use phone_key (normalized digits) as the key.
 * - org_customer_settings must have a unique constraint on (org_id, customer_phone)
 *   OR (org_id, phone_key) depending on how you set it up.
 */
export async function getCustomerSession(
  org_id: string,
  phone_key: string
): Promise<CustomerSession> {
  const orgId = String(org_id || "").trim();
  const phoneKey = String(phone_key || "").trim();

  if (!orgId || !phoneKey) {
    throw new Error("getCustomerSession: org_id and phone_key required");
  }

  const { data, error } = await supa
    .from("org_customer_settings")
    .select(
      `
      org_id,
      customer_phone,
      active_order_id,
      last_order_id,
      last_order_status,
      last_order_at,
      last_inquiry_text,
      last_inquiry_kind,
      last_inquiry_canonical,
      last_inquiry_at,
      last_inquiry_status,
      last_modifier_json,
      last_modifier_at,
      last_seen_at
    `
    )
    .eq("org_id", orgId)
    .eq("customer_phone", phoneKey)
    .maybeSingle();

  if (error) {
    console.warn("[SESSION][getCustomerSession] err", error.message);
    const empty = emptySession(orgId, phoneKey);
    console.log("[SESSION][getCustomerSession] empty_due_to_error", {
      orgId,
      phoneKey,
    });
    return empty;
  }

  if (!data) {
    const empty = emptySession(orgId, phoneKey);
    console.log("[SESSION][getCustomerSession] empty_no_row", {
      orgId,
      phoneKey,
    });
    return empty;
  }

  const session: CustomerSession = {
    org_id: data.org_id,
    phone_key: phoneKey,

    active_order_id: data.active_order_id ?? null,
    last_order_id: data.last_order_id ?? null,
    last_order_status: data.last_order_status ?? null,
    last_order_at: data.last_order_at ?? null,

    last_inquiry_text: data.last_inquiry_text ?? null,
    last_inquiry_kind: (data.last_inquiry_kind as InquiryKind | null) ?? null,
    last_inquiry_canonical: data.last_inquiry_canonical ?? null,
    last_inquiry_at: data.last_inquiry_at ?? null,
    last_inquiry_status: data.last_inquiry_status ?? null,

    last_modifier_json: (data.last_modifier_json ??
      null) as SessionModifierSnapshot | null,
    last_modifier_at: data.last_modifier_at ?? null,

    last_seen_at: data.last_seen_at ?? null,
  };

  console.log("[SESSION][getCustomerSession] loaded", {
    orgId,
    phoneKey,
    active_order_id: session.active_order_id,
    last_order_id: session.last_order_id,
    last_order_status: session.last_order_status,
    last_order_at: session.last_order_at,
  });

  return session;
}

/**
 * Upsert base row (ensure session exists).
 * You usually don't call this directly – all other helpers call it.
 */
async function ensureSessionRow(
  org_id: string,
  phone_key: string
): Promise<void> {
  const orgId = String(org_id || "").trim();
  const phoneKey = String(phone_key || "").trim();
  if (!orgId || !phoneKey) return;

  const now = new Date().toISOString();

  const { error } = await supa
    .from("org_customer_settings")
    .upsert(
      {
        org_id: orgId,
        customer_phone: phoneKey,
        last_seen_at: now,
      },
      { onConflict: "org_id,customer_phone" }
    );

  if (error) {
    console.warn("[SESSION][ensureSessionRow] err", error.message);
  }
}

/**
 * When a NEW order is created for this customer.
 *
 * Example usage from ingestCore:
 *   await markSessionOnNewOrder(orgId, phoneKey, orderId, "pending");
 */
export async function markSessionOnNewOrder(opts: {
  org_id: string;
  phone_key: string;
  order_id: string;
  status?: string | null;
}) {
  const orgId = String(opts.org_id || "").trim();
  const phoneKey = String(opts.phone_key || "").trim();
  const orderId = String(opts.order_id || "").trim();
  const status = (opts.status || "pending") as string;
  if (!orgId || !phoneKey || !orderId) return;

  const now = new Date().toISOString();

  await ensureSessionRow(orgId, phoneKey);

  const { error } = await supa
    .from("org_customer_settings")
    .update({
      active_order_id: orderId,
      last_order_id: orderId,
      last_order_status: status,
      last_order_at: now,
      last_seen_at: now,
    })
    .eq("org_id", orgId)
    .eq("customer_phone", phoneKey);

  if (error) {
    console.warn("[SESSION][markSessionOnNewOrder] err", error.message);
  }
}

/**
 * When we APPEND items to an existing order for this customer.
 * This keeps active_order_id pinned to that order.
 */
export async function markSessionOnAppendOrder(opts: {
  org_id: string;
  phone_key: string;
  order_id: string;
  status?: string | null;
}) {
  const orgId = String(opts.org_id || "").trim();
  const phoneKey = String(opts.phone_key || "").trim();
  const orderId = String(opts.order_id || "").trim();
  const status = (opts.status || "pending") as string;
  if (!orgId || !phoneKey || !orderId) return;

  const now = new Date().toISOString();

  await ensureSessionRow(orgId, phoneKey);

  const { error } = await supa
    .from("org_customer_settings")
    .update({
      active_order_id: orderId,
      last_order_id: orderId,
      last_order_status: status,
      last_order_at: now,
      last_seen_at: now,
    })
    .eq("org_id", orgId)
    .eq("customer_phone", phoneKey);

  if (error) {
    console.warn("[SESSION][markSessionOnAppendOrder] err", error.message);
  }
}

/**
 * When order status changes to a terminal state (paid, cancelled, archived…)
 * → we clear active_order_id but keep last_order_* for history.
 */
export async function markSessionOnOrderStatusChange(opts: {
  org_id: string;
  phone_key: string;
  order_id: string;
  status: string;
}) {
  const orgId = String(opts.org_id || "").trim();
  const phoneKey = String(opts.phone_key || "").trim();
  const orderId = String(opts.order_id || "").trim();
  const status = String(opts.status || "").toLowerCase();

  if (!orgId || !phoneKey || !orderId) return;

  const now = new Date().toISOString();
  const isTerminal = [
    "paid",
    "shipped",
    "cancelled_by_customer",
    "archived_for_new",
  ].includes(status);

  await ensureSessionRow(orgId, phoneKey);

  const patch: any = {
    last_order_id: orderId,
    last_order_status: status,
    last_order_at: now,
    last_seen_at: now,
  };

  if (isTerminal) {
    patch.active_order_id = null;
  }

  const { error } = await supa
    .from("org_customer_settings")
    .update(patch)
    .eq("org_id", orgId)
    .eq("customer_phone", phoneKey);

  if (error) {
    console.warn(
      "[SESSION][markSessionOnOrderStatusChange] err",
      error.message
    );
  }
}

/**
 * When we detect an inquiry ("do u have chicken biryani", "price of coke" etc.)
 * we snapshot it here. This is what your /customer-insight API is already reading.
 */
export async function markSessionOnInquiry(opts: {
  org_id: string;
  phone_key: string;
  kind: InquiryKind;
  canonical: string;
  text: string;
  status?: string | null; // e.g. "pending", "answered"
}) {
  const orgId = String(opts.org_id || "").trim();
  const phoneKey = String(opts.phone_key || "").trim();
  if (!orgId || !phoneKey) return;

  const now = new Date().toISOString();

  await ensureSessionRow(orgId, phoneKey);

  const { error } = await supa
    .from("org_customer_settings")
    .update({
      last_inquiry_text: opts.text,
      last_inquiry_kind: opts.kind,
      last_inquiry_canonical: opts.canonical,
      last_inquiry_at: now,
      last_inquiry_status: opts.status || "pending",
      last_seen_at: now,
    })
    .eq("org_id", orgId)
    .eq("customer_phone", phoneKey);

  if (error) {
    console.warn("[SESSION][markSessionOnInquiry] err", error.message);
  }
}

/**
 * For "modifier / correction" style messages ("only 1 biriyani", "make it spicy").
 * We don't decide DB diff here – WABA will apply it – but we snapshot so UI can show
 * "Customer sent a change request 2 min ago".
 */
export async function markSessionOnModifier(opts: {
  org_id: string;
  phone_key: string;
  modifier: SessionModifierSnapshot;
}) {
  const orgId = String(opts.org_id || "").trim();
  const phoneKey = String(opts.phone_key || "").trim();
  if (!orgId || !phoneKey) return;

  const ts =
    typeof opts.modifier.ts === "number" && opts.modifier.ts > 0
      ? new Date(opts.modifier.ts).toISOString()
      : new Date().toISOString();

  await ensureSessionRow(orgId, phoneKey);

  const { error } = await supa
    .from("org_customer_settings")
    .update({
      last_modifier_json: opts.modifier,
      last_modifier_at: ts,
      last_seen_at: ts,
    })
    .eq("org_id", orgId)
    .eq("customer_phone", phoneKey);

  if (error) {
    console.warn("[SESSION][markSessionOnModifier] err", error.message);
  }
}

/**
 * Helper to ask: "Which order is active for this customer right now?"
 *
 * Logic now is simple:
 *  - if active_order_id exists → return it
 *  - else return null
 *
 * Later we can make this smarter (time-window, status, etc.)
 * without touching ingestCore.
 */
export async function resolveActiveOrderIdForCustomer(opts: {
  org_id: string;
  phone_key: string;
}): Promise<string | null> {
  const session = await getCustomerSession(opts.org_id, opts.phone_key);
  return session.active_order_id || null;
}

// ─────────────────────────────────────────────
// LAYER B — ORDER SESSION ENGINE (decision only)
// ─────────────────────────────────────────────

export type SessionDecisionKind =
  | "noop"
  | "start_new_order"
  | "append_items"
  | "modify_existing_order"
  | "cancel_items"
  | "clarify_before_action";

export type SessionDecision = {
  kind: SessionDecisionKind;
  /** Human-readable reason – super useful in logs / debugging */
  reason: string;

  /** Which order this decision is about (if any) */
  targetOrderId?: string | null;

  /** Items to append (for append_items) */
  itemsToAppend?: any[] | null;

  /** For future: structured patch for modifiers */
  modifierPatch?: {
    lineIndex?: number | null;
    updatedQty?: number | null;
    updatedVariant?: string | null;
    notesAppend?: string | null;
  } | null;

  /** Whether we should explicitly ask the customer to confirm before applying */
  needsClarify?: boolean;
};

// Minimal shape of NLU result we care about
export type NluResult = {
  intent:
    | "greeting"
    | "smalltalk"
    | "spam"
    | "inquiry"
    | "order"
    | "modifier"
    | "address_update"
    | "unknown";
  canonical?: string | null;
  confidence: number;
  raw?: any; // keep original interpreter payload if needed
};

// Minimal shape of parse result from ingestCore / parser
export type ParseResultMinimal = {
  kind: "order" | "inquiry" | "modifier" | "none";
  items?: any[]; // parsed items (line items)
  order_id?: string | null;
  used?: boolean;
  stored?: boolean;
  reason?: string | null;
  inquiry_type?: string | null;
};

// Same UserCommand as in WABA
export type SessionUserCommand =
  | "new"
  | "cancel"
  | "update"
  | "agent"
  | "repeat"
  | null;

/**
 * MAIN BRAIN:
 * Decide what to do with this message at the session level.
 *
 * NOTE:
 *  - This function DOES NOT touch the DB.
 *  - ingestCore / WABA will execute the decision (create order, append items, etc.).
 */
export async function decideOrderSessionAction(opts: {
  org_id: string;
  phone_key: string;
  text: string;

  nlu: NluResult | null;
  parse: ParseResultMinimal | null;

  session?: CustomerSession | null;

  explicitCommand?: SessionUserCommand;
  hasActiveOrder?: boolean;
  activeOrderId?: string | null;

  looksLikeAddToExisting?: boolean;
  aiThinksSoftCancel?: boolean;
}): Promise<SessionDecision> {
  const {
    org_id,
    phone_key,
    text,
    nlu,
    parse,
    explicitCommand,
    looksLikeAddToExisting,
    aiThinksSoftCancel,
  } = opts;

  const lowerText = text.toLowerCase().trim();

  const session =
    opts.session || (await getCustomerSession(org_id, phone_key));

  const activeOrderId =
    (typeof opts.activeOrderId === "string"
      ? opts.activeOrderId
      : session.active_order_id) || null;

  const hasActiveOrder =
    typeof opts.hasActiveOrder === "boolean"
      ? opts.hasActiveOrder
      : !!activeOrderId;

  console.log("[SESSION][engine][input]", {
    org_id,
    phone_key,
    text,
    lowerText,
    nlu_intent: nlu?.intent,
    nlu_confidence: nlu?.confidence,
    parse_kind: parse?.kind,
    parse_items_count: Array.isArray(parse?.items) ? parse!.items!.length : 0,
    parse_reason: parse?.reason,
    explicitCommand,
    looksLikeAddToExisting,
    aiThinksSoftCancel,
    activeOrderId,
    hasActiveOrder,
  });

  const baseDecision = (
    kind: SessionDecisionKind,
    reason: string
  ): SessionDecision => ({
    kind,
    reason,
    targetOrderId: null,
    itemsToAppend: null,
    modifierPatch: null,
    needsClarify: false,
  });

  // ─────────────────────────────
  // 0) Spam / pure smalltalk → NOOP
  // ─────────────────────────────
  if (
    nlu &&
    (nlu.intent === "spam" ||
      (nlu.intent === "smalltalk" && nlu.confidence >= 0.8))
  ) {
    const d = baseDecision("noop", "nlu:smalltalk_or_spam");
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  // ─────────────────────────────
  // 1) Explicit commands override NLU
  // ─────────────────────────────
  if (explicitCommand === "agent") {
    const d = baseDecision("noop", "command:agent");
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  if (explicitCommand === "new") {
    const d = baseDecision("start_new_order", "command:new_order");
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  if (explicitCommand === "repeat") {
    const d = baseDecision("start_new_order", "command:repeat_last_order");
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  if (explicitCommand === "cancel") {
    if (!hasActiveOrder) {
      const d = baseDecision(
        "noop",
        "command:cancel_but_no_active_order"
      );
      console.log("[SESSION][engine][decision]", d);
      return d;
    }
    const d: SessionDecision = {
      ...baseDecision("cancel_items", "command:cancel_active_order"),
      targetOrderId: activeOrderId,
    };
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  if (explicitCommand === "update") {
    const d = baseDecision(
      "clarify_before_action",
      "command:update_order"
    );
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  // ─────────────────────────────
  // 2) Soft cancel (text / AI)
  // ─────────────────────────────
  if (aiThinksSoftCancel && hasActiveOrder) {
    const d: SessionDecision = {
      ...baseDecision("cancel_items", "soft_cancel:ai_signal"),
      targetOrderId: activeOrderId,
      needsClarify: true, // e.g. ask YES/NO before real cancel
    };
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  // ─────────────────────────────
  // 3) No parse result → fall back to NLU
  // ─────────────────────────────
  if (!parse || parse.kind === "none") {
    if (nlu?.intent === "order" && nlu.confidence >= 0.7) {
      if (!hasActiveOrder) {
        const d = baseDecision("start_new_order", "nlu:order_no_active");
        console.log("[SESSION][engine][decision]", d);
        return d;
      }

      if (looksLikeAddToExisting) {
        const d: SessionDecision = {
          ...baseDecision("append_items", "nlu:order_add_to_existing"),
          targetOrderId: activeOrderId,
        };
        console.log("[SESSION][engine][decision]", d);
        return d;
      }

      const d: SessionDecision = {
        ...baseDecision("clarify_before_action", "nlu:order_need_clarify"),
        needsClarify: true,
      };
      console.log("[SESSION][engine][decision]", d);
      return d;
    }

    const d = baseDecision("noop", "no_parse_and_not_order");
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  // ─────────────────────────────
  // 4) Modifier messages (change existing order)
  // ─────────────────────────────
  if (parse.kind === "modifier") {
    if (!hasActiveOrder) {
      const d = baseDecision(
        "clarify_before_action",
        "modifier_but_no_active_order"
      );
      console.log("[SESSION][engine][decision]", d);
      return d;
    }

    const d: SessionDecision = {
      ...baseDecision("modify_existing_order", "modifier_for_active_order"),
      targetOrderId: activeOrderId,
      modifierPatch: null,
      needsClarify: false,
    };
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  // ─────────────────────────────
  // 5) Inquiry messages (menu / price / availability)
  // ─────────────────────────────
  if (parse.kind === "inquiry") {
    const d = baseDecision("noop", "inquiry_message");
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  // ─────────────────────────────
  // 6) Order messages (main path)
  // ─────────────────────────────
  if (parse.kind === "order") {
    const items = Array.isArray(parse.items) ? parse.items : [];

    if (!items.length) {
      const d = baseDecision(
        "clarify_before_action",
        "order_no_items_parsed"
      );
      console.log("[SESSION][engine][decision]", d);
      return d;
    }

    // 6.1) No active order → clearly a NEW ORDER
    if (!hasActiveOrder) {
      const d = baseDecision("start_new_order", "order_no_active_order");
      console.log("[SESSION][engine][decision]", d);
      return d;
    }

    // 6.2) Looks like “add more” → append_items
    if (looksLikeAddToExisting) {
      const d: SessionDecision = {
        ...baseDecision(
          "append_items",
          "order_add_to_existing_heuristic"
        ),
        targetOrderId: activeOrderId,
        itemsToAppend: items,
      };
      console.log("[SESSION][engine][decision]", d);
      return d;
    }

    // 6.3) Parser already linked to an order_id → respect when it matches active
    if (parse.order_id && parse.order_id === activeOrderId) {
      const d: SessionDecision = {
        ...baseDecision(
          "append_items",
          "order_parser_wants_append_to_active"
        ),
        targetOrderId: activeOrderId,
        itemsToAppend: items,
      };
      console.log("[SESSION][engine][decision]", d);
      return d;
    }

    // 6.4) Parser created a NEW order but we ALSO have an active order.
    // Here we ask user which behaviour they want.
    if (parse.order_id && parse.order_id !== activeOrderId) {
      const d: SessionDecision = {
        ...baseDecision(
          "clarify_before_action",
          "order_ambiguous_existing_vs_new"
        ),
        targetOrderId: parse.order_id,
        itemsToAppend: items,
        needsClarify: true,
      };
      console.log("[SESSION][engine][decision]", d);
      return d;
    }

    // 6.5) Fallback: we have active order, but no strong “add more” signal
    const d: SessionDecision = {
      ...baseDecision(
        "clarify_before_action",
        "order_with_active_need_clarify"
      ),
      targetOrderId: activeOrderId,
      itemsToAppend: items,
      needsClarify: true,
    };
    console.log("[SESSION][engine][decision]", d);
    return d;
  }

  // ─────────────────────────────
  // Default: do nothing at session level
  // ─────────────────────────────
  const d = baseDecision("noop", "default_fallback");
  console.log("[SESSION][engine][decision]", d);
  return d;
}

// ─────────────────────────────────────────────
// Thin wrapper used by ingestCore (v1)
// ─────────────────────────────────────────────

export type ParsedMessage = {
  kind: "order" | "inquiry" | "modifier" | "none";
  items: any[];
  inquiryKind: InquiryKind | null;
  canonical: string | null;
  reason: string | null;
  raw: any | null;
};

export async function decideSessionNextStep(opts: {
  org_id: string;
  phone_key: string;
  text: string;
  nlu: NluResult | null;
  parsed: ParsedMessage;
}): Promise<{
  action: "start_new_order" | "append_items" | "noop";
  targetOrderId?: string | null;
  reason?: string;
}> {
  const decision = await decideOrderSessionAction({
    org_id: opts.org_id,
    phone_key: opts.phone_key,
    text: opts.text,
    nlu: opts.nlu,
    parse: {
      kind: opts.parsed.kind,
      items: opts.parsed.items,
      reason: opts.parsed.reason,
    },
    explicitCommand: null,
    looksLikeAddToExisting: false,
    aiThinksSoftCancel: false,
  });

  let action: "start_new_order" | "append_items" | "noop";
  switch (decision.kind) {
    case "start_new_order":
      action = "start_new_order";
      break;
    case "append_items":
      action = "append_items";
      break;
    default:
      action = "noop";
  }

  const out = {
    action,
    targetOrderId: decision.targetOrderId ?? null,
    reason: decision.reason,
  };

  console.log("[SESSION][engine][nextStep]", {
    org_id: opts.org_id,
    phone_key: opts.phone_key,
    text: opts.text,
    decision_kind: decision.kind,
    decision_reason: decision.reason,
    decision_targetOrderId: decision.targetOrderId ?? null,
    action: out.action,
    action_targetOrderId: out.targetOrderId,
  });

  return out;
}

export type CustomerInsight = {
  activeOrderId: string | null;

  lastOrder: {
    id: string | null;
    status: string | null;
    at: string | null;
  };

  lastInquiry: {
    text: string | null;
    kind: InquiryKind | null;
    canonical: string | null;
    at: string | null;
    status: string | null;
  };

  lastModifier: {
    json: any | null;
    at: string | null;
  };

  lastSeenAt: string | null;
};

/**
 * Convert raw CustomerSession → compact insight object for UI.
 */
export function buildCustomerInsight(
  session: CustomerSession
): CustomerInsight {
  return {
    activeOrderId: session.active_order_id || null,
    lastOrder: {
      id: session.last_order_id || null,
      status: session.last_order_status || null,
      at: session.last_order_at || null,
    },
    lastInquiry: {
      text: session.last_inquiry_text || null,
      kind: session.last_inquiry_kind,
      canonical: session.last_inquiry_canonical || null,
      at: session.last_inquiry_at || null,
      status: session.last_inquiry_status || null,
    },
    lastModifier: {
      json: session.last_modifier_json ?? null,
      at: session.last_modifier_at || null,
    },
    lastSeenAt: session.last_seen_at || null,
  };
}