import { getDeliveryGroupReadiness } from "../lib/delivery-readiness/orderLineReadiness";
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

function countByReadinessStatus(lines: Array<{ readinessStatus: string | null }>) {
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const key = line.readinessStatus ?? "<null>";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function notificationCounts() {
  const [notificationEvents, notificationAttempts] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
  };
}

async function main() {
  const lookups = parseOrderArgs(process.argv.slice(2));
  const orders = [];

  for (const lookup of lookups) {
    const order = await prisma.order.findUnique({
      where: {
        orderType_orderNumber: {
          orderType: lookup.orderType,
          orderNumber: lookup.orderNumber,
        },
      },
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
      orders.push({
        lookup,
        found: false,
        reason: "order not found in delivery DB",
        deliveryGroups: [],
        ungroupedLines: [],
        mismatches: [],
      });
      continue;
    }

    const deliveryDates = order.deliveryGroups.map((deliveryGroup) => deliveryGroup.deliveryDate);
    const deliveryGroups = [];
    const mismatches = [];

    for (const deliveryGroup of order.deliveryGroups) {
      const computed = await getDeliveryGroupReadiness(deliveryGroup.id);
      const storedLines = await prisma.orderLine.findMany({
        where: {
          orderId: order.id,
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

      deliveryGroups.push({
        orderDeliveryGroupId: deliveryGroup.id,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryDate: dateKey(deliveryGroup.deliveryDate),
        storedReadinessTotals: countByReadinessStatus(storedLines),
        computedReadinessTotals: computed.totals,
        lineCount: storedLines.length,
        lines: storedLines.map((line) => ({
          orderType: line.orderType,
          orderNumber: line.orderNumber,
          deliveryDate: dateKey(deliveryGroup.deliveryDate),
          requestedOn: dateKey(line.requestedOn),
          lineNbr: line.lineNbr,
          inventoryId: line.inventoryId,
          itemType: line.itemType,
          itemClass: line.itemClass,
          eta: dateKey(line.eta),
          orderQty: decimalString(line.orderQty),
          openQty: decimalString(line.openQty),
          activeAllocatedQty: decimalString(line.activeAllocatedQty),
          allocationStatus: line.allocationStatus,
          etaStatus: line.etaStatus,
          readinessStatus: line.readinessStatus,
          displayStatus: line.displayStatus,
          readinessCalculatedAt: line.readinessCalculatedAt?.toISOString() ?? null,
        })),
      });
    }

    const ungroupedLines = await prisma.orderLine.findMany({
      where: {
        orderId: order.id,
        ...(deliveryDates.length > 0
          ? {
              OR: [{ requestedOn: null }, { requestedOn: { notIn: deliveryDates } }],
            }
          : {}),
      },
      orderBy: { lineNbr: "asc" },
      select: {
        lineNbr: true,
        inventoryId: true,
        requestedOn: true,
        activeAllocatedQty: true,
        allocationStatus: true,
        etaStatus: true,
        readinessStatus: true,
        displayStatus: true,
        readinessCalculatedAt: true,
      },
    });

    orders.push({
      lookup,
      found: true,
      deliveryGroups,
      ungroupedLines: ungroupedLines.map((line) => ({
        lineNbr: line.lineNbr,
        inventoryId: line.inventoryId,
        requestedOn: dateKey(line.requestedOn),
        activeAllocatedQty: decimalString(line.activeAllocatedQty),
        allocationStatus: line.allocationStatus,
        etaStatus: line.etaStatus,
        readinessStatus: line.readinessStatus,
        displayStatus: line.displayStatus,
        readinessCalculatedAt: line.readinessCalculatedAt?.toISOString() ?? null,
      })),
      mismatches,
    });
  }

  console.log(
    JSON.stringify(
      {
        orders,
        notificationCounts: await notificationCounts(),
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
