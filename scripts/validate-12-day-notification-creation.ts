import { readFileSync } from "fs";
import { join } from "path";

import type { DeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";

type Create12DayModule = typeof import("../lib/notifications/create12DayDeliveryPaymentRequestEvents");

const ROOT = process.cwd();

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(source.includes(pattern), message, failures);
}

function assertNotIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(!source.includes(pattern), message, failures);
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
    changeEventsDetected: 0,
    changeEventsCreated: 0,
    changeEventsDeduped: 0,
    skippedOrders: 0,
    failedOrders: 0,
    errors: [],
    ...overrides,
  };
}

function paymentEvaluation(
  overrides: Partial<DeliveryGroupPaymentEvaluation> = {}
): DeliveryGroupPaymentEvaluation {
  return {
    orderDeliveryGroupId: "group_12",
    orderId: "order_12",
    orderType: "SO",
    orderNumber: "SO12",
    deliveryDate: "2026-08-03",
    paymentTerms: "PP",
    unpaidBalance: "500.00",
    orderTotal: "1000.00",
    taxTotal: "0.00",
    paidToDate: "500.00",
    currentDeliveryGroupMerchandiseValue: "400.00",
    currentDeliveryGroupTaxAmount: "0.00",
    currentDeliveryGroupValue: "400.00",
    completedValueBeforeCurrentDelivery: "0.00",
    remainingUndeliveredValueAfterCurrentDelivery: "600.00",
    creditAfterCurrentDelivery: "100.00",
    requiredDownOnRemaining: "270.00",
    amountDueNow: "170.000000",
    amountDueNowRounded: "170.00",
    paymentApplicabilityStatus: "applicable",
    paymentStatus: "balance_due",
    urgencyStatus: "payment_required",
    calculationWarnings: [],
    lines: [
      {
        lineNbr: 1,
        inventoryId: "TEST-ITEM",
        lineDescription: "Test item",
        itemType: "S",
        itemClass: "APPLIANCE",
        requestedOn: "2026-08-03",
        taxCategory: "EXEMPT",
        taxRate: "0",
        discountedUnitPrice: "400.00",
        orderQty: "1.0000",
        openQty: "1.0000",
        completedQtyDerived: "0.0000",
        lineGrossMerchandiseValue: "400.00",
        lineGrossTaxAmount: "0.00",
        lineGrossTotalValue: "400.00",
        lineOpenMerchandiseValue: "400.00",
        lineOpenTaxAmount: "0.00",
        lineOpenTotalValue: "400.00",
        lineCompletedMerchandiseValue: "0.00",
        lineCompletedTaxAmount: "0.00",
        lineCompletedTotalValue: "0.00",
        includedInCurrentDeliveryGroup: true,
      },
    ],
    ...overrides,
  };
}

function targetGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: "group_12",
    orderId: "order_12",
    orderType: "SO",
    orderNumber: "SO12",
    deliveryDate: new Date("2026-08-03T00:00:00.000Z"),
    isActive: true,
    lineCount: 1,
    lastSeenAt: new Date("2026-07-20T00:00:00.000Z"),
    status: "Open",
    order: {
      id: "order_12",
      orderType: "SO",
      orderNumber: "SO12",
      status: "Open",
      internalLifecycleStatus: "ACTIVE",
      buyerGroup: "Appliances",
      confirmVia: " WEBPAGE ",
      salespersonNumber: "123",
      customerDescription: "Smith",
      locationDescription: "Residence",
      total: {
        paymentTerms: " pp ",
        unpaidBalance: "500.00",
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
        contactId: "contact_12",
        companyName: null,
        displayName: "James",
        firstName: "James",
        lastName: "Conte",
        email: "james@example.test",
        phone1: "8015551212",
        phone2: null,
        smsOptIn: true,
        emailOptIn: true,
        smsOptOuts: [],
        emailOptOuts: [],
      },
    },
    ...overrides,
  };
}

function weekendTargetGroup() {
  const base = targetGroup({
    id: "group_C106293",
    orderId: "order_C106293",
    orderNumber: "C106293",
    deliveryDate: new Date("2026-08-08T00:00:00.000Z"),
  });
  return {
    ...base,
    order: {
      ...base.order,
      id: "order_C106293",
      orderNumber: "C106293",
    },
  };
}

