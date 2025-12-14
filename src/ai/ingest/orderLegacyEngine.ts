// src/ai/ingest/orderLegacyEngine.ts

import { supa } from "../../db";
import { loadActiveProducts, ProductRow } from "./productLoader";
import { findCanonicalMatches } from "./textMatchEngine";
import { setState, clearState } from "./stateManager";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { filterVariantsByKeyword, findVariantMatches } from "./variantEngine";
import { detectMetaIntent } from "./metaIntent";
import { getAttempts, incAttempts, resetAttempts } from "./attempts";
import { fuzzyChooseOption } from "./fuzzyOption";
import { normalizeCustomerText } from "../lang/normalize";
import { buildConfirmMenuForReply } from "./finalConfirmationEngine";



// temp_selected_items row
type TempRow = {
  org_id: string;
  customer_phone: string;
  item: any | null;
  list: any[] | null;
  updated_at?: string;
  cart?: any[] | null;
  multi_item_queue?: any[] | null;
  current_item_index?: number | null;
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
  const { error } = await supa.from("temp_selected_items").upsert({
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
    .slice(0, 13)
    .map(
      (c) =>
        `• ${c.display_name || c.canonical} (${c.variant || ""}) - ${
          c.price_per_unit
        }`
    );

  if (!lines.length) return "No items available right now.";
  return `Here are some items from today's menu:\n\n${lines.join("\n")}`;
}

type UpsellOption = {
  source_product_id: string;
  upsell_product_id: string;
  name: string;
  variant?: string | null;
  price?: number | null;
  max_qty: number;
  custom_prompt?: string | null;
};

async function loadUpsellOptionForSource(
  org_id: string,
  source_product_id: string
): Promise<UpsellOption[]> {
  const { data, error } = await supa
    .from("product_upsells")
    .select(
      `
      source_product_id,
      upsell_product_id,
      max_qty,
      custom_prompt,
      upsell:products!product_upsells_upsell_fk(
        id,
        display_name,
        canonical,
        variant,
        price_per_unit
      )
    `
    )
    .eq("org_id", org_id)
    .eq("source_product_id", source_product_id)
    .eq("is_active", true);

  if (error) {
    console.error("[UPSELL][LOAD][ERROR]", {
      org_id,
      source_product_id,
      error,
    });
    return [];
  }

  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((r: any) => {
      const p = r.upsell;
      if (!p?.id) return null;
      return {
        source_product_id: r.source_product_id,
        upsell_product_id: p.id,
        name: p.display_name || p.canonical,
        variant: p.variant ?? null,
        price: typeof p.price_per_unit === "number" ? p.price_per_unit : null,
        max_qty: typeof r.max_qty === "number" ? r.max_qty : 2,
        custom_prompt: r.custom_prompt ?? null,
      } as UpsellOption;
    })
    .filter(Boolean) as UpsellOption[];
}

function buildUpsellPrompt(
  prefix: string,
  opt: UpsellOption,
  vertical: "restaurant" | "grocery" | "salon" | "pharmacy" | "generic"
): string {
  const v = opt.variant ? ` (${opt.variant})` : "";
  const price = opt.price != null ? ` – ${opt.price}` : "";

  const adminHeader = (opt.custom_prompt || "").trim();

  // Restaurant-only default header (only if admin didn't provide one)
  const defaultHeader =
    vertical === "restaurant"
      ? `Popular add-on 🔥\nIt goes well with your order 😊`
      : "";

  const header = adminHeader || defaultHeader;

  // ✅ Always include the actual item line
  const itemLine = `Would you like to add *${opt.name}${v}*${price}?`;

  return (
    prefix +
    (header ? `${header}\n\n` : "") +
    `${itemLine}\n\n` +
    `1) Yes\n` +
    `2) No\n` +
    `3) Skip\n\n` +
    `Please reply with the number.`
  );
}

function parseUpsellReply(raw: string, _maxQty: number): number | null {
  const t = (raw || "").trim().toLowerCase();

  // numbers
  if (t === "1") return 1; // yes -> add 1
  if (t === "2") return 0; // no
  if (t === "3") return 0; // skip

  // words
  if (t === "yes" || t === "y") return 1;
  if (t === "no" || t === "n") return 0;
  if (t === "skip") return 0;

  return null;
}

// ─────────────────────────────────────────────
// 🆕 Helpers for "item 1 of 3" prefix
// ─────────────────────────────────────────────

function toOrdinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function buildItemPrefix(row: TempRow | null): string {
  const queue = row?.multi_item_queue as any[] | undefined;
  const idx =
    typeof row?.current_item_index === "number"
      ? row.current_item_index!
      : null;

  if (!queue || queue.length === 0 || idx === null) return "";

  const safeIdx = Math.min(Math.max(idx, 0), queue.length - 1);
  const entry: any = queue[safeIdx] || {};
  const total = queue.length;
  const label: string = (entry.raw || entry.name || "").toString().trim() || "";

  if (!label) return "";

  const ord = toOrdinal(safeIdx + 1);
  return `For your ${ord} item (${safeIdx + 1} of ${total}) – *${label}*:\n`;
}

// ─────────────────────────────────────────────
// MAIN ORDER FLOW
// ─────────────────────────────────────────────

export async function handleCatalogFallbackFlow(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
  const { org_id, from_phone, text, vertical } = ctx;
  let raw = (text || "").trim();
  const lowerRaw = raw.toLowerCase();

  // Prefer AI-normalized text (from intent) for catalog matching.
  // This is usually English + cleaned (e.g. "bro oru biriyani kodunga" → "give me a biryani").
  const semanticText =
    (ctx.intent?.normalized && ctx.intent.normalized.trim()) ||
    (ctx.intent?.rawText && ctx.intent.rawText.trim()) ||
    raw;

  const semanticLower = semanticText.toLowerCase();

  // 0) Load catalog
  const catalog = await loadActiveProducts(org_id);

  // 🛡 Safety: if we are in idle state but a stale multi-item queue exists,
  // clear it so a fresh order doesn't show "2 of 2" from an old conversation.
  const possibleStale = await getTemp(org_id, from_phone);

    // 🛟 RECOVERY: if state was lost but temp has an upsell context,
  // force the flow back into ordering_upsell so "1/0/skip" works.
  if (state === "idle") {
    const tmp = await getTemp(org_id, from_phone);
    const maybeUpsell = tmp?.item as any;

    // detect our stored upsell object shape
    if (maybeUpsell?.upsell_product_id && maybeUpsell?.source_product_id) {
      await setState(org_id, from_phone, "ordering_upsell");
      // re-run same message but now with correct state
      return handleCatalogFallbackFlow(ctx, "ordering_upsell" as any);
    }
  }


  if (
    state === "idle" &&
    possibleStale?.multi_item_queue &&
    Array.isArray(possibleStale.multi_item_queue) &&
    possibleStale.multi_item_queue.length > 0
  ) {
    await saveTemp(org_id, from_phone, {
      multi_item_queue: null,
      current_item_index: null,
    });
  }

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

    // 🔥 NEW: also clear temp_selected_items (queue, cart, etc.)
    await supa
      .from("temp_selected_items")
      .delete()
      .eq("org_id", org_id)
      .eq("customer_phone", from_phone);

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
  // 🆕 MULTI-ITEM INLINE PARSE (AI or rule-based)
  // ─────────────────────────────────────────────

  // detect: "1 chicken biryani, 2 coke"
  if (
    ctx.intent?.intent === "add_items" &&
    Array.isArray(ctx.intent.lines) &&
    ctx.intent.lines.length > 1 &&
    state === "idle"
  ) {
    // intentEngine usually gives: { itemText, quantity }
    const queue = ctx.intent.lines.map((l: any) => {
      // 🆕 keep original line text (with "donne" etc.)
      const rawLine = (l.rawText || l.line || l.itemText || l.name || "")
        .toString()
        .trim();

      const name = (l.itemText || l.name || "").toString().trim() || rawLine;
      const qty = l.quantity ?? l.qty ?? 1;

      return {
        raw: rawLine || name, // used later for variant hint + prefix
        name,
        qty,
      };
    });

    // store queue in temp_selected_items
    await saveTemp(org_id, from_phone, {
      multi_item_queue: queue,
      current_item_index: 0,
      cart: [],
    });

    // process first item as if user typed it
    const first = queue[0];

    raw = first.name || raw; // safety fallback

    // DO NOT return here — let normal flow (variant/global search) run
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

    // ✅ Check upsell for this selected variant (source_product_id = item.id)
    const upsells = await loadUpsellOptionForSource(org_id, item.id);

    if (upsells.length > 0) {
      const opt = upsells[0]; // unique(org_id, source_product_id) => at most one
      const tmp = await getTemp(org_id, from_phone);
      const prefix = buildItemPrefix(tmp);

      // store upsell context in `item` (existing column)
      await saveTemp(org_id, from_phone, { item: opt as any, list: null });
      await setState(org_id, from_phone, "ordering_upsell");

      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: buildUpsellPrompt(prefix, opt, vertical),
      };
    }

    // 🆕 MULTI-ITEM QUEUE HANDLER
    const tmpRow = await getTemp(org_id, from_phone);

    if (
      tmpRow?.multi_item_queue &&
      typeof tmpRow.current_item_index === "number"
    ) {
      const nextIndex = tmpRow.current_item_index + 1;

      // if more items exist → move to next item
      if (nextIndex < tmpRow.multi_item_queue.length) {
        const queue = tmpRow.multi_item_queue as any[];
        const nextItem = queue[nextIndex];

        // move pointer to next item and clear any old selection
        await saveTemp(org_id, from_phone, {
          current_item_index: nextIndex,
          item: null,
          list: null,
        });

        // build "For your 2nd item (2 of 3) – *1 egg biryani*:"
        const rowForPrefix = await getTemp(org_id, from_phone);
        const itemPrefix = buildItemPrefix(rowForPrefix);

        const nextName = nextItem.name;
        const matches = findCanonicalMatches(nextName, catalog);

        // 🔸 Case 0: we couldn't match even from catalog → ask name once
        if (matches.length === 0) {
          await setState(org_id, from_phone, "ordering_item");

          return {
            used: true,
            kind: "order",
            order_id: null,
            reply:
              itemPrefix +
              `I couldn't find *${nextName}* in today's menu.\n` +
              `You can type a different item name, or send *skip* if you don't want this item..`,
          };
        }

        // 🔸 Case 1: exactly one canonical match
        if (matches.length === 1) {
          const { canonical, variants } = matches[0];

          // 1a) exactly one variant → go straight to qty
          if (variants.length === 1) {
            const item2 = variants[0];

            await saveTemp(org_id, from_phone, { item: item2, list: null });
            await setState(org_id, from_phone, "ordering_qty");

            return {
              used: true,
              kind: "order",
              order_id: null,
              reply:
                itemPrefix +
                `How many *${item2.display_name || item2.canonical} (` +
                `${item2.variant})*?`,
            };
          }

          // 1b) multiple variants → show variant list
          await saveTemp(org_id, from_phone, {
            item: { canonical },
            list: null,
          });
          await setState(org_id, from_phone, "ordering_variant");

          const variantLines = variants
            .map((v, i) => {
              const price = v.price_per_unit ? ` – ${v.price_per_unit}` : "";
              return `${i + 1}) ${v.display_name || v.canonical} – ${
                v.variant || ""
              }${price}`;
            })
            .join("\n");

          return {
            used: true,
            kind: "order",
            order_id: null,
            reply:
              itemPrefix +
              `Choose a variant for *${canonical}*:\n${variantLines}\n\nPlease reply with the number.`,
          };
        }

        // 🔸 Case 2: multiple canonicals (rare, but possible)
        const optionsText = matches
          .map((m, i) => {
            const firstWithPrice = m.variants.find(
              (v: any) => v.price_per_unit
            );
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
          order_id: null,
          reply:
            itemPrefix +
            `I found multiple items:\n${optionsText}\n\nPlease reply with the number.`,
        };
      }
    }

    // 🧺 otherwise: queue finished → go to confirm

    // 🔚 Queue is fully processed – clear multi-item context so it won't leak
    await saveTemp(org_id, from_phone, {
      multi_item_queue: null,
      current_item_index: null,
    });

    await setState(org_id, from_phone, "confirming_order");
    await resetAttempts(org_id, from_phone);

    // Build cart summary text
    const lines = newCart.map((li, idx) => {
      const lineTotal =
        typeof li.price === "number" ? li.price * li.qty : undefined;
      const pricePart =
        lineTotal != null
          ? ` – ${lineTotal}`
          : li.price
          ? ` – ${li.price}`
          : "";
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
      reply: buildConfirmMenuForReply(newCart),
    };
  }

  // ─────────────────────────────────────────────
  // 1.5) UPSELL STEP (after qty, before moving queue / confirm)
  // ─────────────────────────────────────────────
  if (state === "ordering_upsell") {
    const row = await getTemp(org_id, from_phone);
    const prefix = buildItemPrefix(row);

    const opt = row?.item as UpsellOption | null;
    if (!opt) {
      // safety: if upsell context missing, just continue
      await setState(org_id, from_phone, "ordering_item");
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: prefix + "Okay 👍 Please type the next item.",
      };
    }

    const qtyToAdd = parseUpsellReply(raw, opt.max_qty);

    if (qtyToAdd === null) {
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: buildUpsellPrompt(prefix, opt, vertical),
      };
    }

    const cart = Array.isArray(row?.cart) ? row!.cart! : [];
    let newCart = cart;

    if (qtyToAdd > 0) {
      newCart = [
        ...cart,
        {
          product_id: opt.upsell_product_id,
          name: opt.name,
          variant: opt.variant ?? null,
          qty: qtyToAdd,
          price: opt.price ?? null,
          meta: { upsell: true, source_product_id: opt.source_product_id },
        },
      ];
    }

    // clear upsell context
    await saveTemp(org_id, from_phone, {
      cart: newCart,
      item: null,
      list: null,
    });

    // ✅ Continue: if queue active -> next item, else confirm
    const queue = row?.multi_item_queue || null;
    const idx =
      typeof row?.current_item_index === "number"
        ? row.current_item_index!
        : null;

    if (queue && idx !== null) {
      const nextIndex = idx + 1;

      if (nextIndex < queue.length) {
        const nextItem: any = queue[nextIndex];

        await saveTemp(org_id, from_phone, {
          current_item_index: nextIndex,
          item: null,
          list: null,
        });

        const rowForPrefix = await getTemp(org_id, from_phone);
        const itemPrefix = buildItemPrefix(rowForPrefix);

        const nextName = nextItem.name;
        const matches = findCanonicalMatches(nextName, catalog);

        if (matches.length === 0) {
          await setState(org_id, from_phone, "ordering_item");
          return {
            used: true,
            kind: "order",
            order_id: null,
            reply:
              itemPrefix +
              `I couldn't find *${nextName}* in today's menu.\n` +
              `You can type a different item name, or send *skip* if you don't want this item..`,
          };
        }

        if (matches.length === 1) {
          const { canonical, variants } = matches[0];

          if (variants.length === 1) {
            const item2 = variants[0];
            await saveTemp(org_id, from_phone, { item: item2, list: null });
            await setState(org_id, from_phone, "ordering_qty");
            return {
              used: true,
              kind: "order",
              order_id: null,
              reply:
                itemPrefix +
                `How many *${item2.display_name || item2.canonical} (${
                  item2.variant
                })*?`,
            };
          }

          await saveTemp(org_id, from_phone, {
            item: { canonical },
            list: null,
          });
          await setState(org_id, from_phone, "ordering_variant");

          const variantLines = variants
            .map((v, i) => {
              const price = v.price_per_unit ? ` – ${v.price_per_unit}` : "";
              return `${i + 1}) ${v.display_name || v.canonical} – ${
                v.variant || ""
              }${price}`;
            })
            .join("\n");

          return {
            used: true,
            kind: "order",
            order_id: null,
            reply:
              itemPrefix +
              `Choose a variant for *${canonical}*:\n${variantLines}\n\nPlease reply with the number.`,
          };
        }

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
          order_id: null,
          reply:
            itemPrefix +
            `I found multiple items:\n${optionsText}\n\nPlease reply with the number.`,
        };
      }

      // queue finished -> confirm
      await saveTemp(org_id, from_phone, {
        multi_item_queue: null,
        current_item_index: null,
      });
    }

    await setState(org_id, from_phone, "confirming_order");
    await resetAttempts(org_id, from_phone);
    
    // rebuild cart summary (same as ordering_qty confirm block)
    const lines = newCart.map((li: any, idx: number) => {
      const lineTotal =
        typeof li.price === "number" ? li.price * li.qty : undefined;
      const pricePart =
        lineTotal != null
          ? ` – ${lineTotal}`
          : li.price
          ? ` – ${li.price}`
          : "";
      return `${idx + 1}) ${li.name}${li.variant ? ` (${li.variant})` : ""} x ${
        li.qty
      }${pricePart}`;
    });
    
    const total = newCart.reduce((sum: number, li: any) => {
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
  reply: buildConfirmMenuForReply(newCart),
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

    // 🆕 Build prefix: "For your 1st item (1 of 3) – *1 chicken biryani donne*:"
    const itemPrefix = buildItemPrefix(tmp);

    // 🆕 Try to use original queue line as hint (e.g. "1 chicken biryani donne")
    let variantHint = raw;
    if (
      tmp?.multi_item_queue &&
      typeof tmp.current_item_index === "number" &&
      tmp.current_item_index >= 0 &&
      tmp.current_item_index < tmp.multi_item_queue.length
    ) {
      const entry: any = tmp.multi_item_queue[tmp.current_item_index];
      const fromQueue = (entry.raw || entry.name || "").toString().trim();
      if (fromQueue) {
        variantHint = fromQueue;
      }
    }

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
        reply: `${itemPrefix}How many *${v.display_name || v.canonical} (${
          v.variant
        })*?`,
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
        reply: `${itemPrefix}How many *${v.display_name || v.canonical} (${
          v.variant
        })*?`,
        order_id: null,
      };
    }

    // 3) Try smart text match inside these variants (e.g. "donne", "1/2 kg")
    const match = chooseBestVariant(allVariants, variantHint);

    // CASE A: EXACT 1 VARIANT FOUND → AUTO-SELECT
    if (match.type === "single") {
      const v = match.variant;

      await saveTemp(org_id, from_phone, { item: v, list: null });
      await setState(org_id, from_phone, "ordering_qty");

      return {
        used: true,
        kind: "order",
        reply: `${itemPrefix}How many *${v.display_name || v.canonical} (${
          v.variant
        })*?`,
        order_id: null,
      };
    }

    // CASE B: MULTIPLE MATCHES → user must choose from a narrowed list
    if (match.type === "multiple") {
      const lines = match.list
        .map((v: ProductRow, i: number) => {
          const price = v.price_per_unit ? ` – ${v.price_per_unit}` : "";
          return `${i + 1}) ${v.display_name || v.canonical} – ${
            v.variant
          }${price}`;
        })
        .join("\n");

      await saveTemp(org_id, from_phone, {
        item: { canonical },
        list: match.list,
      });

      return {
        used: true,
        kind: "order",
        reply:
          `${itemPrefix}I found multiple options:\n` +
          `${lines}\n\nPlease reply with the number.`,
        order_id: null,
      };
    }

    // CASE C: NO MATCH → stay in variant step, DO NOT fall to global search
    return {
      used: true,
      kind: "order",
      reply:
        `${itemPrefix}I couldn't find that variant.\n` +
        "Please reply with the number from the list, type the variant name again, or type *back* to start over.",
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 0.5) VARIANT SEARCH IN IDLE BEFORE GLOBAL
  // ─────────────────────────────────────────────

  if (state === "idle") {
    const variantHits = findVariantMatches(semanticText, catalog);

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
          return `${i + 1}) ${v.display_name || v.canonical} – ${
            v.variant || ""
          }${price}`;
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

      // 🆕 prefix "For your 1st item (1 of 3)…"
      const rowForContext = await getTemp(org_id, from_phone);
      const itemPrefix = buildItemPrefix(rowForContext);

      return {
        used: true,
        kind: "order",
        reply:
          itemPrefix +
          `I found multiple items:\n${opts}\n\nPlease reply with the number.`,
        order_id: null,
      };
    }
  }

  // ─────────────────────────────────────────────
  // 3) ITEM CHOICE STEP
  // ─────────────────────────────────────────────

  const rowForContext = await getTemp(org_id, from_phone);

  const itemPrefix = buildItemPrefix(rowForContext);

  if (state === "ordering_item") {
    const row = await getTemp(org_id, from_phone);
    const list = (row?.list || []) as any[];

    // When we are in multi-item queue but no list (like "coke"),
    // DO NOT reset the whole flow; allow it to fall through to global matching.
    const inQueue =
      row?.multi_item_queue && typeof row.current_item_index === "number";

    if ((!list || !Array.isArray(list) || list.length === 0) && !inQueue) {
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
    if (num === null && raw && list && Array.isArray(list) && list.length > 0) {
      const opts = list.map((entry: any) => entry.canonical || String(entry));
      const idx = fuzzyChooseOption(raw, opts);
      if (idx !== null) {
        num = idx + 1;
      }
    }

    // If still no number → fall through to global search later
    if (num !== null && list && Array.isArray(list) && list.length > 0) {
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
          return `${i + 1}) ${v.display_name || v.canonical} – ${
            v.variant || ""
          }${price}`;
        })
        .join("\n");

      return {
        used: true,
        kind: "order",
        reply:
          itemPrefix +
          `Choose a variant for *${canonical}*:\n${variantLines}\n\nPlease reply with the number.`,
        order_id: null,
      };
    }

    // if num is still null → fallthrough to global search below (where we now handle queues)
  }

  // ─────────────────────────────────────────────
  // 4) GLOBAL MATCHING (idle or fallback)
  // ─────────────────────────────────────────────

  // 🧠 Use normalized text so "biriayni" → "biryani", Tamil → English, etc.
  const searchText = normalizeCustomerText(raw || "");
  const matches = findCanonicalMatches(searchText, catalog);

  if (matches.length === 0) {
    // 🆕 Special handling when multi-item queue is active (e.g. coke not in menu)
    const row = await getTemp(org_id, from_phone);
    const queue = row?.multi_item_queue || [];
    const idx =
      typeof row?.current_item_index === "number"
        ? row.current_item_index!
        : null;

    const isSkipPhrase = ["skip", "no need", "leave it", "no thanks"].some(
      (p) => lowerRaw.includes(p) || semanticLower.includes(p)
    );

    if (queue && idx !== null && idx >= 0 && idx < queue.length) {
      const current = queue[idx];
      const cart = Array.isArray(row?.cart) ? row!.cart! : [];

      // If user explicitly said "skip / no need", don't blame menu
      const unavailableMsg = isSkipPhrase
        ? ""
        : `Sorry, *${current.name}* is not available in today's menu.\n`;

      // Move to next item in queue
      const nextIndex = idx + 1;

      if (nextIndex < queue.length) {
        const nextItem = queue[nextIndex];

        await saveTemp(org_id, from_phone, {
          current_item_index: nextIndex,
        });
        await setState(org_id, from_phone, "ordering_item");

        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            unavailableMsg +
            `Next item: *${nextItem.qty} ${nextItem.name}*` +
            `\nPlease type the item name (e.g. *${nextItem.name}*).`,
        };
      }

      // No more items in queue → if we have cart, go to confirm; else generic fallback
      if (cart.length > 0) {
        // 🔚 Queue finished here as well (e.g. skipped last item) – clear queue context
        await saveTemp(org_id, from_phone, {
          multi_item_queue: null,
          current_item_index: null,
        });
        await setState(org_id, from_phone, "confirming_order");
        await resetAttempts(org_id, from_phone);

        const lines = cart.map((li: any, i: number) => {
          const lineTotal =
            typeof li.price === "number" ? li.price * li.qty : undefined;
          const pricePart =
            lineTotal != null
              ? ` – ${lineTotal}`
              : li.price
              ? ` – ${li.price}`
              : "";
          return `${i + 1}) ${li.name}${
            li.variant ? ` (${li.variant})` : ""
          } x ${li.qty}${pricePart}`;
        });

        const total = cart.reduce((sum: number, li: any) => {
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
            unavailableMsg +
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
      // Even if no cart, clear any stale multi-item context to avoid leaking into next order
      await saveTemp(org_id, from_phone, {
        multi_item_queue: null,
        current_item_index: null,
      });
      // Queue finished and no cart → normal generic fallback
    }

    // OLD behaviour when no queue (single-item flow) – now generic, no food-specific hacks
    await incAttempts(org_id, from_phone);
    const attempts = await getAttempts(org_id, from_phone);

    const extra =
      attempts >= 2 ? `\n\nYou can type *back* to start again.` : "";

    // Use our standard quick menu snippet
    const sampleBlock = formatQuickMenu(catalog); // already includes heading

    return {
      used: true,
      kind: "order",
      reply:
        itemPrefix +
        "I couldn't find that item.\n" +
        sampleBlock +
        "\n\nPlease type the item name again." +
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
          itemPrefix +
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
        return `${i + 1}) ${v.display_name || v.canonical} – ${
          v.variant || ""
        }${price}`;
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
    reply:
      itemPrefix +
      `I found multiple items:\n${optionsText}\n\nPlease reply with the number.`,
    order_id: null,
  };
}
