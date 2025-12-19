// src/types.ts

// Existing app types
export type Org = {
  id: string;
  name: string;
  phone?: string;
  wa_phone_number_id?: string;
  plan: "free" | "pro";
  created_at: string;
};

export type OrderStatus =
  | "pending"
  | "accepted"
  | "shipped"
  | "paid"
  | "cancelled"
  // legacy/optional:
  | "delivered"
  | "cancelled_by_customer"
  | "archived_for_new";

export type Order = {
  id: string;
  org_id: string;
  customer_name: string | null;
  source_phone: string | null;
  raw_text: string;
  items: { name: string; qty: number; unit?: string }[];
  status: OrderStatus;
  created_at: string;
};

export type InquiryKind = "price" | "availability";

// ─────────────────────────────────────────────
// Modifier payload types (for change requests)
// ─────────────────────────────────────────────

export type ModifierScope = "one" | "all" | "ambiguous";

export type ModifierChangeType = "variant" | "qty" | "remove" | "note";

export type ModifierTarget = {
  type: "item";
  text: string;              // raw phrase from user: "chicken biriyani", "all biryani", "everything"
  canonical?: string | null; // cleaned name if AI is confident (e.g. "chicken biryani")
};

export type ModifierChange = {
  type: ModifierChangeType;

  // For "make biryani spicy", "change to boneless"
  new_variant?: string | null;

  // For "make coke 2", "change coke to 3"
  new_qty?: number | null;

  // For "add one more coke", "add 2 more"
  delta_qty?: number | null;

  // For "no onion", "less oil"
  note?: string | null;
};

export type ModifierPayload = {
  target: ModifierTarget;
  scope: ModifierScope;
  change: ModifierChange;
};

// ─────────────────────────────────────────────
// Ingest types (backend shared)
// ─────────────────────────────────────────────

export type IngestSource =
  | "waba"
  | "local_bridge"
  | "clarify_link"
  | "web"
  | "mobile"
  | "other"
  | "unknown";

export type IngestItem = {
  qty: number | null;
  unit?: string | null;
  canonical?: string | null;
  name?: string | null;
  brand?: string | null;
  variant?: string | null;
  notes?: string | null;

  // 🧠 AI + menu-aware hints (all optional)
  product_id?: string | null;
  match_type?: "catalog_exact" | "catalog_fuzzy" | "text_only" | null;
  needs_clarify?: boolean;
  clarify_reason?: string | null;
  text_span?: string | null;
};

type IngestCommon = {
  // which engine handled it
  used?: "ai" | "rules" | "inquiry" | "modifier" | "none";
  reason?: string;

  items?: IngestItem[];
  org_id?: string;
  order_id?: string;

  // Generic inquiry fields (string-level)
  inquiry?: string;
  inquiry_type?: string;
  inquiry_canonical?: string;

  // Backend can send a reply such as price, availability, etc.
  reply?: string;

  // For order change / correction messages (Option C)
  modifier?: ModifierPayload | null;
  modifier_confidence?: number;
};

type IngestError = IngestCommon & {
  ok: false;
  stored: false;
  kind: "none";
  error: string;
};

type IngestOrder = IngestCommon & {
  ok: true;
  kind: "order";
  stored: true;
  used: "ai" | "rules";
  order_id: string;
  merged_into?: string;
  edited_order_id?: string;
};

export type IngestInquiry = IngestCommon & {
  ok: true;
  kind: "inquiry";
  used: "inquiry";
  stored: boolean;
  order_id?: string;

  // Already used by UI / callers
  reply?: string;
  reason?: string;

  // 🔥 What waba.ts needs (narrowed to InquiryKind)
  inquiry?: InquiryKind;       // "availability" | "price"
  inquiry_type?: InquiryKind;  // same, for backwards-compat
  inquiry_canonical?: string;  // e.g. "Chicken Biryani Today"
};

type IngestNone = IngestCommon & {
  ok: true;
  kind: "none";
  stored: false;
};

// 🔹 Modifier result for Option C
// "This message is a correction / modifier, let WABA update the order"
type IngestModifier = IngestCommon & {
  ok: true;
  kind: "modifier";
  stored: false;
  // you can optionally narrow this:
  // used?: "none" | "modifier";
};

export type IngestResult =
  | IngestError
  | IngestOrder
  | IngestInquiry
  | IngestNone
  | IngestModifier;

export type IngestInput = {
  org_id: string;
  text: string;
  ts?: number;
  from_phone?: string;
  from_name?: string | null;
  msg_id?: string | null;
  edited_at?: number | null;
  source?: IngestSource;
  // NEW: caller can force-append into an active order
  active_order_id?: string | null;
};

