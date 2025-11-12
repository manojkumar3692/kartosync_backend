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
};

type IngestCommon = {
  used?: "ai" | "rules" | "inquiry" | "none";
  reason?: string;

  items?: IngestItem[];
  org_id?: string;
  order_id?: string;

  inquiry?: string;
  inquiry_type?: string;
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

type IngestInquiry = IngestCommon & {
  ok: true;
  kind: "inquiry";
  used: "inquiry";
  stored: boolean; // true when inserted, false on dedupe
  order_id?: string;
};

type IngestNone = IngestCommon & {
  ok: true;
  kind: "none";
  stored: false;
};

export type IngestResult =
  | IngestError
  | IngestOrder
  | IngestInquiry
  | IngestNone;

export type IngestInput = {
  org_id: string;
  text: string;
  ts?: number;
  from_phone?: string;
  from_name?: string | null;
  msg_id?: string | null;
  edited_at?: number | null;
  source?: IngestSource;
};