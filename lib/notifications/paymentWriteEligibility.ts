import { timingSafeEqual } from "node:crypto";
import type { prisma } from "../prisma";
import { selectNotificationChannel, type NotificationContactInput } from "./helpers";
import { loadActiveNotificationOptOutAddresses } from "./notificationOptOutLookup";
import { clearanceSourceAllowed, paymentLifecycleBlockReason } from "./paymentLifecycleEligibility";

export type PaymentWriteEligibilityInput = {
  operation: "hold" | "clearance";
  orderType: string; orderNumber: string; deliveryDate: string; contactId: string;
  sourceInterval?: string;
  contact: NotificationContactInput;
};

export function paymentWriteAuthorized(authorization: string | null, secret: string | undefined) {
  if (!secret?.trim() || !authorization?.startsWith("Bearer ")) return false;
  const expected = Buffer.from(secret.trim());
  const provided = Buffer.from(authorization.slice(7).trim());
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export async function checkPaymentWriteEligibility(input: PaymentWriteEligibilityInput, client: typeof prisma) {
  const deny = (reason: string) => ({ eligible: false, reason });
  if (input.operation === "clearance" && !clearanceSourceAllowed(input.sourceInterval ?? "")) return deny("clearance_source_not_allowed");
  const order = await client.order.findUnique({
    where: { orderType_orderNumber: { orderType: input.orderType, orderNumber: input.orderNumber } },
    include: { deliveryGroups: { where: { isActive: true, deliveryDate: new Date(`${input.deliveryDate}T00:00:00.000Z`),
      deliveryGroupLines: { some: { isActive: true } } } } },
  });
  if (!order || order.contactId !== input.contactId || !order.primaryContactFetchSucceeded) return deny("contact_assignment_or_freshness_changed");
  if (order.deliveryGroups.length !== 1) return deny("delivery_group_missing_or_changed");
  if (["BLOCKED", "MANUAL_REVIEW", "COMPLETED", "CANCELLED"].includes(order.internalLifecycleStatus) ||
      /^(completed?|closed|cancelled|canceled|voided)$/i.test(order.status ?? "")) return deny("order_ineligible");
  const block = paymentLifecycleBlockReason(order);
  if (block) return deny(block);
  const channel = selectNotificationChannel(input.contact, await loadActiveNotificationOptOutAddresses(client));
  if (!channel.selectedChannel) return deny("no_automated_channel_available");
  if (input.operation === "clearance") {
    const { hasQualifyingTenDayNotification } = await import("./deliveryTenDayConfirmation");
    if (!await hasQualifyingTenDayNotification({ ...order.deliveryGroups[0], order }, client, input.contact)) return deny("successful_opted_in_notification_required");
  }
  return { eligible: true, reason: "eligible" };
}
