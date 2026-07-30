import { readFileSync } from "fs";
import { join } from "path";

import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";

type Create2DayModule = typeof import("../lib/notifications/create2DayDeliveryReminderEvents");

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
    requestedOn: "2026-07-22T09:19:00.000Z",
    qualifyingOrdersFetched: 1,
    fullOrdersFetched: 1,
    contactsUpserted: 0,
    ordersCreated: 0,
    ordersUpdated: 1,
    totalsUpserted: 0,
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

function targetGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: "group_2",
    orderId: "order_2",
    orderType: "SO",
    orderNumber: "SO2",
    deliveryDate: new Date("2026-07-22T00:00:00.000Z"),
    isActive: true,
    lineCount: 1,
    lastSeenAt: new Date("2026-07-19T00:00:00.000Z"),
    status: "Open",
    tenDayConfirmation: {
      localConfirmed: true,
      acumaticaWritebackStatus: "WRITTEN",
      mismatchReason: null,
    },
    order: {
      id: "order_2",
      orderType: "SO",
      orderNumber: "SO2",
      status: "Open",
      internalLifecycleStatus: "ACTIVE",
      buyerGroup: "Builder",
      confirmVia: " WEBPAGE ",
      acumaticaOneWeekConfirmed: false,
      salespersonNumber: "123",
      customerDescription: "Jones Project",
      locationDescription: "Residence",
      address: {
        addressLine1: "123 Main",
        addressLine2: null,
        city: "Salt Lake City",
        state: "UT",
        postalCode: "84101",
      },
      contact: {
        contactId: "contact_2",
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

function withOrder(
  group: ReturnType<typeof targetGroup>,
  orderOverrides: Record<string, unknown>,
  contactOverrides: Record<string, unknown> = {}
) {
  return {
    ...group,
    order: {
      ...group.order,
      ...orderOverrides,
      contact: {
        ...group.order.contact,
        ...contactOverrides,
      },
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
        throw new Error("validation dryRun must not create delivery details links");
      },
      update: async () => {
        throw new Error("validation must not update delivery details links");
      },
    },
  };
}

async function validateMockedRuntimeBehavior(
  failures: string[],
  create2DayModule: Create2DayModule
) {
  const { create2DayDeliveryReminderEvents } = create2DayModule;

  let globalImportCalled = false;
  const globalFlags = { queried: false, dedupeChecked: false };
  try {
    await create2DayDeliveryReminderEvents({
      runDate: "2026-07-20",
      dryRun: true,
      prismaClient: fakeClient([], globalFlags) as never,
      importSalesOrders: async () => {
        globalImportCalled = true;
        throw new Error("global import unavailable");
      },
      getSalespersonContactMap: async () => new Map(),
    });
    assert(false, "global import failure should throw", failures);
  } catch (error) {
    assert(globalImportCalled, "global fresh import runs before qualification", failures);
    assert(
      error instanceof Error && error.message.includes("global import unavailable"),
      "global import failure is propagated",
      failures
    );
    assert(!globalFlags.queried, "global import failure stops before DB evaluation", failures);
  }

  let weekendImportCalled = false;
  const weekendRunFlags = { queried: false, dedupeChecked: false };
  const weekendRunSummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-07-25",
    dryRun: true,
    prismaClient: fakeClient([targetGroup()], weekendRunFlags) as never,
    importSalesOrders: async () => {
      weekendImportCalled = true;
      return importResult();
    },
    getSalespersonContactMap: async () => new Map(),
  });
  assert(weekendRunSummary.weekendSkipped, "weekend run date skips", failures);
  assert(!weekendImportCalled, "weekend run skips before import", failures);
  assert(!weekendRunFlags.queried, "weekend run skips before group query", failures);

  const perOrderFlags = { queried: false, dedupeChecked: false };
  const perOrderSummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([targetGroup()], perOrderFlags) as never,
    importSalesOrders: async () =>
      importResult({
        failedOrders: 1,
        errors: [
          {
            orderType: "SO",
            orderNumber: "SO2",
            reason: "Step 2 full SalesOrder fetch failed: timeout",
          },
        ],
      }),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(perOrderFlags.queried, "per-order import failure still allows group scan", failures);
  assert(
    !perOrderFlags.dedupeChecked,
    "per-order import failure excludes order before event dedupe",
    failures
  );
  assert(
    perOrderSummary.deliveryGroupsSkippedFailedImport === 1,
    "per-order import failure is reported as excluded",
    failures
  );
  assert(
    perOrderSummary.eventReports[0]?.status === "IMPORT_FAILED_EXCLUDED",
    "per-order failed import report avoids stale evaluation",
    failures
  );

  let weekendDeliveryImportCalled = false;
  const weekendDeliveryFlags = { queried: false, dedupeChecked: false };
  const weekendGroup = targetGroup({
    id: "group_weekend_2",
    orderId: "order_weekend_2",
    orderNumber: "SO2W",
    deliveryDate: new Date("2026-08-08T00:00:00.000Z"),
  });
  const weekendDeliverySummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-08-06",
    dryRun: true,
    prismaClient: fakeClient([weekendGroup], weekendDeliveryFlags) as never,
    importSalesOrders: async () => {
      weekendDeliveryImportCalled = true;
      return importResult();
    },
    getSalespersonContactMap: async () => {
      throw new Error("weekend delivery date should skip before salesperson lookup");
    },
  });
  assert(weekendDeliveryFlags.queried, "weekend delivery-date branch queries active groups", failures);
  assert(weekendDeliveryFlags.dedupeChecked, "weekend delivery-date branch checks dedupe", failures);
  assert(!weekendDeliveryImportCalled, "weekend delivery date skips before import", failures);
  assert(
    weekendDeliverySummary.deliveryGroupsSkippedWeekendDeliveryDate === 1,
    "weekend delivery date reports one skip",
    failures
  );
  assert(
    weekendDeliverySummary.skippedReasons.delivery_date_weekend === 1,
    "weekend delivery date uses delivery_date_weekend reason",
    failures
  );
  assert(
    weekendDeliverySummary.eventReports[0]?.reasonSkipped === "delivery_date_weekend",
    "weekend delivery date event report has delivery_date_weekend",
    failures
  );

  const missingConfirmFlags = { queried: false, dedupeChecked: false };
  const missingConfirmSummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([withOrder(targetGroup(), { confirmVia: "   " })], missingConfirmFlags) as never,
    importSalesOrders: async () => importResult(),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(
    missingConfirmSummary.deliveryGroupsSkippedNotConfirmedInAcumatica === 1,
    "blank CONFIRMVIA skips with not_confirmed_in_acumatica",
    failures
  );
  assert(
    missingConfirmSummary.eventReports[0]?.reasonSkipped === "not_confirmed_in_acumatica",
    "blank CONFIRMVIA report has not_confirmed_in_acumatica",
    failures
  );

  const missingOneWeekFlags = { queried: false, dedupeChecked: false };
  const missingOneWeekSummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([
      {
        ...targetGroup(),
        tenDayConfirmation: null,
        order: {
          ...targetGroup().order,
          acumaticaOneWeekConfirmed: true,
        },
      },
    ], missingOneWeekFlags) as never,
    importSalesOrders: async () => importResult(),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(
    missingOneWeekSummary.deliveryGroupsSkippedTenDayConfirmationMissing === 1,
    "Acumatica ONEWEEKCON true alone does not qualify without local 10-day confirmation",
    failures
  );
  assert(
    missingOneWeekSummary.eventReports[0]?.reasonSkipped === "one_week_confirmation_missing",
    "missing local 10-day confirmation skips with one_week_confirmation_missing",
    failures
  );

  const dryRunOneWeekSummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([
      {
        ...targetGroup(),
        tenDayConfirmation: {
          localConfirmed: false,
          acumaticaWritebackStatus: "DRY_RUN",
          mismatchReason: null,
        },
      },
    ], { queried: false, dedupeChecked: false }) as never,
    importSalesOrders: async () => importResult(),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(
    dryRunOneWeekSummary.eventReports[0]?.reasonSkipped === "one_week_confirmation_missing",
    "dry-run 10-day confirmation does not qualify 2-day",
    failures
  );

  const noChannelFlags = { queried: false, dedupeChecked: false };
  const noChannelSummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([
      withOrder(
        targetGroup(),
        {},
        { smsOptIn: false, emailOptIn: false, email: null, phone1: null, phone2: null }
      ),
    ], noChannelFlags) as never,
    importSalesOrders: async () => importResult(),
    getSalespersonContactMap: async () => new Map(),
  });
  assert(noChannelSummary.deliveryGroupsSkippedNoChannel === 1, "no channel skips", failures);
  assert(
    noChannelSummary.eventReports[0]?.reasonSkipped === "no_automated_channel_available",
    "no channel skip reason is no_automated_channel_available",
    failures
  );

  const smsFlags = { queried: false, dedupeChecked: false };
  const smsSummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([targetGroup()], smsFlags) as never,
    importSalesOrders: async (requestedOn) => {
      assert(
        requestedOn === "2026-07-22T09:19:00.000Z",
        "fresh import requestedOn uses runDate + 2 days",
        failures
      );
      return importResult();
    },
    getSalespersonContactMap: async () => new Map(),
  });
  const smsReport = smsSummary.eventReports[0];
  assert(smsSummary.targetDeliveryDate === "2026-07-22", "target date is runDate + 2", failures);
  assert(smsSummary.eventsWouldCreate === 1, "confirmed active group qualifies", failures);
  assert(smsReport?.status === "SCHEDULED", "qualified group schedules dry-run event", failures);
  assert(smsReport?.selectedChannel === "SMS", "SMS-first channel selection is used", failures);
  assert(
    smsReport?.dedupeKey === "delivery_notification:SO:SO2:2026-07-22:DAY_2:DELIVERY_REMINDER",
    "dedupe key includes DAY_2 and DELIVERY_REMINDER",
    failures
  );
  assert(
    Boolean(smsReport?.detailsLinkUrl?.includes("/delivery/details/")),
    "2-day preview uses delivery details link",
    failures
  );
  assert(
    !String(smsReport?.detailsLinkUrl).includes("/delivery/confirm/"),
    "2-day preview does not use delivery confirmation link",
    failures
  );

  const emailFlags = { queried: false, dedupeChecked: false };
  const emailSummary = await create2DayDeliveryReminderEvents({
    runDate: "2026-07-20",
    dryRun: true,
    prismaClient: fakeClient([
      withOrder(targetGroup(), {}, { smsOptIn: false, emailOptIn: true, phone1: null }),
    ], emailFlags) as never,
    importSalesOrders: async () => importResult(),
    getSalespersonContactMap: async () =>
      new Map([
        [
          "123",
          {
            salespersonName: "Jane Seller",
            salespersonEmail: "jane.seller@example.test",
            salespersonPhone: "8015553434",
            isActive: true,
          },
        ],
      ]),
  });
  const emailReport = emailSummary.eventReports[0];
  assert(emailReport?.selectedChannel === "EMAIL", "email fallback is used when SMS is unavailable", failures);
  assert(
    emailReport?.subject?.startsWith("Final Delivery Reminder:"),
    "email fallback renders final reminder subject",
    failures
  );
  assert(
    Boolean(emailReport?.renderedMessagePreview.includes("For additional information or to make changes")),
    "email fallback renders no-payment salesperson footer",
    failures
  );
}

