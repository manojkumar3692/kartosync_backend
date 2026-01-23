// src/ai/ingest/types.ts

export type ConversationState =
  | "idle"
  | "ordering_item"
  | "ordering_variant"
  | "ordering_qty"
  | "ordering_upsell"
  | "building_order"
  | "confirming_order"
  | "cart_edit_menu"
  | "cart_edit_item"
  | "cart_edit_qty"
  | "cart_remove_item"
  | "order_finalised"
  | "awaiting_fulfillment"
  | "awaiting_address"
  | "awaiting_location_pin"
  | "awaiting_delivery_slot"
  | "awaiting_payment"
  | "awaiting_payment_proof"
  | "awaiting_pickup_payment"
  | "status"
  | "cancel"
  | "agent"
  // 👇 clinic states
  | "clinic_awaiting_patient_name"
  | "clinic_awaiting_date"
  | "clinic_awaiting_time"
  | "clinic_awaiting_confirmation"
  | "clinic_awaiting_specific_date"
  | "address_confirm_confirm"
  | "awaiting_delivery_slot"

export type Intent =
  | "greeting"
  | "smalltalk"
  | "order"
  | "address"
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
  intent?: any;
  vertical?: any;
}

export type IntentLane =
  | "order"
  | "menu"
  | "opening_hours"
  | "delivery_now"
  | "delivery_area"
  | "delivery_time_specific"
  | "pricing_generic"
  | "store_location"
  | "contact"
  | "clinic_doctor_availability"
  | "clinic_consultation_fee"
  | "clinic_start_booking"
  | "human_help"
  | "unknown";

export interface IngestResult {
  used: boolean;
  kind:
    | "greeting"
    | "smalltalk"
    | "order"
    | "unknown"
    | "payment"
    | "status"
    | "cancel"
    | "manual_mode"
    | "service_inquiry"
    | "agent"
    | "inquiry";
  reply: string | null;
  order_id?: string | null;
  reason?: string | null;
  image?: any;
  meta?: any;
  intentLane?: IntentLane;
}

export interface IngestInput {
  org_id: string;
  from_phone: string;
  text: string;
  ts: number;
  source: string;
  from_name?: string | null;
  msg_id?: string | null;
  edited_at?: number | null;
  location_lat?: number | null;
  location_lng?: number | null;
}