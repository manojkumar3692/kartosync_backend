// src/routes/testing.ts
import express from "express";
import jwt from "jsonwebtoken";
import { supa } from "../db";

export const testing = express.Router();



function ensureAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    req.org_id = d.org_id;
    next();
  } catch (e) {
    console.error("[testing] Auth error:", e);
    res.status(401).json({ error: "unauthorized" });
  }
}

type BusinessType = "grocery" | "restaurant" | "pharmacy" | "salon" | "generic";


type CatalogRow = {
    canonical: string;
    variant: string;
    price_per_unit: number;
  };

  


  // 🛒 1) Grocery Store
const groceryProducts: CatalogRow[] = [
    { canonical: "Onion",         variant: "Nashik",       price_per_unit: 15 },
    { canonical: "Onion",         variant: "Local",        price_per_unit: 10 },
    { canonical: "Tomato",        variant: "Local",        price_per_unit: 8 },
    { canonical: "Potato",        variant: "New",          price_per_unit: 7 },
    { canonical: "Rice",          variant: "Sona Masoori", price_per_unit: 60 },
    { canonical: "Rice",          variant: "Basmati",      price_per_unit: 90 },
    { canonical: "Atta",          variant: "Wheat Flour",  price_per_unit: 55 },
    { canonical: "Milk",          variant: "Full Cream 1L",price_per_unit: 6 },
    { canonical: "Curd",          variant: "500g",         price_per_unit: 5 },
    { canonical: "Egg",           variant: "12 pcs",       price_per_unit: 10 },
  ];
  
  // 🍛 2) Restaurant / Cloud Kitchen (Birgo)
  const restaurantProducts: CatalogRow[] = [
    { canonical: "Chicken Biryani", variant: "Regular",     price_per_unit: 22 },
    { canonical: "Chicken Biryani", variant: "Spicy",       price_per_unit: 24 },
    { canonical: "Mutton Biryani",  variant: "Regular",     price_per_unit: 32 },
    { canonical: "Veg Biryani",     variant: "Regular",     price_per_unit: 18 },
    { canonical: "Kebab",           variant: "Chicken",     price_per_unit: 18 },
    { canonical: "Kebab",           variant: "Mutton",      price_per_unit: 24 },
    { canonical: "Shawarma",        variant: "Roll",        price_per_unit: 12 },
    { canonical: "Raita",           variant: "Regular",     price_per_unit: 5 },
    { canonical: "Gulab Jamun",     variant: "2 pcs",       price_per_unit: 7 },
    { canonical: "Cold Drink",      variant: "Coke Can",    price_per_unit: 5 },
    { canonical: "Cold Drink",      variant: "Pepsi Can",   price_per_unit: 5 },
    { canonical: "Water",           variant: "Bottle 500ml",price_per_unit: 2 },
  ];
  
  // 💊 3) Pharmacy
  const pharmacyProducts: CatalogRow[] = [
    { canonical: "Paracetamol",      variant: "500mg strip",     price_per_unit: 8 },
    { canonical: "Paracetamol",      variant: "650mg strip",     price_per_unit: 12 },
    { canonical: "Cough Syrup",      variant: "100ml",           price_per_unit: 35 },
    { canonical: "Vitamin C",        variant: "Chewable 10 tabs",price_per_unit: 20 },
    { canonical: "Antacid",          variant: "Sachet 5 pcs",    price_per_unit: 15 },
    { canonical: "Pain Relief Gel",  variant: "30g",             price_per_unit: 55 },
    { canonical: "Face Mask",        variant: "Pack of 50",      price_per_unit: 30 },
    { canonical: "Hand Sanitizer",   variant: "100ml",           price_per_unit: 18 },
    { canonical: "Bandage",          variant: "Roll",            price_per_unit: 10 },
    { canonical: "Digital Thermometer", variant: "Standard",     price_per_unit: 65 },
  ];
  
  // 💇‍♀️ 4) Salon / Beauty
  const salonProducts: CatalogRow[] = [
    { canonical: "Hair Cut",         variant: "Men",             price_per_unit: 25 },
    { canonical: "Hair Cut",         variant: "Women",           price_per_unit: 40 },
    { canonical: "Hair Cut",         variant: "Kids",            price_per_unit: 20 },
    { canonical: "Hair Color",       variant: "Global",          price_per_unit: 120 },
    { canonical: "Facial",           variant: "Gold",            price_per_unit: 150 },
    { canonical: "Facial",           variant: "Cleanup",         price_per_unit: 80 },
    { canonical: "Manicure",         variant: "Basic",           price_per_unit: 60 },
    { canonical: "Pedicure",         variant: "Basic",           price_per_unit: 70 },
    { canonical: "Waxing",           variant: "Full Arms",       price_per_unit: 50 },
    { canonical: "Waxing",           variant: "Full Legs",       price_per_unit: 70 },
  ];

