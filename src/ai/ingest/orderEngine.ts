// src/ai/ingest/orderEngine.ts

import { supa } from "../../db";
import { loadActiveProducts, ProductRow } from "./productLoader";
import { findCanonicalMatches } from "./textMatchEngine";
import { setState, clearState } from "./stateManager";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { findVariantMatches } from "./variantEngine";

// temp_selected_items row
type TempRow = {
  org_id: string;
  customer_phone: string;
  item: any | null;
  list: any[] | null;
  updated_at?: string;
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function chooseBestVariant(variants: ProductRow[], raw: string): ProductRow | null {
  const q = raw.toLowerCase().trim();
  if (!q) return null;

  const tokens = q.split(/\s+/).filter(t => t.length > 2);
  if (!tokens.length) return null;

  type Scored = { v: ProductRow; score: number };
  const scored: Scored[] = variants.map(v => {
    const hay = (
      (v.display_name || "") + " " +
      (v.variant || "") + " " +
      (v.canonical || "")
    ).toLowerCase();

    let score = 0;

    if (hay.includes(q)) score += 3;

    for (const t of tokens) {
      if (hay.includes(t)) score += 1;
    }

    return { v: v as ProductRow, score };
  });

  const positive = scored.filter(s => s.score > 0);
  if (!positive.length) return null;

  positive.sort((a, b) => b.score - a.score);
  const best = positive[0];
  const second = positive[1];

  if (second && best.score === second.score) return null;

  return best.v;
}

function parsePureNumber(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function extractQty(text: string): number | null {
  const m = text.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function getTemp(org_id: string, from_phone: string): Promise<TempRow | null> {
  const { data } = await supa
    .from("temp_selected_items")
    .select("*")
    .eq("org_id", org_id)
    .eq("customer_phone", from_phone)
    .maybeSingle();

  return data as TempRow || null;
}

async function saveTemp(
  org_id: string,
  from_phone: string,
  payload: Partial<TempRow>
): Promise<void> {
  await supa.from("temp_selected_items").upsert({
    org_id,
    customer_phone: from_phone,
    updated_at: new Date().toISOString(),
    ...payload,
  } as any);
}

// ─────────────────────────────────────────────
// MAIN ORDER FLOW
// ─────────────────────────────────────────────

export async function handleCatalogFlow(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {

  const { org_id, from_phone, text } = ctx;
  const raw = (text || "").trim();

  // 0) Load catalog
  const catalog = await loadActiveProducts(org_id);

  if (!catalog || catalog.length === 0) {
    return {
      used: true,
      kind: "order",
      reply: "⚠️ No items available right now.",
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 1) QUANTITY STEP
  // ─────────────────────────────────────────────

  if (state === "ordering_qty") {
    const qty = extractQty(raw);
    if (!qty || qty <= 0) {
      return {
        used: true,
        kind: "order",
        reply: "Please enter a valid quantity like 1 or 2.",
        order_id: null,
      };
    }

    const row = await getTemp(org_id, from_phone);
    if (!row || !row.item) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        reply: "Let's start again. Please type the item name.",
        order_id: null,
      };
    }

    const item: ProductRow = row.item as ProductRow;

    const order = {
      org_id,
      source_phone: from_phone,
      raw_text: ctx.text || "",
      items: [
        {
          product_id: item.id,
          name: item.display_name || item.canonical,
          variant: item.variant,
          qty,
          price: item.price_per_unit,
        },
      ],
      status: "pending",
      created_at: new Date().toISOString(),
    };

    const { data: saved, error } = await supa
      .from("orders")
      .insert(order as any)
      .select("id")
      .single();

    await clearState(org_id, from_phone);

    if (error || !saved) {
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: "⚠️ Error saving your order. Please try again.",
      };
    }

    await setState(org_id, from_phone, "awaiting_address");

    return {
      used: true,
      kind: "order",
      order_id: saved.id,
      reply:
        `✅ Order created!\n` +
        `• ${item.canonical} (${item.variant}) x ${qty}\n\n` +
        `📍 Please send your delivery address.`,
    };
  }

  // ─────────────────────────────────────────────
  // 2) VARIANT STEP
  // ─────────────────────────────────────────────

  if (state === "ordering_variant") {
    const row = await getTemp(org_id, from_phone);

    if (!row || !row.item || !row.item.canonical) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        reply: "Let's start again. Please type the item name.",
        order_id: null,
      };
    }

    const canonical = String(row.item.canonical);

    const variants = catalog.filter(
      (p) => (p.canonical || "").trim() === canonical.trim()
    );

    if (!variants.length) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        reply: "I couldn't find variants. Please type the item again.",
        order_id: null,
      };
    }

    // NUMBER SELECT
    if (/^\d+$/.test(raw)) {
      const choice = parseInt(raw, 10);

      if (choice < 1 || choice > variants.length) {
        return {
          used: true,
          kind: "order",
          reply: "Invalid choice. Please send a valid number.",
          order_id: null,
        };
      }

      const selected = variants[choice - 1];

      await saveTemp(org_id, from_phone, { item: selected, list: null });
      await setState(org_id, from_phone, "ordering_qty");

      return {
        used: true,
        kind: "order",
        reply:
          `How many *${selected.display_name || selected.canonical} (${selected.variant})*?`,
        order_id: null,
      };
    }

    // TEXT MATCH INSIDE VARIANT
    const bestVariant = chooseBestVariant(variants, raw);

    if (bestVariant) {
      await saveTemp(org_id, from_phone, { item: bestVariant, list: null });
      await setState(org_id, from_phone, "ordering_qty");

      return {
        used: true,
        kind: "order",
        reply:
          `How many *${bestVariant.display_name || bestVariant.canonical} (${bestVariant.variant})*?`,
        order_id: null,
      };
    }

    // FALLBACK to new search
    const matches = findCanonicalMatches(raw, catalog);

    if (matches.length === 0) {
      const sample = catalog
        .slice(0, 6)
        .map((c) => `• ${c.display_name || c.canonical} (${c.variant})`)
        .join("\n");

      return {
        used: true,
        kind: "order",
        reply:
          `I couldn't find that item.\n` +
          (sample
            ? `Here are some items from today's menu:\n\n${sample}\n\nPlease type the item name again.`
            : "Please type the item name again."),
        order_id: null,
      };
    }

    if (matches.length === 1) {
      const { canonical: newCanonical, variants: newVariants } = matches[0];

      if (newVariants.length === 1) {
        const item = newVariants[0];
        await saveTemp(org_id, from_phone, { item, list: null });
        await setState(org_id, from_phone, "ordering_qty");

        return {
          used: true,
          kind: "order",
          reply:
            `How many *${item.display_name || item.canonical} (${item.variant})*?`,
          order_id: null,
        };
      }

      await saveTemp(org_id, from_phone, {
        item: { canonical: newCanonical },
        list: null,
      });
      await setState(org_id, from_phone, "ordering_variant");

      const variantLines = newVariants
        .map(
          (v, i) =>
            `${i + 1}) ${v.display_name || v.canonical} – ${v.variant || ""}`
        )
        .join("\n");

      return {
        used: true,
        kind: "order",
        reply: `Choose a variant for *${newCanonical}*:\n${variantLines}`,
        order_id: null,
      };
    }

    // MULTIPLE CANONICALS
    const optionsText = matches
      .map((m, i) => `${i + 1}) ${m.canonical}`)
      .join("\n");

    await saveTemp(org_id, from_phone, {
      list: matches.map((m) => ({ canonical: m.canonical })),
      item: null,
    });
    await setState(org_id, from_phone, "ordering_item");

    return {
      used: true,
      kind: "order",
      reply:
        `I found multiple items:\n${optionsText}\n\nPlease reply with the number.`,
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 0.5 NEW VARIANT SEARCH BEFORE GLOBAL
  // ─────────────────────────────────────────────

  if (state === "idle") {
    const variantHits = findVariantMatches(raw, catalog);

    if (variantHits.length === 1) {
      const hit = variantHits[0];

      if (hit.variants.length === 1) {
        const item = hit.variants[0];

        await saveTemp(org_id, from_phone, { item, list: null });
        await setState(org_id, from_phone, "ordering_qty");

        return {
          used: true,
          kind: "order",
          reply:
            `How many *${item.display_name || item.canonical} (${item.variant})*?`,
          order_id: null,
        };
      }

      await saveTemp(org_id, from_phone, {
        item: { canonical: hit.canonical },
        list: null,
      });
      await setState(org_id, from_phone, "ordering_variant");

      const variantLines = hit.variants
        .map(
          (v, i) =>
            `${i + 1}) ${v.display_name || v.canonical} – ${v.variant || ""}`
        )
        .join("\n");

      return {
        used: true,
        kind: "order",
        reply: `Choose a variant for *${hit.canonical}*:\n${variantLines}`,
        order_id: null,
      };
    }

    if (variantHits.length > 1) {
      const opts = variantHits
        .map((h, i) => `${i + 1}) ${h.canonical}`)
        .join("\n");

      await saveTemp(org_id, from_phone, {
        list: variantHits.map((h) => ({ canonical: h.canonical })),
        item: null,
      });
      await setState(org_id, from_phone, "ordering_item");

      return {
        used: true,
        kind: "order",
        reply:
          `I found multiple items:\n${opts}\n\nPlease reply with the number.`,
        order_id: null,
      };
    }
  }

  // ─────────────────────────────────────────────
  // 3) ITEM CHOICE STEP
  // ─────────────────────────────────────────────

  if (state === "ordering_item") {
    const num = parsePureNumber(raw);

    if (num !== null) {
      const row = await getTemp(org_id, from_phone);
      const list = (row?.list || []) as any[];

      if (!list || !Array.isArray(list) || list.length === 0) {
        await clearState(org_id, from_phone);
        return {
          used: true,
          kind: "order",
          reply: "Let's start again. Please type the item name.",
          order_id: null,
        };
      }

      if (num < 1 || num > list.length) {
        return {
          used: true,
          kind: "order",
          reply: "Invalid choice. Please send a valid number.",
          order_id: null,
        };
      }

      const entry = list[num - 1] as any;
      const canonical = entry.canonical || entry;

      const variants = catalog.filter(
        (p) => (p.canonical || "").trim() === canonical.trim()
      );

      if (!variants.length) {
        await clearState(org_id, from_phone);
        return {
          used: true,
          kind: "order",
          reply: "I couldn't find variants. Please type the item again.",
          order_id: null,
        };
      }

      if (variants.length === 1) {
        const item = variants[0];

        await saveTemp(org_id, from_phone, { item, list: null });
        await setState(org_id, from_phone, "ordering_qty");

        return {
          used: true,
          kind: "order",
          reply:
            `How many *${item.display_name || item.canonical} (${item.variant})*?`,
          order_id: null,
        };
      }

      await saveTemp(org_id, from_phone, { item: { canonical }, list: null });
      await setState(org_id, from_phone, "ordering_variant");

      const variantLines = variants
        .map(
          (v, i) =>
            `${i + 1}) ${v.display_name || v.canonical} – ${v.variant || ""}`
        )
        .join("\n");

      return {
        used: true,
        kind: "order",
        reply: `Choose a variant for *${canonical}*:\n${variantLines}`,
        order_id: null,
      };
    }
  }

  // ─────────────────────────────────────────────
  // 4) GLOBAL MATCHING (idle)
  // ─────────────────────────────────────────────

  const matches = findCanonicalMatches(raw, catalog);

  if (matches.length === 0) {
    const sample = catalog
      .slice(0, 6)
      .map((c) => `• ${c.display_name || c.canonical} (${c.variant})`)
      .join("\n");

    return {
      used: true,
      kind: "order",
      reply:
        `I couldn't find that item.\n` +
        (sample
          ? `Here are some items from today's menu:\n\n${sample}\n\nPlease type the item name again.`
          : "Please type the item name again."),
      order_id: null,
    };
  }

  if (matches.length === 1) {
    const { canonical, variants } = matches[0];

    if (variants.length === 1) {
      const item = variants[0];

      await saveTemp(org_id, from_phone, { item, list: null });
      await setState(org_id, from_phone, "ordering_qty");

      return {
        used: true,
        kind: "order",
        reply:
          `How many *${item.display_name || item.canonical} (${item.variant})*?`,
        order_id: null,
      };
    }

    await saveTemp(org_id, from_phone, { item: { canonical }, list: null });
    await setState(org_id, from_phone, "ordering_variant");

    const variantLines = variants
      .map(
        (v, i) =>
          `${i + 1}) ${v.display_name || v.canonical} – ${v.variant || ""}`
      )
      .join("\n");

    return {
      used: true,
      kind: "order",
      reply: `Choose a variant for *${canonical}*:\n${variantLines}`,
      order_id: null,
    };
  }

  const optionsText = matches.map((m, i) => `${i + 1}) ${m.canonical}`).join("\n");

  await saveTemp(org_id, from_phone, {
    list: matches.map((m) => ({ canonical: m.canonical })),
    item: null,
  });

  await setState(org_id, from_phone, "ordering_item");

  return {
    used: true,
    kind: "order",
    reply:
      `I found multiple items:\n${optionsText}\n\nPlease reply with the number.`,
    order_id: null,
  };
}