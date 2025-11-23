// src/util/fuzzy.ts
export function normalizeLabelForFuzzy(raw: string): string {
    return String(raw || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // strip accents
      .replace(/[^a-z0-9]+/g, "") // keep only a-z0-9
      .trim();
  }
  
  export function fuzzyCharOverlapScore(a: string, b: string): number {
    const s1 = normalizeLabelForFuzzy(a);
    const s2 = normalizeLabelForFuzzy(b);
    if (!s1 || !s2) return 0;
  
    const set1 = new Set(s1.split(""));
    let matches = 0;
    for (const ch of s2) {
      if (set1.has(ch)) matches++;
    }
    const maxLen = Math.max(s1.length, s2.length);
    if (!maxLen) return 0;
    return matches / maxLen; // 0 → no overlap, 1 → perfect
  }