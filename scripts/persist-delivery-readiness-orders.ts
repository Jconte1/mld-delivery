import {
  getDeliveryGroupReadiness,
  persistOrderReadinessByOrderNumber,
} from "../lib/delivery-readiness/orderLineReadiness";
import { prisma } from "../lib/prisma";

const DEFAULT_ORDER_NUMBERS = ["HW06397", "PG04618", "HW06205", "SO40064", "PL02553", "SO40278"];

function inferOrderType(orderNumber: string) {
  return orderNumber.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? null;
}

function parseOrderArgs(argv: string[]) {
  const orderNumbers = argv.length > 0 ? argv : DEFAULT_ORDER_NUMBERS;
  return orderNumbers.map((arg) => {
    const [orderType, orderNumber] = arg.includes(":")
      ? (arg.split(":", 2) as [string, string])
      : [inferOrderType(arg), arg];

    if (!orderType || !orderNumber) {
      throw new Error(`Could not infer order type for ${arg}; use ORDER_TYPE:ORDER_NUMBER`);
    }

    return { orderType, orderNumber };
  });
}

function dateKey(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function decimalString(value: { toString(): string } | null) {
  return value?.toString() ?? null;
}

function numbersMatch(stored: { toString(): string } | null, expected: number) {
  const numeric = stored === null ? null : Number(stored.toString());
  return numeric === expected;
}

async function notificationAttemptsCount() {
  return prisma.notificationAttempt.count();
}

async function storedRowsForOrder(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      orderType: true,
      orderNumber: true,
      deliveryGroups: {
        where: { isActive: true },
        orderBy: { deliveryDate: "asc" },
        select: {
          id: true,
          deliveryDate: true,
        },
      },
    },
  });

  if (!order) return [];

  const rows = [];
  for (const deliveryGroup of order.deliveryGroups) {
    const lines = await prisma.orderLine.findMany({
      where: {
        orderId,
        requestedOn: deliveryGroup.deliveryDate,
      },
      orderBy: { lineNbr: "asc" },
      select: {
        id: true,
        orderType: true,
        orderNumber: true,
        requestedOn: true,
        lineNbr: true,
        inventoryId: true,
        lineDescription: true,
        itemType: true,
        itemClass: true,
        eta: true,
        orderQty: true,
        openQty: true,
        activeAllocatedQty: true,
        allocationStatus: true,
        etaStatus: true,
        readinessStatus: true,
        displayStatus: true,
        readinessCalculatedAt: true,
      },
    });

    for (const line of lines) {
      rows.push({
        orderType: line.orderType,
        orderNumber: line.orderNumber,
        deliveryDate: dateKey(deliveryGroup.deliveryDate),
        lineNbr: line.lineNbr,
        inventoryId: line.inventoryId,
        lineDescription: line.lineDescription,
        itemType: line.itemType,
        itemClass: line.itemClass,
        requestedOn: dateKey(line.requestedOn),
        eta: dateKey(line.eta),
        orderQty: decimalString(line.orderQty),
        openQty: decimalString(line.openQty),
        activeAllocatedQty: decimalString(line.activeAllocatedQty),
        allocationStatus: line.allocationStatus,
        etaStatus: line.etaStatus,
        readinessStatus: line.readinessStatus,
        displayStatus: line.displayStatus,
        readinessCalculatedAt: line.readinessCalculatedAt?.toISOString() ?? null,
      });
    }
  }

  return rows;
}

