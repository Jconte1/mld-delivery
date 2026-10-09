import type { OrderCompleteCandidate } from "./orderComplete";

export function renderOrderComplete(order: OrderCompleteCandidate, channel: "SMS" | "EMAIL") {
  const reference = `${order.orderType} ${order.orderNumber}`;
  const textBody = `MLD: Your order ${reference} is complete. Thank you for choosing MLD.${channel === "SMS" ? " Reply STOP to opt out." : ""}`;
  return { subject: `MLD order ${reference} is complete`, textBody };
}
