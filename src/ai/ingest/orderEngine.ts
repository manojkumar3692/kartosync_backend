// src/ai/ingest/orderEngine.ts

import type { IngestContext, IngestResult, ConversationState } from "./types";
import { handleCatalogFallbackFlow } from "./orderLegacyEngine";
import {
  parseIntent,
  type ParsedIntent,
  type ParsedOrderLine,
  getOrgVertical,
  type Vertical,
} from "./intentEngine";

/**
 * Helper: build a synthetic user text from a ParsedOrderLine
 * e.g. { quantity: 2, itemText: "chicken biryani" } → "2 chicken biryani"
 */
function lineToText(line: ParsedOrderLine): string {
  const qty = line.quantity && line.quantity > 0 ? line.quantity : 1;
  return `${qty} ${line.itemText}`;
}

/**
 * Current main catalog/order handler.
 *
 * For now:
 *  - We always run parseIntent (cheap, rule-based).
 *  - If intent is `add_items`, we take ONLY the first line and
 *    feed `"QTY NAME"` into the legacy flow.
 *  - For everything else we fully delegate to handleCatalogFallbackFlow.
 *
 * This preserves your existing behaviour, but ensures multi-item
 * messages at least start with a clean single line for item #1.
 *
 * NOTE: Coke (2nd line) is still not auto-added. To support
 * true multi-item chaining, we’ll need to extend orderLegacyEngine
 * and your state machine to iterate through `intent.lines`.
 */
export async function handleCatalogFlow(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
  const vertical: Vertical = await getOrgVertical(ctx.org_id);

  const intent: ParsedIntent = await parseIntent(ctx.text || "", {
    vertical,
    state,
  });

  console.log("[INTENT][PARSE][ORDER_ENGINE]", {
    vertical,
    state,
    intent: intent.intent,
    ruleTag: intent.ruleTag,
  });

  // If we don't understand the intent → fall back completely
  if (!intent || intent.intent === "unknown") {
    return handleCatalogFallbackFlow(ctx, state);
  }

  // NEW: multi-item message like "1 chicken biryani, 1 coke"
  if (intent.intent === "add_items" && intent.lines && intent.lines.length > 0) {
    const firstLine: ParsedOrderLine = intent.lines[0];

    // Build a synthetic user message for the first line only
    const firstText = lineToText(firstLine);

    const ctxFirst: IngestContext = {
      ...ctx,
      text: firstText,
    };

    // For now we just let the legacy engine handle this as a normal
    // single-item flow. The remaining lines (coke, etc.) will be
    // handled in a later iteration when we add true multi-item chaining.
    return handleCatalogFallbackFlow(ctxFirst, state);
  }

  // Everything else → legacy engine as-is
  return handleCatalogFallbackFlow(ctx, state);
}