async function main() {
  const failures: string[] = [];
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const create2DayModule = await import("../lib/notifications/create2DayDeliveryReminderEvents");
  const service = read("lib/notifications/create2DayDeliveryReminderEvents.ts");
  const renderer = read("lib/notifications/deliveryReminder2Day.ts");
  const script = read("scripts/create-2-day-delivery-reminder-events.ts");
  const manualHarness = read("scripts/manual-demo/test-interval-emails-with-salesperson.ts");
  const detailsHelper = read("lib/notifications/deliveryDetailsLinks.ts");
  const fourteen = read("lib/notifications/create14DayDeliveryReminderEvents.ts");
  const thirty = read("lib/notifications/create30DayDeliveryReminderEvents.ts");
  const twelve = read("lib/notifications/create12DayDeliveryPaymentRequestEvents.ts");
  const ten = read("lib/notifications/create10DayDeliveryPaymentRequestEvents.ts");
  const eight = read("lib/notifications/create8DayPaymentEnforcementEvents.ts");
  const fortyTwo = read("lib/notifications/create42DayDeliveryConfirmationEvents.ts");

  const importIndex = service.indexOf("summary.importResult = await importSalesOrders(importRequestedOn)");
  const queryIndex = service.indexOf("const deliveryGroups = await find2DayDeliveryReminderTargetGroups");

  assertIncludes(service, "DELIVERY_REMINDER_2_DAY_INTERVAL_DAYS = 2", "2-day interval is exactly 2 days", failures);
  assertIncludes(service, "NotificationIntervalType.DAY_2", "2-day service uses DAY_2", failures);
  assertIncludes(service, "NotificationActionType.DELIVERY_REMINDER", "2-day service uses DELIVERY_REMINDER", failures);
  assertNotIncludes(service, "NotificationActionType.PAYMENT_REQUEST", "2-day service must not use PAYMENT_REQUEST", failures);
  assertNotIncludes(service, "NotificationActionType.PAYMENT_ENFORCEMENT", "2-day service must not use PAYMENT_ENFORCEMENT", failures);
  assert(importIndex >= 0 && importIndex < queryIndex, "fresh import runs before qualification query", failures);
  assertIncludes(service, "isActive: true", "target query filters to active delivery groups only", failures);
  assertIncludes(service, "shouldSkipNotificationRunForWeekend(runDate)", "weekend run dates are skipped", failures);
  assertIncludes(service, "getDeliveryDateCustomerNotificationSkipReason(targetDeliveryDate)", "weekend delivery dates are checked", failures);
  assertIncludes(service, "DELIVERY_DATE_WEEKEND_SKIP_REASON", "delivery_date_weekend skip reason is reused", failures);
  assertIncludes(service, "get2DayFailedImportExclusions", "per-order failed import exclusions are collected", failures);
  assertIncludes(service, "isOrderExcludedBy2DayFailedImport", "per-order import failures are excluded", failures);
  assertIncludes(service, "normalize2DayConfirmVia(order.confirmVia)", "CONFIRMVIA is evaluated from imported order state", failures);
  assertIncludes(service, "not_confirmed_in_acumatica", "missing CONFIRMVIA uses not_confirmed_in_acumatica", failures);
  assertIncludes(service, "hasRequired2DayOneWeekConfirmation", "2-day requires local 10-day confirmation clearance", failures);
  assertIncludes(service, "one_week_confirmation_missing", "2-day records missing 10-day confirmation reason", failures);
  assertIncludes(service, "isCompleteTenDayConfirmationWritebackStatus", "2-day requires completed writeback status", failures);
  assertIncludes(service, "group.order.acumaticaOneWeekConfirmed === true", "2-day can accept imported Acumatica true only with local confirmation", failures);
  assertIncludes(service, "selectNotificationChannel(order.contact", "SMS-first/email fallback selection is used", failures);
  assertIncludes(service, "no_automated_channel_available", "no channel skip reason is implemented", failures);
  assertIncludes(service, "buildNotificationDedupeKey", "dedupe key helper is used", failures);
  assertIncludes(service, "intervalType: NotificationIntervalType.DAY_2", "created events use DAY_2", failures);
  assertIncludes(service, "actionType: NotificationActionType.DELIVERY_REMINDER", "created events use DELIVERY_REMINDER", failures);
  assertIncludes(service, "ensureDeliveryDetailsLink", "details links are created/reused", failures);
  assertIncludes(service, "buildDeliveryDetailsLink", "details link URL is rendered", failures);
  assertIncludes(script, "notificationAttemptsUnchanged", "script reports no NotificationAttempt changes", failures);
  assertIncludes(script, "deliveryConfirmationsUnchanged", "script reports no DeliveryConfirmation changes", failures);
  assertNotIncludes(detailsHelper, "/delivery/confirm/", "details helper does not build confirmation URLs", failures);

  for (const forbidden of [
    "getDeliveryGroupPaymentEvaluation",
    "getDeliveryGroupReadiness",
    "Payment may be needed",
    "Balance owed prior to scheduling Delivery",
    "paymentDeadline",
    "amountDueNow",
    "DeliveryConfirmation",
    "newDeliveryConfirmationLinkToken",
    "buildDeliveryConfirmationLink",
    "enqueueDeliveryPrepaymentHold",
    "DeliveryOrderHoldAction",
    "ACUMATICA_PREPAYMENT_HOLD",
    "notificationAttempt.create",
    "sendMail",
    "sendEmail",
    "sendSms",
    "twilio.messages.create",
    "client.messages.create",
  ]) {
    assertNotIncludes(service, forbidden, `2-day service must not include ${forbidden}`, failures);
  }

  assertIncludes(renderer, "Final Delivery Reminder:", "2-day renderer creates final-reminder subject", failures);
  assertIncludes(renderer, "This is your final reminder", "2-day renderer uses final-reminder wording", failures);
  assertIncludes(renderer, "View Delivery Details", "2-day renderer includes details link label", failures);
  assertNotIncludes(renderer, "To make a payment", "2-day renderer avoids global payment footer", failures);
  assertNotIncludes(renderer, "Items For This Delivery", "2-day renderer omits item section", failures);

  assertIncludes(manualHarness, '"2"', "manual one-email harness supports --interval=2", failures);
  assertIncludes(manualHarness, "render2DayDeliveryReminderEmail", "manual harness renders dedicated 2-day email", failures);
  assertIncludes(manualHarness, "NOTIFICATIONS_TEST_EMAIL", "manual harness sends only to configured test email when --send is explicit", failures);
  assertNotIncludes(manualHarness, "sendDemoSms", "manual one-email harness does not use demo SMS sender", failures);

  for (const [label, source] of [
    ["14-day", fourteen],
    ["30-day", thirty],
    ["12-day", twelve],
    ["10-day", ten],
    ["8-day", eight],
    ["42-day", fortyTwo],
  ] as const) {
    assertNotIncludes(source, "create2DayDeliveryReminderEvents", `${label} behavior does not import 2-day service`, failures);
    assertNotIncludes(source, "render2DayDeliveryReminder", `${label} behavior does not import 2-day renderer`, failures);
  }

  await validateMockedRuntimeBehavior(failures, create2DayModule);

  if (failures.length > 0) {
    console.error("2-day notification creation validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "2-day notification creation validation passed. No live SMS/email, provider dispatch, Acumatica write, or DB write was performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
