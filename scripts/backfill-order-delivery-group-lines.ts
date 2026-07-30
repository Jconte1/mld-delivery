import {
  getOrderDeliveryGroupLineExclusionReason,
  isDeliverableOrderLineItemType,
  syncOrderDeliveryGroupLineMemberships,
  dateKey,
} from "@/lib/erp/orderDeliveryGroupLineMembership";
import { prisma } from "@/lib/prisma";

type Args = {
  write: boolean;
};

function parseArgs(argv: string[]): Args {
  return {
    write: argv.includes("--write"),
  };
}

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

async function buildDryRunReport() {
  const groups = await prisma.orderDeliveryGroup.findMany({
    where: { isActive: true },
    orderBy: [{ orderNumber: "asc" }, { deliveryDate: "asc" }],
    select: {
      id: true,
      orderId: true,
      orderType: true,
      orderNumber: true,
      deliveryDate: true,
      order: {
        select: {
          lines: {
            orderBy: { lineNbr: "asc" },
            select: {
              id: true,
              lineNbr: true,
              inventoryId: true,
              itemType: true,
              requestedOn: true,
            },
          },
        },
      },
    },
  });

  const excludedItemTypes: Record<string, number> = {};
  const nonStockOnlyGroups: Array<{
    orderType: string;
    orderNumber: string;
    deliveryDate: string;
    matchingLineCount: number;
  }> = [];

  let inferredMatchingLines = 0;
  let deliverableMatchingLines = 0;
  let excludedNonStockItemTypeN = 0;
  let excludedServiceItemTypeL = 0;
  let excludedUnknownItemType = 0;
  let groupsWithZeroDeliverableLines = 0;

  for (const group of groups) {
    const groupDate = dateKey(group.deliveryDate);
    const matchingLines = group.order.lines.filter(
      (line) => line.requestedOn && dateKey(line.requestedOn) === groupDate
    );
    const deliverableLines = matchingLines.filter((line) =>
      isDeliverableOrderLineItemType(line.itemType)
    );

    inferredMatchingLines += matchingLines.length;
    deliverableMatchingLines += deliverableLines.length;
    if (deliverableLines.length === 0) groupsWithZeroDeliverableLines += 1;

    for (const line of matchingLines) {
      const reason = getOrderDeliveryGroupLineExclusionReason({
        itemType: line.itemType,
        requestedOn: line.requestedOn,
      });
      if (!reason) continue;

      const itemType = line.itemType?.trim().toUpperCase() || "NULL";
      increment(excludedItemTypes, itemType);
      if (itemType === "N") excludedNonStockItemTypeN += 1;
      else if (itemType === "L") excludedServiceItemTypeL += 1;
      else excludedUnknownItemType += 1;
    }

    if (matchingLines.length > 0 && deliverableLines.length === 0) {
      nonStockOnlyGroups.push({
        orderType: group.orderType,
        orderNumber: group.orderNumber,
        deliveryDate: groupDate ?? "",
        matchingLineCount: matchingLines.length,
      });
    }
  }

  return {
    activeDeliveryGroups: groups.length,
    inferredMatchingLines,
    deliverableMatchingLines,
    excludedNonStockItemTypeN,
    excludedServiceItemTypeL,
    excludedUnknownItemType,
    excludedItemTypes,
    groupsWithZeroDeliverableLines,
    nonStockOnlyGroups,
  };
}

async function runWriteBackfill() {
  const orders = await prisma.order.findMany({
    where: { deliveryGroups: { some: { isActive: true } } },
    orderBy: [{ orderNumber: "asc" }],
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      lines: {
        orderBy: { lineNbr: "asc" },
        select: {
          id: true,
          lineNbr: true,
          inventoryId: true,
          itemType: true,
          requestedOn: true,
        },
      },
    },
  });

  const totals = {
    ordersProcessed: 0,
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
  };
  const importAt = new Date();

  for (const order of orders) {
    const sync = await prisma.$transaction((tx) =>
      syncOrderDeliveryGroupLineMemberships(tx, {
        orderId: order.id,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        importAt,
        currentLines: order.lines.map((line) => ({
          id: line.id,
          lineNbr: line.lineNbr,
          inventoryId: line.inventoryId,
          itemType: line.itemType,
          requestedOn: line.requestedOn,
        })),
      })
    );

    totals.ordersProcessed += 1;
    totals.consideredLines += sync.consideredLines;
    totals.deliverableLines += sync.deliverableLines;
    totals.activeMembershipsUpserted += sync.activeMembershipsUpserted;
    totals.membershipsCreated += sync.membershipsCreated;
    totals.membershipsReactivated += sync.membershipsReactivated;
    totals.membershipsDeactivated += sync.membershipsDeactivated;
    totals.excludedNonStockLines += sync.excludedNonStockLines;
    totals.excludedServiceLines += sync.excludedServiceLines;
    totals.excludedUnknownItemTypeLines += sync.excludedUnknownItemTypeLines;
    totals.excludedMissingRequestedOnLines += sync.excludedMissingRequestedOnLines;
    totals.excludedMissingDeliveryGroupLines += sync.excludedMissingDeliveryGroupLines;
  }

  const activeMemberships = await prisma.orderDeliveryGroupLine.count({
    where: { isActive: true },
  });
  const inactiveMemberships = await prisma.orderDeliveryGroupLine.count({
    where: { isActive: false },
  });

  return {
    ...totals,
    activeMemberships,
    inactiveMemberships,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRunReport = await buildDryRunReport();

  console.log(
    JSON.stringify(
      {
        mode: args.write ? "write" : "dry-run",
        includeRule: 'OrderLine.itemType === "F"',
        dryRunReport: {
          ...dryRunReport,
          nonStockOnlyGroups: dryRunReport.nonStockOnlyGroups.slice(0, 50),
          nonStockOnlyGroupsTotal: dryRunReport.nonStockOnlyGroups.length,
        },
        writeResult: args.write ? await runWriteBackfill() : null,
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
