import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import {
  evaluateDeliveryGroupPayment,
  type DeliveryGroupPaymentEvaluation,
  type DeliveryGroupPaymentInput,
  type DeliveryPaymentLineInput,
} from "../lib/delivery-payment/deliveryGroupPayment";
import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";
import { NotificationIntervalType } from "../lib/generated/prisma/client";
import { DeliveryPaymentSummary } from "../app/delivery/components/DeliveryPaymentSummary";
import { render30DayDeliveryReminderEmail } from "../lib/notifications/deliveryReminder30Day";

const ROOT = process.cwd();
const DELIVERY_DATE = "2026-08-10";

type ScenarioSummary = {
  name: string;
  details: Record<string, unknown>;
};

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function money(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function line(
  overrides: Partial<DeliveryPaymentLineInput> & { id: string; lineNbr: number }
): DeliveryPaymentLineInput {
  return {
    id: overrides.id,
    lineNbr: overrides.lineNbr,
    inventoryId: overrides.inventoryId ?? `ITEM-${overrides.lineNbr}`,
    lineDescription: overrides.lineDescription ?? `Fixture item ${overrides.lineNbr}`,
    itemType: overrides.itemType ?? "F",
    itemClass: overrides.itemClass ?? "TEST",
    requestedOn: overrides.requestedOn ?? DELIVERY_DATE,
    taxCategory: overrides.taxCategory ?? "EXEMPT",
    discountedUnitPrice: overrides.discountedUnitPrice ?? "100.00",
    orderQty: overrides.orderQty ?? "1",
    openQty: overrides.openQty ?? "1",
    activeAllocatedQty: overrides.activeAllocatedQty ?? "1",
    allocationStatus: overrides.allocationStatus ?? "allocated",
    etaStatus: "etaStatus" in overrides ? overrides.etaStatus ?? null : "ready",
    readinessStatus:
      "readinessStatus" in overrides ? overrides.readinessStatus ?? null : "ready",
  };
}

function evaluate(
  overrides: Partial<DeliveryGroupPaymentInput> = {}
): DeliveryGroupPaymentEvaluation {
  const lines = overrides.lines ?? [
    line({ id: "ready_1", lineNbr: 1, discountedUnitPrice: "1000.00" }),
  ];
  return evaluateDeliveryGroupPayment({
    orderDeliveryGroupId: "group_current",
    orderId: "order_current",
    orderType: "SO",
    orderNumber: "SO-INTERVAL",
    deliveryDate: DELIVERY_DATE,
    paymentTerms: "PP",
    unpaidBalance: "1500.00",
    orderTotal: "2000.00",
    taxTotal: "0.00",
    lines,
    taxDetails: [],
    activeOrderLineIds: lines
      .filter((candidate) => candidate.itemType === "F")
      .map((candidate) => candidate.id),
    ...overrides,
  });
}

function noBalancePayment(
  overrides: Partial<DeliveryGroupPaymentEvaluation> = {}
): DeliveryGroupPaymentEvaluation {
  return {
    orderDeliveryGroupId: "group_interval",
    orderId: "order_interval",
    orderType: "SO",
    orderNumber: "SOINT",
    deliveryDate: "2026-08-03",
    paymentTerms: "PP",
    unpaidBalance: "0.00",
    orderTotal: "1000.00",
    taxTotal: "0.00",
    paidToDate: "1000.00",
    currentDeliveryGroupMerchandiseValue: "0.00",
    currentDeliveryGroupTaxAmount: "0.00",
    currentDeliveryGroupValue: "0.00",
    completedValueBeforeCurrentDelivery: "0.00",
    remainingUndeliveredValueAfterCurrentDelivery: null,
    creditAfterCurrentDelivery: null,
    requiredDownOnRemaining: null,
    amountDueNow: null,
    amountDueNowRounded: null,
    payableStockValue: "0.00",
    assignedFreightDeliveryChargeValue: "0.00",
    newlyAssignedFreightDeliveryChargeValue: "0.00",
    payableBasisValue: "0.00",
    freightDeliveryChargeTodos: [],
    paymentApplicabilityStatus: "no_meaningful_balance_due",
    paymentStatus: "no_balance_due",
    urgencyStatus: "not_applicable",
    calculationWarnings: [],
    lines: [],
    ...overrides,
  };
}

function balanceDuePayment(
  overrides: Partial<DeliveryGroupPaymentEvaluation> = {}
): DeliveryGroupPaymentEvaluation {
  return noBalancePayment({
    unpaidBalance: "1500.00",
    paidToDate: "500.00",
    currentDeliveryGroupMerchandiseValue: "1000.00",
    currentDeliveryGroupTaxAmount: "0.00",
    currentDeliveryGroupValue: "1000.00",
    remainingUndeliveredValueAfterCurrentDelivery: "1000.00",
    creditAfterCurrentDelivery: "-500.00",
    requiredDownOnRemaining: "450.00",
    amountDueNow: "950.000000",
    amountDueNowRounded: "950.00",
    payableStockValue: "1000.00",
    payableBasisValue: "1000.00",
    paymentApplicabilityStatus: "applicable",
    paymentStatus: "balance_due",
    urgencyStatus: "payment_required",
    ...overrides,
  });
}

function importResult(overrides: Partial<ImportSalesOrdersResult> = {}): ImportSalesOrdersResult {
  return {
    requestedOn: "2026-08-03T09:19:00.000Z",
    qualifyingOrdersFetched: 1,
    fullOrdersFetched: 1,
    contactsUpserted: 0,
    ordersCreated: 0,
    ordersUpdated: 1,
    totalsUpserted: 1,
    taxDetailsUpserted: 0,
    linesUpserted: 1,
    allocationsUpserted: 0,
    addressesUpserted: 1,
    deliveryGroupsUpserted: 1,
    deliveryGroupLinesUpserted: 1,
    deliveryGroupLinesCreated: 1,
    deliveryGroupLinesReactivated: 0,
    deliveryGroupLinesDeactivated: 0,
    deliveryGroupLinesExcludedNonStock: 0,
    deliveryGroupLinesExcludedService: 0,
    deliveryGroupLinesExcludedUnknownItemType: 0,
    deliveryGroupLinesExcludedMissingRequestedOn: 0,
    deliveryGroupLinesExcludedMissingDeliveryGroup: 0,
    changeEventsDetected: 0,
    changeEventsCreated: 0,
    changeEventsDeduped: 0,
    skippedOrders: 0,
    failedOrders: 0,
    errors: [],
    ...overrides,
  };
}

function targetGroup(params: { id: string; orderNumber: string; deliveryDate: string }) {
  return {
    id: params.id,
    orderId: `order_${params.id}`,
    orderType: "SO",
    orderNumber: params.orderNumber,
    deliveryDate: new Date(`${params.deliveryDate}T00:00:00.000Z`),
    isActive: true,
    lineCount: 1,
    lastSeenAt: new Date("2026-07-20T00:00:00.000Z"),
    status: "Open",
    order: {
      id: `order_${params.id}`,
      orderType: "SO",
      orderNumber: params.orderNumber,
      status: "Open",
      internalLifecycleStatus: "ACTIVE",
      buyerGroup: "Appliances",
      confirmVia: "WEBPAGE",
      acumaticaOneWeekConfirmed: false,
      salespersonNumber: "123",
      customerId: "CUST",
      customerDescription: "Customer",
      locationDescription: "Residence",
      total: {
        paymentTerms: "PP",
        unpaidBalance: "1500.00",
        orderTotal: "2000.00",
      },
      address: {
        addressLine1: "123 Main",
        addressLine2: null,
        city: "Salt Lake City",
        state: "UT",
        postalCode: "84101",
      },
      contact: {
        contactId: `contact_${params.id}`,
        companyName: null,
        displayName: "Customer",
        firstName: "Customer",
        lastName: "Fixture",
        email: "customer@example.test",
        phone1: "8015551212",
        phone2: null,
        smsOptIn: true,
        emailOptIn: true,
        smsOptOuts: [],
        emailOptOuts: [],
      },
    },
  };
}

function fakeClient(groups: unknown[], counters: Record<string, number> = {}) {
  const bump = (key: string) => {
    counters[key] = (counters[key] ?? 0) + 1;
  };
  return {
    orderDeliveryGroup: {
      findMany: async () => groups,
    },
    notificationEvent: {
      findUnique: async () => null,
      create: async () => {
        bump("notificationEventCreate");
        throw new Error("validation dry-run must not create NotificationEvent rows");
      },
      update: async () => {
        throw new Error("validation must not update NotificationEvent rows");
      },
    },
    deliveryDetailsLink: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("validation dry-run must not create DeliveryDetailsLink rows");
      },
      update: async () => {
        throw new Error("validation must not update DeliveryDetailsLink rows");
      },
    },
    deliveryOrderHoldAction: {
      findUnique: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        bump("holdCreate");
        return {
          id: "hold_validation",
          status: args.data.status,
          queueJobId: null,
          errorMessage: null,
          acumaticaResponseSummary: null,
          customerNotificationEventId: null,
        };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        bump("holdUpdate");
        return {
          id: "hold_validation",
          status: args.data.status,
          queueJobId: args.data.queueJobId ?? null,
          errorMessage: args.data.errorMessage ?? null,
          acumaticaResponseSummary: args.data.acumaticaResponseSummary ?? null,
          customerNotificationEventId: null,
        };
      },
    },
    internalNotificationEvent: {
      findFirst: async () => null,
      create: async () => {
        throw new Error("validation must not create internal notification rows");
      },
    },
  };
}