async function compareStoredToComputed(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      deliveryGroups: {
        where: { isActive: true },
        orderBy: { deliveryDate: "asc" },
        select: { id: true },
      },
    },
  });

  if (!order) return [];

  const mismatches = [];
  for (const deliveryGroup of order.deliveryGroups) {
    const computed = await getDeliveryGroupReadiness(deliveryGroup.id);
    const storedLines = await prisma.orderLine.findMany({
      where: {
        orderId,
        requestedOn: new Date(`${computed.deliveryDate}T00:00:00.000Z`),
      },
      select: {
        id: true,
        lineNbr: true,
        inventoryId: true,
        activeAllocatedQty: true,
        allocationStatus: true,
        etaStatus: true,
        readinessStatus: true,
        displayStatus: true,
      },
    });
    const storedById = new Map(storedLines.map((line) => [line.id, line]));

    for (const line of computed.lines) {
      const stored = storedById.get(line.orderLineId);
      if (!stored) {
        mismatches.push({
          orderType: computed.orderType,
          orderNumber: computed.orderNumber,
          deliveryDate: computed.deliveryDate,
          lineNbr: line.lineNbr,
          reason: "stored line not found",
        });
        continue;
      }

      const differences = {
        activeAllocatedQty: numbersMatch(stored.activeAllocatedQty, line.activeAllocatedQty)
          ? undefined
          : { stored: decimalString(stored.activeAllocatedQty), computed: line.activeAllocatedQty },
        allocationStatus:
          stored.allocationStatus === line.allocationStatus
            ? undefined
            : { stored: stored.allocationStatus, computed: line.allocationStatus },
        etaStatus:
          stored.etaStatus === line.etaStatus
            ? undefined
            : { stored: stored.etaStatus, computed: line.etaStatus },
        readinessStatus:
          stored.readinessStatus === line.readinessStatus
            ? undefined
            : { stored: stored.readinessStatus, computed: line.readinessStatus },
        displayStatus:
          stored.displayStatus === line.displayStatus
            ? undefined
            : { stored: stored.displayStatus, computed: line.displayStatus },
      };
      const actualDifferences = Object.fromEntries(
        Object.entries(differences).filter(([, value]) => value !== undefined)
      );

      if (Object.keys(actualDifferences).length > 0) {
        mismatches.push({
          orderType: computed.orderType,
          orderNumber: computed.orderNumber,
          deliveryDate: computed.deliveryDate,
          lineNbr: line.lineNbr,
          inventoryId: line.inventoryId,
          differences: actualDifferences,
        });
      }
    }
  }

  return mismatches;
}

async function main() {
  const lookups = parseOrderArgs(process.argv.slice(2));
  const beforeNotificationAttempts = await notificationAttemptsCount();
  const orders = [];

  for (const lookup of lookups) {
    const order = await prisma.order.findUnique({
      where: {
        orderType_orderNumber: {
          orderType: lookup.orderType,
          orderNumber: lookup.orderNumber,
        },
      },
      select: { id: true },
    });

    if (!order) {
      orders.push({
        lookup,
        persisted: false,
        reason: "order not found in delivery DB",
        deliveryGroups: [],
        mismatches: [],
        storedRows: [],
      });
      continue;
    }

    const persisted = await persistOrderReadinessByOrderNumber(lookup);
    const storedRows = await storedRowsForOrder(order.id);
    const mismatches = await compareStoredToComputed(order.id);
    orders.push({
      lookup,
      persisted: true,
      deliveryGroups: persisted.deliveryGroups.map((deliveryGroup) => ({
        orderDeliveryGroupId: deliveryGroup.orderDeliveryGroupId,
        deliveryDate: deliveryGroup.deliveryDate,
        persistedLineCount: deliveryGroup.persistedLineCount,
        readinessCalculatedAt: deliveryGroup.readinessCalculatedAt,
        totals: deliveryGroup.totals,
        hasBackorders: deliveryGroup.hasBackorders,
        hasEtaPending: deliveryGroup.hasEtaPending,
        hasPartialAllocation: deliveryGroup.hasPartialAllocation,
        allReadyOrComplete: deliveryGroup.allReadyOrComplete,
        hasActionableIssues: deliveryGroup.hasActionableIssues,
      })),
      mismatches,
      storedRows,
    });
  }

  const afterNotificationAttempts = await notificationAttemptsCount();

  console.log(
    JSON.stringify(
      {
        orders,
        safety: {
          beforeNotificationAttempts,
          afterNotificationAttempts,
          notificationAttemptsUnchanged: beforeNotificationAttempts === afterNotificationAttempts,
        },
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
