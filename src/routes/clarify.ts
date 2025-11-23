// src/routes/clarify.ts
import express from 'express';
import { supa } from '../db';
import { verifyClarifyToken, sha256 } from '../util/clarifyToken';
import resolvePhoneForOrder, { normalizePhone } from '../util/normalizePhone';

export const clarify = express.Router();

const SECRET = process.env.CLARIFY_SECRET || '';
const CLARIFY_MAX_OPTIONS = Number(process.env.CLARIFY_MAX_OPTIONS || 5);
const HTML_CSP =
  "default-src 'self' https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com;";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const plainMsg = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><div style="font:14px system-ui;padding:24px">${escapeHtml(msg)}</div>`;
const trim = (v: any) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const nz = (v: any) => (v == null ? '' : String(v)); // '' allowed for generic

type ClarifyOption = {
  label: string;
  canonical: string;
  brand?: string | null;
  variant?: string | null;
  unit?: string | null;
  rec?: boolean;     // recommended flag (optional in token; we normalize below)
  score?: number;    // optional score (if upstream added one)
};

/** Normalize options for both GET and POST (dedupe, rank, cap, ensure single rec) */
function processOptions(input: ClarifyOption[] = []): ClarifyOption[] {
  // 1) De-dupe by canonical+brand+variant+unit (case-insensitive)
  const seen = new Set<string>();
  const uniq = input.filter((o) => {
    const k = [
      (o.canonical || '').toLowerCase(),
      (o.brand || '').toLowerCase(),
      (o.variant || '').toLowerCase(),
      (o.unit || '').toLowerCase(),
    ].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 2) Sort by score desc if present, otherwise keep original order
  const ranked = uniq.slice().sort((a, b) => {
    const sa = typeof a.score === 'number' ? a.score! : 0;
    const sb = typeof b.score === 'number' ? b.score! : 0;
    return sb - sa;
  });

  // 3) Cap to max N
  let top = ranked.slice(0, Math.max(1, CLARIFY_MAX_OPTIONS));

  // 4) Ensure exactly one `rec`:
  //    - prefer the first that already has rec=true
  //    - else mark index 0
  const existingIdx = top.findIndex((o) => !!o.rec);
  const recIdx = existingIdx >= 0 ? existingIdx : 0;
  top = top.map((o, i) => ({ ...o, rec: i === recIdx }));

  return top;
}

// -------------- HTML page --------------
clarify.get('/c/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const payload = verifyClarifyToken(token, SECRET);
  if (!payload) {
    return res
      .status(400)
      .send(
        `<!doctype html><meta charset="utf-8"><title>Link expired</title><div style="font:14px system-ui;padding:24px">Link expired or invalid. Please request a new link.</div>`
      );
  }

  const askBrand = !!payload.ask?.brand;
  const askVariant = !!payload.ask?.variant;
  const allowOther = payload.allow_other !== false;

  // Normalize options here for consistent rendering & indices
  const options: ClarifyOption[] = processOptions(payload.options || []);

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
        ${options
          .map(
            (opt: any, i: number) => `
          <form method="post" action="/api/clarify" class="contents">
            <input type="hidden" name="token" value="${token}" />
            <input type="hidden" name="choice" value="${i}" />
            <button class="w-full text-left rounded-lg border border-gray-200 px-3 py-2 hover:bg-gray-50">
              <div class="font-medium flex items-center gap-2">
                ${escapeHtml(opt.label)}
                ${opt.rec ? '<span class="text-[10px] rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5">Recommended</span>' : ''}
              </div>
              <div class="text-xs text-gray-500">${escapeHtml(
                [opt.canonical, opt.brand, opt.variant, opt.unit].filter(Boolean).join(' · ')
              )}</div>
            </button>
          </form>`
          )
          .join('')}
      </div>

      ${allowOther
        ? `
      <div class="mt-5 pt-4 border-t border-gray-100">
        <div class="text-sm font-medium text-gray-900">Or tell us exactly:</div>
        <form method="post" action="/api/clarify" class="mt-2 grid gap-2">
          <input type="hidden" name="token" value="${token}" />
          <input type="hidden" name="choice" value="-1" />
          ${askBrand ? `
            <div>
              <label class="block text-xs text-gray-500 mb-1">Brand</label>
              <input name="other_brand" class="w-full rounded-md border border-gray-200 px-3 py-2" placeholder="e.g., Maggi" />
            </div>` : ``}
          ${askVariant ? `
            <div>
              <label class="block text-xs text-gray-500 mb-1">Variant</label>
              <input name="other_variant" class="w-full rounded-md border border-gray-200 px-3 py-2" placeholder="e.g., Masala 70g" />
            </div>` : ``}
          <button class="rounded-lg bg-black text-white px-3 py-2 text-sm hover:bg-black/90">Submit</button>
        </form>
      </div>` : ``}

      <p class="text-xs text-gray-500 mt-4">This link will auto-update your order. Thanks!</p>
    </div>
  </div>
</body>
</html>`);
});

