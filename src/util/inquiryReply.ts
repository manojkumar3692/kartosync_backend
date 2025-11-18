export function formatInquiryReply(product: any, kind: "price" | "availability") {
    if (kind === "price") {
      return `${product.name} – ${product.price} AED${product.unit ? ` / ${product.unit}` : ""}`;
    }
  
    if (kind === "availability") {
      return `${product.name} is ${product.in_stock ? "available" : "not available"}.`;
    }
  
    return product.name;
  }