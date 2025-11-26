// src/order/modifierEngine.ts
import type { ModifierPayload } from "../types";

export type ModifierApplyStatus =
  | "applied"
  | "no_match"
  | "ambiguous"
  | "noop";

export type ModifierCandidate = {
  index: number;
  label: string;
  qty: number | null;
  modifier?: ModifierPayload; // optional full modifier for that item
};

export type ModifierApplyResult = {
  status: ModifierApplyStatus;
  items: any[];
  summary: string;
  candidates?: ModifierCandidate[];
};

function asNumberOrNull(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function norm(s: any): string {
  return String(s ?? "").trim().toLowerCase();
}

function getItemKey(it: any): string {
  const canonical = norm(it?.canonical);
  const name = norm(it?.name);
  return canonical || name;
}

function scoreMatch(target: string, itemKey: string): number {
  if (!target || !itemKey) return 0;
  if (target === itemKey) return 3;
  if (itemKey.includes(target) || target.includes(itemKey)) return 2;

  // Loose token overlap
  const tTokens = target.split(/\s+/).filter(Boolean);
  const iTokens = itemKey.split(/\s+/).filter(Boolean);
  const overlap = tTokens.filter((t) => iTokens.includes(t));
  if (overlap.length > 0) return 1;

  return 0;
}

function findCandidateIndices(items: any[], modifier: ModifierPayload): number[] {
  const targetText = norm(
    modifier?.target?.canonical || modifier?.target?.text || ""
  );

  // If scope is "all", we do NOT try to match a specific index.
  if (modifier.scope === "all") {
    return items.map((_, idx) => idx);
  }

  if (!targetText) return [];

  const scores: { idx: number; score: number }[] = [];
  items.forEach((it, idx) => {
    const key = getItemKey(it);
    const s = scoreMatch(targetText, key);
    if (s > 0) scores.push({ idx, score: s });
  });

  if (!scores.length) return [];

  // Keep only the best score(s)
  const maxScore = Math.max(...scores.map((s) => s.score));
  const best = scores.filter((s) => s.score === maxScore).map((s) => s.idx);

  return best;
}

function buildCandidates(items: any[], indices: number[]): ModifierCandidate[] {
  return indices.map((idx) => {
    const it = items[idx] || {};
    const labelParts: string[] = [];

    if (it.canonical || it.name) labelParts.push(String(it.canonical || it.name));
    if (it.variant) labelParts.push(String(it.variant));
    if (it.unit) labelParts.push(String(it.unit));

    const label = labelParts.join(" ").trim() || `Item #${idx + 1}`;
    const qty = asNumberOrNull(it.qty);

    return { index: idx, label, qty };
  });
}

function applyToItems(
  items: any[],
  modifier: ModifierPayload,
  indices: number[]
): { items: any[]; summary: string; status: ModifierApplyStatus } {
  const cloned = items.map((x) => ({ ...x }));
  const change = modifier.change;

  if (!indices.length) {
    return {
      items,
      status: "no_match",
      summary: "no matching items for target",
    };
  }

  // If AI explicitly decided "ambiguous" scope → we surface as ambiguous, not apply.
  if (modifier.scope === "ambiguous" && indices.length > 1) {
    return {
      items,
      status: "ambiguous",
      summary: `ambiguous target; ${indices.length} possible items`,
    };
  }

  const targetIndices =
    modifier.scope === "all" ? items.map((_, i) => i) : indices;

  if (!targetIndices.length) {
    return {
      items,
      status: "no_match",
      summary: "no applicable items after scope resolution",
    };
  }

  switch (change.type) {
    case "qty": {
      const newQty = asNumberOrNull(change.new_qty);
      const deltaQty = asNumberOrNull(change.delta_qty);
      let removedCount = 0;
      let changedCount = 0;

      // We apply from high → low index when we might remove items
      const sorted = [...targetIndices].sort((a, b) => b - a);

      for (const idx of sorted) {
        const it = cloned[idx];
        if (!it) continue;

        let curQty = asNumberOrNull(it.qty);
        if (curQty === null) curQty = 1;

        let finalQty = curQty;

        if (newQty !== null) {
          finalQty = newQty;
        } else if (deltaQty !== null) {
          finalQty = curQty + deltaQty;
        } else {
          continue;
        }

        if (finalQty <= 0) {
          cloned.splice(idx, 1);
          removedCount++;
        } else {
          it.qty = finalQty;
          changedCount++;
        }
      }

      if (!removedCount && !changedCount) {
        return {
          items,
          status: "noop",
          summary: "no quantity change applied",
        };
      }

      const parts: string[] = [];
      if (changedCount)
        parts.push(`updated qty on ${changedCount} item(s)`);
      if (removedCount) parts.push(`removed ${removedCount} item(s)`);

      return {
        items: cloned,
        status: "applied",
        summary: parts.join(", "),
      };
    }

    case "variant": {
      const variant = (change as any).new_variant ?? null;
      if (!variant) {
        return {
          items,
          status: "noop",
          summary: "no variant provided",
        };
      }

      let changed = 0;
      for (const idx of targetIndices) {
        const it = cloned[idx];
        if (!it) continue;
        it.variant = variant;
        changed++;
      }

      if (!changed) {
        return { items, status: "noop", summary: "no items updated" };
      }

      return {
        items: cloned,
        status: "applied",
        summary: `set variant="${variant}" on ${changed} item(s)`,
      };
    }

    case "remove": {
      const sorted = [...targetIndices].sort((a, b) => b - a);
      let removed = 0;
      for (const idx of sorted) {
        if (idx >= 0 && idx < cloned.length) {
          cloned.splice(idx, 1);
          removed++;
        }
      }

      if (!removed) {
        return { items, status: "noop", summary: "no items removed" };
      }

      return {
        items: cloned,
        status: "applied",
        summary: `removed ${removed} item(s)`,
      };
    }

    case "note": {
      const note = (change as any).note ?? null;
      if (!note) {
        return {
          items,
          status: "noop",
          summary: "no note provided",
        };
      }

      let changed = 0;
      for (const idx of targetIndices) {
        const it = cloned[idx];
        if (!it) continue;
        const prev = String(it.notes || "").trim();
        it.notes = prev ? `${prev}; ${note}` : note;
        changed++;
      }

      if (!changed) {
        return { items, status: "noop", summary: "no notes updated" };
      }

      return {
        items: cloned,
        status: "applied",
        summary: `added note to ${changed} item(s)`,
      };
    }

    default: {
      return {
        items,
        status: "noop",
        summary: `unsupported change type: ${change.type}`,
      };
    }
  }
}

/**
 * MAIN ENTRY
 * Applies a parsed modifier onto order items, with disambiguation support.
 */
export function applyModifierToItems(
  items: any[],
  modifier: ModifierPayload
): ModifierApplyResult {
  const safeItems = Array.isArray(items) ? items : [];

  // Basic sanity
  if (!modifier || !modifier.change) {
    return {
      status: "noop",
      items: safeItems,
      summary: "invalid modifier payload",
    };
  }

  const indices = findCandidateIndices(safeItems, modifier);

  if (!indices.length && modifier.scope !== "all") {
    return {
      status: "no_match",
      items: safeItems,
      summary: "no items matched the target phrase",
    };
  }

  // If we got 2+ equally good matches and NOT scope=all → ambiguous
  if (indices.length > 1 && modifier.scope !== "all") {
    return {
      status: "ambiguous",
      items: safeItems,
      summary: `ambiguous target; ${indices.length} candidate items`,
      candidates: buildCandidates(safeItems, indices),
    };
  }

  const applied = applyToItems(safeItems, modifier, indices);

  if (applied.status === "ambiguous") {
    return {
      status: "ambiguous",
      items: safeItems,
      summary: applied.summary,
      candidates: buildCandidates(safeItems, indices),
    };
  }

  return {
    status: applied.status,
    items: applied.items,
    summary: applied.summary,
  };
}

// 👇 alias for your import in applyModifierToOrder.ts
export type ApplyModifierResult = ModifierApplyResult;