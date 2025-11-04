import { createClient } from '@supabase/supabase-js';

export const supa = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!,   // MUST be service role (not anon)
  { auth: { persistSession: false } }
);