function fakeClient(groups: unknown[], flags: { queried: boolean; dedupeChecked: boolean }) {
  return {
    orderDeliveryGroup: {
      findMany: async () => {
        flags.queried = true;
        return groups;
      },
    },
    notificationEvent: {
      findUnique: async () => {
        flags.dedupeChecked = true;
        return null;
      },
      create: async () => {
        throw new Error("validation runs in dryRun and must not create notification events");
      },
      update: async () => {
        throw new Error("validation must not update notification events");
      },
    },
    deliveryDetailsLink: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("validation dryRun must not create details links");
      },
      update: async () => {
        throw new Error("validation must not update details links");
      },
    },
  };
}

async function validateMockedRuntimeBehavior(
  failures: string[],
  create12DayModule: Create12DayModule
) {
  const { create12DayDeliveryPaymentRequestEvents } = create12DayModule;
  const globalFlags = { queried: false, dedupeChecked: false };
  try {
    await create12DayDeliveryPaymentRequestEvents({
      runDate: "2026-07-22",
      dryRun: true,
      prismaClient: fakeClient([], globalFlags) as never,
      importSalesOrders: async () => {
        throw new Error("global import unavailable");
      },
      getSalespersonContactMap: async () => new Map(),
    });
    assert(false, "global import failure should throw", failures);
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("global import unavailable"),
      "global import failure is propagated",
      failures
    );
    assert(!globalFlags.queried, "global import failure stops before DB evaluation", failures);
  }

  let paymentCalledForFailedImport = false;
  const perOrderFlags = { queried: false, dedupeChecked: false };
  const perOrderSummary = await create12DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-22",
    dryRun: true,
    prismaClient: fakeClient([targetGroup()], perOrderFlags) as never,
    importSalesOrders: async () =>
      importResult({
        failedOrders: 1,
        errors: [
          {
            orderType: "SO",
            orderNumber: "SO12",
            reason: "Step 2 full SalesOrder fetch failed: timeout",
          },
        ],
      }),
    getPaymentEvaluation: async () => {
      paymentCalledForFailedImport = true;
      throw new Error("stale payment data should not be evaluated");
    },
    getReadiness: async () => {
      throw new Error("stale readiness should not be evaluated");
    },
    getSalespersonContactMap: async () => new Map(),
  });

  assert(perOrderFlags.queried, "per-order import failure still allows safe group scan", failures);
  assert(
    !perOrderFlags.dedupeChecked,
    "per-order import failure excludes order before event dedupe",
    failures
  );
  assert(
    !paymentCalledForFailedImport,
    "per-order import failure prevents stale payment evaluation",
    failures
  );
  assert(
    perOrderSummary.deliveryGroupsSkippedFailedImport === 1,
    "per-order import failure is reported as excluded",
    failures
  );

  let weekendImportCalled = false;
  let weekendPaymentCalled = false;
  let weekendReadinessCalled = false;
  const weekendFlags = { queried: false, dedupeChecked: false };
  const weekendSummary = await create12DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-27",
    dryRun: true,
    prismaClient: fakeClient([weekendTargetGroup()], weekendFlags) as never,
    importSalesOrders: async () => {
      weekendImportCalled = true;
      throw new Error("weekend delivery dates must skip before import");
    },
    getPaymentEvaluation: async () => {
      weekendPaymentCalled = true;
      throw new Error("weekend delivery dates must skip before payment evaluation");
    },
    getReadiness: async () => {
      weekendReadinessCalled = true;
      throw new Error("weekend delivery dates must skip before readiness loading");
    },
    getSalespersonContactMap: async () => {
      throw new Error("weekend delivery dates must skip before salesperson lookup");
    },
  });
  const weekendReport = weekendSummary.eventReports[0];
  assert(weekendFlags.queried, "weekend delivery-date validation queries known DB groups", failures);
  assert(weekendFlags.dedupeChecked, "weekend delivery-date validation checks dedupe", failures);
  assert(!weekendImportCalled, "C106293 Saturday target skips before fresh import", failures);
  assert(!weekendPaymentCalled, "C106293 Saturday target skips before payment evaluation", failures);
  assert(!weekendReadinessCalled, "C106293 Saturday target skips before readiness loading", failures);
  assert(
    weekendSummary.deliveryGroupsSkippedWeekendDeliveryDate === 1,
    "C106293 Saturday target reports one weekend delivery-date skip",
    failures
  );
  assert(
    weekendSummary.skippedReasons.delivery_date_weekend === 1,
    "C106293 Saturday target uses delivery_date_weekend reason",
    failures
  );
  assert(
    weekendSummary.scheduledEvents === 0 && weekendReport?.status === "SKIPPED",
    "C106293 Saturday target is skipped, not scheduled",
    failures
  );
  assert(
    weekendReport?.orderNumber === "C106293" &&
      weekendReport.reasonSkipped === "delivery_date_weekend",
    "C106293 Saturday target report has delivery_date_weekend reason",
    failures
  );
  assert(
    weekendReport?.detailsLinkCreated === false &&
      weekendReport.detailsLinkReused === false &&
      weekendReport.detailsLinkTokenPresent === false,
    "C106293 Saturday target does not create or reuse details links",
    failures
  );

  const qualifiedFlags = { queried: false, dedupeChecked: false };
  const qualifiedSummary = await create12DayDeliveryPaymentRequestEvents({
    runDate: "2026-07-22",
    dryRun: true,
    prismaClient: fakeClient([targetGroup()], qualifiedFlags) as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () => paymentEvaluation(),
    getReadiness: async () => ({
      orderDeliveryGroupId: "group_12",
      orderId: "order_12",
      orderType: "SO",
      orderNumber: "SO12",
      deliveryDate: "2026-08-03",
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
      lines: [
        {
          orderLineId: "line_12",
          lineNbr: 1,
          inventoryId: "TEST-ITEM",
          lineDescription: "Test item",
          itemType: "S",
          itemClass: "APPLIANCE",
          requestedOn: "2026-08-03",
          eta: "2026-07-25",
          orderQty: 1,
          openQty: 1,
          activeAllocatedQty: 1,
          allocationStatus: "allocated",
          etaStatus: "ready",
          readinessStatus: "ready",
          displayStatus: "Ready",
          allocationCount: 1,
          allocationRowsCompact: ["1"],
          activeAllocationCount: 1,
          completedAllocationCount: 0,
        },
      ],
    }),
    getSalespersonContactMap: async () => new Map(),
  });

  const report = qualifiedSummary.eventReports[0];
  assert(
    qualifiedSummary.eventsWouldCreate === 1 && report?.status === "SCHEDULED",
    "balance greater than zero qualifies as a scheduled dry-run event",
    failures
  );
  assert(
    report?.dedupeKey ===
      "delivery_notification:SO:SO12:2026-08-03:DAY_12:PAYMENT_REQUEST",
    "dedupe key uses DAY_12 and PAYMENT_REQUEST",
    failures
  );
  assert(
    report?.amountDueNowRounded === "170.00",
    "12-day report uses delivery-group-specific amount due",
    failures
  );
  assert(
    report?.paymentDeadlineDate === "2026-07-24",
    "12-day report includes adjusted 8-day deadline",
    failures
  );
}

