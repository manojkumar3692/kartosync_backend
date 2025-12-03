// src/ai/ingest/orderEngine.ts

import type { IngestContext, IngestResult, ConversationState } from "./types";
import { handleCatalogFallbackFlow } from "./orderLegacyEngine";

/**
 * Current main catalog/order handler.
 *
 * For now this is a thin wrapper that delegates everything to the
 * legacy engine (handleCatalogFallbackFlow), which contains your
 * full, battle-tested ordering logic.
 *
 * Later, when we’re ready to enable AI free-flow multi-item parsing,
 * we’ll enhance this function to:
 *  - run parseIntent / applyIntentToCart first
 *  - and only if that fails, fall back to handleCatalogFallbackFlow.
 */
export async function handleCatalogFlow(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
  return handleCatalogFallbackFlow(ctx, state);
}