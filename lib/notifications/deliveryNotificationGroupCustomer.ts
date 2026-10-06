import { Prisma, type PrismaClient } from "../generated/prisma/client";
import { deliveryAddressGroupingKey } from "./deliveryNotificationGrouping";
import { getDeliveryAppBaseUrl } from "./deliveryConfirmationLinks";
import { dateKey } from "./helpers";
import { parseDateInputValue, validateRequestedDeliveryDateEligibility } from "./deliveryDateEligibility";
import { enqueueDeliveryConfirmationAttributeWriteback, SMS_CONFIRMED_VIA_VALUE } from "./deliveryConfirmationAttributeWritebackQueue";
import { enqueueDeliveryRequestedDateWriteback } from "./deliveryRequestedDateWritebackQueue";

export const buildDeliveryNotificationGroupLink = (token: string) => `${getDeliveryAppBaseUrl()}/group/${encodeURIComponent(token)}`;
export const groupCustomerInclude = {
  attempts: { orderBy: { attemptNumber: "desc" as const }, take: 1 },
  members: { include: { notificationEvent: { include: {
    order: { include: { address: true, contact: true } },
    orderDeliveryGroup: { include: { deliveryGroupLines: { where: { isActive: true }, include: { orderLine: true } } } },
  } } } },
} satisfies Prisma.DeliveryNotificationGroupInclude;
export type CustomerNotificationGroup = Prisma.DeliveryNotificationGroupGetPayload<{ include: typeof groupCustomerInclude }>;

export function groupCustomerStateError(group: CustomerNotificationGroup, now = new Date()) {
  if (!group.members.length) return "empty_group";
  if (dateKey(group.deliveryDate) < dateKey(now)) return "expired";
  if (!["SUBMITTED", "DELIVERED"].includes(group.attempts[0]?.status ?? "")) return "notification_not_sent";
  for (const { notificationEvent: event } of group.members) {
    const delivery = event.orderDeliveryGroup;
    const assignedContactId = event.intervalType === "DAY_2" && event.recipientContactRole === "DELIVERY"
      ? event.order.deliveryContactId : event.order.contactId;
    if (event.contactId !== group.contactId || assignedContactId !== group.contactId ||
        dateKey(delivery.deliveryDate) !== dateKey(group.deliveryDate) || !delivery.isActive ||
        deliveryAddressGroupingKey(event.order.address) !== group.addressKey ||
        !delivery.deliveryGroupLines.length || delivery.deliveryGroupLines.some(line =>
          dateKey(line.deliveryDate) !== dateKey(group.deliveryDate) || !line.orderLine?.requestedOn || dateKey(line.orderLine.requestedOn) !== dateKey(group.deliveryDate))) return "membership_changed";
    if (!["ACTIVE", "PAYMENT_PENDING"].includes(event.order.internalLifecycleStatus) ||
        /^(completed?|closed|cancelled|canceled|voided)$/i.test(event.order.status ?? "")) return "order_ineligible";
  }
  return null;
}

export async function loadCustomerNotificationGroup(client: PrismaClient, token: string) {
  return client.deliveryNotificationGroup.findUnique({ where: { linkToken: token }, include: groupCustomerInclude });
}

export type CustomerResponsePorts = {
  refresh?: (group: CustomerNotificationGroup) => Promise<void>;
  confirm?: typeof enqueueDeliveryConfirmationAttributeWriteback;
  requestDate?: typeof enqueueDeliveryRequestedDateWriteback;
};

async function refreshGroup(group: CustomerNotificationGroup) {
  const { importSalesOrdersForLineRequestedOn } = await import("../erp/importSalesOrders");
  const result = await importSalesOrdersForLineRequestedOn(group.deliveryDate, {
    orderLookups: group.members.map(({ notificationEvent: e }) => ({ orderType: e.orderType, orderNumber: e.orderNumber })),
    includeUnqualifiedOrderLookups: true,
  });
  const successes = new Set(result.successfullyRefreshedOrders?.map(o => `${o.orderType}:${o.orderNumber}`));
  if (group.members.some(({ notificationEvent: e }) => !successes.has(`${e.orderType}:${e.orderNumber}`))) throw new Error("fresh_import_failed");
}

