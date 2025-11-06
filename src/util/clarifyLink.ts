// src/util/clarifyLink.ts
import { signClarifyToken, ClarifyPayload } from './clarifyToken';

export function makeClarifyLink(args: {
  org_id: string;
  order_id: string;
  line_index: number;
  options: ClarifyPayload['options'];
  // NEW: pass which fields we want the customer to fill
  ask?: { brand?: boolean; variant?: boolean };
  // NEW: allow showing the "Other" free-text section (default true)
  allow_other?: boolean;
  ttlSeconds?: number; // default 2 days
}) {
  const secret = process.env.CLARIFY_SECRET || '';
  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:8787';
  const exp = Math.floor(Date.now() / 1000) + (args.ttlSeconds ?? 2 * 24 * 3600);

  const token = signClarifyToken(
    {
      org_id: args.org_id,
      order_id: args.order_id,
      line_index: args.line_index,
      options: args.options,
      ask: args.ask,                         // ✅ include ask
      allow_other: args.allow_other ?? true, // ✅ include allow_other
      exp,
    },
    secret
  );

  // IMPORTANT: this must point to your backend’s /c/:token route (served by clarify.ts)
  return `${base}/c/${token}`;
}