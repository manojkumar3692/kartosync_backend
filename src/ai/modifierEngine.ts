// src/ai/modifierEngine.ts
import { supa } from "../db";
import { ModifierPayload } from "../types";

export type ModifierApplyResult = {
  status:
    | "applied"
    | "skipped_no_modifier"
    | "skipped_low_confidence"
    | "no_phone"
    | "no_open_order"
    | "no_match"
    | "ambiguous_scope"
    | "error";
  orderId?: string;
  reason: string;
};

function normText(s: string | null | undefined): string {
  return (s || "").toString().toLowerCase().trim();
}

function isOrderOpen(statusRaw: string | null | undefined): boolean {
  const s = normText(statusRaw);
  if (!s) return true;
  return ![
    "cancelled_by_customer",
    "archived_for_new",
    "paid",
    "shipped",
  ].includes(s);
}

// Find indices of order items that match the modifier target
function findTargetItemIndices(items: any[], targetText: string): number[] {
  const target = normText(targetText);
  if (!target) return [];

  const indices: number[] = [];

  items.forEach((it, idx) => {
    const label = normText(it.canonical || it.name || "");
    if (!label) return;

    // simple contains match
    if (label.includes(target) || target.includes(label)) {
      indices.push(idx);
      return;
    }

    // token overlap
    const tTokens = target.split(/\s+/).filter(Boolean);
    const lTokens = label.split(/\s+/).filter(Boolean);
    const overlap = tTokens.filter((t) => lTokens.includes(t));
    if (overlap.length >= Math.min(2, tTokens.length)) {
      indices.push(idx);
    }
  });

  return indices;
}

export async function applyModifierToLatestOrder(opts: {
  orgId: string;
  phoneNorm: string | null;
  modifier: ModifierPayload;
  confidence: number;
}): Promise<ModifierApplyResult> {
  const { orgId, phoneNorm, modifier, confidence } = opts;

  if (!modifier) {
    return { status: "skipped_no_modifier", reason: "no_modifier" };
  }
  if (!phoneNorm) {
    return { status: "no_phone", reason: "phone_required_for_order_lookup" };
  }
  if (confidence < 0.6) {
    // threshold tweakable
    return {
      status: "skipped_low_confidence",
      reason: `confidence_below_threshold:${confidence.toFixed(2)}`,
    };
  }

  try {
    const phonePlain = phoneNorm.replace(/^\+/, "");

    // 1) Fetch latest OPEN order for this customer
    const { data, error } = await supa
      .from("orders")
      .select("id, items, status, source_phone, parse_reason")
      .eq("org_id", orgId)
      .or(
        `source_phone.eq.${phonePlain},source_phone.eq.+${phonePlain}` // supabase OR syntax
      )
      .order("created_at", { ascending: false })
      .limit(5);

    if (error) {
      console.warn("[MODIFIER][engine] order fetch err", error.message);
      return { status: "error", reason: "order_fetch_error" };
    }

    const openOrder = (data || []).find((o: any) =>
      isOrderOpen(o.status as string)
    );

    if (!openOrder || !openOrder.id) {
      return { status: "no_open_order", reason: "no_open_order_for_phone" };
    }

    const orderId = openOrder.id as string;
    const items = Array.isArray(openOrder.items) ? [...openOrder.items] : [];

    if (!items.length) {
      return { status: "no_match", reason: "order_has_no_items" };
    }

    const mc = modifier.change;
    const mt = modifier.target;

    if (!mc || !mt || mt.type !== "item") {
      return { status: "skipped_no_modifier", reason: "invalid_modifier_shape" };
    }

    if (modifier.scope === "ambiguous") {
      return { status: "ambiguous_scope", reason: "scope_ambiguous" };
    }

    // Scope resolution
    let targetIndices: number[] = [];

    if (modifier.scope === "all") {
      // if they say "everything" etc, we apply to all items
      targetIndices = items.map((_, idx) => idx);
    } else {
      // scope = "one" or undefined → try to match by text
      const targetText = mt.text || mt.canonical || "";
      targetIndices = findTargetItemIndices(items, targetText);

      // If multiple matches and they said "one", we still apply to all matches –
      // safer than guessing a single line silently.
      if (!targetIndices.length) {
        return { status: "no_match", reason: "no_item_match_for_target" };
      }
    }

    let changed = false;

    for (const idx of targetIndices) {
      const it = { ...(items[idx] || {}) };

      switch (mc.type) {
        case "variant": {
          const newVar = (mc.new_variant || "").toString().trim();
          if (newVar) {
            it.variant = newVar;
            changed = true;
          }
          break;
        }
        case "qty": {
          const hasNew = mc.new_qty != null && Number.isFinite(mc.new_qty);
          const hasDelta =
            mc.delta_qty != null && Number.isFinite(mc.delta_qty);
          const prevQty = Number(it.qty || 0) || 0;

          if (hasNew) {
            it.qty = mc.new_qty;
            changed = true;
          } else if (hasDelta) {
            const next = prevQty + (mc.delta_qty as number);
            it.qty = next > 0 ? next : 0;
            changed = true;
          }
          break;
        }
        case "remove": {
          // Mark as removed by setting qty=0
          it.qty = 0;
          changed = true;
          break;
        }
        case "note": {
          const note = (mc.note || "").toString().trim();
          if (note) {
            const existing = (it.notes || "").toString().trim();
            it.notes = existing ? `${existing}; ${note}` : note;
            changed = true;
          }
          break;
        }
        default:
          break;
      }

      items[idx] = it;
    }

    if (!changed) {
      return { status: "no_match", reason: "no_change_applied" };
    }

    const newParseReason =
      (openOrder.parse_reason || "") +
      `; modifier:${mc.type}:${modifier.scope || "one"}`;

    const { error: upErr } = await supa
      .from("orders")
      .update({
        items,
        parse_reason: newParseReason,
      })
      .eq("id", orderId)
      .eq("org_id", orgId);

    if (upErr) {
      console.warn("[MODIFIER][engine] update err", upErr.message);
      return { status: "error", reason: "order_update_error" };
    }

    console.log("[MODIFIER][engine] applied", {
      orgId,
      orderId,
      changeType: mc.type,
      scope: modifier.scope,
      affectedLines: targetIndices.length,
    });

    return {
      status: "applied",
      orderId,
      reason: "modifier_applied",
    };
  } catch (e: any) {
    console.warn("[MODIFIER][engine] unexpected", e?.message || e);
    return { status: "error", reason: "unexpected_error" };
  }
}