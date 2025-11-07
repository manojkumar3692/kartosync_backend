export type ReasonFlags = {
    edited: boolean;
    merged: boolean;
    inquiryKind: string | null; // e.g. "price" from "inq:price"
    msgId: string | null;       // from "msgid:abc123"
    editedAt: number | null;    // epoch ms from "edited_at:1730796543123"
    raw: string;
  };
  
  const pick = (re: RegExp, s: string): string | null => {
    const m = re.exec(s);
    return m ? (m[1] || m[0]).trim() : null;
  };
  
  export function parseReasonFlags(reason?: string | null): ReasonFlags {
    const raw = String(reason || "");
    const low = raw.toLowerCase();
  
    const edited = /\bedited_replace\b/.test(low);
    const merged = /\bmerged_append\b/.test(low);
  
    const inquiryKind = pick(/\binq:([a-z0-9_-]+)\b/i, raw);
    const msgId = pick(/\bmsgid:([^\s;]+)\b/i, raw);
  
    const editedAtStr = pick(/\bedited_at:(\d{10,})\b/i, raw);
    const editedAt = editedAtStr ? Number(editedAtStr) : null;
  
    return { edited, merged, inquiryKind, msgId, editedAt, raw };
  }