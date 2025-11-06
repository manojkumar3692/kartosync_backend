// src/util/clarifyToken.ts
import crypto from 'crypto';

export type ClarifyPayload = {
  org_id: string;
  order_id: string;
  line_index: number;
  options: Array<{
    label: string;         // shown to customer (e.g., "Maggi Masala 70g")
    canonical: string;     // your normalized name (e.g., "noodles")
    brand?: string | null; // "Maggi"
    variant?: string | null; // "Masala 70g"
    rec?: boolean;         // optional "Recommended" badge
  }>;
  // NEW (optional) — controls which free-text inputs to show
  ask?: {
    brand?: boolean;
    variant?: boolean;
  };
  // NEW (optional) — whether to show the “Other” section
  allow_other?: boolean;

  exp: number;             // unix epoch seconds (e.g., now + 2 days)
};

const b64url = {
  enc: (buf: Buffer) =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
  dec: (str: string) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
};

function hmac(input: Buffer, secret: string) {
  return crypto.createHmac('sha256', secret).update(input).digest();
}

export function signClarifyToken(payload: ClarifyPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = hmac(body, secret);
  return `${b64url.enc(body)}.${b64url.enc(sig)}`;
}

export function verifyClarifyToken(token: string, secret: string): ClarifyPayload | null {
  const [b64, b64sig] = token.split('.');
  if (!b64 || !b64sig) return null;
  const body = b64url.dec(b64);
  const expect = hmac(body, secret);
  const got = b64url.dec(b64sig);
  try {
    if (!crypto.timingSafeEqual(expect, got)) return null;
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(body.toString('utf8')) as ClarifyPayload;
    if (typeof obj?.exp !== 'number' || Date.now() / 1000 > obj.exp) return null; // expired
    return obj;
  } catch {
    return null;
  }
}

export function sha256(text: string) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}