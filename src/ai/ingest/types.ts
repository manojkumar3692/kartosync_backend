// src/ai/ingest/types.ts

export type ConversationState =
  | "idle"
  | "ordering_item"
  | "ordering_variant"
  | "ordering_qty"
  | "awaiting_address";  // 👈 NEW


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
| "unknown"


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
}

export interface IngestResult {
  used: boolean; // did AI actually handle it
  kind: "greeting" | "smalltalk" | "order" | "unknown";
  reply: string | null;
  order_id?: number | null;
  reason?: string | null;
}