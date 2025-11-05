import jwt from 'jsonwebtoken';
export function ensureAdmin(req: any, res: any, next: any) {
  try {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const d: any = jwt.verify(t, process.env.JWT_SECRET!);
    if (d?.role !== 'admin') throw new Error('not_admin');
    req.admin_id = d.admin_id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized_admin' });
  }
}