// src/util/notOrder.ts

export function isNotOrderMessage(text: string): boolean {
    const t = text.trim().toLowerCase();
  
    // A) Hard ignore: just emojis / punctuation / very short replies
    if (/^[\s\p{Emoji}._,!?]+$/u.test(t)) return true;
    if (t.length <= 3) return true; // ok / hi / yo etc.
  
    // B) Greetings & chit-chat
    if (/(hello|hiii+|hi|hey|how are you|good (morning|night|evening)|bro|buddy|machan|dei|da|ok|fine|super|sorry|thank you|thanks|🙏|😂|😍)/i.test(t)) {
      return true;
    }
  
    // C) Bank / promo / spam
    if (/(loan|credit card|offer|discount|festival|deal|insurance|emirates nbd|apply now|cashback|limited time)/i.test(t)) {
      return true;
    }
  
    // D) Inventory **keywords** (products)
    const productWords = [
      "milk","curd","yogurt","paneer","butter","cheese",
      "apple","banana","onion","potato","tomato","carrot","beans","grapes","orange",
      "rice","atta","maida","sugar","salt","dal","lentil","oil","ghee",
      "bread","biscuit","egg","chicken","fish","mutton",
      "shampoo","soap","toothpaste","cream","perfume","spray","juice","water"
    ];
  
    const hasProductWord = productWords.some(w => t.includes(w));
  
    // E) Quantity indicators (so we know it's probably an order)
    const hasQuantity = /\b\d+(\.\d+)?\s?(kg|g|gram|gm|ltr|l|ml|packet|pack|bottle|pc|pcs|piece|pieces|dozen)\b/i.test(t);
  
    // If neither quantity nor product mention → definitely **not** an order
    if (!hasQuantity && !hasProductWord) return true;
  
    return false; // ← keep as potential order/inquiry
  }