// One local transaction claims the response. ERP jobs remain independently tracked per order.
export async function respondToNotificationGroup(params: {
  client: PrismaClient; token: string; action: "CONFIRM" | "REQUEST_DATE" | "CHANGE_REQUEST";
  requestedDate?: string; source: "WEBPAGE" | "SMS"; rawResponse?: string; now?: Date;
  ports?: CustomerResponsePorts;
}) {
  const { client } = params;
  const now = params.now ?? new Date();
  let group = await loadCustomerNotificationGroup(client, params.token);
  if (!group || group.intervalType !== "DAY_42") throw new Error("confirmation_group_not_found");
  if (group.responseAt) return { outcome: "already_recorded", jobs: [] };
  await (params.ports?.refresh ?? refreshGroup)(group);
  group = await loadCustomerNotificationGroup(client, params.token);
  if (!group) throw new Error("confirmation_group_not_found");
  const stateError = groupCustomerStateError(group, now);
  if (stateError) throw new Error(stateError);
  const ids = group.members.map(m => m.deliveryConfirmationId).filter((id): id is string => Boolean(id));
  if (ids.length !== group.members.length || new Set(ids).size !== ids.length) throw new Error("confirmation_membership_incomplete");
  const confirmations = await client.deliveryConfirmation.findMany({ where: { id: { in: ids } } });
  if (confirmations.length !== ids.length) throw new Error("confirmation_missing");
  let requestedDate: Date | null = null;
  const pendingStatuses = ["PENDING", "INCOMPLETE", "UNRECOGNIZED", "AWAITING_NEW_DATE", "CHANGE_REQUESTED"];
  for (const member of group.members) {
    const confirmation = confirmations.find(c => c.id === member.deliveryConfirmationId)!;
    const event = member.notificationEvent;
    if (!pendingStatuses.includes(confirmation.status) || confirmation.linkExpiredAt ||
        (confirmation.linkExpiresAt && confirmation.linkExpiresAt < now) ||
        confirmation.deliveryGroupId !== event.deliveryGroupId || confirmation.contactId !== group.contactId ||
        dateKey(confirmation.deliveryDate) !== dateKey(group.deliveryDate) || event.order.confirmVia?.trim()) throw new Error("confirmation_already_resolved_or_stale");
    if (params.action === "REQUEST_DATE") {
      const parsed = parseDateInputValue(params.requestedDate ?? "");
      const validation = validateRequestedDeliveryDateEligibility({ requestedDate: parsed.valid ? parsed.date : null,
        currentDeliveryDate: group.deliveryDate, address: event.order.address });
      if (!validation.allowed) throw new Error(validation.reason);
      requestedDate = validation.date;
    }
  }
  const status = params.action === "CONFIRM" ? "CONFIRMED" : params.action === "REQUEST_DATE" ? "NEW_DATE_REQUESTED" : "AWAITING_NEW_DATE";
  const claimed = await client.$transaction(async tx => {
    const latest = await tx.deliveryNotificationGroup.findUnique({ where: { id: group!.id }, include: groupCustomerInclude });
    if (!latest || groupCustomerStateError(latest, now)) throw new Error("membership_changed");
    const claim = await tx.deliveryNotificationGroup.updateMany({ where: { id: group!.id, responseAt: null }, data:
      params.action === "CHANGE_REQUEST" ? { responseAction: "CHANGE_REQUEST" } :
        { responseAction: params.action, responseDate: requestedDate, responseAt: now } });
    if (!claim.count) return false;
    const updated = await tx.deliveryConfirmation.updateMany({ where: { id: { in: ids }, status: { in: ["PENDING", "INCOMPLETE", "UNRECOGNIZED", "AWAITING_NEW_DATE", "CHANGE_REQUESTED"] } }, data: {
      status, responseChannel: params.source === "SMS" ? "SMS" : null, rawResponse: params.rawResponse ?? params.action,
      normalizedResponse: requestedDate ? dateKey(requestedDate) : params.action,
      confirmedAt: params.action === "CONFIRM" ? now : undefined,
      changeRequestedAt: params.action !== "CONFIRM" ? now : undefined,
      requestedNewDate: requestedDate ?? undefined, requestedNewDateRaw: params.requestedDate,
      requestedNewDateAt: requestedDate ? now : undefined,
      lastSmsResponseAt: params.source === "SMS" ? now : undefined,
      lastSmsResponseBody: params.source === "SMS" ? params.rawResponse : undefined,
      confirmationWritebackStatus: params.action === "CONFIRM" ? "enqueue_pending" : undefined,
      requestedDateWritebackStatus: requestedDate ? "enqueue_pending" : undefined,
      manualReviewRequired: requestedDate ? true : undefined,
      manualReviewReason: requestedDate ? "NEW_DATE_REQUESTED" : undefined,
    } });
    if (updated.count !== ids.length) throw new Error("confirmation_changed_during_response");
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (!claimed) return { outcome: "already_recorded", jobs: [] };
  const jobs: { order: string; jobId: string | null; error: string | null }[] = [];
  if (params.action === "CHANGE_REQUEST") return { outcome: "awaiting_new_date", jobs };
  for (const member of group.members) {
    const e = member.notificationEvent;
    const confirmationId = member.deliveryConfirmationId!;
    const common = { orderType: e.orderType, orderNumber: e.orderNumber, deliveryConfirmationId: confirmationId,
      deliveryGroupId: e.deliveryGroupId, contact: e.order.contact!, source: params.source };
    try {
      const queued = requestedDate
        ? await (params.ports?.requestDate ?? enqueueDeliveryRequestedDateWriteback)({ ...common,
            originalDeliveryDate: group.deliveryDate, requestedDeliveryDate: requestedDate, requestedAt: now,
            lineNumbers: e.orderDeliveryGroup.deliveryGroupLines.map(l => l.lineNbr) })
        : await (params.ports?.confirm ?? enqueueDeliveryConfirmationAttributeWriteback)({ ...common,
            deliveryDate: group.deliveryDate, confirmedVia: params.source === "SMS" ? SMS_CONFIRMED_VIA_VALUE : "WEBPAGE" });
      await client.deliveryConfirmation.update({ where: { id: confirmationId }, data: requestedDate ? {
        requestedDateWritebackJobId: queued.jobId, requestedDateWritebackStatus: "queued", requestedDateWritebackPayload: queued.payload,
        requestedDateWritebackQueuedAt: now, requestedDateWritebackError: null,
      } : { confirmationWritebackJobId: queued.jobId, confirmationWritebackStatus: "queued", confirmationWritebackPayload: queued.payload,
        confirmationWritebackQueuedAt: now, confirmationWritebackError: null } });
      jobs.push({ order: `${e.orderType}/${e.orderNumber}`, jobId: queued.jobId, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.deliveryConfirmation.update({ where: { id: confirmationId }, data: requestedDate ? {
        requestedDateWritebackStatus: "enqueue_failed", requestedDateWritebackError: message.slice(0, 2048), requestedDateWritebackCheckedAt: now,
      } : { confirmationWritebackStatus: "enqueue_failed", confirmationWritebackError: message.slice(0, 2048), confirmationWritebackCheckedAt: now } });
      jobs.push({ order: `${e.orderType}/${e.orderNumber}`, jobId: null, error: message });
    }
  }
  return { outcome: jobs.some(j => j.error) ? "writeback_attention_required" : "recorded", jobs };
}
