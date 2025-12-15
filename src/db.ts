import { createClient } from '@supabase/supabase-js';
console.log("[DB] Using service role?", String(process.env.SUPABASE_SERVICE_ROLE || "").startsWith("sb_secret_"));
console.log("[DB] SUPABASE_SERVICE_ROLE len", (process.env.SUPABASE_SERVICE_ROLE || "").length);
console.log("[DB] SUPABASE_ANON_KEY len", (process.env.SUPABASE_ANON_KEY || "").length);
export const supa = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!,   // MUST be service role (not anon)
  { auth: { persistSession: false } }
);