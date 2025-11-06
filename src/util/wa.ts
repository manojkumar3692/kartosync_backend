// src/util/wa.ts
export function buildWAWebLink(phoneE164: string, text: string) {
    // web.whatsapp.com / desktop app both respect this format
    const phone = String(phoneE164).replace(/[^\d]/g, ""); // digits only for wa.me style
    const enc = encodeURIComponent(text);
    // Prefer web.whatsapp.com on desktop:
    return `https://web.whatsapp.com/send?phone=${phone}&text=${enc}`;
  }