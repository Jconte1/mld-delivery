import type { Prisma } from "@/lib/generated/prisma/client";

export const DELIVERABLE_ORDER_LINE_ITEM_TYPE = "F";

export const ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS = {
  nonStockLineExcluded: "non_stock_line_excluded",
  serviceLineExcluded: "service_line_excluded",
  unknownItemTypeExcluded: "unknown_item_type_excluded",
  requestedOnMissing: "requested_on_missing",
  deliveryGroupMissing: "delivery_group_missing",
  lineMovedDeliveryDate: "line_moved_delivery_date",
  lineRemovedFromOrder: "line_removed_from_order",
} as const;

export type OrderDeliveryGroupLineRemovedReason =
  (typeof ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS)[keyof typeof ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS];

export type CurrentOrderLineDeliveryGroupMembershipInput = {
  id: string;
  lineNbr: number;
  inventoryId: string | null;
  itemType: string | null;
  requestedOn: Date | null;
};

export type SyncOrderDeliveryGroupLineMembershipsResult = {
  consideredLines: number;
  deliverableLines: number;
  activeMembershipsUpserted: number;
  membershipsCreated: number;
  membershipsReactivated: number;
  membershipsDeactivated: number;
  excludedNonStockLines: number;
  excludedServiceLines: number;
  excludedUnknownItemTypeLines: number;
  excludedMissingRequestedOnLines: number;
  excludedMissingDeliveryGroupLines: number;
  activeMembershipCount: number;
};

type OrderDeliveryGroupLineMembershipClient = Pick<
  Prisma.TransactionClient,
  "orderDeliveryGroup" | "orderDeliveryGroupLine"
>;

function emptyResult(): SyncOrderDeliveryGroupLineMembershipsResult {
  return {
    consideredLines: 0,
    deliverableLines: 0,
    activeMembershipsUpserted: 0,
    membershipsCreated: 0,
    membershipsReactivated: 0,
    membershipsDeactivated: 0,
    excludedNonStockLines: 0,
    excludedServiceLines: 0,
    excludedUnknownItemTypeLines: 0,
    excludedMissingRequestedOnLines: 0,
    excludedMissingDeliveryGroupLines: 0,
    activeMembershipCount: 0,
  };
}

function normalizeItemType(itemType: string | null | undefined) {
  const normalized = itemType?.trim().toUpperCase();
  return normalized || null;
}

export function isDeliverableOrderLineItemType(itemType: string | null | undefined) {
  return normalizeItemType(itemType) === DELIVERABLE_ORDER_LINE_ITEM_TYPE;
}

export function dateKey(value: Date | string | null | undefined) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const trimmed = value.trim();
  const isoDatePrefix = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDatePrefix) return isoDatePrefix[1];

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateKey(parsed);
}

function membershipKey(orderDeliveryGroupId: string, orderLineId: string) {
  return `${orderDeliveryGroupId}:${orderLineId}`;
}

function addExclusionCount(
  result: SyncOrderDeliveryGroupLineMembershipsResult,
  reason: OrderDeliveryGroupLineRemovedReason
) {
  if (reason === ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.nonStockLineExcluded) {
    result.excludedNonStockLines += 1;
  } else if (reason === ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.serviceLineExcluded) {
    result.excludedServiceLines += 1;
  } else if (reason === ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.unknownItemTypeExcluded) {
    result.excludedUnknownItemTypeLines += 1;
  } else if (reason === ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.requestedOnMissing) {
    result.excludedMissingRequestedOnLines += 1;
  } else if (reason === ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.deliveryGroupMissing) {
    result.excludedMissingDeliveryGroupLines += 1;
  }
}

export function getOrderDeliveryGroupLineExclusionReason(
  line: Pick<CurrentOrderLineDeliveryGroupMembershipInput, "itemType" | "requestedOn">
): OrderDeliveryGroupLineRemovedReason | null {
  const itemType = normalizeItemType(line.itemType);

  if (itemType === "N") {
    return ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.nonStockLineExcluded;
  }

  if (itemType === "L") {
    return ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.serviceLineExcluded;
  }

  if (itemType !== DELIVERABLE_ORDER_LINE_ITEM_TYPE) {
    return ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.unknownItemTypeExcluded;
  }

  if (!dateKey(line.requestedOn)) {
    return ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.requestedOnMissing;
  }

  return null;
}

