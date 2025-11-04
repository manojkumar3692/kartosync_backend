// src/routes/auth.ts
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { supa } from '../db';

export const auth = express.Router();

function sign(org_id: string) {
  return jwt.sign({ org_id }, process.env.JWT_SECRET!, { expiresIn: '14d' });
}

// POST /api/auth/signup  {name, phone, password}
auth.post('/signup', async (req, res) => {
  try {
    const { name, phone, password } = req.body || {};
    if (!name || !phone || !password) return res.status(400).json({ error: 'name_phone_password_required' });

    const hash = await bcrypt.hash(password, 10);

    const { data, error } = await supa
      .from('orgs')
      .insert({
        name,
        phone,
        password_hash: hash,
        // map WhatsApp ID to login phone so webhooks/companion map correctly
        wa_phone_number_id: String(phone)
      })
      .select('*')
      .limit(1);

    if (error) {
      // if duplicate phone
      if ((error as any).code === '23505') return res.status(409).json({ error: 'phone_in_use' });
      throw error;
    }

    const org = data![0];
    const token = sign(org.id);
    res.json({ token, org });
  } catch (e: any) {
    console.error('signup error', e);
    res.status(500).json({ error: e.message || 'signup_failed' });
  }
});

// POST /api/auth/login {phone, password}
auth.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) return res.status(400).json({ error: 'phone_password_required' });

    const { data, error } = await supa.from('orgs').select('*').eq('phone', String(phone)).limit(1);
    if (error) throw error;
    const org = data?.[0];
    if (!org) return res.status(404).json({ error: 'org_not_found' });

    if (!org.password_hash) return res.status(401).json({ error: 'password_not_set' });

    const ok = await bcrypt.compare(password, org.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const token = sign(org.id);
    res.json({ token, org });
  } catch (e: any) {
    console.error('login error', e);
    res.status(500).json({ error: e.message || 'login_failed' });
  }
});

// POST /api/auth/set-password-first {phone, password}
// Allows setting a password ONLY if none exists yet.
auth.post('/set-password-first', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) return res.status(400).json({ error: 'phone_password_required' });

    const { data, error } = await supa.from('orgs').select('*').eq('phone', String(phone)).limit(1);
    if (error) throw error;
    const org = data?.[0];
    if (!org) return res.status(404).json({ error: 'org_not_found' });
    if (org.password_hash) return res.status(409).json({ error: 'already_has_password' });

    const hash = await bcrypt.hash(password, 10);
    const { error: upErr } = await supa.from('orgs').update({ password_hash: hash }).eq('id', org.id);
    if (upErr) throw upErr;

    // (optional) also ensure wa_phone_number_id matches login phone
    await supa.from('orgs').update({ wa_phone_number_id: String(phone) }).eq('id', org.id);

    // return a token so user is logged-in immediately
    const token = sign(org.id);
    res.json({ token, org: { ...org, password_hash: hash, wa_phone_number_id: String(phone) } });
  } catch (e: any) {
    console.error('set-password-first error', e);
    res.status(500).json({ error: e.message || 'set_password_failed' });
  }
});