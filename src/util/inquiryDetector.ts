export function detectInquiry(text: string) {
    const t = text.toLowerCase().trim();
  
    const inquiryWords = ["price", "rate", "how much", "cost", "available", "in stock"];
  
    const productKeywords = t.split(/\s+/);
  
    const isInquiry = inquiryWords.some((w) => t.includes(w));
  
    return { isInquiry, productKeywords };
  }