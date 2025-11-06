// src/util/inquiry.ts
export type InquiryKind = 'price' | 'availability';
export type Inquiry = { kind: InquiryKind; canonical: string; confidence: number } | null;

const WORD = `([a-zA-Z][a-zA-Z0-9\\s._-]{1,40})`;

export function detectInquiry(raw: string): Inquiry {
  const txt = String(raw || '').trim();
  const low = txt.toLowerCase();

  // PRICE
  const priceHits =
    +(low.includes('price')) +
    +(low.includes('how much')) +
    +(low.includes('rate')) +
    +(low.includes('cost'));
  const mPrice =
    low.match(new RegExp(`(?:price|how much|rate|cost)\\s*(?:of|for)?\\s*${WORD}`)) ||
    low.match(new RegExp(`${WORD}\\s*(?:price|rate|cost)`));
  if ((priceHits >= 1 || mPrice) && mPrice?.[1]) {
    return { kind: 'price', canonical: toTitle(mPrice[1]), confidence: Math.min(1, 0.6 + 0.1 * priceHits) };
  }

  // AVAILABILITY
  const availHits =
    +(low.includes('have')) +
    +(low.includes('available')) +
    +(low.includes('in stock')) +
    +(low.includes('stock'));
  const mAvail =
    low.match(new RegExp(`(?:have|stock|available)\\s*(?:any|the)?\\s*${WORD}`)) ||
    low.match(new RegExp(`${WORD}\\s*(?:available|in stock)`));
  if ((availHits >= 1 || mAvail) && mAvail?.[1]) {
    return { kind: 'availability', canonical: toTitle(mAvail[1]), confidence: Math.min(1, 0.6 + 0.1 * availHits) };
  }

  return null;
}

function toTitle(s: string) {
  return s
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .trim();
}