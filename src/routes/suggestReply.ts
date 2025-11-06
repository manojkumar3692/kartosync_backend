// src/routes/suggestReply.ts
import express from "express";
import { supa } from "../db";

export const suggestReply = express.Router();

const asStr = (v:any)=> typeof v==="string"?v: v==null? "": String(v);
const trim = (v:any)=> asStr(v).trim();
const toNull = (v:any)=> { const t=trim(v); return t? t:null };

suggestReply.post("/", express.json(), async (req, res) => {
  try {
    const { org_id, customer_phone, message } = req.body || {};
    if (!org_id || !customer_phone || !message) {
      return res.status(400).json({ ok:false, error:"org_id, customer_phone, message required" });
    }

    // Very light canonical guess (feel free to replace with your rule parser)
    const q = trim(message).toLowerCase();
    let canonical = "";
    if (/milk|பால்|doodh/.test(q)) canonical = "Milk";
    else if (/nood(le|les)|maggi|indomie/.test(q)) canonical = "Noodles";
    else if (/water|mai dubai|masafi/.test(q)) canonical = "Water";
    else if (/oil|sunflower|corn/.test(q)) canonical = "Cooking Oil";
    else {
      const m = q.match(/[a-zA-Z]+/);
      canonical = m ? m[0].charAt(0).toUpperCase()+m[0].slice(1).toLowerCase() : "Item";
    }

    // Pull top store-level combos for this canonical (from your learn table)
    const { data: bvs } = await supa
      .from("brand_variant_stats")
      .select("brand, variant, cnt")
      .eq("org_id", org_id)
      .eq("canonical", canonical)
      .order("cnt", { ascending: false })
      .limit(5);

    const combos = (bvs||[]).map(r=>({
      brand: toNull(r.brand),
      variant: toNull(r.variant),
      cnt: Number(r.cnt||0)
    }));

    const lines: string[] = [];
    if (combos.length) {
      lines.push(`${canonical} available ✅`);
      combos.slice(0,3).forEach((c,i)=>{
        const parts = [c.brand, c.variant].filter(Boolean).join(" · ");
        lines.push(`${i+1}) ${parts || "Generic"} — reply ${i+1}`);
      });
      lines.push(`\nReply with number to confirm. Need a photo? Reply "photo".`);
    } else {
      // fallback
      if (canonical === "Milk") {
        lines.push(`Milk available ✅`);
        lines.push(`1) Almarai · Full Fat 1L`);
        lines.push(`2) Al Rawabi · Low Fat 1L`);
        lines.push(`\nReply 1 or 2 to confirm. Need a photo? Reply "photo".`);
      } else {
        lines.push(`${canonical} available ✅`);
        lines.push(`Reply "options" to see brands or "photo" for image.`);
      }
    }

    const suggested_text = lines.join("\n");
    return res.json({ ok:true, canonical, suggested_text });
  } catch (e:any) {
    console.error("[suggest-reply]", e?.message || e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});

export default suggestReply;