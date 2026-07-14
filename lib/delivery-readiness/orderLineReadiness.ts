import type { Prisma } from "@/lib/generated/prisma/client";

export type AllocationStatus =
  | "ignored"
  | "complete"
  | "allocated"
  | "partially_allocated"
  | "not_allocated";

export type EtaStatus =
  | "ignored"
  | "complete"
  | "ready"
  | "eta_pending"
  | "backordered"
  | "expected_on_time";

export type ReadinessStatus =
  | "ignored"
  | "complete"
  | "ready"
  | "partially_allocated"
  | "expected_on_time"
  | "eta_pending"
  | "backordered";

export const READINESS_STATUS_LABELS: Record<ReadinessStatus, string> = {
  ignored: "Ignored",
  complete: "Complete",
  ready: "Ready",
  partially_allocated: "Partially ready",
  expected_on_time: "Expected on time",
  eta_pending: "ETA pending",
  backordered: "Backordered",
};

export type DecimalLike = number | string | { toString(): string } | null | undefined;

export type OrderLineReadinessAllocationInput = {
  id?: string | null;
  splitLineNbr?: number | null;
  allocated: boolean;
  completed: boolean;
  qty: DecimalLike;
};

export type OrderLineReadinessInput = {
  id: string;
  lineNbr: number;
  inventoryId: string | null;
  lineDescription: string | null;
  itemType: string | null;
  itemClass: string | null;
  requestedOn: Date | string | null;
  eta: Date | string | null;
  orderQty: DecimalLike;
  openQty: DecimalLike;
  allocations: OrderLineReadinessAllocationInput[];
};

export type OrderLineReadinessSummary = {
  orderLineId: string;
  lineNbr: number;
  inventoryId: string | null;
  lineDescription: string | null;
  itemType: string | null;
  itemClass: string | null;
  requestedOn: string | null;
  eta: string | null;
  orderQty: number | null;
  openQty: number | null;
  activeAllocatedQty: number;
  allocationStatus: AllocationStatus;
  etaStatus: EtaStatus;
  readinessStatus: ReadinessStatus;
  displayStatus: string;
  allocationCount: number;
  allocationRowsCompact: string[];
  activeAllocationCount: number;
  completedAllocationCount: number;
};

export type ReadinessTotals = Record<ReadinessStatus, number>;

export type DeliveryGroupReadinessResult = {
  orderDeliveryGroupId: string;
  orderId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: string;
  lineCount: number;
  includedLineCount: number;
  totals: ReadinessTotals;
  hasBackorders: boolean;
  hasEtaPending: boolean;
  hasPartialAllocation: boolean;
  allReadyOrComplete: boolean;
  hasActionableIssues: boolean;
  lines: OrderLineReadinessSummary[];
};

export type PersistedDeliveryGroupReadinessResult = DeliveryGroupReadinessResult & {
  persistedLineCount: number;
  readinessCalculatedAt: string;
};

type ReadinessPrismaClient = Pick<
  Prisma.TransactionClient,
  "orderDeliveryGroup" | "order" | "orderLine"
>;

async function getReadinessPrisma(client?: ReadinessPrismaClient) {
  if (client) return client;
  const { prisma } = await import("@/lib/prisma");
  return prisma;
}

function quantityToNumber(value: DecimalLike) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const numeric = Number(value.toString());
  return Number.isFinite(numeric) ? numeric : null;
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

function dateFromDateKey(value: Date | string) {
  const key = dateKey(value);
  if (!key) {
    throw new Error(`Invalid delivery date: ${String(value)}`);
  }
  return new Date(`${key}T00:00:00.000Z`);
}

function emptyReadinessTotals(): ReadinessTotals {
  return {
    ignored: 0,
    complete: 0,
    ready: 0,
    partially_allocated: 0,
    expected_on_time: 0,
    eta_pending: 0,
    backordered: 0,
  };
}

function compactQuantity(value: DecimalLike) {
  const numeric = quantityToNumber(value);
  if (numeric === null) return "";
  return Number.isInteger(numeric) ? String(numeric) : String(numeric);
}

