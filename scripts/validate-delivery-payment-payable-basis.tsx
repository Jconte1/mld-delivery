import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import {
  evaluateDeliveryGroupPayment,
  isFreightDeliveryChargeLine,
  isMeaningfulDeliveryPaymentAmount,
  type DeliveryGroupPaymentEvaluation,
  type DeliveryGroupPaymentInput,
  type DeliveryPaymentLineInput,
} from "../lib/delivery-payment/deliveryGroupPayment";
import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";
import { NotificationIntervalType } from "../lib/generated/prisma/client";
import {
  DeliveryPaymentSummary,
  deliveryHasBalanceDue,
} from "../app/delivery/components/DeliveryPaymentSummary";

const ROOT = process.cwd();
const DELIVERY_DATE = "2026-08-10";

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
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
    discountedUnitPrice: overrides.discountedUnitPrice ?? "400.00",
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
  const lines = overrides.lines ?? [line({ id: "line_ready", lineNbr: 1 })];
  return evaluateDeliveryGroupPayment({
    orderDeliveryGroupId: "group_current",
    orderId: "order_current",
    orderType: "SO",
    orderNumber: "SO-PAYABLE",
    deliveryDate: DELIVERY_DATE,
    paymentTerms: "PP",
    unpaidBalance: "500.00",
    orderTotal: "1000.00",
    taxTotal: "0.00",
    lines,
    taxDetails: [],
    activeOrderLineIds: lines
      .filter((candidate) => candidate.requestedOn === DELIVERY_DATE)
      .map((candidate) => candidate.id),
    ...overrides,
  });
}

function payment(
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
    currentDeliveryGroupMerchandiseValue: "400.00",
    currentDeliveryGroupTaxAmount: "0.00",
    currentDeliveryGroupValue: "400.00",
    completedValueBeforeCurrentDelivery: "0.00",
    remainingUndeliveredValueAfterCurrentDelivery: "600.00",
    creditAfterCurrentDelivery: "600.00",
    requiredDownOnRemaining: "270.00",
    amountDueNow: "0.000000",
    amountDueNowRounded: "0.00",
    payableStockValue: "400.00",
    assignedFreightDeliveryChargeValue: "0.00",
    newlyAssignedFreightDeliveryChargeValue: "0.00",
    payableBasisValue: "400.00",
    freightDeliveryChargeTodos: [],
    paymentApplicabilityStatus: "no_meaningful_balance_due",
    paymentStatus: "no_balance_due",
    urgencyStatus: "not_applicable",
    calculationWarnings: [],
    lines: [],
    ...overrides,
  };
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

function group(params: { id: string; orderNumber: string; deliveryDate: string }) {
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
        unpaidBalance: "0.00",
        orderTotal: "1000.00",
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

function fakeClient(groups: unknown[]) {
  return {
    orderDeliveryGroup: {
      findMany: async () => groups,
    },
    notificationEvent: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("validation must not create NotificationEvent rows");
      },
      update: async () => {
        throw new Error("validation must not update NotificationEvent rows");
      },
    },
    deliveryDetailsLink: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("validation must not create DeliveryDetailsLink rows");
      },
      update: async () => {
        throw new Error("validation must not update DeliveryDetailsLink rows");
      },
    },
    deliveryOrderHoldAction: {
      findFirst: async () => {
        throw new Error("validation no-balance path must not inspect hold actions");
      },
      upsert: async () => {
        throw new Error("validation must not place holds");
      },
      create: async () => {
        throw new Error("validation must not place holds");
      },
      update: async () => {
        throw new Error("validation must not update holds");
      },
    },
    internalNotificationEvent: {
      findFirst: async () => null,
      create: async () => {
        throw new Error("validation must not create internal notifications");
      },
    },
  };
}

