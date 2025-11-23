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

export type Order = {
  id: string;
  org_id: string;
  customer_name: string | null;
  source_phone: string | null;
  raw_text: string;
  items: { name: string; qty: number; unit?: string }[];
  status: "pending" | "delivered" | "paid";
  created_at: string;
};

export type InquiryKind = "price" | "availability";

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
  used?: "ai" | "rules" | "inquiry" | "none";
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

// 🔹 NEW: Modifier result for Option C
// "This message is a correction / modifier, let WABA update the order"
type IngestModifier = IngestCommon & {
  ok: true;
  kind: "modifier";
  stored: false;
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
  // NEW:
  active_order_id?: string | null;
};