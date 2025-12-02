// src/ai/ingest/orderEngine.ts

import { supa } from "../../db";
import { loadActiveProducts, ProductRow } from "./productLoader";
import { findCanonicalMatches } from "./textMatchEngine";
import { setState, clearState } from "./stateManager";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { filterVariantsByKeyword, findVariantMatches } from "./variantEngine";
import { detectMetaIntent } from "./metaIntent";
import { getAttempts, incAttempts, resetAttempts } from "./attempts";
import { fuzzyChooseOption } from "./fuzzyOption";

// temp_selected_items row
type TempRow = {
  org_id: string;
  customer_phone: string;
  item: any | null;
  list: any[] | null;
  updated_at?: string;
  cart?: any[] | null;  // 🆕 full cart before final confirmation
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

export function chooseBestVariant(variants: any[], raw: string) {
  const matches = filterVariantsByKeyword(variants, raw);

  if (matches.length === 1) {
    return {
      type: "single",
      variant: matches[0],
    };
  }

  if (matches.length > 1) {
    return {
      type: "multiple",
      list: matches,
    };
  }

  return {
    type: "none",
  };
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

async function getTemp(
  org_id: string,
  from_phone: string
): Promise<TempRow | null> {
  const { data } = await supa
    .from("temp_selected_items")
    .select("*")
    .eq("org_id", org_id)
    .eq("customer_phone", from_phone)
    .maybeSingle();

  return (data as TempRow) || null;
}

async function saveTemp(
  org_id: string,
  from_phone: string,
  payload: Partial<TempRow>
): Promise<void> {
  const { error } = await supa
    .from("temp_selected_items")
    .upsert({
      org_id,
      customer_phone: from_phone,
      updated_at: new Date().toISOString(),
      ...payload,
    } as any);

  if (error) {
    console.error("[TEMP][UPSERT][ERROR]", {
      org_id,
      from_phone,
      error,
    });
  }
}

function formatQuickMenu(catalog: ProductRow[]): string {
  const lines = catalog
    .slice(0, 8)
    .map((c) => `• ${c.display_name || c.canonical} (${c.variant || ""}) - ${c.price_per_unit}`);

  if (!lines.length) return "No items available right now.";
  return `Here are some items from today's menu:\n\n${lines.join("\n")}`;
}

// ─────────────────────────────────────────────
// MAIN ORDER FLOW
// ─────────────────────────────────────────────

export async function handleCatalogFlow(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;
  let raw = (text || "").trim();

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

  // 0.1) META INTENT (back / help / menu / greeting / agent)
  const meta = detectMetaIntent(raw);

  if (meta === "reset") {
    await clearState(org_id, from_phone);
    await resetAttempts(org_id, from_phone);
    return {
      used: true,
      kind: "order",
      reply:
        "No problem 👍 Starting fresh.\nPlease type the item name or say *menu*.",
      order_id: null,
    };
  }

  if (meta === "greeting" && state !== "idle") {
    return {
      used: true,
      kind: "order",
      reply:
        "You're in the middle of an order.\nReply with a number or type *back* to start again.",
      order_id: null,
    };
  }

  if (meta === "help") {
    return {
      used: true,
      kind: "order",
      reply:
        "You can type an item name (e.g. *chicken biryani*), or reply with a number when you see a list.\nType *back* to restart.",
      order_id: null,
    };
  }

  if (meta === "menu") {
    return {
      used: true,
      kind: "order",
      reply: formatQuickMenu(catalog),
      order_id: null,
    };
  }

  if (meta === "agent") {
    return {
      used: true,
      kind: "order",
      reply: "A human agent will reach out shortly 😊",
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 1) QUANTITY STEP  → add to CART (no DB yet)
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

    // 🧺 Build line item
    const lineItem = {
      product_id: item.id,
      name: item.display_name || item.canonical,
      variant: item.variant,
      qty,
      price: item.price_per_unit,
    };

    // 🧺 Merge into cart
    const existingCart = Array.isArray(row.cart) ? row.cart : [];
    const newCart = [...existingCart, lineItem];

    await saveTemp(org_id, from_phone, {
      cart: newCart,
      item: null,
      list: null,
    });

    // Move to confirming_order (final confirmation engine)
    await setState(org_id, from_phone, "confirming_order");
    await resetAttempts(org_id, from_phone);

    // Build cart summary text
    const lines = newCart.map((li, idx) => {
      const lineTotal =
        typeof li.price === "number" ? li.price * li.qty : undefined;
      const pricePart =
        lineTotal != null ? ` – ${lineTotal}` : li.price ? ` – ${li.price}` : "";
      return `${idx + 1}) ${li.name}${li.variant ? ` (${li.variant})` : ""} x ${
        li.qty
      }${pricePart}`;
    });

    const total = newCart.reduce((sum, li: any) => {
      if (typeof li.price === "number" && typeof li.qty === "number") {
        return sum + li.price * li.qty;
      }
      return sum;
    }, 0);

    const totalLine = total > 0 ? `\n\n💰 Total: ${total}` : "";

    return {
      used: true,
      kind: "order",
      order_id: null,
      reply:
        "🧺 Your cart:\n" +
        lines.join("\n") +
        totalLine +
        "\n\n" +
        "1) Confirm order\n" +
        "2) Add another item\n" +
        "3) Change quantity\n" +
        "4) Remove an item\n" +
        "5) Cancel\n\n" +
        "Please reply with the number.",
    };
  }

  // ─────────────────────────────────────────────
  // 2) VARIANT STEP
  // ─────────────────────────────────────────────

  if (state === "ordering_variant") {
    const tmp = await getTemp(org_id, from_phone);
    const canonical = tmp?.item?.canonical as string | undefined;
    const narrowedList = Array.isArray(tmp?.list)
      ? (tmp!.list as ProductRow[])
      : null;

    // 0) If user replies with a NUMBER and we have a narrowed variant list,
    //    treat it as "pick from this list"
    if (/^\d+$/.test(raw) && narrowedList && narrowedList.length > 0) {
      const idx = parseInt(raw, 10) - 1;

      if (idx < 0 || idx >= narrowedList.length) {
        return {
          used: true,
          kind: "order",
          reply: "Invalid choice. Please send a valid number.",
          order_id: null,
        };
      }

      const v = narrowedList[idx];

      await saveTemp(org_id, from_phone, { item: v, list: null });
      await setState(org_id, from_phone, "ordering_qty");

      return {
        used: true,
        kind: "order",
        reply: `How many *${v.display_name || v.canonical} (${v.variant})*?`,
        order_id: null,
      };
    }

    // 1) Safety: if we somehow lost canonical, reset
    if (!canonical) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        reply: "Let's start again. Please type the item name.",
        order_id: null,
      };
    }

    // 2) Get all variants for this canonical
    const allVariants = catalog.filter(
      (p) => (p.canonical || "").trim() === canonical.trim()
    );

    if (!allVariants.length) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        reply: "I couldn't find variants. Please type the item again.",
        order_id: null,
      };
    }

    // NUMBER SELECT INSIDE ordering_variant
    if (/^\d+$/.test(raw)) {
      const idx = parseInt(raw, 10) - 1;

      if (idx < 0 || idx >= allVariants.length) {
        return {
          used: true,
          kind: "order",
          reply: "Invalid choice. Please send a valid number.",
          order_id: null,
        };
      }

      const v = allVariants[idx];

      await saveTemp(org_id, from_phone, { item: v, list: null });
      await setState(org_id, from_phone, "ordering_qty");

      return {
        used: true,
        kind: "order",
        reply: `How many *${v.display_name || v.canonical} (${v.variant})*?`,
        order_id: null,
      };
    }

    // 3) Try smart text match inside these variants (e.g. "donne", "1/2 kg")
    const match = chooseBestVariant(allVariants, raw);

    // CASE A: EXACT 1 VARIANT FOUND → AUTO-SELECT
    if (match.type === "single") {
      const v = match.variant;

      await saveTemp(org_id, from_phone, { item: v, list: null });
      await setState(org_id, from_phone, "ordering_qty");

      return {
        used: true,
        kind: "order",
        reply: `How many *${v.display_name || v.canonical} (${v.variant})*?`,
        order_id: null,
      };
    }

    // CASE B: MULTIPLE MATCHES → user must choose from a narrowed list
    if (match.type === "multiple") {
      const lines = match.list
      .map((v: ProductRow, i: number) => {
        const price = v.price_per_unit ? ` – ${v.price_per_unit}` : "";
        return `${i + 1}) ${v.display_name || v.canonical} – ${v.variant}${price}`;
      })
      .join("\n");

      await saveTemp(org_id, from_phone, {
        item: { canonical },
        list: match.list,
      });

      return {
        used: true,
        kind: "order",
        reply: `I found multiple *${raw}* options:\n${lines}\n\nPlease reply with the number.`,
        order_id: null,
      };
    }

    // CASE C: NO MATCH → stay in variant step, DO NOT fall to global search
    return {
      used: true,
      kind: "order",
      reply:
        "I couldn't find that variant.\n" +
        "Please reply with the number from the list, type the variant name again, or type *back* to start over.",
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 0.5) VARIANT SEARCH IN IDLE BEFORE GLOBAL
  // ─────────────────────────────────────────────

  if (state === "idle") {
    const variantHits = findVariantMatches(raw, catalog);

    if (variantHits && variantHits.length === 1) {
      const hit = variantHits[0];

      if (hit.variants.length === 1) {
        const item = hit.variants[0];

        await saveTemp(org_id, from_phone, { item, list: null });
        await setState(org_id, from_phone, "ordering_qty");

        return {
          used: true,
          kind: "order",
          reply:
            `How many *${item.display_name || item.canonical} (` +
            `${item.variant})*?`,
          order_id: null,
        };
      }

      await saveTemp(org_id, from_phone, {
        item: { canonical: hit.canonical },
        list: null,
      });
      await setState(org_id, from_phone, "ordering_variant");

      const variantLines = hit.variants
      .map((v, i) => {
        const price = v.price_per_unit ? ` – ${v.price_per_unit}` : "";
        return `${i + 1}) ${v.display_name || v.canonical} – ${v.variant || ""}${price}`;
      })
      .join("\n");

      return {
        used: true,
        kind: "order",
        reply: `Choose a variant for *${hit.canonical}*:\n${variantLines}\n\nPlease reply with the number.`,
        order_id: null,
      };
    }

    if (variantHits && variantHits.length > 1) {
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
        reply: `I found multiple items:\n${opts}\n\nPlease reply with the number.`,
        order_id: null,
      };
    }
  }

  // ─────────────────────────────────────────────
  // 3) ITEM CHOICE STEP
  // ─────────────────────────────────────────────

  if (state === "ordering_item") {
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

    let num = parsePureNumber(raw);

    // 3A) TEXT → FUZZY OPTION (e.g. type "egg" instead of "2")
    if (num === null && raw) {
      const opts = list.map((entry: any) => entry.canonical || String(entry));
      const idx = fuzzyChooseOption(raw, opts);
      if (idx !== null) {
        num = idx + 1;
      }
    }

    // If still no number → fall through to global search later
    if (num !== null) {
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
            `How many *${item.display_name || item.canonical} (` +
            `${item.variant})*?`,
          order_id: null,
        };
      }

      await saveTemp(org_id, from_phone, { item: { canonical }, list: null });
      await setState(org_id, from_phone, "ordering_variant");

      const variantLines = variants
      .map((v, i) => {
        const price = v.price_per_unit ? ` – ${v.price_per_unit}` : "";
        return `${i + 1}) ${v.display_name || v.canonical} – ${v.variant || ""}${price}`;
      })
      .join("\n");

      return {
        used: true,
        kind: "order",
        reply: `Choose a variant for *${canonical}*:\n${variantLines}\n\nPlease reply with the number.`,
        order_id: null,
      };
    }

    // if num is still null → fallthrough to global search below
  }

  // ─────────────────────────────────────────────
  // 4) GLOBAL MATCHING (idle or fallback)
  // ─────────────────────────────────────────────

  const matches = findCanonicalMatches(raw, catalog);

  if (matches.length === 0) {
    await incAttempts(org_id, from_phone);
    const attempts = await getAttempts(org_id, from_phone);

    const sample = catalog
    .slice(0, 6)
    .map((c) => {
      const label = c.display_name || c.canonical;
      const variant = c.variant ? ` (${c.variant})` : "";
      const price = c.price_per_unit ? ` – ${c.price_per_unit}` : "";
      return `• ${label}${variant}${price}`;
    })
    .join("\n");

    const extra =
      attempts >= 2 ? `\n\nYou can type *back* to start again.` : "";

    return {
      used: true,
      kind: "order",
      reply:
        `I couldn't find that item.\n` +
        (sample
          ? `Here are some items from today's menu:\n\n${sample}\n\nPlease type the item name again.`
          : "Please type the item name again.") +
        extra,
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
          `How many *${item.display_name || item.canonical} (` +
          `${item.variant})*?`,
        order_id: null,
      };
    }

    await saveTemp(org_id, from_phone, { item: { canonical }, list: null });
    await setState(org_id, from_phone, "ordering_variant");

    const variantLines = variants
    .map((v, i) => {
      const price = v.price_per_unit ? ` – ${v.price_per_unit}` : "";
      return `${i + 1}) ${v.display_name || v.canonical} – ${v.variant || ""}${price}`;
    })
    .join("\n");

    return {
      used: true,
      kind: "order",
      reply: `Choose a variant for *${canonical}*:\n${variantLines}\n\nPlease reply with the number.`,
      order_id: null,
    };
  }

  const optionsText = matches
  .map((m, i) => {
    const firstWithPrice = m.variants.find((v) => v.price_per_unit);
    const priceStr = firstWithPrice?.price_per_unit
      ? ` – from ${firstWithPrice.price_per_unit}`
      : "";
    return `${i + 1}) ${m.canonical}${priceStr}`;
  })
  .join("\n");

  await saveTemp(org_id, from_phone, {
    list: matches.map((m) => ({ canonical: m.canonical })),
    item: null,
  });

  await setState(org_id, from_phone, "ordering_item");

  return {
    used: true,
    kind: "order",
    reply: `I found multiple items:\n${optionsText}\n\nPlease reply with the number.`,
    order_id: null,
  };
}
