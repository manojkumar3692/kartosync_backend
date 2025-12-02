// src/ai/ingest/types.ts

export type ConversationState =
  | "idle"
  | "ordering_item"
  | "ordering_variant"
  | "ordering_qty"
  | "awaiting_address"
  | "address_confirm_confirm"
  | "confirming_order"
  | "cart_remove_item"
  | "cart_edit_item"
  | "cart_edit_qty"
  | "order_finalised"
  | "awaiting_payment_proof"
  | "awaiting_payment"
  | "status"
  | "cancel"
  | "awaiting_location_pin";


  // make sure address is in Intent union
  export type Intent =
  | "greeting"
  | "smalltalk"
  | "order"
  | "address"           // 👈 ensure this exists
  | "status"
  | "cancel"
  | "payment"
  | "agent"
  | "menu"
  | "availability"
  | "price"
  | "unknown";



export interface CatalogVariant {
  id: string | number;
  name: string;
  price?: number;
}

export interface CatalogItem {
  id: string | number;
  name: string;
  canonical?: string;
  category?: string;
  variants: CatalogVariant[];
}

export type VariantMatchResult = {
  [canonicalName: string]: CatalogVariant[];
};

export interface IngestContext {
  org_id: string;
  from_phone: string;
  text: string;
  ts: number;
  source: string; // "waba" | "local" | etc.
  location_lat?: number | null;
  location_lng?: number | null;
}

export interface IngestResult {
  used: boolean; // did AI actually handle it
  kind: "greeting" | "smalltalk" | "order" | "unknown" | "payment" | "status" | "cancel";
  reply: string | null;
  order_id?: string | null;  
  reason?: string | null;
}

export interface IngestInput {
  org_id: string;
  from_phone: string;
  text: string;
  ts: number;
  source: string; // "waba" | "local" | etc.
  from_name?: string | null;
  msg_id?: string | null;
  edited_at?: number | null;
  // 👇 add these
  location_lat?: number | null;
  location_lng?: number | null;
}