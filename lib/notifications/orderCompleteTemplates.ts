import type { OrderCompleteCandidate } from "./orderComplete";
import { formatOrderGroup } from "./helpers";

export function renderOrderComplete(order: OrderCompleteCandidate & { buyerGroup?: string | null }, channel: "SMS" | "EMAIL") {
  const reference = `${order.orderType} ${order.orderNumber}`;
  const group = formatOrderGroup(order.buyerGroup, order.orderType);
  const description = group ? `${group} order` : "order";
  const textBody = `MLD: Your ${description} ${reference} is complete. Thank you for choosing MLD.${channel === "SMS" ? " Reply STOP to opt out." : ""}`;
  return { subject: `MLD ${description} ${reference} is complete`, textBody };
}
