import express from 'express';
import { supa } from '../db';

export const availability = express.Router();

/**
 * Simple availability lookup by canonical.
 * Table assumption (optional): products(org_id, canonical, in_stock bool)
 * If you don't have 'products', always return {found:false}.
 */
availability.get('/', async (req, res) => {
  try {
    const { q, org_id } = req.query as { q?: string; org_id?: string };
    if (!q || !org_id) return res.status(400).json({ ok: false, error: 'q_and_org_id_required' });

    const { data, error } = await supa
      .from('products')
      .select('canonical, in_stock, updated_at')
      .eq('org_id', org_id)
      .ilike('canonical', String(q))
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    if (!data || !data[0]) return res.json({ ok: true, found: false });

    const p = data[0];
    return res.json({
      ok: true,
      found: true,
      item: {
        canonical: p.canonical,
        in_stock: !!p.in_stock,
        updated_at: p.updated_at,
      },
    });
  } catch (e: any) {
    console.error('[availability]', e?.message || e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default availability;