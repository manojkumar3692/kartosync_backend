// src/ai/ingest/fuzzyOption.ts

function score(a: string, b: string): number {
    a = a.toLowerCase();
    b = b.toLowerCase();
    let s = 0;
  
    if (a.includes(b)) s += 3;
    if (b.includes(a)) s += 3;
    if (a.startsWith(b)) s += 2;
  
    const words = b.split(/\s+/);
    for (const w of words) if (a.includes(w)) s++;
  
    return s;
  }
  
  // options = ["Chicken Biryani", "Egg Biryani", ...]
  export function fuzzyChooseOption(raw: string, options: string[]) {
    const msg = raw.toLowerCase().trim();
    let best = -1;
    let bestIndex = -1;
  
    options.forEach((opt, i) => {
      const sc = score(opt, msg);
      if (sc > best) {
        best = sc;
        bestIndex = i;
      }
    });
  
    // No strong match
    if (best < 3) return null;
  
    return bestIndex; // 0-based index
  }