export function classifyOrderLineReadiness(
  line: OrderLineReadinessInput,
  deliveryDate: Date | string
): OrderLineReadinessSummary {
  const requestedOn = dateKey(line.requestedOn);
  const eta = dateKey(line.eta);
  const deliveryDateKey = dateKey(deliveryDate);
  const comparisonDateKey = requestedOn ?? deliveryDateKey;
  const orderQty = quantityToNumber(line.orderQty);
  const openQty = quantityToNumber(line.openQty);
  const activeAllocations = line.allocations.filter(
    (allocation) => allocation.allocated && !allocation.completed
  );
  const activeAllocatedQty = activeAllocations.reduce(
    (sum, allocation) => sum + (quantityToNumber(allocation.qty) ?? 0),
    0
  );
  const completedAllocationCount = line.allocations.filter(
    (allocation) => allocation.completed
  ).length;

  const isIgnored = line.itemType === "N";
  const isComplete = !isIgnored && openQty === 0;
  const isAllocated = !isIgnored && openQty !== null && openQty > 0 && activeAllocatedQty >= openQty;
  const isPartiallyAllocated =
    !isIgnored && openQty !== null && activeAllocatedQty > 0 && activeAllocatedQty < openQty;

  let allocationStatus: AllocationStatus;
  if (isIgnored) {
    allocationStatus = "ignored";
  } else if (isComplete) {
    allocationStatus = "complete";
  } else if (isAllocated) {
    allocationStatus = "allocated";
  } else if (isPartiallyAllocated) {
    allocationStatus = "partially_allocated";
  } else {
    allocationStatus = "not_allocated";
  }

  let etaStatus: EtaStatus;
  if (isIgnored) {
    etaStatus = "ignored";
  } else if (isComplete) {
    etaStatus = "complete";
  } else if (allocationStatus === "allocated") {
    etaStatus = "ready";
  } else if (!eta) {
    etaStatus = "eta_pending";
  } else if (comparisonDateKey && eta > comparisonDateKey) {
    etaStatus = "backordered";
  } else {
    etaStatus = "expected_on_time";
  }

  let readinessStatus: ReadinessStatus;
  if (isIgnored) {
    readinessStatus = "ignored";
  } else if (isComplete) {
    readinessStatus = "complete";
  } else if (allocationStatus === "allocated") {
    readinessStatus = "ready";
  } else if (allocationStatus === "partially_allocated") {
    readinessStatus = "partially_allocated";
  } else if (!eta) {
    readinessStatus = "eta_pending";
  } else if (comparisonDateKey && eta > comparisonDateKey) {
    readinessStatus = "backordered";
  } else {
    readinessStatus = "expected_on_time";
  }

  return {
    orderLineId: line.id,
    lineNbr: line.lineNbr,
    inventoryId: line.inventoryId,
    lineDescription: line.lineDescription,
    itemType: line.itemType,
    itemClass: line.itemClass,
    requestedOn,
    eta,
    orderQty,
    openQty,
    activeAllocatedQty,
    allocationStatus,
    etaStatus,
    readinessStatus,
    displayStatus: READINESS_STATUS_LABELS[readinessStatus],
    allocationCount: line.allocations.length,
    allocationRowsCompact: line.allocations.map(
      (allocation) =>
        `[${allocation.allocated ? "true" : "false"}/${allocation.completed ? "true" : "false"}/${compactQuantity(
          allocation.qty
        )}]`
    ),
    activeAllocationCount: activeAllocations.length,
    completedAllocationCount,
  };
}

export function summarizeDeliveryGroupReadiness(params: {
  orderDeliveryGroupId: string;
  orderId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
  lines: OrderLineReadinessInput[];
}): DeliveryGroupReadinessResult {
  const deliveryDate = dateKey(params.deliveryDate);
  if (!deliveryDate) {
    throw new Error(`Invalid delivery date: ${String(params.deliveryDate)}`);
  }

  const lines = params.lines.map((line) => classifyOrderLineReadiness(line, deliveryDate));
  const totals = emptyReadinessTotals();
  for (const line of lines) {
    totals[line.readinessStatus] += 1;
  }

  const includedLines = lines.filter((line) => line.readinessStatus !== "ignored");
  const hasBackorders = totals.backordered > 0;
  const hasEtaPending = totals.eta_pending > 0;
  const hasPartialAllocation = totals.partially_allocated > 0;
  const allReadyOrComplete = includedLines.every((line) =>
    ["ready", "complete"].includes(line.readinessStatus)
  );

  return {
    orderDeliveryGroupId: params.orderDeliveryGroupId,
    orderId: params.orderId,
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate,
    lineCount: lines.length,
    includedLineCount: includedLines.length,
    totals,
    hasBackorders,
    hasEtaPending,
    hasPartialAllocation,
    allReadyOrComplete,
    hasActionableIssues: hasBackorders || hasEtaPending || hasPartialAllocation,
    lines,
  };
}

