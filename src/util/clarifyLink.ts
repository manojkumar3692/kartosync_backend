// src/util/clarifyLink.ts
import { signClarifyToken, ClarifyPayload } from './clarifyToken';

// Extend the payload we sign to optionally include phone/name
type ClarifyPayloadExtended = ClarifyPayload & {
  source_phone?: string | null;
  customer_name?: string | null;
};

export function makeClarifyLink(args: {
  org_id: string;
  order_id: string;
  line_index: number;
  options: ClarifyPayload['options'];
  // Which fields we want the customer to fill
  ask?: { brand?: boolean; variant?: boolean };
  // Show the "Other" free-text section (default true)
  allow_other?: boolean;
  // Optional extras we want to carry so /api/clarify can learn reliably
  source_phone?: string | null;
  customer_name?: string | null;
  ttlSeconds?: number; // default 2 days
}) {
  const secret = process.env.CLARIFY_SECRET || '';
  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:8787';
  const exp = Math.floor(Date.now() / 1000) + (args.ttlSeconds ?? 2 * 24 * 3600);

  const payload: ClarifyPayloadExtended = {
    org_id: args.org_id,
    order_id: args.order_id,
    line_index: args.line_index,
    options: args.options,
    ask: args.ask,                                 // include ask
    allow_other: args.allow_other ?? true,         // include allow_other
    exp,
    // carried extras (optional)
    source_phone: args.source_phone ?? null,
    customer_name: args.customer_name ?? null,
  };

  const token = signClarifyToken(payload, secret);

  // IMPORTANT: this must point to your backend’s /c/:token route (served by clarify.ts)
  return `${base}/c/${token}`;
}