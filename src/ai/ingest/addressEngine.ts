// src/ai/ingest/addressEngine.ts
import { supa } from "../../db";
import {
  IngestContext,
  IngestResult,
  ConversationState,
} from "./types";
import { setState, clearState } from "./stateManager";

// Strong address heuristic
function looksLikeAddress(text: string): boolean {
  const msg = text.toLowerCase().trim();

  return (
    msg.includes("street") ||
    msg.includes("st ") ||
    msg.includes("road") ||
    msg.includes("rd ") ||
    msg.includes("area") ||
    msg.includes("blk") ||
    msg.includes("block") ||
    msg.includes("near") ||
    msg.includes("behind") ||
    msg.includes("flat") ||
    msg.includes("villa") ||
    msg.includes("apt") ||
    msg.includes("tower") ||
    msg.includes("building") ||
    msg.includes("nagar") ||
    msg.includes("layout") ||
    msg.includes("colony") ||
    // number + word → common house format
    !!msg.match(/\d+[\/\-]?\d*\s+[a-z]/i) ||
    msg.length > 15
  );
}

export async function handleAddress(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
  const { org_id, from_phone, text } = ctx;
  const msg = text.trim();

  // 1) Not an address → ask again
  if (!looksLikeAddress(msg)) {
    await setState(org_id, from_phone, "awaiting_address");

    return {
      used: true,
      kind: "order",
      reply:
        "📍 Please send your full delivery address (flat/house no, street, area, city).",
      order_id: null,
    };
  }

  // --------------------------------------------------------
  // 2) FIXED: SELECT latest pending order FIRST (safe)
  // --------------------------------------------------------
  const { data: orderRow, error: findErr } = await supa
    .from("orders")
    .select("id")
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("[ADDR][FIND_PENDING]", { orderRow, findErr });

  if (!orderRow) {
    await setState(org_id, from_phone, "awaiting_address");
    return {
      used: true,
      kind: "order",
      reply: "⚠️ Couldn't find a pending order. Please send the address again.",
      order_id: null,
    };
  }

  // --------------------------------------------------------
  // 3) FIXED: UPDATE using ID ONLY (Postgres-safe)
  // --------------------------------------------------------
  const { data: updated, error: updErr } = await supa
    .from("orders")
    .update({ shipping_address: msg })
    .eq("id", orderRow.id)
    .select("id")
    .single();

  console.log("[ADDR][UPDATE]", { updated, updErr });

  if (!updated || updErr) {
    await setState(org_id, from_phone, "awaiting_address");

    return {
      used: true,
      kind: "order",
      reply: "⚠️ Couldn't attach the address. Please send it again.",
      order_id: null,
    };
  }

  // 4) Success → clear state
  await clearState(org_id, from_phone);

  return {
    used: true,
    kind: "order",
    reply:
      "📍 Address received!\n\n" +
      "How would you like to pay?\n" +
      "1) Cash\n" +
      "2) Online Payment\n\n" +
      "Please type *1* or *2*.",
    order_id: updated.id,
  };
}