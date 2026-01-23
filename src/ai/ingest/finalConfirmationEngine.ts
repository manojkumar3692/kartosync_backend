// src/ai/ingest/finalConfirmationEngine.ts

import { supa } from "../../db";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { setState, clearState } from "./stateManager";
import { resetAttempts } from "./attempts";
import { emitNewOrder } from "../../routes/realtimeOrders";
import { generateOrderCode } from "./orderCode";

type CartLine = {
  product_id: string | number;
  name: string;
  variant?: string | null;
  qty: number;
  price?: number | null;
};

type TempRow = {
  org_id: string;
  customer_phone: string;
  item: any | null; // reused for editing metadata
  list: any[] | null;
  cart?: CartLine[] | null;
  updated_at?: string;
};

// ─────────────────────────────────────────────
// DB helpers (local copy, same table as orderEngine)
// ─────────────────────────────────────────────

function buildConfirmMenu(cart: CartLine[]): string {
  const { text: cartText } = formatCart(cart);
  return (
    "🧺 Your cart:\n" +
    cartText +
    "\n\n" +
    "1) Confirm order\n" +
    "2) Edit your order\n\n" +
    "Please reply with the number."
  );
}

// 🆕 Clinic-specific confirm menu
function buildConfirmMenuClinic(cart: CartLine[]): string {
  const { text: cartText } = formatCart(cart);
  return (
    "📝 Your selected service(s):\n" +
    cartText +
    "\n\n" +
    "1) Confirm booking\n" +
    "2) Edit details\n\n" +
    "Please reply with the number."
  );
}

function buildEditMenu(cart: CartLine[]): string {
  const { text: cartText } = formatCart(cart);
  return (
    "🧺 Your cart:\n" +
    cartText +
    "\n\n" +
    "🛠 Edit your order:\n" +
    "1) Add another item\n" +
    "2) Change quantity\n" +
    "3) Remove an item\n" +
    "4) Cancel order\n\n" +
    "5) Back\n\n" +
    "Please reply with the number."
  );
}

