// src/parser.ts
// Tamil-aware order parser for WhatsApp messages (General store + Meat/Seafood)

// ---------------------- Numbers (Tamil digits & words) -----------------------
const TA_DIGITS: Record<string, number> = {
  '௦': 0, '௧': 1, '௨': 2, '௩': 3, '௪': 4, '௫': 5, '௬': 6, '௭': 7, '௮': 8, '௯': 9
};

const TA_NUMWORDS: Record<string, number> = {
  'பூஜ்ஜியம்': 0, 'சூன்யம்': 0,
  'ஒன்று': 1, 'ஒரு': 1,
  'இரண்டு': 2, 'ரெண்டு': 2, 'ரண்டு': 2,
  'மூன்று': 3,
  'நான்கு': 4,
  'ஐந்து': 5,
  'ஆறு': 6,
  'ஏழு': 7,
  'எட்டு': 8,
  'ஒன்பது': 9,
  'பத்து': 10
};

function toLowerClean(s: string) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[.,;:|(){}\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tamilDigitsToNum(s: string) {
  if (/[\u0BE6-\u0BEF]/.test(s)) {
    let out = 0;
    for (const ch of s) out = out * 10 + (TA_DIGITS[ch] ?? 0);
    return out;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function wordToNum(word: string) {
  const w = toLowerClean(word);
  if (TA_NUMWORDS[w] !== undefined) return TA_NUMWORDS[w];
  if (w === 'a' || w === 'an' || w === 'one') return 1;
  return NaN;
}

// ---------------------- Units & helpers --------------------------------------
export type Unit = 'kg' | 'g' | 'l' | 'ml' | 'pack' | 'pc';

const UNIT_MAP: Record<string, Unit> = {
  kg: 'kg', kilo: 'kg', kilos: 'kg', 'கிலோ': 'kg',
  g: 'g', gram: 'g', grams: 'g', 'கிராம்': 'g',
  l: 'l', lt: 'l', liter: 'l', litre: 'l', 'லிட்டர்': 'l',
  ml: 'ml',
  packet: 'pack', packets: 'pack', pack: 'pack', pkt: 'pack', 'பாக்கெட்': 'pack',
  piece: 'pc', pieces: 'pc', pcs: 'pc', pc: 'pc', 'பீஸ்': 'pc',
};

function normalizeUnit(u?: string): Unit | undefined {
  if (!u) return undefined;
  const key = toLowerClean(u);
  return UNIT_MAP[key];
}

function inferUnitFromTail(tail: string): Unit | undefined {
  const t = toLowerClean(tail);
  if (/\b(பாக்கெட்|packet|pack|pkt)\b/.test(t)) return 'pack';
  if (/\b(பீஸ்|pcs?|piece|pieces)\b/.test(t)) return 'pc';
  if (/\b(கிலோ|kg)\b/.test(t)) return 'kg';
  if (/\b(கிராம்|g)\b/.test(t)) return 'g';
  if (/\b(லிட்டர்|l|ml)\b/.test(t)) return (t.includes('ml') ? 'ml' : 'l');
  return undefined;
}

// size hints
export type Size = 'small' | 'medium' | 'large';
const SIZE_HINTS: Record<string, string> = {
  'small': 'small', 'sm': 'small', 'சிறியது': 'small', 'சின்ன': 'small',
  'medium': 'medium', 'md': 'medium', 'மத்திய': 'medium',
  'big': 'large', 'large': 'large', 'lg': 'large', 'பெரியது': 'large', 'பெரிய': 'large'
};

// ---------------------- Catalog ----------------------------------------------
type CatalogEntry = { canonical: string; synonyms: string[]; category: 'grocery'|'meat'|'seafood' };

const CATALOG: CatalogEntry[] = [
  // Grocery
  { canonical: 'milk', synonyms: ['milk', 'பால்', 'milk packet', 'பால் பாக்கெட்'], category: 'grocery' },
  { canonical: 'curd', synonyms: ['curd', 'தயிர்'], category: 'grocery' },
  { canonical: 'buttermilk', synonyms: ['buttermilk','மோர்'], category: 'grocery' },
  { canonical: 'ghee', synonyms: ['ghee','நெய்'], category: 'grocery' },
  { canonical: 'sugar', synonyms: ['sugar','சர்க்கரை'], category: 'grocery' },
  { canonical: 'salt', synonyms: ['salt','உப்பு'], category: 'grocery' },
  { canonical: 'rice', synonyms: ['rice','அரிசி','பாஸ்மதி','sona masoori','சோனா மசூரி'], category: 'grocery' },
  { canonical: 'wheat flour', synonyms: ['atta','wheat flour','கோதுமை மாவு'], category: 'grocery' },
  { canonical: 'maida', synonyms: ['maida','மைதா'], category: 'grocery' },
  { canonical: 'ragi', synonyms: ['ragi','கேழ்வரகு','ராகி மாவு'], category: 'grocery' },
  { canonical: 'oil', synonyms: ['oil','எண்ணெய்','groundnut oil','செம்யா எண்ணெய்','gingelly oil','நல்லெண்ணெய்','sunflower oil'], category: 'grocery' },
  { canonical: 'dal', synonyms: ['dal','paruppu','பருப்பு','toor dal','thuvaram paruppu','urad dal','ulundhu'], category: 'grocery' },
  { canonical: 'egg', synonyms: ['egg','முட்டை','eggs'], category: 'grocery' },
  { canonical: 'onion', synonyms: ['onion','வெங்காயம்'], category: 'grocery' },
  { canonical: 'tomato', synonyms: ['tomato','தக்காளி'], category: 'grocery' },
  { canonical: 'potato', synonyms: ['potato','உருளைக்கிழங்கு'], category: 'grocery' },

  // Meat / Seafood
  { canonical: 'chicken', synonyms: ['chicken','கோழி'], category: 'meat' },
  { canonical: 'country chicken', synonyms: ['nattu kozhi','நாட்டு கோழி','country chicken'], category: 'meat' },
  { canonical: 'mutton', synonyms: ['mutton','மட்டன்','goat','ஆட்டு மாஸ்'], category: 'meat' },
  { canonical: 'fish', synonyms: ['fish','மீன்'], category: 'seafood' },
  { canonical: 'prawn', synonyms: ['prawn','இறால்','shrimp'], category: 'seafood' },
  { canonical: 'crab', synonyms: ['crab','நண்டு'], category: 'seafood' },
];

const SYN_TO_CANON = new Map<string, { canonical: string; category: CatalogEntry['category'] }>();
for (const row of CATALOG) {
  for (const s of row.synonyms) SYN_TO_CANON.set(toLowerClean(s), { canonical: row.canonical, category: row.category });
  SYN_TO_CANON.set(row.canonical, { canonical: row.canonical, category: row.category });
}

// ---------------------- Cut / Size / Intent -----------------------------------
const CUT_TYPES = [
  'leg','breast','curry cut','biryani cut','mince','keema','boneless','with bone','skinless','fillet','steak','whole','cleaned'
];
const CUT_TYPES_TA = [
  'கால்','மார்பு','கறிவேட்டி','பிரியாணி வெட்டி','மின்ஸ்','கீமா','எலும்பு இல்லாமல்','எலும்பு உடன்','தோல் நீக்கி','துண்டு','முழுதாக','சுத்தம்'
];

function pickCutMeta(text: string) {
  const t = toLowerClean(text);
  const cuts: string[] = [];
  for (const c of CUT_TYPES) if (t.includes(c)) cuts.push(c);
  for (const c of CUT_TYPES_TA) if (t.includes(c)) cuts.push(c);
  return Array.from(new Set(cuts));
}

function pickSizeMeta(text: string): Size | undefined {
  const t = toLowerClean(text);
  for (const [k, v] of Object.entries(SIZE_HINTS))
    if (t.includes(k)) return v as Size;
  return undefined;
}

function isCancelIntent(text: string) {
  const t = toLowerClean(text);
  return t.includes('ரத்து') || t.includes('வேண்டாம்') || t.includes('cancel');
}

function normalizeItemName(raw: string): { canonical: string; category: CatalogEntry['category'] | 'unknown' } {
  const n = toLowerClean(raw);
  const found = SYN_TO_CANON.get(n);
  if (found) return found;
  for (const [k, v] of SYN_TO_CANON.entries())
    if (n.includes(k)) return v;
  const stripped = n.replace(/\b(பாக்கெட்|packet|pkt|pack|பீஸ்|piece|pcs|pc)\b/g, '').trim();
  const found2 = SYN_TO_CANON.get(stripped);
  if (found2) return found2;
  return { canonical: stripped || n, category: 'unknown' };
}

// Title-case ASCII words, preserve Tamil
function titleifyCanon(c: string) {
  return c.split(' ').map(w => (/^[a-z]/.test(w) ? (w.charAt(0).toUpperCase() + w.slice(1)) : w)).join(' ');
}

// ---------------------- Core parser -------------------------------------------
export type ParsedItem = {
  canonical: string;
  qty: number;
  unit?: Unit;
  category?: 'grocery' | 'meat' | 'seafood' | 'unknown';
  meta?: { cut?: string[]; size?: Size };
  raw?: string;
};

export type ParsedMessage = {
  items: ParsedItem[];
  intent: 'order' | 'cancel' | 'unknown';
  customerName?: string | null;
};

export function parseMessage(text: string): ParsedMessage {
  const norm = text.normalize('NFKC');

  const intent: 'order' | 'cancel' | 'unknown' =
    isCancelIntent(norm)
      ? 'cancel'
      : /(\d|[\u0BE6-\u0BEF]|ஒன்று|இரண்டு|மூன்று|நான்கு|ஐந்து|ஆறு|ஏழு|எட்டு|ஒன்பது|பத்து)/.test(norm)
      ? 'order'
      : 'unknown';

  // Robust chunking: commas, slashes, Tamil/English conjunctions, newlines
  const chunks = norm
    .replace(/(\d+)\s*(kg|g|l|ml|packet|pack|pkt|pcs|pc|piece|பாக்கெட்|பீஸ்|கிலோ|கிராம்|லிட்டர்)\s+/gi, '$1 $2 ')
    .split(/[,/&]| மற்றும் | and |\n| plus | also | கூட|உடன்/g)
    .map(s => s.trim())
    .filter(Boolean);

  const results: ParsedItem[] = [];

  for (const ch of chunks) {
    // Prefer: <num or tamilnum or wordnum> <unit?> <tail>
    let m = ch.match(
      /^(\d+|[\u0BE6-\u0BEF]+|[A-Za-z\u0B80-\u0BFF]+)\s*(kg|g|l|ml|packet|pack|pkt|pcs|pc|piece|பாக்கெட்|பீஸ்|கிலோ|கிராம்|லிட்டர்)?\s+(.+)$/i
    );

    if (m) {
      const qraw = m[1];
      const unit0 = normalizeUnit(m[2] as string);
      const tail = m[3];

      let qty = tamilDigitsToNum(qraw);
      if (Number.isNaN(qty)) qty = wordToNum(qraw) || 1;

      const cut = pickCutMeta(tail);
      const size = pickSizeMeta(tail);

      // Clean tail for name detection
      const tailClean = tail
        .replace(/\b(kg|g|l|ml|packet|pack|pkt|pcs|pc|piece|பாக்கெட்|பீஸ்|கிலோ|கிராம்|லிட்டர்)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const { canonical, category } = normalizeItemName(tailClean);

      // Only meat/seafood can keep cut meta
      const allowedForCut =
        category === 'meat' ||
        category === 'seafood' ||
        canonical.includes('chicken') ||
        canonical.includes('mutton') ||
        canonical.includes('fish') ||
        canonical.includes('prawn') ||
        canonical.includes('crab');

      const safeCut = allowedForCut ? cut : [];
      const unit = unit0 || inferUnitFromTail(tail) || undefined;

      if (!canonical) continue;

      results.push({
        canonical,
        qty: qty || 1,
        unit,
        category,
        meta: { cut: safeCut.length ? safeCut : undefined, size },
        raw: ch
      });
      continue;
    }

    // Fallback: bare item → qty 1; infer unit if present in text
    const { canonical, category } = normalizeItemName(ch);
    const cut = pickCutMeta(ch);
    const size = pickSizeMeta(ch);
    const allowedForCut =
      category === 'meat' ||
      category === 'seafood' ||
      canonical.includes('chicken') ||
      canonical.includes('mutton') ||
      canonical.includes('fish') ||
      canonical.includes('prawn') ||
      canonical.includes('crab');
    const unit = inferUnitFromTail(ch);

    if (!canonical) continue;

    results.push({
      canonical,
      qty: 1,
      unit,
      category,
      meta: { cut: (allowedForCut ? cut : []).length ? cut : undefined, size },
      raw: ch
    });
  }

  // Merge duplicates by (canonical, unit, cut, size)
  const merged: Record<string, ParsedItem> = {};
  for (const it of results) {
    const cutSig = it.meta?.cut ? it.meta.cut.slice().sort().join('|') : '';
    const sizeSig = it.meta?.size || '';
    const key = `${toLowerClean(it.canonical)}|${it.unit || ''}|${cutSig}|${sizeSig}`;
    if (!merged[key]) merged[key] = { ...it };
    else merged[key].qty += it.qty;
  }

  // Optional: Title-case canonical for nicer display in UI
  const items = Object.values(merged).map(it => ({
    ...it,
    canonical: titleifyCanon(it.canonical)
  }));

  return { items, intent, customerName: null };
}

// Backward compatibility
export function parseOrder(text: string) {
  return parseMessage(text).items;
}