async function main() {
  const failures: string[] = [];
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const create12DayModule = await import(
    "../lib/notifications/create12DayDeliveryPaymentRequestEvents"
  );
  const {
    DELIVERY_PAYMENT_REQUEST_12_DAY_SKIP_REASONS,
    get12DayPaymentSkipReason,
    isOrderExcludedBy12DayFailedImport,
    normalize12DayConfirmVia,
  } = create12DayModule;
  const service = read("lib/notifications/create12DayDeliveryPaymentRequestEvents.ts");
  const helper = read("lib/notifications/helpers.ts");
  const renderer = read("lib/notifications/deliveryPaymentReminder12Day.ts");
  const script = read("scripts/create-12-day-delivery-payment-request-events.ts");
  const manualHarness = read("scripts/manual-demo/test-interval-emails-with-salesperson.ts");
  const detailsSafety = read("scripts/validate-delivery-details-link-safety.ts");
  const thirty = read("lib/notifications/create30DayDeliveryReminderEvents.ts");
  const fourteen = read("lib/notifications/create14DayDeliveryReminderEvents.ts");
  const fortyTwo = read("lib/notifications/create42DayDeliveryConfirmationEvents.ts");

  const importIndex = service.indexOf("summary.importResult = await importSalesOrders");
  const deliveryDateWeekendIndex = service.indexOf(
    "getDeliveryDateCustomerNotificationSkipReason(targetDeliveryDate)"
  );
  const queryIndex = service.indexOf(
    "const deliveryGroups = await find12DayDeliveryPaymentRequestTargetGroups"
  );

  assertIncludes(service, "NotificationIntervalType.DAY_12", "DAY_12 is used", failures);
  assertIncludes(
    service,
    "NotificationActionType.PAYMENT_REQUEST",
    "PAYMENT_REQUEST is used",
    failures
  );
  assertNotIncludes(
    service,
    "NotificationActionType.DELIVERY_REMINDER",
    "12-day service must not use DELIVERY_REMINDER",
    failures
  );
  assert(
    deliveryDateWeekendIndex >= 0 && importIndex > deliveryDateWeekendIndex && importIndex < queryIndex,
    "fresh import occurs only after weekend delivery-date eligibility check",
    failures
  );
  assertIncludes(
    helper,
    "DELIVERY_DATE_WEEKEND_SKIP_REASON = \"delivery_date_weekend\"",
    "shared helper defines delivery_date_weekend",
    failures
  );
  assertIncludes(
    service,
    "DELIVERY_DATE_WEEKEND_SKIP_REASON",
    "12-day skip map uses shared weekend delivery-date reason",
    failures
  );
  assertIncludes(
    service,
    "deliveryGroupsSkippedWeekendDeliveryDate",
    "12-day summary reports weekend delivery-date skips",
    failures
  );
  assertIncludes(
    service,
    "detailsLinkId: null",
    "12-day weekend delivery-date dedupe branch detaches details links",
    failures
  );
  assertIncludes(
    service,
    "isOrderExcludedBy12DayFailedImport",
    "per-order failed imports are excluded from stale evaluation",
    failures
  );
  assertIncludes(
    service,
    "getDeliveryGroupPaymentEvaluation",
    "delivery-group-specific payment helper is used",
    failures
  );
  assertIncludes(
    service,
    "loadReadiness(deliveryGroup.id)",
    "current delivery-group item readiness is used",
    failures
  );
  assertIncludes(
    service,
    "ensureDeliveryDetailsLink",
    "readonly details link is reused",
    failures
  );

  for (const reason of Object.values(DELIVERY_PAYMENT_REQUEST_12_DAY_SKIP_REASONS)) {
    if (reason === "delivery_date_weekend") {
      assertIncludes(
        service,
        "DELIVERY_DATE_WEEKEND_SKIP_REASON",
        `skip reason ${reason} is implemented`,
        failures
      );
    } else {
      assertIncludes(service, reason, `skip reason ${reason} is implemented`, failures);
    }
  }

  assert(normalize12DayConfirmVia(null) === null, "null confirmVia is not confirmed", failures);
  assert(normalize12DayConfirmVia("") === null, "blank confirmVia is not confirmed", failures);
  assert(
    normalize12DayConfirmVia("   ") === null,
    "whitespace confirmVia is not confirmed",
    failures
  );
  assert(
    normalize12DayConfirmVia(" AUTOTXT ") === "AUTOTXT",
    "any non-empty confirmVia qualifies",
    failures
  );

  for (const paymentTerms of ["PIF", "PP", "PPP", "PPT", " pp "]) {
    assert(
      get12DayPaymentSkipReason({
        hasOrderTotal: true,
        paymentTerms,
        unpaidBalance: "10.00",
        paymentStatus: "balance_due",
        amountDueNowRounded: "1.00",
        calculationWarnings: [],
      }) === null,
      `${paymentTerms} qualifies after term normalization`,
      failures
    );
  }
  for (const paymentTerms of [null, "", "   ", "N30NODEP"]) {
    assert(
      get12DayPaymentSkipReason({
        hasOrderTotal: true,
        paymentTerms,
        unpaidBalance: "10.00",
        paymentStatus: "balance_due",
        amountDueNowRounded: "1.00",
        calculationWarnings: [],
      }) === DELIVERY_PAYMENT_REQUEST_12_DAY_SKIP_REASONS.paymentTermsNotEligible,
      `${String(paymentTerms)} skips with payment_terms_not_eligible`,
      failures
    );
  }
  assert(
    get12DayPaymentSkipReason({
      hasOrderTotal: false,
      paymentTerms: null,
      unpaidBalance: null,
      paymentStatus: null,
      amountDueNowRounded: null,
    }) === DELIVERY_PAYMENT_REQUEST_12_DAY_SKIP_REASONS.missingOrderTotal,
    "missing OrderTotal maps to missing_order_total",
    failures
  );
  assert(
    get12DayPaymentSkipReason({
      hasOrderTotal: true,
      paymentTerms: "PP",
      unpaidBalance: null,
      paymentStatus: "calculation_blocked",
      amountDueNowRounded: null,
    }) === DELIVERY_PAYMENT_REQUEST_12_DAY_SKIP_REASONS.missingUnpaidBalance,
    "null unpaidBalance maps to missing_unpaid_balance",
    failures
  );
  assert(
    get12DayPaymentSkipReason({
      hasOrderTotal: true,
      paymentTerms: "PP",
      unpaidBalance: "10.00",
      paymentStatus: "no_balance_due",
      amountDueNowRounded: "0.00",
      calculationWarnings: [],
    }) === DELIVERY_PAYMENT_REQUEST_12_DAY_SKIP_REASONS.noBalanceDue,
    "zero balance maps to no_balance_due",
    failures
  );
  assert(
    isOrderExcludedBy12DayFailedImport({
      importResult: importResult({
        failedOrders: 1,
        errors: [
          {
            orderNumber: "SO12",
            orderType: "SO",
            reason: "SalesOrder import failed: timeout",
          },
        ],
      }),
      orderType: "SO",
      orderNumber: "SO12",
    }),
    "failed import matching order excludes stale data",
    failures
  );

  assertIncludes(
    renderer,
    "Balance Reminder:",
    "renderer prefixes existing reminder subject",
    failures
  );
  assertIncludes(
    renderer,
    "This is your second balance reminder.",
    "renderer includes second reminder copy",
    failures
  );
  assertIncludes(
    renderer,
    "Your balance must be handled by",
    "renderer includes dynamic deadline copy",
    failures
  );
  assertIncludes(
    renderer,
    "Balance owed prior to scheduling Delivery:",
    "renderer includes exact balance wording",
    failures
  );
  assertIncludes(
    renderer,
    "Reply STOP to opt out.",
    "SMS includes opt-out copy without confirmation language",
    failures
  );

  for (const forbidden of [
    "DeliveryConfirmation",
    "newDeliveryConfirmationLinkToken",
    "buildDeliveryConfirmationLink",
    "confirmDeliveryFromWebpage",
    "enqueueDeliveryConfirmationAttributeWriteback",
    "twilio.messages.create",
    "client.messages.create",
    "sendMail",
    "sendSms",
  ]) {
    assertNotIncludes(service, forbidden, `12-day service must not include ${forbidden}`, failures);
    assertNotIncludes(script, forbidden, `12-day script must not include ${forbidden}`, failures);
  }

  assertIncludes(manualHarness, '"12"', "manual harness supports --interval=12", failures);
  assertIncludes(
    manualHarness,
    "render12DayDeliveryPaymentReminderEmail",
    "manual harness renders dedicated 12-day email",
    failures
  );
  assertIncludes(
    manualHarness,
    "NOTIFICATIONS_TEST_EMAIL",
    "manual harness sends only to test email when --send is explicit",
    failures
  );
  assertIncludes(
    manualHarness,
    "getDeliveryDateCustomerNotificationSkipReason(targetDate)",
    "manual harness excludes weekend delivery dates before selecting 12-day candidates",
    failures
  );
  assertIncludes(
    detailsSafety,
    "details page must not include confirmation behavior",
    "details page readonly safety remains validated",
    failures
  );
  assertNotIncludes(
    thirty,
    "create12DayDeliveryPaymentRequestEvents",
    "30-day behavior remains unchanged",
    failures
  );
  assertNotIncludes(
    fourteen,
    "create12DayDeliveryPaymentRequestEvents",
    "14-day behavior remains unchanged",
    failures
  );
  assertNotIncludes(
    fortyTwo,
    "create12DayDeliveryPaymentRequestEvents",
    "42-day behavior remains unchanged",
    failures
  );

  await validateMockedRuntimeBehavior(failures, create12DayModule);

  if (failures.length > 0) {
    console.error("12-day notification creation validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "12-day notification creation validation passed. No live SMS/email, Acumatica write, provider dispatch, or DB write was performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