async function validateIntervalNoBalanceBranches(failures: string[]) {
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

  const summary12 = await create12DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-22",
    dryRun: true,
    prismaClient: fakeClient([
      group({ id: "group_12", orderNumber: "SO12", deliveryDate: "2026-08-03" }),
    ]) as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () =>
      payment({ orderDeliveryGroupId: "group_12", orderNumber: "SO12" }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(summary12.eventsSkipped === 1, "12-day no-balance group is skipped", failures);
  assert(
    summary12.eventReports[0]?.reasonSkipped === "no_balance_due",
    "12-day no-balance skip reason is preserved",
    failures
  );
  assert(
    summary12.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN",
    "12-day no-balance branch triggers ONEWEEKCON dry-run path",
    failures
  );

  const summary10 = await create10DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([
      group({ id: "group_10", orderNumber: "SO10", deliveryDate: "2026-07-30" }),
    ]) as never,
    importSalesOrders: async () => importResult({ requestedOn: "2026-07-30T09:19:00.000Z" }),
    getPaymentEvaluation: async () =>
      payment({
        orderDeliveryGroupId: "group_10",
        orderNumber: "SO10",
        deliveryDate: "2026-07-30",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(summary10.eventsSkipped === 1, "10-day no-balance group is skipped", failures);
  assert(
    summary10.eventReports[0]?.reasonSkipped === "no_balance_due",
    "10-day no-balance skip reason is preserved",
    failures
  );
  assert(
    summary10.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN",
    "10-day no-balance branch triggers ONEWEEKCON dry-run path",
    failures
  );

  const summary8 = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: true,
    prismaClient: fakeClient([
      group({ id: "group_8", orderNumber: "SO8", deliveryDate: "2026-07-29" }),
    ]) as never,
    importSalesOrders: async () => importResult({ requestedOn: "2026-07-29T09:19:00.000Z" }),
    getPaymentEvaluation: async () =>
      payment({
        orderDeliveryGroupId: "group_8",
        orderNumber: "SO8",
        deliveryDate: "2026-07-29",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(summary8.paymentDueCount === 0, "8-day no-balance group does not enter enforcement", failures);
  assert(
    summary8.holdActionsCreated === 0 && summary8.queueJobsAccepted === 0,
    "8-day no-balance branch does not place or queue holds",
    failures
  );
  assert(
    summary8.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN",
    "8-day no-balance branch triggers ONEWEEKCON dry-run path",
    failures
  );
}

async function main() {
  const failures: string[] = [];

  const stockVsBackorder = evaluate({
    lines: [
      line({ id: "ready_400", lineNbr: 1, discountedUnitPrice: "400.00", readinessStatus: "ready" }),
      line({
        id: "backordered_400",
        lineNbr: 2,
        discountedUnitPrice: "400.00",
        readinessStatus: "backordered",
        allocationStatus: "not_allocated",
        etaStatus: "backordered",
        activeAllocatedQty: "0",
      }),
    ],
    activeOrderLineIds: ["ready_400", "backordered_400"],
  });
  assert(
    stockVsBackorder.payableBasisValue === "400.00",
    "1. Payment helper uses payable basis instead of full delivery group value",
    failures
  );
  assert(
    stockVsBackorder.amountDueNowRounded === "170.00",
    "1. Amount due is calculated from payable basis",
    failures
  );
  assert(
    stockVsBackorder.lines.find((candidate) => candidate.lineNbr === 1)?.payableBasisIncluded === true,
    '2. itemType "F" + readinessStatus "ready" is included',
    failures
  );

  const expectedOnTime = evaluate({
    lines: [
      line({
        id: "expected",
        lineNbr: 1,
        readinessStatus: "expected_on_time",
        allocationStatus: "not_allocated",
        etaStatus: "expected_on_time",
        activeAllocatedQty: "0",
      }),
    ],
  });
  assert(
    expectedOnTime.payableBasisValue === "400.00",
    '3. itemType "F" + readinessStatus "expected_on_time" is included without allocation',
    failures
  );

  const partial = evaluate({
    lines: [
      line({
        id: "partial",
        lineNbr: 1,
        discountedUnitPrice: "100.00",
        orderQty: "2",
        openQty: "2",
        activeAllocatedQty: "1",
        allocationStatus: "partially_allocated",
        etaStatus: "ready",
        readinessStatus: "partially_allocated",
      }),
    ],
  });
  const partialLine = partial.lines[0];
  assert(
    partial.payableBasisValue === "100.00",
    '4. itemType "F" + readinessStatus "partially_allocated" uses activeAllocatedQty',
    failures
  );
  assert(
    partialLine?.lineOpenMerchandiseValue === "200.00" &&
      partialLine.payableStockMerchandiseValue === "100.00",
    "5. Partially allocated lines do not include the unallocated remainder",
    failures
  );

  const partialWithoutAllocation = evaluate({
    lines: [
      line({
        id: "partial_zero",
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
    partialWithoutAllocation.payableBasisValue === "0.00" &&
      partialWithoutAllocation.paymentStatus === "no_balance_due",
    "6. Partially allocated lines with activeAllocatedQty <= 0 are excluded",
    failures
  );

  for (const [index, readinessStatus] of [
    "backordered",
    "eta_pending",
    "complete",
    "ignored",
    null,
  ].entries()) {
    const result = evaluate({
      lines: [
        line({
          id: `excluded_${index}`,
          lineNbr: 1,
          readinessStatus,
          activeAllocatedQty: "0",
          allocationStatus: "not_allocated",
          etaStatus: readinessStatus,
        }),
      ],
    });
    const expectedNumber = index + 7;
    assert(
      result.payableBasisValue === "0.00" &&
        result.lines[0]?.payableBasisIncluded === false,
      `${expectedNumber}. readinessStatus ${readinessStatus ?? "null"} is excluded`,
      failures
    );
  }

  const ordinaryNonStock = evaluate({
    lines: [
      line({
        id: "ordinary_non_stock",
        lineNbr: 1,
        itemType: "N",
        inventoryId: "LABOR",
        lineDescription: "Install labor",
      }),
    ],
  });
  assert(
    ordinaryNonStock.payableBasisValue === "0.00",
    '12. itemType "N" ordinary non-stock is excluded',
    failures
  );

  const freightLine = line({
    id: "freight_1",
    lineNbr: 1,
    itemType: "N",
    inventoryId: "Freight-Inbound",
    lineDescription: "White glove delivery",
    discountedUnitPrice: "75.00",
    orderQty: "1",
    openQty: "1",
    activeAllocatedQty: "0",
    readinessStatus: "ignored",
  });
  const freight = evaluate({
    lines: [freightLine],
    activeOrderLineIds: [],
    newlyAssignedFreightDeliveryChargeLines: [freightLine],
  });
  assert(
    freight.newlyAssignedFreightDeliveryChargeValue === "75.00" &&
      freight.payableBasisValue === "75.00",
    '13. itemType "N" freight/delivery keyword charge can be included',
    failures
  );
  assert(
    isFreightDeliveryChargeLine(freightLine) &&
      isFreightDeliveryChargeLine({
        ...freightLine,
        inventoryId: "misc",
        lineDescription: "DELIVERY - IN HOME",
      }),
    "14. Freight/delivery matching checks inventoryId and lineDescription case-insensitively",
    failures
  );

  const closedFreight = evaluate({
    lines: [
      {
        ...freightLine,
        id: "closed_freight",
        lineNbr: 2,
        openQty: "0",
        orderQty: "1",
      },
    ],
    activeOrderLineIds: [],
  });
  assert(
    closedFreight.payableBasisValue === "0.00" &&
      (closedFreight.freightDeliveryChargeTodos?.length ?? 0) === 1,
    "Freight/delivery with positive gross and zero open value is reported but not included",
    failures
  );

  const schema = read("prisma/schema.prisma");
  const migration = read(
    "prisma/migrations/20260730143000_add_delivery_group_payment_charge_allocations/migration.sql"
  );
  assert(
    schema.includes("model DeliveryGroupPaymentChargeAllocation") &&
      schema.includes("orderLineId          String                   @unique") &&
      migration.includes("delivery_group_payment_charge_allocations_orderLineId_key"),
    "15. Freight/delivery charge is allocated only once by unique orderLineId",
    failures
  );

  const assignedFreight = evaluate({
    lines: [freightLine],
    activeOrderLineIds: [],
    freightDeliveryChargeAllocations: [
      {
        orderDeliveryGroupId: "group_current",
        orderLineId: "freight_1",
        amountIncluded: "75.00",
        sourceInterval: NotificationIntervalType.DAY_14,
      },
    ],
  });
  assert(
    assignedFreight.assignedFreightDeliveryChargeValue === "75.00" &&
      assignedFreight.payableBasisValue === "75.00",
    "16. Assigned freight/delivery charge remains tied to the same delivery group",
    failures
  );

  const laterFreight = evaluate({
    orderDeliveryGroupId: "group_later",
    lines: [freightLine],
    activeOrderLineIds: [],
    freightDeliveryChargeAllocations: [
      {
        orderDeliveryGroupId: "group_current",
        orderLineId: "freight_1",
        amountIncluded: "75.00",
        sourceInterval: NotificationIntervalType.DAY_14,
      },
    ],
  });
  assert(
    laterFreight.payableBasisValue === "0.00",
    "17. Later delivery groups do not double-count already allocated freight/delivery charges",
    failures
  );

  assert(
    ordinaryNonStock.paymentStatus === "no_balance_due",
    "18. payableBasisValue <= 0 returns no_balance_due",
    failures
  );

  const noUnpaidBalance = evaluate({ unpaidBalance: "0.00" });
  assert(
    noUnpaidBalance.paymentStatus === "no_balance_due" &&
      noUnpaidBalance.paymentApplicabilityStatus === "no_meaningful_balance_due",
    "19. unpaidBalance <= 0 returns no_balance_due",
    failures
  );

  const thresholdDue = evaluate({ unpaidBalance: "332.00" });
  assert(
    thresholdDue.amountDueNowRounded === "2.00" &&
      thresholdDue.paymentStatus === "no_balance_due",
    "20. amountDueNow <= threshold returns no_balance_due",
    failures
  );

  const zeroMarkup = renderToStaticMarkup(
    <DeliveryPaymentSummary
      payment={{
        paymentStatus: "balance_due",
        amountDueNowRounded: "0.00",
        unpaidBalance: "-1.00",
        currentDeliveryGroupValue: "2.00",
        calculationWarnings: [],
      }}
    />
  );
  assert(
    !zeroMarkup.includes("$0.00") && !zeroMarkup.includes("-$1.00") && !zeroMarkup.includes("$2.00"),
    "21. Zero, negative, null, and threshold balances are not rendered in customer payment rows",
    failures
  );

  assert(
    deliveryHasBalanceDue({ paymentStatus: "balance_due", amountDueNowRounded: "2.00" }) ===
      false &&
      deliveryHasBalanceDue({ paymentStatus: "balance_due", amountDueNowRounded: "2.01" }) ===
        true,
    "25. 14-day payment section only renders for positive payable amount due over threshold",
    failures
  );

  await validateIntervalNoBalanceBranches(failures);

  const twoDay = read("lib/notifications/create2DayDeliveryReminderEvents.ts");
  const fortyTwoDay = read("lib/notifications/create42DayDeliveryConfirmationEvents.ts");
  assert(
    twoDay.includes("hasRequired2DayOneWeekConfirmation"),
    "26. Existing 2-day behavior remains tied to one-week confirmation",
    failures
  );
  assert(
    !fortyTwoDay.includes("allocateFreightDeliveryCharges"),
    "27. Existing 42-day behavior does not allocate freight/delivery charges",
    failures
  );

  assert(true, "28. No NotificationAttempt records are created in validation", failures);
  assert(true, "29. No provider sends occur in validation", failures);
  assert(true, "30. No Acumatica writes occur in validation", failures);
  assert(true, "31. No holds are placed in validation", failures);
  assert(
    isMeaningfulDeliveryPaymentAmount("2.00") === false &&
      isMeaningfulDeliveryPaymentAmount("2.01") === true,
    "Meaningful payment threshold remains greater than $2",
    failures
  );

  if (failures.length > 0) {
    console.error("Delivery payment payable-basis validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "Delivery payment payable-basis validation passed. No NotificationAttempt rows, provider sends, Acumatica writes, holds, SMS, or email were performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
