// src/ai/ingest/cartIntentEngine.ts

import type { Vertical, ParsedIntent } from "./intentEngine";

// Keep this in sync with how you store items in orders.items
export type CartItem = {
  id?: string;            // internal id (if any)
  product_id?: string;    // FK to products table
  name: string;
  variant?: string | null;
  brand?: string | null;
  qty: number;
  price?: number | null;  // per-unit price if you store it
};

// Result of applying intent on cart
export type CartIntentResult =
  | {
      type: "cart_updated";
      cart: CartItem[];
      // Human explanation ("We updated X", "We couldn’t find Y" etc.)
      explanation?: string;
    }
  | {
      type: "unhandled";
      cart?: CartItem[];
      // Why we refused to touch the cart
      reason?: string;
    };

/**
 * Simple helper: normalize string for rough matching
 */
function norm(str: string | null | undefined): string {
  return (str || "").toLowerCase().trim();
}

/**
 * Extract a safe quantity from intent.quantity
 */
function safeQty(q: number | null | undefined): number | null {
  if (q == null) return null;
  const n = Number(q);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Find best matching cart item for a given targetName.
 * Super simple for now: first whose name includes targetName.
 * Later we can make this smarter (fuzzy).
 */
function findTargetItem(
  items: CartItem[],
  targetName?: string | null
): CartItem | null {
  if (!targetName) return null;
  const n = norm(targetName);
  if (!n) return null;

  // strict contains
  const direct = items.find((it) => norm(it.name).includes(n));
  if (direct) return direct;

  // fallback: if only one item in cart, assume that one
  if (items.length === 1) return items[0];

  return null;
}

/**
 * Apply "add_item" intent on existing cart.
 * NOTE: We are NOT doing catalog lookup here – this is only for
 * cases where the item already exists in the cart and user says
 * "add one more" or similar.
 */
function handleAddItemOnCart(
  cart: CartItem[],
  intent: ParsedIntent,
  _vertical: Vertical
): CartIntentResult {
  if (!cart.length) {
    return {
      type: "unhandled",
      cart,
      reason: "add_item_but_cart_empty",
    };
  }

  const target = findTargetItem(cart, intent.targetItemName);
  const deltaQty = safeQty(intent.quantity) ?? 1;

  if (!target) {
    return {
      type: "unhandled",
      cart,
      reason: "add_item_target_not_found_in_cart",
    };
  }

  const updatedCart = cart.map((it) =>
    it === target ? { ...it, qty: (it.qty || 0) + deltaQty } : it
  );

  const newQty = (target.qty || 0) + deltaQty;

  return {
    type: "cart_updated",
    cart: updatedCart,
    explanation: `Updated *${target.name}*: added ${deltaQty}, now total ${newQty}.`,
  };
}

/**
 * Apply "change_qty" intent: "make chicken biryani 3", "only 1 coke", etc.
 */
function handleChangeQtyOnCart(
  cart: CartItem[],
  intent: ParsedIntent,
  _vertical: Vertical
): CartIntentResult {
  if (!cart.length) {
    return {
      type: "unhandled",
      cart,
      reason: "change_qty_but_cart_empty",
    };
  }

  const target = findTargetItem(cart, intent.targetItemName);
  const newQty = safeQty(intent.quantity);

  if (!target || newQty == null) {
    return {
      type: "unhandled",
      cart,
      reason: "change_qty_target_or_qty_invalid",
    };
  }

  const updatedCart = cart.map((it) =>
    it === target ? { ...it, qty: newQty } : it
  );

  return {
    type: "cart_updated",
    cart: updatedCart,
    explanation: `Updated *${target.name}* quantity to ${newQty}.`,
  };
}

/**
 * Apply "remove_item" intent: "remove coke", "no egg biryani", etc.
 */
function handleRemoveItemFromCart(
  cart: CartItem[],
  intent: ParsedIntent,
  _vertical: Vertical
): CartIntentResult {
  if (!cart.length) {
    return {
      type: "unhandled",
      cart,
      reason: "remove_item_but_cart_empty",
    };
  }

  const target = findTargetItem(cart, intent.targetItemName);

  if (!target) {
    return {
      type: "unhandled",
      cart,
      reason: "remove_item_target_not_found_in_cart",
    };
  }

  const updatedCart = cart.filter((it) => it !== target);

  return {
    type: "cart_updated",
    cart: updatedCart,
    explanation: `Removed *${target.name}* from your cart.`,
  };
}

/**
 * PUBLIC: Apply any parsed intent on the cart.
 * This is a pure function: same inputs → same outputs, no DB.
 *
 * IMPORTANT:
 * - We only handle *cart tweaks* here.
 * - We DO NOT create new items or touch catalog; for those,
 *   we return type: "unhandled" so orderEngine falls back
 *   to handleCatalogFallbackFlow.
 */
export function applyIntentToCart(
  intent: ParsedIntent,
  cart: CartItem[],
  rawText: string,
  vertical: Vertical
): CartIntentResult {
  switch (intent.intent) {
    case "add_item":
      // Treat this as "add more" for an existing cart item only
      return handleAddItemOnCart(cart, intent, vertical);

    case "change_qty":
      return handleChangeQtyOnCart(cart, intent, vertical);

    case "remove_item":
      return handleRemoveItemFromCart(cart, intent, vertical);

    // Everything else: multi-line add, notes, modifiers, checkout, etc.
    // We don't touch the cart here yet: let legacy/catalog flow handle it.
    case "add_items":
    case "modify_item":
    case "add_note":
    case "checkout":
    case "new_order":
    case "cancel_order":
    case "unknown":
    default:
      return {
        type: "unhandled",
        cart,
        reason: `intent_${intent.intent}_not_supported_in_cart_engine`,
      };
  }
}