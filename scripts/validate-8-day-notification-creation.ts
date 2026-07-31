import { readFileSync } from "fs";
import { join } from "path";

import type { DeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";
import {
  DeliveryOrderHoldActionReason,
  DeliveryOrderHoldActionStatus,
  InternalNotificationPurpose,
  NotificationActionType,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import type { EnqueueDeliveryPrepaymentHoldResult } from "../lib/notifications/deliveryPrepaymentHoldQueue";

type Create8DayModule = typeof import("../lib/notifications/create8DayPaymentEnforcementEvents");

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
    requestedOn: "2026-07-29T09:19:00.000Z",
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

function paymentEvaluation(
  overrides: Partial<DeliveryGroupPaymentEvaluation> = {}
): DeliveryGroupPaymentEvaluation {
  return {
    orderDeliveryGroupId: "group_8",
    orderId: "order_8",
    orderType: "SO",
    orderNumber: "SO8",
    deliveryDate: "2026-07-29",
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
    payableStockValue: "400.00",
    assignedFreightDeliveryChargeValue: "0.00",
    newlyAssignedFreightDeliveryChargeValue: "0.00",
    payableBasisValue: "400.00",
    freightDeliveryChargeTodos: [],
    paymentApplicabilityStatus: "applicable",
    paymentStatus: "balance_due",
    urgencyStatus: "payment_required",
    calculationWarnings: [],
    lines: [],
    ...overrides,
  };
}

function targetGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: "group_8",
    orderId: "order_8",
    orderType: "SO",
    orderNumber: "SO8",
    deliveryDate: new Date("2026-07-29T00:00:00.000Z"),
    isActive: true,
    lineCount: 1,
    lastSeenAt: new Date("2026-07-21T00:00:00.000Z"),
    status: "Open",
    order: {
      id: "order_8",
      orderType: "SO",
      orderNumber: "SO8",
      status: "Open",
      internalLifecycleStatus: "ACTIVE",
      buyerGroup: "Appliances",
      confirmVia: " WEBPAGE ",
      salespersonNumber: "123",
      customerId: "CUST8",
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
        contactId: "contact_8",
        companyName: null,
        displayName: "James",
        firstName: "James",
        lastName: "Conte",
        email: "customer@example.test",
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

function noChannelGroup() {
  const group = targetGroup({
    id: "group_no_channel",
    orderId: "order_no_channel",
    orderNumber: "SO_NO_CHANNEL",
  });
  return {
    ...group,
    order: {
      ...group.order,
      id: "order_no_channel",
      orderNumber: "SO_NO_CHANNEL",
      contact: {
        ...group.order.contact,
        email: null,
        phone1: null,
        phone2: null,
        smsOptIn: false,
        emailOptIn: false,
      },
    },
  };
}

function weekendTargetGroup() {
  const group = targetGroup({
    id: "group_weekend",
    orderId: "order_weekend",
    orderNumber: "SO_WEEKEND",
    deliveryDate: new Date("2026-08-08T00:00:00.000Z"),
  });
  return {
    ...group,
    order: {
      ...group.order,
      id: "order_weekend",
      orderNumber: "SO_WEEKEND",
    },
  };
}

type FakeClientOptions = {
  groups: unknown[];
  existingHoldActions?: Array<Record<string, unknown>>;
  salespersonContacts?: Array<Record<string, unknown>>;
  flags?: Record<string, number | boolean | string[]>;
};

function fakeClient(options: FakeClientOptions) {
  const holdActions = [...(options.existingHoldActions ?? [])];
  const notificationEvents: Array<Record<string, unknown>> = [];
  const internalNotificationEvents: Array<Record<string, unknown>> = [];
  const detailsLinks: Array<Record<string, unknown>> = [];
  const flags = options.flags ?? {};

  function inc(name: string) {
    flags[name] = Number(flags[name] ?? 0) + 1;
  }

  function deliveryDateKey(value: unknown) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  }

  return {
    state: { holdActions, notificationEvents, internalNotificationEvents, detailsLinks, flags },
    client: {
      orderDeliveryGroup: {
        findMany: async () => {
          inc("findMany");
          return options.groups;
        },
      },
      deliveryOrderHoldAction: {
        findUnique: async (args: { where: Record<string, Record<string, unknown>> }) => {
          inc("holdFindUnique");
          const key = args.where.orderDeliveryGroupId_deliveryDate_reason;
          return (
            holdActions.find(
              (action) =>
                action.orderDeliveryGroupId === key.orderDeliveryGroupId &&
                deliveryDateKey(action.deliveryDate) === deliveryDateKey(key.deliveryDate) &&
                action.reason === key.reason
            ) ?? null
          );
        },
        create: async (args: { data: Record<string, unknown> }) => {
          inc("holdCreate");
          const action = {
            id: `hold_${holdActions.length + 1}`,
            queueJobId: null,
            errorMessage: null,
            acumaticaResponseSummary: null,
            customerNotificationEventId: null,
            ...args.data,
          };
          holdActions.push(action);
          return action;
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          inc("holdUpdate");
          const action = holdActions.find((candidate) => candidate.id === args.where.id);
          if (!action) throw new Error(`hold action missing ${args.where.id}`);
          Object.assign(action, args.data);
          return action;
        },
      },
      notificationEvent: {
        findUnique: async (args: { where: { dedupeKey: string } }) => {
          inc("eventFindUnique");
          return notificationEvents.find((event) => event.dedupeKey === args.where.dedupeKey) ?? null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          inc("eventCreate");
          const event = { id: `event_${notificationEvents.length + 1}`, ...args.data };
          notificationEvents.push(event);
          return event;
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          inc("eventUpdate");
          const event = notificationEvents.find((candidate) => candidate.id === args.where.id);
          if (!event) throw new Error(`event missing ${args.where.id}`);
          Object.assign(event, args.data);
          return event;
        },
      },
      deliveryDetailsLink: {
        findUnique: async (args: { where: Record<string, unknown> }) => {
          inc("detailsFindUnique");
          if (typeof args.where.id === "string") {
            return detailsLinks.find((link) => link.id === args.where.id) ?? null;
          }
          const key = args.where.orderDeliveryGroupId_deliveryDate as
            | Record<string, unknown>
            | undefined;
          if (!key) return null;
          return (
            detailsLinks.find(
              (link) =>
                link.orderDeliveryGroupId === key.orderDeliveryGroupId &&
                deliveryDateKey(link.deliveryDate) === deliveryDateKey(key.deliveryDate)
            ) ?? null
          );
        },
        create: async (args: { data: Record<string, unknown> }) => {
          inc("detailsCreate");
          const link = { id: `details_${detailsLinks.length + 1}`, token: "dd_validation", ...args.data };
          detailsLinks.push(link);
          return link;
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          inc("detailsUpdate");
          const link = detailsLinks.find((candidate) => candidate.id === args.where.id);
          if (!link) throw new Error(`details link missing ${args.where.id}`);
          Object.assign(link, args.data);
          return link;
        },
      },
      internalNotificationEvent: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          inc("internalFindFirst");
          return (
            internalNotificationEvents.find((event) =>
              Object.entries(args.where).every(([key, value]) => event[key] === value)
            ) ?? null
          );
        },
        create: async (args: { data: Record<string, unknown> }) => {
          inc("internalCreate");
          const event = { id: `internal_${internalNotificationEvents.length + 1}`, ...args.data };
          internalNotificationEvents.push(event);
          return event;
        },
      },
      salespersonContact: {
        findMany: async () => options.salespersonContacts ?? [],
      },
    },
  };
}

