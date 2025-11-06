// src/routes/clarify.ts
import express from 'express';
import { supa } from '../db';
import { verifyClarifyToken, sha256 } from '../util/clarifyToken';

export const clarify = express.Router();

const SECRET = process.env.CLARIFY_SECRET || '';
const HTML_CSP = "default-src 'self' https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com;";

// -------------- HTML page --------------
clarify.get('/c/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const payload = verifyClarifyToken(token, SECRET);
  if (!payload) {
    return res
      .status(400)
      .send(`<!doctype html><meta charset="utf-8"><title>Link expired</title><div style="font:14px system-ui;padding:24px">Link expired or invalid. Please request a new link.</div>`);
  }

  const askBrand = !!payload.ask?.brand;
  const askVariant = !!payload.ask?.variant;
  const allowOther = payload.allow_other !== false;

  res.setHeader('Content-Security-Policy', HTML_CSP);
  res.send(`<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Confirm your item</title>
<script src="https://cdn.tailwindcss.com"></script>
<body class="bg-gray-50">
  <div class="max-w-md mx-auto p-5">
    <div class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div class="text-lg font-semibold">Help us confirm your item</div>
      <p class="text-sm text-gray-600 mt-1">Please tap the exact option below:</p>
      <div class="mt-4 grid gap-2">
        ${payload.options.map((opt:any, i) => `
          <form method="post" action="/api/clarify" class="contents">
            <input type="hidden" name="token" value="${token}" />
            <input type="hidden" name="choice" value="${i}" />
            <button class="w-full text-left rounded-lg border border-gray-200 px-3 py-2 hover:bg-gray-50">
              <div class="font-medium flex items-center gap-2">
  ${escapeHtml(opt.label)}
  ${opt.rec ? '<span class="text-[10px] rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5">Recommended</span>' : ''}
</div>
              <div class="text-xs text-gray-500">${escapeHtml(
                [opt.canonical, opt.brand, opt.variant].filter(Boolean).join(' · ')
              )}</div>
            </button>
          </form>`).join('')}
      </div>

      ${allowOther ? `
      <div class="mt-5 pt-4 border-t border-gray-100">
        <div class="text-sm font-medium text-gray-900">Or tell us exactly:</div>
        <form method="post" action="/api/clarify" class="mt-2 grid gap-2">
          <input type="hidden" name="token" value="${token}" />
          <input type="hidden" name="choice" value="-1" />
          ${askBrand ? `
            <div>
              <label class="block text-xs text-gray-500 mb-1">Brand</label>
              <input name="other_brand" class="w-full rounded-md border border-gray-200 px-3 py-2" placeholder="e.g., Maggi" />
            </div>
          ` : ``}
          ${askVariant ? `
            <div>
              <label class="block text-xs text-gray-500 mb-1">Variant</label>
              <input name="other_variant" class="w-full rounded-md border border-gray-200 px-3 py-2" placeholder="e.g., Masala 70g" />
            </div>
          ` : ``}
          <button class="rounded-lg bg-black text-white px-3 py-2 text-sm hover:bg-black/90">Submit</button>
        </form>
      </div>` : ``}

      <p class="text-xs text-gray-500 mt-4">This link will auto-update your order. Thanks!</p>
    </div>
  </div>
</body>
</html>`);
});
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// -------------- POST /api/clarify --------------
clarify.post('/api/clarify', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const token = String(req.body?.token || '');
    const choice = Number(req.body?.choice);
    const ua = String(req.headers['user-agent'] || '');
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '';

    const payload = verifyClarifyToken(token, SECRET);
    if (!payload) {
      return res.status(400).send(plainMsg('Link expired or invalid. Please request a new link.'));
    }

    const { org_id, order_id, line_index, options } = payload as {
      org_id: string;
      order_id: string;
      line_index: number;
      options: Array<{ label: string; canonical: string; brand?: string | null; variant?: string | null }>;
      ask?: { brand?: boolean; variant?: boolean };
    };

    const askBrand = !!payload.ask?.brand;
    const askVariant = !!payload.ask?.variant;

    // Resolve selection
    let selected: { label: string; canonical: string; brand?: string | null; variant?: string | null } | null = null;

    if (!Number.isNaN(choice) && choice >= 0 && choice < options.length) {
      selected = options[choice];
    } else if (choice === -1) {
      // "Other" path (free-text submitted from the form)
      const ob = (String(req.body?.other_brand || '').trim()) || null;
      const ov = (String(req.body?.other_variant || '').trim()) || null;

      // If we explicitly asked for a field, require it
      if ((askBrand && !ob) || (askVariant && !ov)) {
        return res.status(400).send(plainMsg('Please fill the required field(s).'));
      }
      selected = {
        label: [options?.[0]?.canonical || 'item', ob || undefined, ov || undefined].filter(Boolean).join(' '),
        canonical: options?.[0]?.canonical || 'item',
        brand: ob,
        variant: ov,
      };
    } else {
      return res.status(400).send(plainMsg('Invalid choice.'));
    }

    // Load & update order line  (NOTE: include source_phone for learn-writes)
    const { data: rows, error: e1 } = await supa
      .from('orders')
      .select('id, org_id, items, status, source_phone')
      .eq('id', order_id)
      .eq('org_id', org_id)
      .limit(1);
    if (e1) throw e1;

    const order = rows?.[0];
    if (!order) return res.status(404).send(plainMsg('Order not found.'));

    const items = Array.isArray(order.items) ? order.items : [];
    if (line_index < 0 || line_index >= items.length) {
      return res.status(400).send(plainMsg('Line index out of range.'));
    }

    const line = { ...items[line_index] };
    line.canonical = selected!.canonical || line.canonical || line.name || '';
    if (askBrand)   line.brand   = selected!.brand ?? null;
    if (askVariant) line.variant = selected!.variant ?? null;

    const newItems = items.slice();
    newItems[line_index] = line;

    const { error: e2 } = await supa
      .from('orders')
      .update({
        items: newItems,
        parse_reason: choice === -1 ? 'clarified_other' : 'clarified_choice',
      })
      .eq('id', order_id)
      .eq('org_id', org_id);
    if (e2) throw e2;

    // Log the clarification event
    await supa.from('clarifications').insert({
      org_id,
      order_id,
      line_index,
      selection: selected as any,
      options: options as any,
      token_hash: sha256(token),
      user_agent: ua,
      ip: ip as any,
    });

    // ── B1: Write learnings (non-fatal if they fail)
    try {
      const phone = order.source_phone || null;
      const canon = String(selected!.canonical || line.canonical || line.name || '').trim();
      const brand = selected!.brand ?? null;
      const variant = selected!.variant ?? null;

      if (phone && canon) {
        const { error: ecp } = await supa.rpc('upsert_customer_pref', {
          p_org_id: org_id,
          p_phone: phone,
          p_canonical: canon,
          p_brand: brand,
          p_variant: variant,
          p_inc: 1,
        });
        if (ecp) {
          console.warn('[LEARN][customer_pref][ERR]', ecp.message);
        } else {
          console.log('[LEARN][customer_pref][OK]', { org_id, phone, canon, brand, variant });
        }
      }

      if (canon) {
        const { error: ebvs } = await supa.rpc('upsert_bvs', {
          p_org_id: org_id,
          p_canonical: canon,
          p_brand: brand,
          p_variant: variant,
          p_inc: 1,
        });
        if (ebvs) {
          console.warn('[LEARN][bvs][ERR]', ebvs.message);
        } else {
          console.log('[LEARN][bvs][OK]', { org_id, canon, brand, variant });
        }
      }
    } catch (e) {
      console.warn('[LEARN][clarify][non-fatal]', (e as any)?.message || e);
    }

    // Thank-you page
    return res.send(`<!doctype html>
<meta charset="utf-8" />
<title>Thanks!</title>
<link rel="preconnect" href="https://cdn.tailwindcss.com">
<script src="https://cdn.tailwindcss.com"></script>
<div class="min-h-[60vh] grid place-items-center bg-gray-50">
  <div class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm text-center">
    <div class="text-3xl mb-2">✅</div>
    <div class="text-lg font-semibold">Noted</div>
    <div class="text-sm text-gray-600 mt-1">We’ve updated your order.</div>
  </div>
</div>`);
  } catch (err: any) {
    console.error('[clarify]', err?.message || err);
    return res.status(500).send(plainMsg('Something went wrong. Please try again later.'));
  }
});

function plainMsg(msg: string) {
  return `<!doctype html><meta charset="utf-8"><div style="font:14px system-ui;padding:24px">${escapeHtml(msg)}</div>`;
}

export default clarify;