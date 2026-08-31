import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";

const ROOT = process.cwd();

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function importResult(overrides: Partial<ImportSalesOrdersResult> = {}): ImportSalesOrdersResult {
  return {
    requestedOn: "2026-08-03T09:19:00.000Z",
    qualifyingOrdersFetched: 1,
    fullOrdersFetched: 1,
    successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "SO12" }],
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

function payment(overrides: Partial<DeliveryGroupPaymentEvaluation> = {}): DeliveryGroupPaymentEvaluation {
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
        throw new Error("validation dry-run must not create notification events");
      },
      update: async () => {
        throw new Error("validation must not update notification events");
      },
    },
    deliveryDetailsLink: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("validation dry-run must not create details links");
      },
      update: async () => {
        throw new Error("validation must not update details links");
      },
    },
  };
}

async function main() {
  const failures: string[] = [];
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const {
    create10DayDeliveryPaymentRequestEvents,
  } = await import("../lib/notifications/create10DayDeliveryPaymentRequestEvents");
  const {
    create12DayDeliveryPaymentRequestEvents,
  } = await import("../lib/notifications/create12DayDeliveryPaymentRequestEvents");
  const {
    create8DayPaymentEnforcementEvents,
  } = await import("../lib/notifications/create8DayPaymentEnforcementEvents");

  const sharedReminder = read("lib/notifications/create30DayDeliveryReminderEvents.ts");
  const twelve = read("lib/notifications/create12DayDeliveryPaymentRequestEvents.ts");
  const ten = read("lib/notifications/create10DayDeliveryPaymentRequestEvents.ts");
  const eight = read("lib/notifications/create8DayPaymentEnforcementEvents.ts");
  const two = read("lib/notifications/create2DayDeliveryReminderEvents.ts");

  assert(
    sharedReminder.includes("options.intervalType === NotificationIntervalType.DAY_14"),
    "14-day shared reminder is the only shared reminder interval that records ONEWEEKCON",
    failures
  );
  assert(
    sharedReminder.includes("sourceInterval: NotificationIntervalType.DAY_14"),
    "14-day records DAY_14 as ONEWEEKCON source interval",
    failures
  );
  assert(
    !sharedReminder.includes("sourceInterval: NotificationIntervalType.DAY_30"),
    "30-day does not record ONEWEEKCON",
    failures
  );
  assert(
    twelve.includes("sourceInterval: NotificationIntervalType.DAY_12"),
    "12-day no-balance path records DAY_12 as ONEWEEKCON source interval",
    failures
  );
  assert(
    ten.includes("sourceInterval: NotificationIntervalType.DAY_10"),
    "10-day no-balance path records DAY_10 as ONEWEEKCON source interval",
    failures
  );
  assert(
    eight.includes("sourceInterval: NotificationIntervalType.DAY_8"),
    "8-day no-balance path records DAY_8 as ONEWEEKCON source interval",
    failures
  );
  assert(
    two.includes("hasRequired2DayOneWeekConfirmation"),
    "2-day consumes local ONEWEEKCON confirmation status",
    failures
  );

  const summary12 = await create12DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-22",
    dryRun: true,
    prismaClient: fakeClient([group({ id: "group_12", orderNumber: "SO12", deliveryDate: "2026-08-03" })]) as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () => payment({ orderDeliveryGroupId: "group_12", orderNumber: "SO12" }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(summary12.eventsSkipped === 1, "12-day no-balance group remains skipped", failures);
  assert(summary12.eventReports[0]?.reasonSkipped === "no_balance_due", "12-day no-balance skip reason remains", failures);
  assert(summary12.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN", "12-day dry-run reports ONEWEEKCON dry-run", failures);

  const summary10 = await create10DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([group({ id: "group_10", orderNumber: "SO10", deliveryDate: "2026-07-30" })]) as never,
    importSalesOrders: async () =>
      importResult({
        requestedOn: "2026-07-30T09:19:00.000Z",
        successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "SO10" }],
      }),
    getPaymentEvaluation: async () =>
      payment({
        orderDeliveryGroupId: "group_10",
        orderNumber: "SO10",
        deliveryDate: "2026-07-30",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(summary10.eventsSkipped === 1, "10-day no-balance group remains skipped", failures);
  assert(summary10.eventReports[0]?.reasonSkipped === "no_balance_due", "10-day no-balance skip reason remains", failures);
  assert(summary10.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN", "10-day dry-run reports ONEWEEKCON dry-run", failures);

  const summary8 = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: true,
    prismaClient: fakeClient([group({ id: "group_8", orderNumber: "SO8", deliveryDate: "2026-07-29" })]) as never,
    importSalesOrders: async () =>
      importResult({
        requestedOn: "2026-07-29T09:19:00.000Z",
        successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "SO8" }],
      }),
    getPaymentEvaluation: async () =>
      payment({
        orderDeliveryGroupId: "group_8",
        orderNumber: "SO8",
        deliveryDate: "2026-07-29",
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(summary8.paymentDueCount === 0, "8-day no-balance group does not enter enforcement", failures);
  assert(summary8.eventReports[0]?.renderedMessagePreview === "no_balance_due", "8-day no-balance report remains clear", failures);
  assert(summary8.eventReports[0]?.tenDayConfirmationStatus === "DRY_RUN", "8-day dry-run reports ONEWEEKCON dry-run", failures);

  if (failures.length > 0) {
    console.error("One-week confirmation interval integration validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "One-week confirmation interval integration validation passed. No SMS/email, provider dispatch, Acumatica write, or deployment was performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
