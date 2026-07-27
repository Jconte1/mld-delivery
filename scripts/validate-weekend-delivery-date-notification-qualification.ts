import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  DELIVERY_DATE_WEEKEND_SKIP_REASON,
  getDeliveryDateCustomerNotificationSkipReason,
  isEligibleDeliveryDateForCustomerNotification,
  shouldSkipNotificationRunForWeekend,
} from "../lib/notifications/helpers";

type CreatedEvent = {
  id: string;
  dedupeKey: string;
  intervalType: string;
  actionType: string;
  status: string;
  selectedChannel: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  reasonSkipped: string | null;
  detailsLinkId: string | null;
};

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function read(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function targetGroup(params: {
  deliveryDate: string;
  orderNumber: string;
  id?: string;
}) {
  const id = params.id ?? `group_${params.orderNumber}`;
  return {
    id,
    orderId: `order_${params.orderNumber}`,
    orderType: "SO",
    orderNumber: params.orderNumber,
    deliveryDate: new Date(`${params.deliveryDate}T00:00:00.000Z`),
    isActive: true,
    lineCount: 1,
    lastSeenAt: new Date("2026-07-01T00:00:00.000Z"),
    status: "Open",
    deliveryConfirmations: [],
    order: {
      id: `order_${params.orderNumber}`,
      orderType: "SO",
      orderNumber: params.orderNumber,
      status: "Open",
      internalLifecycleStatus: "ACTIVE",
      buyerGroup: "Appliances",
      confirmVia: "WEBPAGE",
      salespersonNumber: "123",
      customerDescription: "Weekend Fixture",
      locationDescription: "Main",
      total: {
        paymentTerms: "PP",
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
        contactId: `contact_${params.orderNumber}`,
        companyName: null,
        displayName: "Validation Customer",
        firstName: "Validation",
        lastName: "Customer",
        email: "validation@example.test",
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

function fakeClient(groups: unknown[], flags: Record<string, number>) {
  const createdEvents: CreatedEvent[] = [];

  function eventFromData(data: Record<string, unknown>): CreatedEvent {
    return {
      id: `event_${createdEvents.length + 1}`,
      dedupeKey: String(data.dedupeKey),
      intervalType: String(data.intervalType),
      actionType: String(data.actionType),
      status: String(data.status),
      selectedChannel: (data.selectedChannel as string | null | undefined) ?? null,
      recipientEmail: (data.recipientEmail as string | null | undefined) ?? null,
      recipientPhone: (data.recipientPhone as string | null | undefined) ?? null,
      reasonSkipped: (data.reasonSkipped as string | null | undefined) ?? null,
      detailsLinkId: (data.detailsLinkId as string | null | undefined) ?? null,
    };
  }

  return {
    createdEvents,
    client: {
      orderDeliveryGroup: {
        findMany: async () => {
          flags.groupQueries = (flags.groupQueries ?? 0) + 1;
          return groups;
        },
      },
      notificationEvent: {
        findUnique: async () => {
          flags.eventDedupeChecks = (flags.eventDedupeChecks ?? 0) + 1;
          return null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          flags.eventCreates = (flags.eventCreates ?? 0) + 1;
          const event = eventFromData(data);
          createdEvents.push(event);
          return event;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          flags.eventUpdates = (flags.eventUpdates ?? 0) + 1;
          const event = eventFromData(data);
          createdEvents.push(event);
          return event;
        },
      },
      deliveryDetailsLink: {
        findUnique: async () => {
          flags.detailsLinkReads = (flags.detailsLinkReads ?? 0) + 1;
          throw new Error("weekend delivery-date validation must not read details links");
        },
        create: async () => {
          flags.detailsLinkCreates = (flags.detailsLinkCreates ?? 0) + 1;
          throw new Error("weekend delivery-date validation must not create details links");
        },
        update: async () => {
          flags.detailsLinkUpdates = (flags.detailsLinkUpdates ?? 0) + 1;
          throw new Error("weekend delivery-date validation must not update details links");
        },
      },
      deliveryConfirmation: {
        findUnique: async () => {
          flags.confirmationReads = (flags.confirmationReads ?? 0) + 1;
          throw new Error("weekend delivery-date validation must not read confirmation links");
        },
        upsert: async () => {
          flags.confirmationUpserts = (flags.confirmationUpserts ?? 0) + 1;
          throw new Error("weekend delivery-date validation must not create confirmation links");
        },
        create: async () => {
          flags.confirmationCreates = (flags.confirmationCreates ?? 0) + 1;
          throw new Error("weekend delivery-date validation must not create confirmation links");
        },
        update: async () => {
          flags.confirmationUpdates = (flags.confirmationUpdates ?? 0) + 1;
          throw new Error("weekend delivery-date validation must not update confirmation links");
        },
      },
    },
  };
}

function assertWeekendEvent(
  event: CreatedEvent | undefined,
  intervalType: string,
  message: string,
  failures: string[]
) {
  assert(event, `${message}: skipped event was created`, failures);
  assert(event?.intervalType === intervalType, `${message}: interval type is ${intervalType}`, failures);
  assert(
    event?.status === NotificationEventStatus.SKIPPED,
    `${message}: event status is SKIPPED`,
    failures
  );
  assert(
    event?.reasonSkipped === DELIVERY_DATE_WEEKEND_SKIP_REASON,
    `${message}: reason is delivery_date_weekend`,
    failures
  );
  assert(event?.selectedChannel === null, `${message}: no selected channel`, failures);
  assert(event?.recipientEmail === null, `${message}: no recipient email`, failures);
  assert(event?.recipientPhone === null, `${message}: no recipient phone`, failures);
  assert(event?.detailsLinkId === null, `${message}: no details link id`, failures);
}

async function main() {
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";

  const failures: string[] = [];
  const [
    deliveryReminderModule,
    confirmation42Module,
    confirmedReminderModule,
    payment12Module,
  ] = await Promise.all([
    import("../lib/notifications/createDeliveryReminderEvents"),
    import("../lib/notifications/create42DayDeliveryConfirmationEvents"),
    import("../lib/notifications/create30DayDeliveryReminderEvents"),
    import("../lib/notifications/create12DayDeliveryPaymentRequestEvents"),
  ]);

  const saturday = "2026-08-08";
  const sunday = "2026-08-09";
  const friday = "2026-08-07";

  assert(
    getDeliveryDateCustomerNotificationSkipReason(saturday) ===
      DELIVERY_DATE_WEEKEND_SKIP_REASON,
    "Saturday delivery date maps to delivery_date_weekend",
    failures
  );
  assert(
    getDeliveryDateCustomerNotificationSkipReason(sunday) === DELIVERY_DATE_WEEKEND_SKIP_REASON,
    "Sunday delivery date maps to delivery_date_weekend",
    failures
  );
  assert(
    isEligibleDeliveryDateForCustomerNotification(friday),
    "Friday delivery date remains eligible",
    failures
  );
  assert(
    shouldSkipNotificationRunForWeekend(saturday) &&
      shouldSkipNotificationRunForWeekend(sunday),
    "existing weekend run skip helper remains true for Saturday/Sunday run dates",
    failures
  );

  for (const [label, runDate, deliveryDate] of [
    ["180-day Saturday", "2026-02-09", saturday],
    ["180-day Sunday", "2026-02-10", sunday],
  ] as const) {
    const flags: Record<string, number> = {};
    const { client, createdEvents } = fakeClient(
      [targetGroup({ deliveryDate, orderNumber: `${label.replace(/\W/g, "_")}` })],
      flags
    );
    const summary = await deliveryReminderModule.createDeliveryReminderEvents({
      runDate,
      intervalDays: 180,
      intervalType: NotificationIntervalType.DAY_180,
      prismaClient: client as never,
    });
    assert(summary.eligibleDeliveryGroups === 0, `${label}: not eligible`, failures);
    assert(
      summary.deliveryGroupsSkippedWeekendDeliveryDate === 1,
      `${label}: reports weekend delivery-date skip`,
      failures
    );
    assert(
      summary.skippedReasons[DELIVERY_DATE_WEEKEND_SKIP_REASON] === 1,
      `${label}: records skip reason`,
      failures
    );
    assertWeekendEvent(createdEvents[0], NotificationIntervalType.DAY_180, label, failures);
  }

  for (const [label, runDate, deliveryDate] of [
    ["42-day Saturday", "2026-06-27", saturday],
    ["42-day Sunday", "2026-06-28", sunday],
  ] as const) {
    const flags: Record<string, number> = {};
    const { client, createdEvents } = fakeClient(
      [targetGroup({ deliveryDate, orderNumber: `${label.replace(/\W/g, "_")}` })],
      flags
    );
    const summary = await confirmation42Module.create42DayDeliveryConfirmationEvents({
      runDate,
      prismaClient: client as never,
    });
    const report = summary.eventReports[0];
    assert(
      summary.deliveryGroupsSkippedWeekendDeliveryDate === 1,
      `${label}: reports weekend delivery-date skip`,
      failures
    );
    assert(report?.linkTokenPresent === false, `${label}: no confirmation link token`, failures);
    assert(report?.confirmationState === null, `${label}: no confirmation state`, failures);
    assert((flags.confirmationReads ?? 0) === 0, `${label}: confirmation links not read`, failures);
    assertWeekendEvent(createdEvents[0], NotificationIntervalType.DAY_42, label, failures);
  }

  for (const [label, runDate, deliveryDate, intervalType, intervalDays] of [
    ["30-day Saturday", "2026-07-09", saturday, NotificationIntervalType.DAY_30, 30],
    ["30-day Sunday", "2026-07-10", sunday, NotificationIntervalType.DAY_30, 30],
  ] as const) {
    const flags: Record<string, number> = {};
    const { client, createdEvents } = fakeClient(
      [targetGroup({ deliveryDate, orderNumber: `${label.replace(/\W/g, "_")}` })],
      flags
    );
    const summary = await confirmedReminderModule.createConfirmedDeliveryReminderEvents({
      runDate,
      intervalType,
      intervalDays,
      prismaClient: client as never,
    });
    const report = summary.eventReports[0];
    assert(
      summary.deliveryGroupsSkippedWeekendDeliveryDate === 1,
      `${label}: reports weekend delivery-date skip`,
      failures
    );
    assert(report?.detailsLinkTokenPresent === false, `${label}: no details link token`, failures);
    assert((flags.detailsLinkCreates ?? 0) === 0, `${label}: details links not created`, failures);
    assertWeekendEvent(createdEvents[0], intervalType, label, failures);
  }

  for (const [label, runDate, deliveryDate] of [
    ["12-day Saturday C106293", "2026-07-27", saturday],
    ["12-day Sunday", "2026-07-28", sunday],
  ] as const) {
    const flags: Record<string, number> = {};
    const orderNumber = label.includes("C106293") ? "C106293" : "SO12SUN";
    const { client, createdEvents } = fakeClient([targetGroup({ deliveryDate, orderNumber })], flags);
    let importCalled = false;
    let paymentCalled = false;
    let readinessCalled = false;
    const summary = await payment12Module.create12DayDeliveryPaymentRequestEvents({
      runDate,
      prismaClient: client as never,
      importSalesOrders: async () => {
        importCalled = true;
        throw new Error("weekend delivery-date skip must happen before import");
      },
      getPaymentEvaluation: async () => {
        paymentCalled = true;
        throw new Error("weekend delivery-date skip must happen before payment evaluation");
      },
      getReadiness: async () => {
        readinessCalled = true;
        throw new Error("weekend delivery-date skip must happen before readiness loading");
      },
      getSalespersonContactMap: async () => new Map(),
    });
    const report = summary.eventReports[0];
    assert(!importCalled, `${label}: no import`, failures);
    assert(!paymentCalled, `${label}: no payment evaluation`, failures);
    assert(!readinessCalled, `${label}: no readiness loading`, failures);
    assert(
      summary.deliveryGroupsSkippedWeekendDeliveryDate === 1,
      `${label}: reports weekend delivery-date skip`,
      failures
    );
    assert(report?.orderNumber === orderNumber, `${label}: expected order report`, failures);
    assert(report?.detailsLinkTokenPresent === false, `${label}: no details link token`, failures);
    assertWeekendEvent(createdEvents[0], NotificationIntervalType.DAY_12, label, failures);
  }

  const weekdayFlags: Record<string, number> = {};
  const { client: weekdayClient, createdEvents: weekdayEvents } = fakeClient(
    [targetGroup({ deliveryDate: "2026-08-10", orderNumber: "SO-WEEKDAY" })],
    weekdayFlags
  );
  const weekdaySummary = await deliveryReminderModule.createDeliveryReminderEvents({
    runDate: "2026-02-11",
    intervalDays: 180,
    intervalType: NotificationIntervalType.DAY_180,
    prismaClient: weekdayClient as never,
  });
  assert(weekdaySummary.eligibleDeliveryGroups === 1, "weekday delivery remains eligible", failures);
  assert(weekdaySummary.eventsSkipped === 0, "weekday delivery is not skipped", failures);
  assert(
    weekdayEvents[0]?.status === NotificationEventStatus.SCHEDULED,
    "weekday delivery can schedule when other rules pass",
    failures
  );

  const weekendRunFlags: Record<string, number> = {};
  const { client: weekendRunClient } = fakeClient(
    [targetGroup({ deliveryDate: saturday, orderNumber: "SO-WEEKEND-RUN" })],
    weekendRunFlags
  );
  const weekendRunSummary = await confirmedReminderModule.createConfirmedDeliveryReminderEvents({
    runDate: "2026-07-25",
    intervalType: NotificationIntervalType.DAY_14,
    intervalDays: 14,
    prismaClient: weekendRunClient as never,
  });
  assert(weekendRunSummary.weekendSkipped, "existing weekend run skip remains for 14-day", failures);
  assert((weekendRunFlags.groupQueries ?? 0) === 0, "weekend run skip stops before DB query", failures);

  const confirmedSource = read("lib/notifications/create30DayDeliveryReminderEvents.ts");
  const fourteenSource = read("lib/notifications/create14DayDeliveryReminderEvents.ts");
  const manualHarness = read("scripts/manual-demo/test-interval-emails-with-salesperson.ts");
  const manualSkipIndex = manualHarness.indexOf(
    "getDeliveryDateCustomerNotificationSkipReason(targetDate)"
  );
  const manualImportIndex = manualHarness.indexOf("importSalesOrdersForLineRequestedOn(requestedOn)");
  const manualSelectIndex = manualHarness.indexOf("const selected = await selectDeliveryGroup");
  assert(
    fourteenSource.includes("createConfirmedDeliveryReminderEvents") &&
      confirmedSource.includes("getDeliveryDateCustomerNotificationSkipReason(targetDeliveryDate)"),
    "14-day uses shared confirmed-reminder weekend delivery-date rule",
    failures
  );
  assert(
    getDeliveryDateCustomerNotificationSkipReason(saturday) ===
      DELIVERY_DATE_WEEKEND_SKIP_REASON &&
      getDeliveryDateCustomerNotificationSkipReason(sunday) === DELIVERY_DATE_WEEKEND_SKIP_REASON,
    "14-day Saturday/Sunday delivery dates map to the shared skip reason",
    failures
  );
  assert(
    manualSkipIndex >= 0 &&
      manualImportIndex > manualSkipIndex &&
      manualSelectIndex > manualSkipIndex,
    "manual harness skips weekend delivery dates before import or candidate selection",
    failures
  );

  if (failures.length > 0) {
    console.error("Weekend delivery-date notification qualification validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        weekendDeliveryDateSkipReason: DELIVERY_DATE_WEEKEND_SKIP_REASON,
        saturdayDeliveryDateSkipped: true,
        sundayDeliveryDateSkipped: true,
        weekdayDeliveryDateStillQualifies: true,
        manualHarnessExcludesWeekendDeliveryDates: true,
        detailsLinksCreatedForWeekendSkips: false,
        confirmationLinksCreatedForWeekendSkips: false,
        liveSmsSent: false,
        liveEmailSent: false,
        acumaticaWritePerformed: false,
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