function readinessSummary(params: { groupId: string; orderNumber: string; deliveryDate: string }) {
  return {
    orderDeliveryGroupId: params.groupId,
    orderId: `order_${params.groupId}`,
    orderType: "SO",
    orderNumber: params.orderNumber,
    deliveryDate: params.deliveryDate,
    lineCount: 1,
    includedLineCount: 1,
    totals: {
      ignored: 0,
      complete: 0,
      ready: 1,
      partially_allocated: 0,
      expected_on_time: 0,
      eta_pending: 0,
      backordered: 0,
    },
    hasBackorders: false,
    hasEtaPending: false,
    hasPartialAllocation: false,
    allReadyOrComplete: true,
    hasActionableIssues: false,
    lines: [],
  };
}

function excludedValue(evaluation: DeliveryGroupPaymentEvaluation, reasonPrefix: string) {
  return evaluation.lines
    .filter((candidate) => candidate.payableBasisExclusionReason?.startsWith(reasonPrefix))
    .reduce((total, candidate) => total + money(candidate.lineOpenMerchandiseValue), 0);
}

async function validateBranchScenarios(failures: string[], summaries: ScenarioSummary[]) {
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const {
    create12DayDeliveryPaymentRequestEvents,
  } = await import("../lib/notifications/create12DayDeliveryPaymentRequestEvents");
  const {
    create10DayDeliveryPaymentRequestEvents,
  } = await import("../lib/notifications/create10DayDeliveryPaymentRequestEvents");
  const {
    create8DayPaymentEnforcementEvents,
  } = await import("../lib/notifications/create8DayPaymentEnforcementEvents");

  const summary12Due = await create12DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-22",
    dryRun: true,
    prismaClient: fakeClient([
      targetGroup({ id: "group_12_due", orderNumber: "SO12DUE", deliveryDate: "2026-08-03" }),
    ]) as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () =>
      balanceDuePayment({
        orderDeliveryGroupId: "group_12_due",
        orderNumber: "SO12DUE",
        deliveryDate: "2026-08-03",
      }),
    getReadiness: async () =>
      readinessSummary({
        groupId: "group_12_due",
        orderNumber: "SO12DUE",
        deliveryDate: "2026-08-03",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(
    summary12Due.eventsWouldCreate === 1 &&
      summary12Due.eventReports[0]?.status === "SCHEDULED",
    "17. 12-day payable amount due > 2 schedules a dry-run payment request",
    failures
  );

  const summary12NoBalance = await create12DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-22",
    dryRun: true,
    prismaClient: fakeClient([
      targetGroup({ id: "group_12_clear", orderNumber: "SO12CLR", deliveryDate: "2026-08-03" }),
    ]) as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () =>
      noBalancePayment({
        orderDeliveryGroupId: "group_12_clear",
        orderNumber: "SO12CLR",
        deliveryDate: "2026-08-03",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(
    summary12NoBalance.eventsSkipped === 1 &&
      summary12NoBalance.eventReports[0]?.reasonSkipped === "no_balance_due" &&
      summary12NoBalance.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN",
    "17. 12-day amount due <= 2 skips payment request and invokes ONEWEEKCON dry-run path",
    failures
  );

  const summary10Due = await create10DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([
      targetGroup({ id: "group_10_due", orderNumber: "SO10DUE", deliveryDate: "2026-07-30" }),
    ]) as never,
    importSalesOrders: async () => importResult({ requestedOn: "2026-07-30T09:19:00.000Z" }),
    getPaymentEvaluation: async () =>
      balanceDuePayment({
        orderDeliveryGroupId: "group_10_due",
        orderNumber: "SO10DUE",
        deliveryDate: "2026-07-30",
      }),
    getReadiness: async () =>
      readinessSummary({
        groupId: "group_10_due",
        orderNumber: "SO10DUE",
        deliveryDate: "2026-07-30",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(
    summary10Due.eventsWouldCreate === 1 &&
      summary10Due.eventReports[0]?.status === "SCHEDULED",
    "18. 10-day payable amount due > 2 schedules a dry-run payment request",
    failures
  );

  const summary10NoBalance = await create10DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([
      targetGroup({ id: "group_10_clear", orderNumber: "SO10CLR", deliveryDate: "2026-07-30" }),
    ]) as never,
    importSalesOrders: async () => importResult({ requestedOn: "2026-07-30T09:19:00.000Z" }),
    getPaymentEvaluation: async () =>
      noBalancePayment({
        orderDeliveryGroupId: "group_10_clear",
        orderNumber: "SO10CLR",
        deliveryDate: "2026-07-30",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(
    summary10NoBalance.eventsSkipped === 1 &&
      summary10NoBalance.eventReports[0]?.reasonSkipped === "no_balance_due" &&
      summary10NoBalance.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN",
    "18. 10-day amount due <= 2 skips payment request and invokes ONEWEEKCON dry-run path",
    failures
  );

  const holdCounters: Record<string, number> = {};
  const summary8Due = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: true,
    prismaClient: fakeClient(
      [targetGroup({ id: "group_8_due", orderNumber: "SO8DUE", deliveryDate: "2026-07-29" })],
      holdCounters
    ) as never,
    importSalesOrders: async () => importResult({ requestedOn: "2026-07-29T09:19:00.000Z" }),
    getPaymentEvaluation: async () =>
      balanceDuePayment({
        orderDeliveryGroupId: "group_8_due",
        orderNumber: "SO8DUE",
        deliveryDate: "2026-07-29",
      }),
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: async () => ({
      jobId: "dry_run_hold_job",
      payload: {
        orderType: "SO",
        orderNumber: "SO8DUE",
        reason: "payment_not_received_by_deadline",
        dryRun: true,
        deliveryDate: "2026-07-29",
        amountDueAtTrigger: "950.00",
        paymentDeadline: "2026-07-21",
      },
      result: { status: "dry_run", reason: "dry_run" },
    }),
  });
  assert(
    summary8Due.paymentDueCount === 1 &&
      summary8Due.holdActionsCreated === 1 &&
      summary8Due.holdActionsDryRun === 1 &&
      holdCounters.holdCreate === 1,
    "19. 8-day payable amount due > 2 can proceed through dry-run hold/enforcement path",
    failures
  );

  const noHoldCounters: Record<string, number> = {};
  const summary8NoBalance = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: true,
    prismaClient: fakeClient(
      [targetGroup({ id: "group_8_clear", orderNumber: "SO8CLR", deliveryDate: "2026-07-29" })],
      noHoldCounters
    ) as never,
    importSalesOrders: async () => importResult({ requestedOn: "2026-07-29T09:19:00.000Z" }),
    getPaymentEvaluation: async () =>
      noBalancePayment({
        orderDeliveryGroupId: "group_8_clear",
        orderNumber: "SO8CLR",
        deliveryDate: "2026-07-29",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(
    summary8NoBalance.paymentDueCount === 0 &&
      (noHoldCounters.holdCreate ?? 0) === 0 &&
      summary8NoBalance.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN",
    "19. 8-day amount due <= 2 creates no hold and invokes ONEWEEKCON dry-run path",
    failures
  );

  summaries.push({
    name: "12/10/8 branch behavior",
    details: {
      day12DueWouldCreate: summary12Due.eventsWouldCreate,
      day12NoBalanceReason: summary12NoBalance.eventReports[0]?.reasonSkipped,
      day10DueWouldCreate: summary10Due.eventsWouldCreate,
      day10NoBalanceReason: summary10NoBalance.eventReports[0]?.reasonSkipped,
      day8DueHoldCreates: holdCounters.holdCreate ?? 0,
      day8NoBalanceHoldCreates: noHoldCounters.holdCreate ?? 0,
    },
  });
}

async function main() {
  const failures: string[] = [];
  const summaries: ScenarioSummary[] = [];

  const backordered14 = evaluate({
    lines: [
      line({
        id: "scenario1_line",
        lineNbr: 1,
        discountedUnitPrice: "1000.00",
        activeAllocatedQty: "0",
        allocationStatus: "not_allocated",
        etaStatus: "backordered",
        readinessStatus: "backordered",
      }),
    ],
  });
  const expected12 = evaluate({
    lines: [
      line({
        id: "scenario1_line",
        lineNbr: 1,
        discountedUnitPrice: "1000.00",
        activeAllocatedQty: "0",
        allocationStatus: "not_allocated",
        etaStatus: "expected_on_time",
        readinessStatus: "expected_on_time",
      }),
    ],
  });
  assert(
    backordered14.payableBasisValue === "0.00" &&
      backordered14.paymentStatus === "no_balance_due",
    "1. Backordered at 14-day is excluded and no-balance if no other payable value exists",
    failures
  );
  assert(
    expected12.payableBasisValue === "1000.00" &&
      expected12.paymentStatus === "balance_due" &&
      expected12.amountDueNowRounded === "950.00",
    "1. expected_on_time at 12-day includes the $1000 line and computes amount due",
    failures
  );
  summaries.push({
    name: "backordered at 14, expected_on_time at 12",
    details: {
      day14Status: backordered14.paymentStatus,
      day14PayableBasis: backordered14.payableBasisValue,
      day12Status: expected12.paymentStatus,
      day12PayableBasis: expected12.payableBasisValue,
      day12AmountDue: expected12.amountDueNowRounded,
    },
  });

  const eta14 = evaluate({
    orderTotal: "3000.00",
    unpaidBalance: "2500.00",
    lines: [
      line({
        id: "scenario2_line",
        lineNbr: 1,
        discountedUnitPrice: "1500.00",
        activeAllocatedQty: "0",
        allocationStatus: "not_allocated",
        etaStatus: "eta_pending",
        readinessStatus: "eta_pending",
      }),
    ],
  });
  const ready10 = evaluate({
    orderTotal: "3000.00",
    unpaidBalance: "2500.00",
    lines: [
      line({
        id: "scenario2_line",
        lineNbr: 1,
        discountedUnitPrice: "1500.00",
        readinessStatus: "ready",
      }),
    ],
  });
  assert(
    eta14.payableBasisValue === "0.00" && ready10.payableBasisValue === "1500.00",
    "2. ETA pending at 14 is excluded; ready at 10 is included",
    failures
  );
  summaries.push({
    name: "eta_pending at 14, ready at 10",
    details: {
      day14PayableBasis: eta14.payableBasisValue,
      day10PayableBasis: ready10.payableBasisValue,
      day10AmountDue: ready10.amountDueNowRounded,
    },
  });

  const partial14 = evaluate({
    lines: [
      line({
        id: "scenario3_line",
        lineNbr: 1,
        discountedUnitPrice: "500.00",
        orderQty: "2",
        openQty: "2",
        activeAllocatedQty: "1",
        allocationStatus: "partially_allocated",
        etaStatus: "ready",
        readinessStatus: "partially_allocated",
      }),
    ],
  });
  const readyFull10 = evaluate({
    lines: [
      line({
        id: "scenario3_line",
        lineNbr: 1,
        discountedUnitPrice: "500.00",
        orderQty: "2",
        openQty: "2",
        activeAllocatedQty: "2",
        allocationStatus: "allocated",
        etaStatus: "ready",
        readinessStatus: "ready",
      }),
    ],
  });
  assert(
    partial14.payableStockValue === "500.00" &&
      partial14.lines[0]?.lineOpenMerchandiseValue === "1000.00" &&
      readyFull10.payableStockValue === "1000.00",
    "3. Partially allocated at 14 charges only active allocation, full ready at 10 charges full open value",
    failures
  );
  summaries.push({
    name: "partially_allocated at 14, fully ready at 10",
    details: {
      day14PayableStockValue: partial14.payableStockValue,
      day10PayableStockValue: readyFull10.payableStockValue,
    },
  });

  const cappedPartial = evaluate({
    lines: [
      line({
        id: "scenario4_line",
        lineNbr: 1,
        discountedUnitPrice: "100.00",
        orderQty: "2",
        openQty: "2",
        activeAllocatedQty: "5",
        allocationStatus: "partially_allocated",
        etaStatus: "ready",
        readinessStatus: "partially_allocated",
      }),
    ],
  });
  assert(
    cappedPartial.lines[0]?.payableQuantity === "2.0000" &&
      cappedPartial.payableStockValue === "200.00",
    "4. Partially allocated activeAllocatedQty greater than openQty is capped to openQty",
    failures
  );

  const zeroPartial = evaluate({
    lines: [
      line({
        id: "scenario5_line",
        lineNbr: 1,
        discountedUnitPrice: "100.00",
        orderQty: "2",
        openQty: "2",
        activeAllocatedQty: "0",
        allocationStatus: "partially_allocated",
        etaStatus: "ready",
        readinessStatus: "partially_allocated",
      }),
    ],
  });
  assert(
    zeroPartial.payableBasisValue === "0.00" &&
      zeroPartial.lines[0]?.payableBasisIncluded === false,
    "5. Partially allocated activeAllocatedQty zero is excluded",
    failures
  );

  const expectedNoAllocation = evaluate({
    orderTotal: "2400.00",
    unpaidBalance: "1900.00",
    lines: [
      line({
        id: "scenario6_line",
        lineNbr: 1,
        discountedUnitPrice: "1200.00",
        activeAllocatedQty: "0",
        allocationStatus: "not_allocated",
        etaStatus: "expected_on_time",
        readinessStatus: "expected_on_time",
      }),
    ],
  });
  assert(
    expectedNoAllocation.payableStockValue === "1200.00" &&
      expectedNoAllocation.lines[0]?.payableQuantity === "1.0000",
    "6. expected_on_time counts as payable using openQty even without allocation",
    failures
  );

  const backorderedIntervals = [
    NotificationIntervalType.DAY_14,
    NotificationIntervalType.DAY_12,
    NotificationIntervalType.DAY_10,
    NotificationIntervalType.DAY_8,
  ].map((interval) => ({
    interval,
    evaluation: evaluate({
      lines: [
        line({
          id: `scenario7_${interval}`,
          lineNbr: 1,
          discountedUnitPrice: "1000.00",
          activeAllocatedQty: "0",
          allocationStatus: "not_allocated",
          etaStatus: "backordered",
          readinessStatus: "backordered",
        }),
      ],
    }),
  }));
  assert(
    backorderedIntervals.every(
      ({ evaluation }) =>
        evaluation.payableBasisValue === "0.00" &&
        evaluation.paymentStatus === "no_balance_due"
    ),
    "7. Backordered through 8-day contributes no payable basis at every interval",
    failures
  );

  const mixed = evaluate({
    orderTotal: "12000.00",
    unpaidBalance: "9000.00",
    lines: [
      line({ id: "mixed_ready", lineNbr: 1, discountedUnitPrice: "1000.00" }),
      line({
        id: "mixed_expected",
        lineNbr: 2,
        discountedUnitPrice: "2000.00",
        activeAllocatedQty: "0",
        allocationStatus: "not_allocated",
        etaStatus: "expected_on_time",
        readinessStatus: "expected_on_time",
      }),
      line({
        id: "mixed_partial",
        lineNbr: 3,
        discountedUnitPrice: "500.00",
        orderQty: "3",
        openQty: "3",
        activeAllocatedQty: "1",
        allocationStatus: "partially_allocated",
        etaStatus: "ready",
        readinessStatus: "partially_allocated",
      }),
      line({
        id: "mixed_backordered",
        lineNbr: 4,
        discountedUnitPrice: "4000.00",
        activeAllocatedQty: "0",
        allocationStatus: "not_allocated",
        etaStatus: "backordered",
        readinessStatus: "backordered",
      }),
      line({
        id: "mixed_eta_pending",
        lineNbr: 5,
        discountedUnitPrice: "3000.00",
        activeAllocatedQty: "0",
        allocationStatus: "not_allocated",
        etaStatus: "eta_pending",
        readinessStatus: "eta_pending",
      }),
      line({
        id: "mixed_non_stock",
        lineNbr: 6,
        itemType: "N",
        inventoryId: "LABOR",
        lineDescription: "Install labor",
        discountedUnitPrice: "900.00",
        orderQty: "1",
        openQty: "1",
        activeAllocatedQty: "0",
        etaStatus: "ignored",
        readinessStatus: "ignored",
      }),
    ],
  });
  assert(
    mixed.payableStockValue === "3500.00" &&
      excludedValue(mixed, "readiness_backordered") === 4000 &&
      excludedValue(mixed, "readiness_eta_pending") === 3000 &&
      excludedValue(mixed, "ordinary_non_stock") === 900,
    "8. Mixed readiness group uses 3500 payable basis and excludes backorder/ETA/non-stock values",
    failures
  );

  const freightLine = line({
    id: "freight_line",
    lineNbr: 1,
    itemType: "N",
    inventoryId: "FREIGHT-INBOUND",
    lineDescription: "Delivery freight",
    discountedUnitPrice: "300.00",
    orderQty: "1",
    openQty: "1",
    activeAllocatedQty: "0",
    etaStatus: "ignored",
    readinessStatus: "ignored",
  });
  const freightFirst = evaluate({
    orderDeliveryGroupId: "group_freight_first",
    lines: [freightLine],
    activeOrderLineIds: [],
    newlyAssignedFreightDeliveryChargeLines: [freightLine],
  });
  const freightSecond = evaluate({
    orderDeliveryGroupId: "group_freight_second",
    lines: [freightLine],
    activeOrderLineIds: [],
    freightDeliveryChargeAllocations: [
      {
        orderDeliveryGroupId: "group_freight_first",
        orderLineId: "freight_line",
        amountIncluded: "300.00",
        sourceInterval: NotificationIntervalType.DAY_14,
      },
    ],
  });
  const schema = read("prisma/schema.prisma");
  assert(
    freightFirst.newlyAssignedFreightDeliveryChargeValue === "300.00" &&
      freightSecond.payableBasisValue === "0.00" &&
      schema.includes("orderLineId          String                   @unique"),
    "9. Freight/delivery line is allocated once and later groups do not double-count it",
    failures
  );

  const freightAt12 = evaluate({
    orderDeliveryGroupId: "group_freight_same",
    lines: [freightLine],
    activeOrderLineIds: [],
    freightDeliveryChargeAllocations: [
      {
        orderDeliveryGroupId: "group_freight_same",
        orderLineId: "freight_line",
        amountIncluded: "300.00",
        sourceInterval: NotificationIntervalType.DAY_12,
      },
    ],
  });
  const freightAt10 = evaluate({
    orderDeliveryGroupId: "group_freight_same",
    lines: [freightLine],
    activeOrderLineIds: [],
    freightDeliveryChargeAllocations: [
      {
        orderDeliveryGroupId: "group_freight_same",
        orderLineId: "freight_line",
        amountIncluded: "300.00",
        sourceInterval: NotificationIntervalType.DAY_12,
      },
    ],
  });
  const freightAt8 = evaluate({
    orderDeliveryGroupId: "group_freight_same",
    lines: [freightLine],
    activeOrderLineIds: [],
    freightDeliveryChargeAllocations: [
      {
        orderDeliveryGroupId: "group_freight_same",
        orderLineId: "freight_line",
        amountIncluded: "300.00",
        sourceInterval: NotificationIntervalType.DAY_12,
      },
    ],
  });
  assert(
    freightAt12.payableBasisValue === "300.00" &&
      freightAt10.payableBasisValue === "300.00" &&
      freightAt8.payableBasisValue === "300.00",
    "10. Assigned freight/delivery remains included for the same group across 12/10/8",
    failures
  );

  const zeroOpenFreight = evaluate({
    lines: [
      {
        ...freightLine,
        id: "zero_open_freight",
        openQty: "0",
        orderQty: "1",
      },
    ],
    activeOrderLineIds: [],
  });
  assert(
    zeroOpenFreight.payableBasisValue === "0.00" &&
      (zeroOpenFreight.freightDeliveryChargeTodos?.length ?? 0) === 1,
    "11. Freight/delivery keyword false positive with zero open value is flagged uncertain and excluded",
    failures
  );

  const ordinaryNonKeyword = evaluate({
    lines: [
      {
        ...freightLine,
        id: "ordinary_non_keyword",
        inventoryId: "MISC",
        lineDescription: "Misc charge",
      },
    ],
    activeOrderLineIds: [],
    newlyAssignedFreightDeliveryChargeLines: [],
  });
  assert(
    ordinaryNonKeyword.payableBasisValue === "0.00",
    "12. Non-keyword non-stock positive amount is excluded",
    failures
  );

  const unpaidZero = evaluate({ unpaidBalance: "0.00" });
  const unpaidNegative = evaluate({ unpaidBalance: "-25.00" });
  const threshold = evaluate({
    lines: [line({ id: "threshold", lineNbr: 1, discountedUnitPrice: "400.00" })],
    unpaidBalance: "332.00",
    orderTotal: "1000.00",
  });
  assert(
    unpaidZero.paymentStatus === "no_balance_due" &&
      unpaidNegative.paymentStatus === "no_balance_due" &&
      threshold.amountDueNowRounded === "2.00" &&
      threshold.paymentStatus === "no_balance_due",
    "13/14/15. Zero, negative, and <= $2 due all return no_balance_due",
    failures
  );

  const fourteenDue = render30DayDeliveryReminderEmail({
    contactName: "Customer",
    buyerGroup: "Appliance",
    jobName: "Job",
    jobAddress: "123 Main",
    deliveryDate: DELIVERY_DATE,
    detailsLink: "https://example.test/delivery/details/token",
    paymentDue: true,
    amountDueNowRounded: "100.00",
  });
  const fourteenClear = render30DayDeliveryReminderEmail({
    contactName: "Customer",
    buyerGroup: "Appliance",
    jobName: "Job",
    jobAddress: "123 Main",
    deliveryDate: DELIVERY_DATE,
    detailsLink: "https://example.test/delivery/details/token",
    paymentDue: false,
    amountDueNowRounded: "0.00",
  });
  assert(
    fourteenDue.body.includes("Payment") &&
      fourteenDue.body.includes("$100.00") &&
      !fourteenClear.body.includes("$0.00") &&
      !fourteenClear.body.includes("Payment"),
    "16. 14-day rendering shows payment only when payable amount due > 2",
    failures
  );

  await validateBranchScenarios(failures, summaries);

  for (const value of [null, "0.00", "-1.00", "2.00"]) {
    const markup = renderToStaticMarkup(
      <DeliveryPaymentSummary
        payment={{
          paymentStatus: "balance_due",
          amountDueNowRounded: value,
          unpaidBalance: value,
          currentDeliveryGroupValue: value,
          calculationWarnings: [],
        }}
      />
    );
    assert(
      !markup.includes("$0.00") && !markup.includes("-$") && !markup.includes("$2.00"),
      `20. Details/confirmation payment rendering suppresses ${String(value)}`,
      failures
    );
  }

  summaries.push(
    {
      name: "mixed readiness group",
      details: {
        payableStockValue: mixed.payableStockValue,
        excludedBackorderedValue: excludedValue(mixed, "readiness_backordered"),
        excludedEtaPendingValue: excludedValue(mixed, "readiness_eta_pending"),
        excludedOrdinaryNonStockValue: excludedValue(mixed, "ordinary_non_stock"),
        amountDueNowRounded: mixed.amountDueNowRounded,
      },
    },
    {
      name: "freight/delivery allocation",
      details: {
        firstGroupFreightValue: freightFirst.newlyAssignedFreightDeliveryChargeValue,
        secondGroupPayableBasis: freightSecond.payableBasisValue,
        sameGroupAt12: freightAt12.payableBasisValue,
        sameGroupAt10: freightAt10.payableBasisValue,
        sameGroupAt8: freightAt8.payableBasisValue,
        zeroOpenTodoCount: zeroOpenFreight.freightDeliveryChargeTodos?.length ?? 0,
      },
    },
    {
      name: "zero negative threshold",
      details: {
        zeroBalanceStatus: unpaidZero.paymentStatus,
        negativeBalanceStatus: unpaidNegative.paymentStatus,
        thresholdAmountDue: threshold.amountDueNowRounded,
        thresholdStatus: threshold.paymentStatus,
      },
    }
  );

  if (failures.length > 0) {
    console.error("Delivery payment interval scenario validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(JSON.stringify({ scenarios: summaries }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        validation: "delivery payment interval scenario validation passed",
        scenarios: summaries,
        safety: {
          liveSmsSent: false,
          liveEmailSent: false,
          providerDispatch: false,
          acumaticaWrites: false,
          oneWeekConfirmationWrite: false,
          realHoldsPlaced: false,
          notificationAttemptsCreated: false,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