const birgoProducts = [
  { canonical: "Chicken Biryani", variant: "Regular", price_per_unit: 22 },
  { canonical: "Chicken Biryani", variant: "Spicy", price_per_unit: 24 },
  { canonical: "Mutton Biryani", variant: "Regular", price_per_unit: 32 },
  { canonical: "Kebab", variant: "Chicken", price_per_unit: 18 },
  { canonical: "Kebab", variant: "Mutton", price_per_unit: 24 },
  { canonical: "Raita", variant: "Regular", price_per_unit: 5 },
  { canonical: "Gulab Jamun", variant: "2 pcs", price_per_unit: 7 },
  { canonical: "Cold Drink", variant: "Coke Can", price_per_unit: 5 },
  { canonical: "Cold Drink", variant: "Pepsi Can", price_per_unit: 5 },
  { canonical: "Water", variant: "Bottle 500ml", price_per_unit: 2 },
];


// 🔁 Map type → catalog
const catalogsByType: Record<BusinessType, CatalogRow[]> = {
    grocery: groceryProducts,
    restaurant: restaurantProducts,
    pharmacy: pharmacyProducts,
    salon: salonProducts,
    generic: [],
  };


// You can add groceryProducts, pharmacyProducts etc later…
testing.post(
    "/switch-business",
    ensureAuth,
    express.json(),
    async (req: any, res) => {
      try {
        const org_id = req.org_id as string;
        const mode = String(req.body?.type || "").toLowerCase() as BusinessType;
  
        if (!["grocery", "restaurant", "pharmacy", "salon", "generic"].includes(mode)) {
          return res.status(400).json({ error: "invalid_type" });
        }
  
        // 1) Clear org data (test-only)
        const orgFilter = { org_id };
  
        const tablesToClear = [
          "order_clarify_sessions",
          "clarify_links",
          "waba_flow_logs",
          "messages",
          "conversations",
          "orders",
          "products",
          "product_aliases",
          "brand_variant_stats",
          "customer_prefs",
          "org_customer_settings",
          "org_store_auto_reply_settings",
          "org_customer_auto_reply_settings",
        ] as const;
  
        for (const table of tablesToClear) {
          const { error } = await supa.from(table).delete().match(orgFilter);
          if (error && error.code !== "42P01") {
            console.warn(`[testing][switch-business] clear ${table} warn:`, error.message);
          }
        }
  
        // 2) Insert catalog for chosen business type
        const catalog = catalogsByType[mode] || [];
  
        if (catalog.length) {
          const rows = catalog.map((p) => ({
            org_id,
            canonical: p.canonical,
            variant: p.variant,
            price_per_unit: p.price_per_unit,
            dynamic_price: false,
          }));
  
          const { error: insErr } = await supa.from("products").insert(rows);
          if (insErr) throw insErr;
        }
  
        // 3) Update org store_type
        const { error: orgErr } = await supa
          .from("orgs")
          .update({ store_type: mode })
          .eq("id", org_id);
  
        if (orgErr) throw orgErr;
  
        return res.json({
          ok: true,
          org_id,
          store_type: mode,
          products_inserted: catalog.length,
        });
      } catch (e: any) {
        console.error("[testing][switch-business] ERR", e?.message || e);
        return res
          .status(500)
          .json({ error: e?.message || "switch_business_failed" });
      }
    }
  );

export default testing;