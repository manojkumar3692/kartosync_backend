import { fuzzyCharOverlapScore, normalizeLabelForFuzzy } from "../../util/fuzzy";
import { recordAliasConfirmation } from "./aliasEngine";

// Learn aliases from confirmed ORDER items
export async function learnAliasesFromOrder(opts: {
    org_id: string;
    from_phone: string;
    text: string;      // original user message (or parserText)
    items: any[];      // parsed items (after product_router)
  }) {
    const { org_id, from_phone, text, items } = opts;
  
    try {
      if (!items || !items.length) return;
  
      const wrongRaw = (text || "").trim();
      if (!wrongRaw) return;
  
      // Normalise the "wrong" label (what the user actually typed)
      const wrongNorm = normalizeLabelForFuzzy(wrongRaw);
      if (!wrongNorm || wrongNorm.length < 3) return;
  
      for (const it of items) {
        if (!it) continue;
  
        // We need a concrete product id to tie alias to
        const productId = (it.product_id as string) || null;
        if (!productId) continue;
  
        const labelRaw = String(it.canonical || it.name || "").trim();
        if (!labelRaw) continue;
  
        const labelNorm = normalizeLabelForFuzzy(labelRaw);
        if (!labelNorm || labelNorm.length < 3) continue;
  
        // If user already typed something almost identical (like exact label),
        // no need to create alias — we want aliases for "chicken marriage" type.
        const score = fuzzyCharOverlapScore(wrongNorm, labelNorm);
  
        // If it's too low, it's random; if it's basically identical (>=0.98),
        // alias isn't very useful.
        if (score < 0.5 || score >= 0.98) continue;
  
        await recordAliasConfirmation({
          org_id,
          customer_phone: from_phone,
          wrong_text: wrongRaw,
          canonical_product_id: productId,
          confidence: score, // store how close it was
        });
      }
    } catch (e: any) {
      console.warn("[learnAliasesFromOrder err]", e?.message || e);
    }
  }