export async function getDeliveryGroupReadiness(
  orderDeliveryGroupId: string,
  client?: ReadinessPrismaClient
): Promise<DeliveryGroupReadinessResult> {
  const db = await getReadinessPrisma(client);
  const deliveryGroup = await db.orderDeliveryGroup.findUnique({
    where: { id: orderDeliveryGroupId },
    select: {
      id: true,
      orderId: true,
      orderType: true,
      orderNumber: true,
      deliveryDate: true,
    },
  });

  if (!deliveryGroup) {
    throw new Error(`Delivery group not found: ${orderDeliveryGroupId}`);
  }

  const order = await db.order.findUnique({
    where: { id: deliveryGroup.orderId },
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      lines: {
        where: { requestedOn: deliveryGroup.deliveryDate },
        orderBy: { lineNbr: "asc" },
        select: {
          id: true,
          lineNbr: true,
          inventoryId: true,
          lineDescription: true,
          itemType: true,
          itemClass: true,
          requestedOn: true,
          eta: true,
          orderQty: true,
          openQty: true,
          allocations: {
            orderBy: { splitLineNbr: "asc" },
            select: {
              id: true,
              splitLineNbr: true,
              allocated: true,
              completed: true,
              qty: true,
            },
          },
        },
      },
    },
  });

  if (!order) {
    throw new Error(`Order not found for delivery group: ${orderDeliveryGroupId}`);
  }

  return summarizeDeliveryGroupReadiness({
    orderDeliveryGroupId: deliveryGroup.id,
    orderId: order.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: deliveryGroup.deliveryDate,
    lines: order.lines,
  });
}

export async function getDeliveryGroupReadinessByOrderDate(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
}, client?: ReadinessPrismaClient): Promise<DeliveryGroupReadinessResult> {
  const db = await getReadinessPrisma(client);
  const deliveryDate = dateFromDateKey(params.deliveryDate);
  const deliveryGroup = await db.orderDeliveryGroup.findFirst({
    where: {
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      deliveryDate,
      isActive: true,
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });

  if (!deliveryGroup) {
    throw new Error(
      `Delivery group not found for ${params.orderType} ${params.orderNumber} ${dateKey(deliveryDate)}`
    );
  }

  return getDeliveryGroupReadiness(deliveryGroup.id, db);
}

export async function persistDeliveryGroupReadiness(
  orderDeliveryGroupId: string,
  client?: ReadinessPrismaClient
): Promise<PersistedDeliveryGroupReadinessResult> {
  const db = await getReadinessPrisma(client);
  const readiness = await getDeliveryGroupReadiness(orderDeliveryGroupId, db);
  const readinessCalculatedAt = new Date();

  for (const line of readiness.lines) {
    await db.orderLine.update({
      where: { id: line.orderLineId },
      data: {
        activeAllocatedQty: line.activeAllocatedQty.toString(),
        allocationStatus: line.allocationStatus,
        etaStatus: line.etaStatus,
        readinessStatus: line.readinessStatus,
        displayStatus: line.displayStatus,
        readinessCalculatedAt,
      },
    });
  }

  return {
    ...readiness,
    persistedLineCount: readiness.lines.length,
    readinessCalculatedAt: readinessCalculatedAt.toISOString(),
  };
}

export async function persistOrderReadiness(orderId: string, client?: ReadinessPrismaClient) {
  const db = await getReadinessPrisma(client);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      deliveryGroups: {
        where: { isActive: true },
        orderBy: { deliveryDate: "asc" },
        select: { id: true, deliveryDate: true },
      },
    },
  });

  if (!order) {
    throw new Error(`Order not found: ${orderId}`);
  }

  const deliveryGroups: PersistedDeliveryGroupReadinessResult[] = [];
  for (const deliveryGroup of order.deliveryGroups) {
    deliveryGroups.push(await persistDeliveryGroupReadiness(deliveryGroup.id, db));
  }

  const deliveryDates = order.deliveryGroups.map((deliveryGroup) => deliveryGroup.deliveryDate);
  await db.orderLine.updateMany({
    where: {
      orderId: order.id,
      ...(deliveryDates.length > 0
        ? {
            OR: [{ requestedOn: null }, { requestedOn: { notIn: deliveryDates } }],
          }
        : {}),
    },
    data: {
      activeAllocatedQty: null,
      allocationStatus: null,
      etaStatus: null,
      readinessStatus: null,
      displayStatus: null,
      readinessCalculatedAt: null,
    },
  });

  return {
    orderId: order.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryGroups,
  };
}

export async function persistOrderReadinessByOrderNumber(
  params: {
    orderType: string;
    orderNumber: string;
  },
  client?: ReadinessPrismaClient
) {
  const db = await getReadinessPrisma(client);
  const order = await db.order.findUnique({
    where: {
      orderType_orderNumber: {
        orderType: params.orderType,
        orderNumber: params.orderNumber,
      },
    },
    select: { id: true },
  });

  if (!order) {
    throw new Error(`Order not found: ${params.orderType} ${params.orderNumber}`);
  }

  return persistOrderReadiness(order.id, db);
}