function queueResult(status: string, reason: string): EnqueueDeliveryPrepaymentHoldResult {
  return {
    jobId: `job_${status}`,
    payload: {
      orderType: "SO",
      orderNumber: "SO8",
      reason: "payment_not_received_by_deadline",
      dryRun: status === "dry_run",
    },
    result: {
      status,
      reason,
      dryRun: status === "dry_run",
      liveWriteEnabled: status !== "refused",
      allowedByOrderAllowlist: true,
      intendedHoldValue: true,
      wouldWrite: status !== "already_on_hold",
    },
  };
}

function mockEnqueuer(result: EnqueueDeliveryPrepaymentHoldResult) {
  return async (_params: unknown, options?: { onJobAccepted?: (jobId: string) => void | Promise<void> }) => {
    await options?.onJobAccepted?.(result.jobId);
    return result;
  };
}

async function validateMockedRuntime(
  failures: string[],
  create8DayModule: Create8DayModule
) {
  const {
    create8DayPaymentEnforcementEvents,
  } = create8DayModule;

  let importBeforeQuery = false;
  const importOrderFlags: Record<string, number | boolean | string[]> = {};
  const importOrderClient = fakeClient({ groups: [], flags: importOrderFlags });
  await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: true,
    prismaClient: importOrderClient.client as never,
    importSalesOrders: async () => {
      importBeforeQuery = true;
      return importResult();
    },
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: mockEnqueuer(queueResult("dry_run", "dry_run")) as never,
  });
  assert(importBeforeQuery, "fresh import runs before target evaluation", failures);
  assert(Number(importOrderFlags.findMany ?? 0) === 1, "DB group query happens after import", failures);

  const globalFlags: Record<string, number | boolean | string[]> = {};
  try {
    await create8DayPaymentEnforcementEvents({
      runDate: "2026-07-21",
      dryRun: true,
      prismaClient: fakeClient({ groups: [targetGroup()], flags: globalFlags }).client as never,
      importSalesOrders: async () => {
        throw new Error("global import unavailable");
      },
      getSalespersonContactMap: async () => new Map(),
      enqueueHoldJob: mockEnqueuer(queueResult("dry_run", "dry_run")) as never,
    });
    assert(false, "global import failure should throw", failures);
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("global import unavailable"),
      "global import failure propagates",
      failures
    );
    assert(Number(globalFlags.findMany ?? 0) === 0, "global import failure stops before DB evaluation", failures);
  }

  let paymentCalledForFailedImport = false;
  const perOrderFlags: Record<string, number | boolean | string[]> = {};
  const perOrderSummary = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: true,
    prismaClient: fakeClient({ groups: [targetGroup()], flags: perOrderFlags }).client as never,
    importSalesOrders: async () =>
      importResult({
        failedOrders: 1,
        errors: [
          {
            orderType: "SO",
            orderNumber: "SO8",
            reason: "Step 2 full SalesOrder fetch failed: timeout",
          },
        ],
      }),
    getPaymentEvaluation: async () => {
      paymentCalledForFailedImport = true;
      throw new Error("stale payment data should not be evaluated");
    },
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: mockEnqueuer(queueResult("dry_run", "dry_run")) as never,
  });
  assert(perOrderSummary.deliveryGroupsSkippedFailedImport === 1, "per-order import failure is excluded", failures);
  assert(!paymentCalledForFailedImport, "per-order import failure prevents payment evaluation", failures);

  let weekendImportCalled = false;
  let weekendPaymentCalled = false;
  const weekendSummary = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-31",
    dryRun: true,
    prismaClient: fakeClient({ groups: [weekendTargetGroup()] }).client as never,
    importSalesOrders: async () => {
      weekendImportCalled = true;
      return importResult();
    },
    getPaymentEvaluation: async () => {
      weekendPaymentCalled = true;
      return paymentEvaluation();
    },
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: mockEnqueuer(queueResult("dry_run", "dry_run")) as never,
  });
  assert(weekendSummary.deliveryGroupsSkippedWeekendDeliveryDate === 1, "weekend delivery date skips", failures);
  assert(weekendSummary.skippedReasons.delivery_date_weekend === 1, "weekend skip reason is delivery_date_weekend", failures);
  assert(!weekendImportCalled, "weekend delivery target skips before import", failures);
  assert(!weekendPaymentCalled, "weekend delivery target skips before payment evaluation", failures);

  let paymentGroupId: string | null = null;
  const dryRunStore = fakeClient({ groups: [targetGroup()] });
  const dryRunSummary = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: true,
    prismaClient: dryRunStore.client as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async (deliveryGroupId) => {
      paymentGroupId = deliveryGroupId;
      return paymentEvaluation();
    },
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: mockEnqueuer(queueResult("dry_run", "dry_run")) as never,
  });
  assert(paymentGroupId === "group_8", "multi-date safety uses current delivery group id for payment evaluation", failures);
  assert(dryRunSummary.eligibleDeliveryGroups === 1, "amount due greater than threshold qualifies", failures);
  assert(dryRunSummary.holdActionsCreated === 1, "new candidate creates PENDING hold action before queue", failures);
  assert(dryRunSummary.queueJobsAccepted === 1, "accepted queue job is recorded", failures);
  assert(dryRunSummary.holdActionsDryRun === 1, "dry_run result is recorded as non-success", failures);
  assert(dryRunSummary.customerEventsCreated === 0, "dry_run does not create customer event", failures);
  assert(dryRunSummary.internalEventsCreated === 0, "dry_run does not create internal event", failures);

  const successStore = fakeClient({
    groups: [targetGroup()],
    salespersonContacts: [
      {
        salespersonNumber: "123",
        salespersonName: "Sales Person",
        salespersonEmail: "sales@example.test",
        salespersonPhone: "8015551212",
        isActive: true,
      },
    ],
  });
  const successSummary = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: false,
    prismaClient: successStore.client as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () => paymentEvaluation(),
    getSalespersonContactMap: async () =>
      new Map([
        [
          "123",
          {
            salespersonName: "Sales Person",
            salespersonEmail: "sales@example.test",
            salespersonPhone: "8015551212",
            isActive: true,
          },
        ],
      ]),
    enqueueHoldJob: mockEnqueuer(queueResult("succeeded", "hold_written")) as never,
  });
  const successEvent = successStore.state.notificationEvents[0];
  assert(successSummary.holdActionsSucceeded === 1, "succeeded queue result marks hold action SUCCEEDED", failures);
  assert(successSummary.customerEventsCreated === 1, "customer event is created after hold success", failures);
  assert(successEvent?.intervalType === NotificationIntervalType.DAY_8, "customer event uses DAY_8", failures);
  assert(successEvent?.actionType === NotificationActionType.PAYMENT_ENFORCEMENT, "customer event uses PAYMENT_ENFORCEMENT", failures);
  assert(successEvent?.dedupeKey === "delivery_notification:SO:SO8:2026-07-29:DAY_8:PAYMENT_ENFORCEMENT", "dedupe key uses DAY_8 + PAYMENT_ENFORCEMENT", failures);
  assert(successEvent?.status === NotificationEventStatus.SCHEDULED, "customer event is scheduled, not provider sent", failures);
  assert(String(successEvent?.detailsLinkId ?? "").startsWith("details_"), "customer event has details link after success", failures);
  assert(successSummary.eventReports[0]?.detailsLinkUrl?.includes("/delivery/details/"), "details link uses /delivery/details/[token]", failures);
  assert(!successSummary.eventReports[0]?.detailsLinkUrl?.includes("/delivery/confirm/"), "details link does not use confirmation URL", failures);
  assert(successSummary.internalEventsCreated === 1, "hold success creates internal notification event", failures);
  assert(
    successStore.state.internalNotificationEvents[0]?.purpose ===
      InternalNotificationPurpose.PAYMENT_ENFORCEMENT_HOLD_SUCCEEDED,
    "internal success purpose is correct",
    failures
  );

  const noChannelStore = fakeClient({ groups: [noChannelGroup()] });
  const noChannelSummary = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: false,
    prismaClient: noChannelStore.client as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () => paymentEvaluation({ orderNumber: "SO_NO_CHANNEL" }),
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: mockEnqueuer(queueResult("already_on_hold", "already_on_hold")) as never,
  });
  assert(noChannelSummary.holdActionsSucceeded === 1, "already_on_hold result is idempotent success", failures);
  assert(noChannelSummary.customerEventsSkipped === 1, "no channel creates skipped customer event after hold success", failures);
  assert(noChannelStore.state.notificationEvents[0]?.reasonSkipped === "no_automated_channel_available", "no channel reason is recorded", failures);

  const refusedStore = fakeClient({ groups: [targetGroup()] });
  const refusedSummary = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: false,
    prismaClient: refusedStore.client as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () => paymentEvaluation(),
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: mockEnqueuer(queueResult("refused", "live_write_disabled")) as never,
  });
  assert(refusedSummary.holdActionsFailed === 1, "refused queue result marks FAILED", failures);
  assert(refusedSummary.customerEventsCreated === 0, "refused hold does not create customer event", failures);
  assert(refusedSummary.internalEventsCreated === 1, "hold failure creates internal failure notification event", failures);
  assert(
    refusedStore.state.internalNotificationEvents[0]?.purpose ===
      InternalNotificationPurpose.PAYMENT_ENFORCEMENT_HOLD_FAILED,
    "internal failure purpose is correct",
    failures
  );

  const pendingStore = fakeClient({
    groups: [targetGroup()],
    existingHoldActions: [
      {
        id: "hold_pending",
        orderDeliveryGroupId: "group_8",
        deliveryDate: new Date("2026-07-29T00:00:00.000Z"),
        reason: DeliveryOrderHoldActionReason.PAYMENT_NOT_RECEIVED_BY_DEADLINE,
        status: DeliveryOrderHoldActionStatus.QUEUED,
        queueJobId: "job_pending",
        errorMessage: null,
        acumaticaResponseSummary: null,
        customerNotificationEventId: null,
      },
    ],
  });
  const pendingSummary = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: false,
    prismaClient: pendingStore.client as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () => paymentEvaluation(),
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: async () => {
      throw new Error("pending/queued action must not enqueue duplicate job");
    },
  });
  assert(pendingSummary.holdActionsPendingOrQueued === 1, "pending/queued hold action is reported", failures);
  assert(pendingSummary.customerEventsCreated === 0, "pending/queued hold action does not create customer event", failures);

  const failedStore = fakeClient({
    groups: [targetGroup()],
    existingHoldActions: [
      {
        id: "hold_failed",
        orderDeliveryGroupId: "group_8",
        deliveryDate: new Date("2026-07-29T00:00:00.000Z"),
        reason: DeliveryOrderHoldActionReason.PAYMENT_NOT_RECEIVED_BY_DEADLINE,
        status: DeliveryOrderHoldActionStatus.FAILED,
        queueJobId: "job_failed",
        errorMessage: "previous failure",
        acumaticaResponseSummary: null,
        customerNotificationEventId: null,
      },
    ],
  });
  const failedSummary = await create8DayPaymentEnforcementEvents({
    runDate: "2026-07-21",
    dryRun: false,
    prismaClient: failedStore.client as never,
    importSalesOrders: async () => importResult(),
    getPaymentEvaluation: async () => paymentEvaluation(),
    getSalespersonContactMap: async () => new Map(),
    enqueueHoldJob: async () => {
      throw new Error("failed action must not retry by default");
    },
  });
  assert(failedSummary.holdActionsFailed === 1, "existing failed hold action is reported", failures);
  assert(failedSummary.customerEventsCreated === 0, "existing failed hold action does not create customer event", failures);
}

