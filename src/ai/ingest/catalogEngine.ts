// // src/ai/ingest/catalogEngine.ts

// import { supa } from "../../db";
// import { setState, clearState } from "./stateManager";
// import {
//   IngestContext,
//   IngestResult,
//   ConversationState,
// } from "./types";

// import { matchProductsToText, chooseByNumber } from "./textMatchEngine";

// // -------------------------------------------------------------
// // Extract integer quantity (1, 2, 3…)
// // (kept for future use)
// // -------------------------------------------------------------
// function extractQty(text: string): number | null {
//   const m = text.match(/(\d+)/);
//   return m ? Number(m[1]) : null;
// }

// export async function handleCatalogFlow(
//   ctx: IngestContext,
//   state: ConversationState
// ): Promise<IngestResult> {
//   const { org_id, from_phone, text } = ctx;

//   // -------------------------------------------------------
//   // 0️⃣ LOAD MATCHES (smart engine)
//   // -------------------------------------------------------
//   const matches = await matchProductsToText(org_id, text);

//   // NO MATCH
//   if (matches.length === 0) {
//     return {
//       used: true,
//       kind: "order",
//       reply: `I couldn't find that item. Please type again.`,
//       order_id: null,
//     };
//   }

//   // -------------------------------------------------------
//   // 1️⃣ USER PICKED BY NUMBER (highest priority)
//   // -------------------------------------------------------
//   const numChoice = chooseByNumber(text, matches);
//   if (numChoice) {
//     return await proceedWithSingleMatch(numChoice, ctx);
//   }

//   // -------------------------------------------------------
//   // 2️⃣ MULTIPLE MATCH → show choices
//   // -------------------------------------------------------
//   if (matches.length > 1) {
//     const formatted = matches
//       .map(
//         (m, i) =>
//           `${i + 1}) ${m.canonical} – ${m.variants
//             .map((v: any) => v.variant)
//             .join(", ")}`
//       )
//       .join("\n");

//     await setState(org_id, from_phone, "ordering_item");

//     return {
//       used: true,
//       kind: "order",
//       reply:
//         `I found multiple items:\n${formatted}\n\nPlease reply with the number.`,
//       options: matches,
//       order_id: null,
//     };
//   }

//   // -------------------------------------------------------
//   // 3️⃣ EXACT MATCH → continue order
//   // -------------------------------------------------------
//   return await proceedWithSingleMatch(matches[0], ctx);
// }

// // -------------------------------------------------------------
// // HANDLE SINGLE CHOSEN ITEM
// // -------------------------------------------------------------
// async function proceedWithSingleMatch(
//   match: any,
//   ctx: IngestContext
// ): Promise<IngestResult> {
//   const { org_id, from_phone } = ctx;

//   const variants = match.variants || [];
//   const canonical = match.canonical || "";

//   // MULTIPLE VARIANTS → ask to choose number
//   if (variants.length > 1) {
//     await setState(org_id, from_phone, "ordering_item");

//     const opts = variants
//       .map(
//         (v: any, i: number) =>
//           `${i + 1}) ${v.display_name || canonical} – ${v.variant}`
//       )
//       .join("\n");

//     return {
//       used: true,
//       kind: "order",
//       reply: `Choose a variant for *${canonical}*:\n${opts}`,
//       options: variants,
//       order_id: null,
//     };
//   }

//   // SINGLE VARIANT
//   const item = variants[0];

//   await setState(org_id, from_phone, "ordering_qty");

//   return {
//     used: true,
//     kind: "order",
//     reply: `How many *${item.display_name || canonical} (${item.variant})*?`,
//     meta: { item },
//     order_id: null,
//   };
// }