// GET /api/orders/:id/clarify-prompt
clarify.get("/:orderId/clarify-prompt", async (req, res) => {
  try {
    const org_id = String(req.query.org_id || "");
    const orderId = String(req.params.orderId || "");
    if (!org_id || !orderId) {
      return res.json({ ok: false, text: "" });
    }

    const { data: order, error } = await supa
      .from("orders")
      .select("id, items, source_phone")
      .eq("org_id", org_id)
      .eq("id", orderId)
      .single();

    if (error || !order || !Array.isArray(order.items)) {
      return res.json({ ok: false, text: "" });
    }

    const lines: string[] = [];
    lines.push("Got your order ✅\n");

    for (const it of order.items) {
      const canon = (it.canonical || it.name || "").trim();
      if (!canon) continue;

      // Fetch variants for this item
      const { data: prods } = await supa
        .from("products")
        .select("variant")
        .eq("org_id", org_id)
        .eq("canonical", canon);

      if (!prods || !prods.length) continue;

      const variants = Array.from(
        new Set(
          prods
            .map((p: any) => String(p.variant || "").trim())
            .filter(Boolean)
        )
      );

      if (variants.length <= 1) {
        // no real choice → no clarify needed for this item
        continue;
      }

      const currentVariant = String(it.variant || "").trim();

      if (!currentVariant) {
        // Case 1: no variant yet → ask
        lines.push(
          `• For *${canon}*, which variant do you prefer? (${variants.join(
            " / "
          )})`
        );
      } else {
        // Case 2: variant already chosen (from prefs/router)
        // Optional: check if this matches user's usual variant
        let fromUsual = false;
        if (order.source_phone) {
          const phonePlain = String(order.source_phone).replace(/^\+/, "");
          const { data: cp } = await supa
            .from("customer_prefs")
            .select("variant")
            .eq("org_id", org_id)
            .eq("phone", phonePlain)
            .eq("canonical", canon)
            .order("score", { ascending: false })
            .limit(1);

          if (cp && cp[0] && cp[0].variant) {
            const usual = String(cp[0].variant).trim().toLowerCase();
            if (usual && usual === currentVariant.toLowerCase()) {
              fromUsual = true;
            }
          }
        }

        if (fromUsual) {
          lines.push(
            `• For *${canon}*, we used your usual: *${currentVariant}*. ` +
              `If you want to change, just reply like “make ${canon} ${variants
                .filter((v) => v !== currentVariant)
                .join(" / ")}”.`
          );
        } else {
          lines.push(
            `• For *${canon}*, we selected *${currentVariant}*. ` +
              `If you want a different variant, just reply “change ${canon} to <variant>”.`
          );
        }
      }
    }

    if (lines.length <= 1) {
      // nothing to clarify
      return res.json({ ok: false, text: "" });
    }

    const text = lines.join("\n");
    return res.json({ ok: true, text });
  } catch (e: any) {
    console.warn("[clarify-prompt] err", e?.message || e);
    return res.json({ ok: false, text: "" });
  }
});

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

    const { org_id, order_id, line_index } = payload as {
      org_id: string;
      order_id: string;
      line_index: number;
      options: ClarifyOption[];
      ask?: { brand?: boolean; variant?: boolean };
      source_phone?: string | null;   // ← may be present from token
      customer_name?: string | null;  // ← optional
    };

    const askBrand = !!payload.ask?.brand;
    const askVariant = !!payload.ask?.variant;

    // IMPORTANT: normalize the same way as GET to keep indices aligned
    const options: ClarifyOption[] = processOptions((payload as any).options || []);

    // Idempotency hint
    try {
      const { data: prev } = await supa
        .from('clarifications')
        .select('id, created_at')
        .eq('token_hash', sha256(token))
        .limit(1);
      if (prev && prev[0]) {
        console.warn('[clarify] token reused; continuing', { order_id, line_index });
      }
    } catch (_) {}

    // Resolve selection
    let selected: ClarifyOption | null = null;

    if (!Number.isNaN(choice) && choice >= 0 && choice < options.length) {
      selected = options[choice];
    } else if (choice === -1) {
      const ob = trim(req.body?.other_brand || '') || null;
      const ov = trim(req.body?.other_variant || '') || null;
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

    // Load order
    const { data: rows, error: e1 } = await supa
      .from('orders')
      .select('id, org_id, items, status, source_phone, customer_name')
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

    // Apply line updates
    const line = { ...items[line_index] };
    line.canonical = trim(selected!.canonical || line.canonical || line.name || '');
    if (askBrand) line.brand = selected!.brand ?? null;
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

    // Log the clarification
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

    // ── Learning writes
    try {
      // Prefer phone embedded in token, else resolver fallback
      const tokenPhone = normalizePhone((payload as any)?.source_phone || '');
      const phone =
        tokenPhone ||
        (await resolvePhoneForOrder(org_id, order_id, order.customer_name)) ||
        '';

      const canon = trim(selected!.canonical || line.canonical || line.name || '');
      const brand = nz(selected!.brand ?? (askBrand ? '' : line.brand ?? ''));
      const variant = nz(selected!.variant ?? (askVariant ? '' : line.variant ?? ''));

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
      } else {
        console.warn('[LEARN][customer_pref][SKIP] missing phone or canonical', { phone: !!phone, canon: !!canon });
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

export default clarify;