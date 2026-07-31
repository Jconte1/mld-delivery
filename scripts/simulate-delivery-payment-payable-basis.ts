import {
  evaluateDeliveryGroupPayment,
  isFreightDeliveryChargeLine,
  normalizeDeliveryPaymentTerms,
  type DeliveryGroupPaymentEvaluation,
  type DeliveryGroupPaymentInput,
  type DeliveryPaymentChargeAllocationInput,
  type DeliveryPaymentLineInput,
} from "../lib/delivery-payment/deliveryGroupPayment";
import { NotificationIntervalType } from "../lib/generated/prisma/client";
import { prisma } from "../lib/prisma";

type DecimalLike = string | number | { toString(): string } | null | undefined;

type LoadedGroup = Awaited<ReturnType<typeof loadGroups>>["groups"][number];

const INTERVAL_DAYS = [
  { days: 14, interval: NotificationIntervalType.DAY_14 },
  { days: 12, interval: NotificationIntervalType.DAY_12 },
  { days: 10, interval: NotificationIntervalType.DAY_10 },
  { days: 8, interval: NotificationIntervalType.DAY_8 },
] as const;

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function dateKey(value: Date | string) {
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  return dateKey(new Date(trimmed));
}

function dateFromKey(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(value: string, days: number) {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

function money(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimalNumber(value: DecimalLike) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimalString(value: DecimalLike) {
  return value === null || value === undefined ? null : value.toString();
}

function lineOpenValue(line: DeliveryPaymentLineInput) {
  return decimalNumber(line.discountedUnitPrice) * decimalNumber(line.openQty);
}

function lineGrossValue(line: DeliveryPaymentLineInput) {
  return decimalNumber(line.discountedUnitPrice) * decimalNumber(line.orderQty);
}

function lineFromDb(line: LoadedGroup["order"]["lines"][number]): DeliveryPaymentLineInput {
  return {
    id: line.id,
    lineNbr: line.lineNbr,
    inventoryId: line.inventoryId,
    lineDescription: line.lineDescription,
    itemType: line.itemType,
    itemClass: line.itemClass,
    requestedOn: line.requestedOn,
    taxCategory: line.taxCategory,
    discountedUnitPrice: line.discountedUnitPrice,
    orderQty: line.orderQty,
    openQty: line.openQty,
    activeAllocatedQty: line.activeAllocatedQty,
    allocationStatus: line.allocationStatus,
    etaStatus: line.etaStatus,
    readinessStatus: line.readinessStatus,
  };
}

function allocationFromDb(
  allocation: LoadedGroup["order"]["deliveryGroupPaymentChargeAllocations"][number]
): DeliveryPaymentChargeAllocationInput {
  return {
    orderDeliveryGroupId: allocation.orderDeliveryGroupId,
    orderLineId: allocation.orderLineId,
    amountIncluded: allocation.amountIncluded,
    sourceInterval: allocation.sourceInterval,
  };
}

function inputFromGroup(
  group: LoadedGroup,
  params: {
    lines?: DeliveryPaymentLineInput[];
    freightDeliveryChargeAllocations?: DeliveryPaymentChargeAllocationInput[];
    newlyAssignedFreightDeliveryChargeLines?: DeliveryPaymentLineInput[];
  } = {}
): DeliveryGroupPaymentInput {
  const lines = params.lines ?? group.order.lines.map(lineFromDb);
  return {
    orderDeliveryGroupId: group.id,
    orderId: group.orderId,
    orderType: group.orderType,
    orderNumber: group.orderNumber,
    deliveryDate: group.deliveryDate,
    paymentTerms: group.order.total?.paymentTerms ?? null,
    unpaidBalance: group.order.total?.unpaidBalance,
    orderTotal: group.order.total?.orderTotal,
    taxTotal: group.order.total?.taxTotal,
    lines,
    taxDetails: group.order.taxDetails,
    activeOrderLineIds: group.deliveryGroupLines
      .map((line) => line.orderLineId)
      .filter((orderLineId): orderLineId is string => Boolean(orderLineId)),
    freightDeliveryChargeAllocations:
      params.freightDeliveryChargeAllocations ??
      group.order.deliveryGroupPaymentChargeAllocations.map(allocationFromDb),
    newlyAssignedFreightDeliveryChargeLines: params.newlyAssignedFreightDeliveryChargeLines,
  };
}

function unallocatedFreightCandidates(group: LoadedGroup) {
  const allocations = new Set(
    group.order.deliveryGroupPaymentChargeAllocations.map((allocation) => allocation.orderLineId)
  );
  return group.order.lines
    .map(lineFromDb)
    .filter(
      (line) =>
        isFreightDeliveryChargeLine(line) &&
        !allocations.has(line.id) &&
        lineOpenValue(line) > 0
    );
}

function legacyInput(group: LoadedGroup) {
  const activeLineIds = new Set(
    group.deliveryGroupLines
      .map((line) => line.orderLineId)
      .filter((orderLineId): orderLineId is string => Boolean(orderLineId))
  );
  const lines = group.order.lines
    .map(lineFromDb)
    .filter((line) => activeLineIds.has(line.id))
    .map((line) => ({
      ...line,
      readinessStatus: "ready",
      etaStatus: "ready",
      allocationStatus: "allocated",
      activeAllocatedQty: line.openQty,
    }));
  return inputFromGroup(group, {
    lines,
    freightDeliveryChargeAllocations: [],
    newlyAssignedFreightDeliveryChargeLines: [],
  });
}

function breakdown(evaluation: DeliveryGroupPaymentEvaluation, sourceInput: DeliveryGroupPaymentInput) {
  const includedReadyValue = evaluation.lines
    .filter((line) => line.payableBasisIncluded && line.readinessStatus === "ready")
    .reduce((sum, line) => sum + money(line.payableStockMerchandiseValue), 0);
  const includedExpectedOnTimeValue = evaluation.lines
    .filter((line) => line.payableBasisIncluded && line.readinessStatus === "expected_on_time")
    .reduce((sum, line) => sum + money(line.payableStockMerchandiseValue), 0);
  const includedPartialAllocatedValue = evaluation.lines
    .filter((line) => line.payableBasisIncluded && line.readinessStatus === "partially_allocated")
    .reduce((sum, line) => sum + money(line.payableStockMerchandiseValue), 0);
  const excludedBackorderedValue = evaluation.lines
    .filter((line) => line.payableBasisExclusionReason?.startsWith("readiness_backordered"))
    .reduce((sum, line) => sum + money(line.lineOpenMerchandiseValue), 0);
  const excludedEtaPendingValue = evaluation.lines
    .filter((line) => line.payableBasisExclusionReason?.startsWith("readiness_eta_pending"))
    .reduce((sum, line) => sum + money(line.lineOpenMerchandiseValue), 0);
  const excludedOrdinaryNonStockValue = evaluation.lines
    .filter((line) => line.payableBasisExclusionReason === "ordinary_non_stock_excluded")
    .reduce((sum, line) => sum + money(line.lineOpenMerchandiseValue), 0);
  const uncertainFreightLines = sourceInput.lines.filter(
    (line) =>
      isFreightDeliveryChargeLine(line) && lineOpenValue(line) <= 0 && lineGrossValue(line) > 0
  );

  return {
    includedReadyValue,
    includedExpectedOnTimeValue,
    includedPartialAllocatedValue,
    includedFreightDeliveryValue:
      money(evaluation.assignedFreightDeliveryChargeValue) +
      money(evaluation.newlyAssignedFreightDeliveryChargeValue),
    excludedBackorderedValue,
    excludedEtaPendingValue,
    excludedOrdinaryNonStockValue,
    uncertainFreightGrossButZeroOpenCount: uncertainFreightLines.length,
    uncertainFreightGrossButZeroOpenValue: uncertainFreightLines.reduce(
      (sum, line) => sum + lineGrossValue(line),
      0
    ),
  };
}

function intervalForDate(runDate: string, deliveryDate: string) {
  return INTERVAL_DAYS.find((candidate) => addDays(runDate, candidate.days) === deliveryDate)
    ?.interval ?? null;
}

async function loadGroups(runDate: string, limit: number) {
  const targetDates = INTERVAL_DAYS.map((candidate) => dateFromKey(addDays(runDate, candidate.days)));
  const groups = await prisma.orderDeliveryGroup.findMany({
    where: {
      isActive: true,
      deliveryDate: { in: targetDates },
      deliveryGroupLines: { some: { isActive: true } },
    },
    orderBy: [{ deliveryDate: "asc" }, { orderNumber: "asc" }],
    take: limit,
    include: {
      deliveryGroupLines: {
        where: { isActive: true },
        select: { orderLineId: true },
      },
      order: {
        include: {
          total: true,
          lines: {
            where: {
              OR: [
                { deliveryGroupLines: { some: { isActive: true } } },
                {
                  itemType: "N",
                  OR: [
                    { inventoryId: { contains: "freight", mode: "insensitive" } },
                    { inventoryId: { contains: "delivery", mode: "insensitive" } },
                    { lineDescription: { contains: "freight", mode: "insensitive" } },
                    { lineDescription: { contains: "delivery", mode: "insensitive" } },
                  ],
                },
              ],
            },
            orderBy: { lineNbr: "asc" },
          },
          taxDetails: { orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }] },
          deliveryGroupPaymentChargeAllocations: {
            select: {
              orderDeliveryGroupId: true,
              orderLineId: true,
              amountIncluded: true,
              sourceInterval: true,
            },
            orderBy: [{ includedAt: "asc" }, { orderLineId: "asc" }],
          },
        },
      },
    },
  });

  if (groups.length > 0) return { groups, selectionMode: "exact_payment_gated_target_dates" };

  const fallbackGroups = await prisma.orderDeliveryGroup.findMany({
    where: {
      isActive: true,
      deliveryDate: {
        gte: dateFromKey(addDays(runDate, 1)),
        lte: dateFromKey(addDays(runDate, 60)),
      },
      deliveryGroupLines: { some: { isActive: true } },
    },
    orderBy: [{ deliveryDate: "asc" }, { orderNumber: "asc" }],
    take: limit,
    include: {
      deliveryGroupLines: {
        where: { isActive: true },
        select: { orderLineId: true },
      },
      order: {
        include: {
          total: true,
          lines: {
            where: {
              OR: [
                { deliveryGroupLines: { some: { isActive: true } } },
                {
                  itemType: "N",
                  OR: [
                    { inventoryId: { contains: "freight", mode: "insensitive" } },
                    { inventoryId: { contains: "delivery", mode: "insensitive" } },
                    { lineDescription: { contains: "freight", mode: "insensitive" } },
                    { lineDescription: { contains: "delivery", mode: "insensitive" } },
                  ],
                },
              ],
            },
            orderBy: { lineNbr: "asc" },
          },
          taxDetails: { orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }] },
          deliveryGroupPaymentChargeAllocations: {
            select: {
              orderDeliveryGroupId: true,
              orderLineId: true,
              amountIncluded: true,
              sourceInterval: true,
            },
            orderBy: [{ includedAt: "asc" }, { orderLineId: "asc" }],
          },
        },
      },
    },
  });
  return { groups: fallbackGroups, selectionMode: "fallback_next_60_days" };
}