async function main() {
  const failures: string[] = [];
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  process.env.DELIVERY_PAYMENT_ENFORCEMENT_FALLBACK_EMAIL ||= "fallback@example.test";
  const create8DayModule = await import(
    "../lib/notifications/create8DayPaymentEnforcementEvents"
  );
  const {
    DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS,
    get8DayPaymentEnforcementSkipReason,
    isOrderExcludedBy8DayFailedImport,
    normalize8DayConfirmVia,
  } = create8DayModule;
  const service = read("lib/notifications/create8DayPaymentEnforcementEvents.ts");
  const queueHelper = read("lib/notifications/deliveryPrepaymentHoldQueue.ts");
  const script = read("scripts/create-8-day-payment-enforcement-events.ts");
  const ten = read("lib/notifications/create10DayDeliveryPaymentRequestEvents.ts");
  const twelve = read("lib/notifications/create12DayDeliveryPaymentRequestEvents.ts");
  const fourteen = read("lib/notifications/create14DayDeliveryReminderEvents.ts");
  const thirty = read("lib/notifications/create30DayDeliveryReminderEvents.ts");
  const fortyTwo = read("lib/notifications/create42DayDeliveryConfirmationEvents.ts");

  assertIncludes(service, "NotificationIntervalType.DAY_8", "DAY_8 is used", failures);
  assertIncludes(service, "NotificationActionType.PAYMENT_ENFORCEMENT", "PAYMENT_ENFORCEMENT is used", failures);
  assertNotIncludes(service, "NotificationActionType.PAYMENT_REQUEST", "8-day does not use PAYMENT_REQUEST", failures);
  assertIncludes(service, "summary.importResult = await importSalesOrders(importRequestedOn)", "fresh import is called", failures);
  assertIncludes(service, "isOrderExcludedBy8DayFailedImport", "per-order failed imports are excluded", failures);
  assertIncludes(service, "DeliveryOrderHoldActionReason.PAYMENT_NOT_RECEIVED_BY_DEADLINE", "hold action reason is fixed", failures);
  assertIncludes(queueHelper, "DELIVERY_PREPAYMENT_HOLD_ROUTE = \"/api/erp/jobs/delivery/prepayment-hold\"", "mld-queue hold route is used", failures);

  for (const reason of Object.values(DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS)) {
    if (reason === "delivery_date_weekend") {
      assertIncludes(
        service,
        "DELIVERY_DATE_WEEKEND_SKIP_REASON",
        `skip/failure reason ${reason} is implemented`,
        failures
      );
    } else {
      assertIncludes(service, reason, `skip/failure reason ${reason} is implemented`, failures);
    }
  }

  assert(normalize8DayConfirmVia(null) === null, "null confirmVia is not confirmed", failures);
  assert(normalize8DayConfirmVia("   ") === null, "blank confirmVia is not confirmed", failures);
  assert(normalize8DayConfirmVia(" WEBPAGE ") === "WEBPAGE", "populated confirmVia qualifies", failures);

  for (const paymentTerms of ["PIF", "PP", "PPP", "PPT", " pp "]) {
    assert(
      get8DayPaymentEnforcementSkipReason({
        hasOrderTotal: true,
        paymentTerms,
        unpaidBalance: "10.00",
        paymentStatus: "balance_due",
        amountDueNowRounded: "2.01",
        calculationWarnings: [],
      }) === null,
      `${paymentTerms} qualifies after term normalization`,
      failures
    );
  }
  assert(
    get8DayPaymentEnforcementSkipReason({
      hasOrderTotal: true,
      paymentTerms: "N30",
      unpaidBalance: "10.00",
      paymentStatus: "balance_due",
      amountDueNowRounded: "10.00",
      calculationWarnings: [],
    }) === DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.paymentTermsNotEligible,
    "ineligible terms skip with payment_terms_not_eligible",
    failures
  );
  assert(
    get8DayPaymentEnforcementSkipReason({
      hasOrderTotal: false,
      paymentTerms: "PP",
      unpaidBalance: "10.00",
      paymentStatus: "balance_due",
      amountDueNowRounded: "10.00",
    }) === DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.missingOrderTotal,
    "missing OrderTotal skips with missing_order_total",
    failures
  );
  assert(
    get8DayPaymentEnforcementSkipReason({
      hasOrderTotal: true,
      paymentTerms: "PP",
      unpaidBalance: null,
      paymentStatus: "calculation_blocked",
      amountDueNowRounded: null,
    }) === DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.missingUnpaidBalance,
    "null unpaidBalance skips with missing_unpaid_balance",
    failures
  );
  assert(
    get8DayPaymentEnforcementSkipReason({
      hasOrderTotal: true,
      paymentTerms: "PP",
      unpaidBalance: "500.00",
      paymentStatus: "balance_due",
      amountDueNowRounded: "2.00",
      calculationWarnings: [],
    }) === DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.noBalanceDue,
    "amount due <= threshold skips with no_balance_due",
    failures
  );
  assert(
    isOrderExcludedBy8DayFailedImport({
      importResult: importResult({
        failedOrders: 1,
        errors: [{ orderType: "SO", orderNumber: "SO8", reason: "SalesOrder import failed" }],
      }),
      orderType: "SO",
      orderNumber: "SO8",
    }),
    "failed import matching order excludes stale data",
    failures
  );

  for (const forbidden of [
    "notificationAttempt.create",
    "twilio.messages.create",
    "client.messages.create",
    "sendMail",
    "sendSms",
    "Hold: { value: false }",
    "requestedOn:",
    "OrderLine",
  ]) {
    assertNotIncludes(service, forbidden, `8-day service must not include ${forbidden}`, failures);
  }
  assertIncludes(script, "dryRun = true", "8-day script defaults dry-run", failures);
  assertIncludes(script, "noCustomerEmailSent: true", "script reports no customer email sent", failures);
  assertIncludes(script, "noInternalEmailSent: true", "script reports no internal email sent", failures);
  assertIncludes(script, "noSmsSent: true", "script reports no SMS sent", failures);

  assertIncludes(ten, "NotificationActionType.PAYMENT_REQUEST", "10-day remains PAYMENT_REQUEST", failures);
  assertIncludes(twelve, "NotificationActionType.PAYMENT_REQUEST", "12-day remains PAYMENT_REQUEST", failures);
  assertNotIncludes(fourteen, "create8DayPaymentEnforcementEvents", "14-day behavior unchanged", failures);
  assertNotIncludes(thirty, "create8DayPaymentEnforcementEvents", "30-day behavior unchanged", failures);
  assertNotIncludes(fortyTwo, "create8DayPaymentEnforcementEvents", "42-day behavior unchanged", failures);

  await validateMockedRuntime(failures, create8DayModule);

  if (failures.length > 0) {
    console.error("8-day notification creation validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        validation: "8-day notification creation validation passed",
        day8PaymentEnforcementUsed: true,
        paymentRequestNotUsed: true,
        freshImportBeforeQualification: true,
        perOrderImportFailureExcluded: true,
        customerEventOnlyAfterHoldSuccess: true,
        noNotificationAttemptsCreated: true,
        noProviderSends: true,
        noLiveAcumaticaWrite: true,
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
