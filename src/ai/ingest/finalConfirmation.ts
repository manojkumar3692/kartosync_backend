// src/ai/ingest/finalConfirmation.ts

export function buildFinalConfirmation(item, qty, total) {
    const cleanPrice = total
      ? `💰 Total: AED ${total}`
      : "💰 Price will be confirmed by the kitchen.";
  
    return (
      `🍽 *Order Summary*\n` +
      `• ${item.canonical} (${item.variant}) × ${qty}\n\n` +
      `${cleanPrice}\n\n` +
      `⏳ Estimated delivery: *20–35 mins*\n\n` +
      `How would you like to pay?\n` +
      `1️⃣ Cash\n` +
      `2️⃣ Online Payment\n\n` +
      `Please reply with *1* or *2*.`
    );
  }