async function main() {
  const runDate = argValue("run-date") ?? dateKey(new Date());
  const limit = Number(argValue("limit") ?? "60");
  const loaded = await loadGroups(runDate, Number.isFinite(limit) ? limit : 60);
  const groups = loaded.groups;

  const rows = groups.map((group) => {
    const deliveryDate = dateKey(group.deliveryDate);
    const matchedInterval = intervalForDate(runDate, deliveryDate);
    const proposedInput = inputFromGroup(group, {
      newlyAssignedFreightDeliveryChargeLines: unallocatedFreightCandidates(group),
    });
    const proposed = evaluateDeliveryGroupPayment(proposedInput);
    const legacy = evaluateDeliveryGroupPayment(legacyInput(group));
    const details = breakdown(proposed, proposedInput);
    const oldDue = money(legacy.amountDueNowRounded);
    const proposedDue = money(proposed.amountDueNowRounded);

    return {
      orderType: group.orderType,
      orderNumber: group.orderNumber,
      deliveryDate,
      matchedInterval,
      terms: normalizeDeliveryPaymentTerms(group.order.total?.paymentTerms ?? null),
      unpaidBalance: decimalString(group.order.total?.unpaidBalance),
      oldFormulaAmountDue: legacy.amountDueNowRounded,
      proposedPayableAmountDue: proposed.amountDueNowRounded,
      oldPaymentStatus: legacy.paymentStatus,
      proposedPaymentStatus: proposed.paymentStatus,
      payableStockValue: proposed.payableStockValue,
      payableBasisValue: proposed.payableBasisValue,
      ...details,
      calculationWarnings: proposed.calculationWarnings,
      freightDeliveryTodos: proposed.freightDeliveryChargeTodos ?? [],
      behaviorWouldChange:
        oldDue !== proposedDue || legacy.paymentStatus !== proposed.paymentStatus,
      day12WouldChange:
        oldDue !== proposedDue || legacy.paymentStatus !== proposed.paymentStatus,
      day10WouldChange:
        oldDue !== proposedDue || legacy.paymentStatus !== proposed.paymentStatus,
      day8WouldChange:
        oldDue !== proposedDue || legacy.paymentStatus !== proposed.paymentStatus,
    };
  });

  const changed = rows.filter((row) => row.behaviorWouldChange);
  const withBackorderedExclusion = rows.filter((row) => row.excludedBackorderedValue > 0);
  const withEtaPendingExclusion = rows.filter((row) => row.excludedEtaPendingValue > 0);
  const withPartial = rows.filter((row) => row.includedPartialAllocatedValue > 0);
  const withFreight = rows.filter((row) => row.includedFreightDeliveryValue > 0);
  const withUncertainFreight = rows.filter(
    (row) => row.uncertainFreightGrossButZeroOpenCount > 0
  );
  const blocked = rows.filter((row) => row.proposedPaymentStatus === "calculation_blocked");

  console.log(
    JSON.stringify(
      {
        simulation: "delivery payment payable-basis real-data dry-run",
        runDate,
        selectionMode: loaded.selectionMode,
        targetDates: INTERVAL_DAYS.map((candidate) => ({
          interval: candidate.interval,
          deliveryDate: addDays(runDate, candidate.days),
        })),
        groupsEvaluated: rows.length,
        summary: {
          changedCount: changed.length,
          backorderedExclusionCount: withBackorderedExclusion.length,
          etaPendingExclusionCount: withEtaPendingExclusion.length,
          partialAllocatedIncludedCount: withPartial.length,
          freightDeliveryIncludedCount: withFreight.length,
          uncertainFreightGrossButZeroOpenCount: withUncertainFreight.length,
          calculationBlockedCount: blocked.length,
        },
        changedExamples: changed.slice(0, 10),
        backorderedExamples: withBackorderedExclusion.slice(0, 5),
        etaPendingExamples: withEtaPendingExclusion.slice(0, 5),
        partialAllocationExamples: withPartial.slice(0, 5),
        freightDeliveryExamples: withFreight.slice(0, 5),
        uncertainFreightExamples: withUncertainFreight.slice(0, 5),
        calculationBlockedExamples: blocked.slice(0, 5),
        safety: {
          dryRunReadOnly: true,
          notificationEventsCreated: false,
          notificationAttemptsCreated: false,
          freightAllocationRowsCreated: false,
          smsSent: false,
          emailSent: false,
          providerDispatch: false,
          acumaticaWrites: false,
          holdsPlaced: false,
          orderLinesModified: false,
          deliveryDatesModified: false,
          liveIntervalJobsRun: false,
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
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
