import express from 'express';
import jwt from 'jsonwebtoken';
import { supa } from '../db';

export const ordersFeedback = express.Router();

function ensureAuth(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    req.org_id = d.org_id;
    next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

ordersFeedback.post('/:orderId/feedback', ensureAuth, async (req: any, res) => {
  const { orderId } = req.params;
  const { raw_text, corrected_items } = req.body || {};
  if (!raw_text || !Array.isArray(corrected_items)) {
    return res.status(400).json({ error: 'bad_payload' });
  }
  await supa.from('parser_feedback').insert({
    org_id: req.org_id,
    order_id: orderId,
    raw_text,
    corrected_items
  });
  return res.json({ ok: true });
});