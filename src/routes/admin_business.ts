// src/routes/admin_business.ts
import express from "express";
import { supa } from "../db";
import { v4 as uuidv4 } from "uuid";

export const adminBusiness = express.Router();

// ---------------------------
// 1) Templates for each type
// ---------------------------
const TEMPLATES: Record<string, any[]> = {
  grocery: [
    { canonical: "Onion", category: "Vegetables", unit: "kg" },
    { canonical: "Tomato", category: "Vegetables", unit: "kg" },
    { canonical: "Potato", category: "Vegetables", unit: "kg" },
    { canonical: "Milk", category: "Dairy", unit: "1L pack" },
    { canonical: "Rice", category: "Grains", unit: "5kg bag" }
  ],

  restaurant: [
    { canonical: "Chicken Biryani", category: "Main Course", unit: "plate" },
    { canonical: "Mutton Biryani", category: "Main Course", unit: "plate" },
    { canonical: "Chicken 65", category: "Starters", unit: "plate" },
    { canonical: "Parotta", category: "Bread", unit: "piece" }
  ],

  meat: [
    { canonical: "Chicken Boneless", category: "Chicken", unit: "kg" },
    { canonical: "Chicken Curry Cut", category: "Chicken", unit: "kg" },
    { canonical: "Mutton", category: "Goat Meat", unit: "kg" },
    { canonical: "Eggs", category: "Poultry", unit: "12 pack" }
  ],

  salon: [
    { canonical: "Men Haircut", product_type: "service", unit: "service" },
    { canonical: "Women Haircut", product_type: "service", unit: "service" },
    { canonical: "Hair Spa", product_type: "service", unit: "service" },
    { canonical: "Beard Trim", product_type: "service", unit: "service" }
  ],

  pharmacy: [
    { canonical: "Paracetamol 500mg", category: "Medicines", unit: "strip" },
    { canonical: "ORS", category: "Medicines", unit: "pack" },
    { canonical: "Bandage Roll", category: "First Aid", unit: "piece" }
  ]
};

// ---------------------------
// 2) API: SWITCH BUSINESS TYPE
// ---------------------------
adminBusiness.post("/switch", async (req, res) => {
  try {
    const { org_id, business_type } = req.body || {};

    if (!org_id || !business_type) {
      return res.status(400).json({
        ok: false,
        error: "org_id and business_type required"
      });
    }

    if (!TEMPLATES[business_type]) {
      return res.status(400).json({
        ok: false,
        error: "Invalid business_type"
      });
    }

    // Update org
    await supa
      .from("orgs")
      .update({ business_type })
      .eq("id", org_id);

    // Delete old products for this org
    await supa
      .from("products")
      .delete()
      .eq("org_id", org_id);

    // Insert template products
    const templateList = TEMPLATES[business_type].map((p) => ({
      id: uuidv4(),
      org_id,
      canonical: p.canonical,
      category: p.category || null,
      brand: p.brand || null,
      variant: p.variant || null,
      product_type: p.product_type || "item",
      unit: p.unit || null,
      active: true
    }));

    const { error: insertErr } = await supa
      .from("products")
      .insert(templateList);

    if (insertErr)
      throw insertErr;

    return res.json({
      ok: true,
      business_type,
      inserted: templateList.length
    });

  } catch (err: any) {
    console.error("[API][business switch]", err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

export default adminBusiness;