// 🆕 Used by order engine / clinic flows
export function buildConfirmMenuForReply(
  cart: any[],
  opts?: { clinic?: boolean }
): string {
  return opts?.clinic
    ? buildConfirmMenuClinic(cart as CartLine[])
    : buildConfirmMenu(cart as CartLine[]);
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

async function clearCart(org_id: string, from_phone: string): Promise<void> {
  await saveTemp(org_id, from_phone, {
    cart: [],
    item: null,
    list: null,
  });
}

// ─────────────────────────────────────────────
// Cart formatting
// ─────────────────────────────────────────────

function computeTotal(cart: CartLine[]): number {
  return cart.reduce((sum, li) => {
    if (typeof li.price === "number" && typeof li.qty === "number") {
      return sum + li.price * li.qty;
    }
    return sum;
  }, 0);
}

function formatCart(cart: CartLine[]): { text: string; total: number } {
  if (!cart.length) {
    return { text: "Cart is empty.", total: 0 };
  }

  const lines = cart.map((li, idx) => {
    const base = `${idx + 1}) ${li.name}${
      li.variant ? ` (${li.variant})` : ""
    } x ${li.qty}`;
    if (typeof li.price === "number") {
      const lineTotal = li.price * li.qty;
      return `${base} – ${lineTotal}`;
    }
    return base;
  });

  const total = computeTotal(cart);
  const totalLine = total > 0 ? `\n\n💰 Total: ${total}` : "";

  return {
    text: lines.join("\n") + totalLine,
    total,
  };
}

// ─────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────

export async function handleFinalConfirmation(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;
  const raw = (text || "").trim();
  const lower = raw.toLowerCase();

  const tmp = await getTemp(org_id, from_phone);
  const cart = Array.isArray(tmp?.cart) ? (tmp!.cart as CartLine[]) : [];

  // Safety: no cart → reset
  if (!cart.length) {
    await clearState(org_id, from_phone);
    await clearCart(org_id, from_phone);

    return {
      used: true,
      kind: "order",
      reply:
        "Your cart is empty now.\nPlease type the item name to start a new order.",
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 1) CONFIRMATION MENU (state === confirming_order)
  // ─────────────────────────────────────────────
  if (state === "confirming_order") {
    // 🆕 Detect vertical once (restaurant vs clinic)
    let isRestaurant = false;
    let isClinic = false;
    let clinicName: string | null = null;

    try {
      const { data: orgRow } = await supa
        .from("orgs")
        .select("business_type, name")
        .eq("id", org_id)
        .maybeSingle();

      const t = (orgRow?.business_type || "").toLowerCase();
      if (t.includes("restaurant")) {
        isRestaurant = true;
      } else if (t.includes("clinic")) {
        isClinic = true;
        clinicName = orgRow?.name || null;
      }
    } catch (e) {
      console.warn("[FINAL_CONFIRM][VERTICAL_CHECK_ERR]", e);
    }

    // NUMBER FIRST
    let choice: number | null = null;
    if (/^[1-2]$/.test(lower)) {
      choice = parseInt(lower, 10);
    }

    // TEXT SECOND
    if (choice === null) {
      if (["confirm", "yes", "y", "ok", "done"].includes(lower)) choice = 1;
      else if (
        ["edit", "change", "qty", "quantity", "remove", "cancel"].includes(
          lower
        )
      )
        choice = 2;
      // else if (["edit", "change", "qty", "quantity"].includes(lower)) choice = 3;
      else if (["remove", "delete", "rm"].includes(lower)) choice = 4;
      else if (["cancel", "stop", "clear"].includes(lower)) choice = 5;
    }

    // FALLBACK → repeat menu with cart
    if (choice === null) {
      return {
        used: true,
        kind: "order",
        reply: buildConfirmMenuForReply(cart, { clinic: isClinic }),
        order_id: null,
      };
    }

    // 1) CONFIRM ORDER → create order in DB
    if (choice === 1) {
      const { text: cartText, total } = formatCart(cart);
      const shortCode = await generateOrderCode(org_id);

      const orderPayload = {
        org_id,
        source_phone: from_phone,
        raw_text: ctx.text || "",
        items: cart,
        // ✅ Customer / patient must still complete next steps
        status: "awaiting_customer_action",
        created_at: new Date().toISOString(),
        total_amount: total || null,
        payment_status: "unpaid",
        payment_mode: null,
        order_code: shortCode,
      };

      const { data: saved, error } = await supa
        .from("orders")
        .insert(orderPayload as any)
        .select("id")
        .single();

      console.log("[FINAL_CONFIRM][INSERT]", { error, saved, orderPayload });

      if (error || !saved) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "⚠️ Error confirming your order. Please try again or type *cancel*.",
        };
      }

      // Reset cart + reset attempts for next step
      await clearCart(org_id, from_phone);
      await resetAttempts(org_id, from_phone);

      // ✅ Decide next state based on business_type
      let nextState: ConversationState = "awaiting_address";

      if (isRestaurant) {
        nextState = "awaiting_fulfillment";
      } else if (isClinic) {
        nextState = "clinic_awaiting_patient_name";
      }

      await setState(org_id, from_phone, nextState);

      // 🧾 Follow-up message per vertical
      let followUpMsg: string;

      if (nextState === "awaiting_fulfillment") {
        followUpMsg =
          "How would you like to receive your order?\n" +
          "1) Store Pickup\n" +
          "2) Home Delivery\n\n" +
          "Please type *1* or *2*.";
      } else if (nextState === "clinic_awaiting_patient_name") {
        const nameForText = clinicName || "the clinic";
        followUpMsg =
          `To book your appointment at *${nameForText}*, please share the *patient name* ` +
          "(for example: *Vani Kumar*).";
      } else {
        followUpMsg = "📍 Please send your delivery address.";
      }

      // 🆕 Header: clinic → "Service captured", others → "Order confirmed"
      const header = isClinic
        ? "✅ *Service captured!*\n\n"
        : "✅ *Order confirmed!*\n\n";

      return {
        used: true,
        kind: "order",
        order_id: saved.id,
        reply: header + cartText + "\n\n" + followUpMsg,
      };
    }

    // 2) EDIT YOUR ORDER → show edit menu
    if (choice === 2) {
      await setState(org_id, from_phone, "cart_edit_menu");
      const { text: cartText } = formatCart(cart);

      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "🧺 Your cart:\n" +
          cartText +
          "\n\n" +
          "🛠 Edit your order:\n" +
          "1) Add another item\n" +
          "2) Change quantity\n" +
          "3) Remove an item\n" +
          "4) Cancel order\n\n" +
          "Please reply with the number.",
      };
    }

    // 3) CHANGE QUANTITY → choose which line
    if (choice === 3) {
      const { text: cartText } = formatCart(cart);

      await setState(org_id, from_phone, "cart_edit_item");

      return {
        used: true,
        kind: "order",
        reply:
          "🧺 Your cart:\n" +
          cartText +
          "\n\nWhich item number do you want to change the quantity for?",
        order_id: null,
      };
    }

    // 4) REMOVE ITEM → choose which line
    if (choice === 4) {
      const { text: cartText } = formatCart(cart);

      await setState(org_id, from_phone, "cart_remove_item");

      return {
        used: true,
        kind: "order",
        reply:
          "🧺 Your cart:\n" +
          cartText +
          "\n\nWhich item number do you want to remove?",
        order_id: null,
      };
    }

    // 5) CANCEL ENTIRE ORDER
    if (choice === 5) {
      await clearState(org_id, from_phone);
      await clearCart(org_id, from_phone);

      return {
        used: true,
        kind: "order",
        reply:
          "🛑 Your cart has been cleared.\nIf you want to order again, just type the item name.",
        order_id: null,
      };
    }
  }

  if (state === "cart_edit_menu") {
    let choice: number | null = null;

    if (/^[1-5]$/.test(lower)) choice = parseInt(lower, 10);

    if (choice === null) {
      // basic text support
      if (["add", "another", "more"].includes(lower)) choice = 1;
      else if (["edit", "change", "qty", "quantity"].includes(lower))
        choice = 2;
      else if (["remove", "delete", "rm"].includes(lower)) choice = 3;
      else if (["cancel", "stop", "clear"].includes(lower)) choice = 4;
      else if (["back", "go back", "previous"].includes(lower)) choice = 5;
    }

    const { text: cartText } = formatCart(cart);

    if (choice === null) {
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: buildEditMenu(cart),
      };
    }

  // 1) Add another item
  if (choice === 1) {
    await setState(org_id, from_phone, "idle");

    // 🔹 Pick a smart example from current cart (org-agnostic)
    const firstLine = cart[0];
    const exampleName = firstLine
      ? firstLine.variant
        ? `${firstLine.name} (${firstLine.variant})`
        : firstLine.name
      : null;

    const exampleLine = exampleName
      ? `Type the item name to add (e.g. *${exampleName}*).\n`
      : "Type the item name to add.\n";

    return {
      used: true,
      kind: "order",
      order_id: null,
      reply:
        "Got it 👍\n" +
        exampleLine +
        "\n" +
        "Current cart:\n" +
        cartText,
    };
  }

    // 2) Change qty → reuse existing flow
    if (choice === 2) {
      await setState(org_id, from_phone, "cart_edit_item");
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "🧺 Your cart:\n" +
          cartText +
          "\n\nWhich item number do you want to change the quantity for?",
      };
    }

    // 3) Remove item → reuse existing flow
    if (choice === 3) {
      await setState(org_id, from_phone, "cart_remove_item");
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "🧺 Your cart:\n" +
          cartText +
          "\n\nWhich item number do you want to remove?",
      };
    }

    // 4) Cancel order
    if (choice === 4) {
      await clearState(org_id, from_phone);
      await clearCart(org_id, from_phone);

      return {
        used: true,
        kind: "order",
        order_id: null,
        reply:
          "🛑 Your order has been cancelled.\nIf you want to order again, just type the item name.",
      };
    }

    // 5) Back to confirm menu
    if (choice === 5) {
      await setState(org_id, from_phone, "confirming_order");
      return {
        used: true,
        kind: "order",
        order_id: null,
        reply: buildConfirmMenu(cart),
      };
    }
  }

  // ─────────────────────────────────────────────
  // 2) CART EDIT: choose item to CHANGE QTY
  // ─────────────────────────────────────────────

  if (state === "cart_edit_item") {
    const idx = parseInt(raw, 10);
    if (Number.isNaN(idx) || idx < 1 || idx > cart.length) {
      const { text: cartText } = formatCart(cart);
      return {
        used: true,
        kind: "order",
        reply: "Please send a valid item number from the cart.\n\n" + cartText,
        order_id: null,
      };
    }

    const editIndex = idx - 1;
    const item = cart[editIndex];

    // store editIndex in temp.item
    await saveTemp(org_id, from_phone, {
      item: { editIndex },
    });
    await setState(org_id, from_phone, "cart_edit_qty");

    return {
      used: true,
      kind: "order",
      reply: `Enter new quantity for *${item.name}${
        item.variant ? ` (${item.variant})` : ""
      }* (current: ${item.qty}).`,
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 3) CART EDIT: enter NEW QTY
  // ─────────────────────────────────────────────

  if (state === "cart_edit_qty") {
    const tmp2 = await getTemp(org_id, from_phone);
    const editIndex = tmp2?.item?.editIndex;

    if (
      typeof editIndex !== "number" ||
      editIndex < 0 ||
      editIndex >= cart.length
    ) {
      await setState(org_id, from_phone, "confirming_order");
      const { text: cartText } = formatCart(cart);
      return {
        used: true,
        kind: "order",
        reply:
          "Something went wrong while editing the quantity. Showing your cart again:\n\n" +
          cartText +
          "\n\nPlease choose from the menu again.",
        order_id: null,
      };
    }

    const newQty = parseInt(raw, 10);
    if (Number.isNaN(newQty) || newQty <= 0) {
      const item = cart[editIndex];
      return {
        used: true,
        kind: "order",
        reply: `Please enter a valid quantity (e.g. 1 or 2) for *${item.name}${
          item.variant ? ` (${item.variant})` : ""
        }*.`,
        order_id: null,
      };
    }

    const newCart = cart.map((li, i) =>
      i === editIndex ? { ...li, qty: newQty } : li
    );

    await saveTemp(org_id, from_phone, {
      cart: newCart,
      item: null,
    });
    await setState(org_id, from_phone, "confirming_order");

    return {
      used: true,
      kind: "order",
      reply: "✅ Quantity updated.\n\n" + buildConfirmMenu(newCart as any),
      order_id: null,
    };
  }

  // ─────────────────────────────────────────────
  // 4) CART REMOVE ITEM
  // ─────────────────────────────────────────────

  if (state === "cart_remove_item") {
    const idx = parseInt(raw, 10);
    if (Number.isNaN(idx) || idx < 1 || idx > cart.length) {
      const { text: cartText } = formatCart(cart);
      return {
        used: true,
        kind: "order",
        reply: "Please send a valid item number to remove.\n\n" + cartText,
        order_id: null,
      };
    }

    const removeIndex = idx - 1;
    const removed = cart[removeIndex];
    const newCart = cart.filter((_, i) => i !== removeIndex);

    await saveTemp(org_id, from_phone, {
      cart: newCart,
      item: null,
    });

    // If cart is empty after removal → reset
    if (!newCart.length) {
      await clearState(org_id, from_phone);
      return {
        used: true,
        kind: "order",
        reply: `🗑️ Removed *${removed.name}${
          removed.variant ? ` (${removed.variant})` : ""
        }* from your cart.\n\nYour cart is now empty. Type an item name to start again.`,
        order_id: null,
      };
    }

    await setState(org_id, from_phone, "confirming_order");

    return {
      used: true,
      kind: "order",
      reply:
        `🗑️ Removed *${removed.name}${
          removed.variant ? ` (${removed.variant})` : ""
        }* from your cart.\n\n` + buildConfirmMenu(newCart as any),
      order_id: null,
    };
  }

  // Fallback (should rarely hit)
  await setState(org_id, from_phone, "confirming_order");

  return {
    used: true,
    kind: "order",
    reply: buildConfirmMenu(cart as any),
    order_id: null,
  };
}