// // src/ai/ingest/inquiryEngine.ts

// import { supa } from "../../db";
// import {
//   IngestContext,
//   IngestResult,
//   ConversationState,
//   InquiryType,
// } from "./types";

// import { setState } from "./stateManager";
// import { matchProductsToText, chooseByNumber } from "./textMatchEngine";

// export async function handleInquiryFlow(
//   ctx: IngestContext,
//   inquiry: InquiryType,
//   state: ConversationState
// ): Promise<IngestResult> {
//   const { org_id, from_phone, text } = ctx;

//   // -------------------------------------------------------
//   // 1️⃣ RUN SMART MATCHING ENGINE
//   // -------------------------------------------------------
//   const matches = await matchProductsToText(org_id, text);

//   if (matches.length === 0) {
//     return {
//       used: true,
//       kind: "inquiry",
//       reply: `I couldn’t find that item.\nPlease type exact item name or try again.`,
//     };
//   }

//   // -------------------------------------------------------
//   // 2️⃣ USER CHOOSES BY NUMBER (Highest priority)
//   // -------------------------------------------------------
//   const numChoice = chooseByNumber(text, matches);
//   if (numChoice) {
//     return await finalizeSingleInquiry(numChoice, inquiry, ctx);
//   }

//   // -------------------------------------------------------
//   // 3️⃣ MULTIPLE MATCHES (Text fallback)
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
//       kind: "inquiry",
//       reply: `I found multiple items:\n${formatted}\n\nPlease reply with the number.`,
//       options: matches,
//     };
//   }

//   // -------------------------------------------------------
//   // 4️⃣ EXACT SINGLE MATCH
//   // -------------------------------------------------------
//   return await finalizeSingleInquiry(matches[0], inquiry, ctx);
// }

// // -------------------------------------------------------
// // HELPERS
// // -------------------------------------------------------
// async function finalizeSingleInquiry(
//   match: any,
//   inquiry: InquiryType,
//   ctx: IngestContext
// ): Promise<IngestResult> {
//   const { org_id, from_phone } = ctx;

//   const item = match.variants[0]; // BEST variant

//   // PRICE INQUIRY
//   if (inquiry === "price") {
//     return {
//       used: true,
//       kind: "inquiry",
//       reply: `The price of *${item.display_name || item.canonical}* (${item.variant}) is ₹${item.price_per_unit}.`,
//     };
//   }

//   // AVAILABILITY INQUIRY
//   if (inquiry === "availability") {
//     await setState(org_id, from_phone, "ordering_qty");

//     return {
//       used: true,
//       kind: "inquiry",
//       reply:
//         `Yes, *${item.display_name || item.canonical}* (${item.variant}) is available.\n\n` +
//         `How many would you like to order?`,
//       meta: { item },
//     };
//   }

//   // MENU INQUIRY
//   if (inquiry === "menu") {
//     const { data: catalog } = await supa
//       .from("products")
//       .select("canonical, display_name, variant, price_per_unit")
//       .eq("org_id", org_id)
//       .eq("active", true);

//     const items = catalog
//       .map(
//         (c) =>
//           `• ${c.display_name || c.canonical} (${c.variant}) – ₹${c.price_per_unit}`
//       )
//       .join("\n");

//     return {
//       used: true,
//       kind: "inquiry",
//       reply: `Here is today's menu:\n\n${items}`,
//     };
//   }

//   // fallback
//   return {
//     used: true,
//     kind: "inquiry",
//     reply: `How can I help you?`,
//   };
// }