export async function syncOrderDeliveryGroupLineMemberships(
  tx: OrderDeliveryGroupLineMembershipClient,
  params: {
    orderId: string;
    orderType: string;
    orderNumber: string;
    importAt: Date;
    currentLines: CurrentOrderLineDeliveryGroupMembershipInput[];
  }
): Promise<SyncOrderDeliveryGroupLineMembershipsResult> {
  const result = emptyResult();
  result.consideredLines = params.currentLines.length;

  const deliveryGroups = await tx.orderDeliveryGroup.findMany({
    where: { orderId: params.orderId, isActive: true },
    select: { id: true, deliveryDate: true },
  });
  const deliveryGroupByDate = new Map(
    deliveryGroups
      .map((deliveryGroup) => [dateKey(deliveryGroup.deliveryDate), deliveryGroup] as const)
      .filter((entry): entry is [string, (typeof deliveryGroups)[number]] => Boolean(entry[0]))
  );

  const existingMemberships = await tx.orderDeliveryGroupLine.findMany({
    where: { orderId: params.orderId },
    select: {
      id: true,
      orderDeliveryGroupId: true,
      orderLineId: true,
      deliveryDate: true,
      isActive: true,
    },
  });
  const existingByGroupAndLine = new Map(
    existingMemberships
      .filter((membership) => membership.orderLineId)
      .map((membership) => [
        membershipKey(membership.orderDeliveryGroupId, membership.orderLineId as string),
        membership,
      ])
  );
  const incomingLinesById = new Map(params.currentLines.map((line) => [line.id, line]));
  const retainedActiveMembershipIds = new Set<string>();

  for (const line of params.currentLines) {
    const exclusionReason = getOrderDeliveryGroupLineExclusionReason(line);
    if (exclusionReason) {
      addExclusionCount(result, exclusionReason);
      continue;
    }

    const deliveryDateKey = dateKey(line.requestedOn);
    const deliveryGroup = deliveryDateKey ? deliveryGroupByDate.get(deliveryDateKey) : null;
    if (!deliveryDateKey || !deliveryGroup) {
      addExclusionCount(result, ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.deliveryGroupMissing);
      continue;
    }

    result.deliverableLines += 1;
    const key = membershipKey(deliveryGroup.id, line.id);
    const existing = existingByGroupAndLine.get(key) ?? null;

    const membership = await tx.orderDeliveryGroupLine.upsert({
      where: {
        orderDeliveryGroupId_orderLineId: {
          orderDeliveryGroupId: deliveryGroup.id,
          orderLineId: line.id,
        },
      },
      create: {
        orderDeliveryGroupId: deliveryGroup.id,
        orderLineId: line.id,
        orderId: params.orderId,
        orderType: params.orderType,
        orderNumber: params.orderNumber,
        lineNbr: line.lineNbr,
        inventoryId: line.inventoryId,
        deliveryDate: line.requestedOn as Date,
        isActive: true,
        firstSeenAt: params.importAt,
        lastSeenAt: params.importAt,
        removedAt: null,
        removedReason: null,
      },
      update: {
        orderId: params.orderId,
        orderType: params.orderType,
        orderNumber: params.orderNumber,
        lineNbr: line.lineNbr,
        inventoryId: line.inventoryId,
        deliveryDate: line.requestedOn as Date,
        isActive: true,
        lastSeenAt: params.importAt,
        removedAt: null,
        removedReason: null,
      },
      select: { id: true },
    });

    retainedActiveMembershipIds.add(membership.id);
    result.activeMembershipsUpserted += 1;
    if (!existing) result.membershipsCreated += 1;
    if (existing && !existing.isActive) result.membershipsReactivated += 1;
  }

  for (const membership of existingMemberships.filter((existing) => existing.isActive)) {
    if (retainedActiveMembershipIds.has(membership.id)) continue;

    const incomingLine = membership.orderLineId
      ? incomingLinesById.get(membership.orderLineId) ?? null
      : null;
    const incomingExclusion = incomingLine
      ? getOrderDeliveryGroupLineExclusionReason(incomingLine)
      : null;
    const reason =
      incomingExclusion ??
      (incomingLine && dateKey(incomingLine.requestedOn) !== dateKey(membership.deliveryDate)
        ? ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.lineMovedDeliveryDate
        : ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.lineRemovedFromOrder);

    const deactivated = await tx.orderDeliveryGroupLine.updateMany({
      where: { id: membership.id, isActive: true },
      data: {
        isActive: false,
        removedAt: params.importAt,
        removedReason: reason,
      },
    });
    result.membershipsDeactivated += deactivated.count;
  }

  result.activeMembershipCount = await tx.orderDeliveryGroupLine.count({
    where: { orderId: params.orderId, isActive: true },
  });

  return result;
}
