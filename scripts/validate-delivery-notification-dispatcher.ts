import { readFileSync } from "fs";
import path from "path";

import {
  InternalOrderLifecycleStatus,
} from "../lib/generated/prisma/client";
import { create42DayDeliveryConfirmationEvents } from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import { evaluateDeliveryDispatcherPreflight } from "../lib/notifications/deliveryNotificationDispatcher";
import { handleTwilioMessageStatus } from "../lib/notifications/handleTwilioMessageStatus";
import { dateFromKey } from "../lib/notifications/helpers";

const projectRoot = process.cwd();

function read(relativePath: string) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function includes(source: string, pattern: string) {
  return source.includes(pattern);
}

type FakeAttempt = {
  id: string;
  notificationEventId: string;
  attemptNumber: number;
  channel: "SMS" | "EMAIL";
  status: string;
  externalMessageId: string | null;
  provider?: string | null;
  providerCode?: string | null;
  httpStatus?: number | null;
  success?: boolean | null;
  errorMessage?: string | null;
  sentAt?: Date | null;
  createdAt: Date;
};

type FakeEvent = {
  id: string;
  status: string;
  provider?: string | null;
  externalMessageId?: string | null;
  sentAt?: Date | null;
  reasonFailed?: string | null;
  deliveryConfirmations: Array<{ id: string }>;
};

type FakeCallback = {
  id: string;
  callbackKey: string;
  messageSid: string;
  messageStatus: string;
  notificationAttemptId: string | null;
  notificationEventId: string | null;
  deliveryConfirmationId: string | null;
  matchStatus: string;
  processedAt: Date | null;
  [key: string]: unknown;
};

function cleanData<T extends Record<string, unknown>>(data: T) {
  return Object.fromEntries(
    Object.entries(data).filter((entry) => entry[1] !== undefined)
  ) as Partial<T>;
}

function matchesWhere(record: Record<string, unknown>, where: Record<string, unknown> = {}) {
  for (const [key, expected] of Object.entries(where)) {
    const actual = record[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const condition = expected as { in?: unknown[]; not?: unknown };
      if (condition.in && !condition.in.includes(actual)) return false;
      if ("not" in condition && actual === condition.not) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function pickFields<T extends Record<string, unknown>>(record: T, select?: Record<string, boolean>) {
  if (!select) return { ...record };
  return Object.fromEntries(
    Object.entries(select)
      .filter((entry) => entry[1])
      .map(([key]) => [key, record[key]])
  );
}

function createFakeStatusClient(params: {
  attempts?: FakeAttempt[];
  events?: FakeEvent[];
}) {
  const state = {
    attempts: params.attempts ?? [],
    events: params.events ?? [],
    callbacks: [] as FakeCallback[],
    deliveryConfirmationUpdates: 0,
  };

  const findEvent = (id: string) => state.events.find((event) => event.id === id) ?? null;

  const client = {
    twilioMessageStatusCallback: {
      findUnique: async (args: { where: { callbackKey: string }; select?: Record<string, boolean> }) => {
        const found = state.callbacks.find(
          (callback) => callback.callbackKey === args.where.callbackKey
        );
        return found ? pickFields(found, args.select) : null;
      },
      create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const callback: FakeCallback = {
          id: `callback_${state.callbacks.length + 1}`,
          callbackKey: String(args.data.callbackKey),
          messageSid: String(args.data.messageSid),
          messageStatus: String(args.data.messageStatus),
          notificationAttemptId: null,
          notificationEventId: null,
          deliveryConfirmationId: null,
          matchStatus: "UNPROCESSED",
          processedAt: null,
          ...args.data,
        };
        state.callbacks.push(callback);
        return pickFields(callback, args.select);
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        const callback = state.callbacks.find((item) => item.id === args.where.id);
        if (!callback) throw new Error(`Missing fake callback ${args.where.id}`);
        Object.assign(callback, cleanData(args.data));
        return pickFields(callback, args.select);
      },
    },
    notificationAttempt: {
      findFirst: async (args: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, string>;
        include?: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        const matches = state.attempts.filter((attempt) =>
          matchesWhere(attempt as unknown as Record<string, unknown>, args.where)
        );
        if (args.orderBy?.attemptNumber === "desc") {
          matches.sort((left, right) => right.attemptNumber - left.attemptNumber);
        } else {
          matches.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        }
        const found = matches[0];
        if (!found) return null;
        if (args.include?.notificationEvent) {
          return {
            ...found,
            notificationEvent: {
              ...findEvent(found.notificationEventId),
              deliveryConfirmations: findEvent(found.notificationEventId)?.deliveryConfirmations ?? [],
            },
          };
        }
        return pickFields(found as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const attempt = state.attempts.find((item) => item.id === args.where.id);
        if (!attempt) throw new Error(`Missing fake attempt ${args.where.id}`);
        Object.assign(attempt, cleanData(args.data));
        return attempt;
      },
      updateMany: async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const attempt of state.attempts) {
          if (!matchesWhere(attempt as unknown as Record<string, unknown>, args.where)) continue;
          Object.assign(attempt, cleanData(args.data));
          count += 1;
        }
        return { count };
      },
    },
    notificationEvent: {
      findFirst: async (args: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, string>;
        include?: Record<string, unknown>;
      }) => {
        const found = state.events.find((event) =>
          matchesWhere(event as unknown as Record<string, unknown>, args.where)
        );
        return found
          ? {
              ...found,
              deliveryConfirmations: found.deliveryConfirmations,
            }
          : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const event = findEvent(args.where.id);
        if (!event) throw new Error(`Missing fake event ${args.where.id}`);
        Object.assign(event, cleanData(args.data));
        return event;
      },
      updateMany: async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const event of state.events) {
          if (!matchesWhere(event as unknown as Record<string, unknown>, args.where)) continue;
          Object.assign(event, cleanData(args.data));
          count += 1;
        }
        return { count };
      },
    },
    deliveryConfirmation: {
      update: async () => {
        state.deliveryConfirmationUpdates += 1;
        return {};
      },
    },
  };

  return { client, state };
}

function fakeAttempt(params: Partial<FakeAttempt> & { id: string; externalMessageId: string }) {
  return {
    notificationEventId: "event_1",
    attemptNumber: 1,
    channel: "SMS" as const,
    status: "SUBMITTED",
    provider: "twilio",
    providerCode: null,
    httpStatus: null,
    success: true,
    errorMessage: null,
    sentAt: null,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    ...params,
  };
}

function fakeEvent(params: Partial<FakeEvent> & { id: string }) {
  return {
    status: "SENT",
    provider: null,
    externalMessageId: null,
    sentAt: null,
    reasonFailed: null,
    deliveryConfirmations: [],
    ...params,
  };
}

function statusPayload(messageSid: string, messageStatus: string, extra: Record<string, string> = {}) {
  return {
    MessageSid: messageSid,
    MessageStatus: messageStatus,
    From: "+15550000000",
    To: "+15555551629",
    ...extra,
  };
}

function fake42DeliveryGroup(params: {
  orderNumber: string;
  deliveryDate: Date;
  orderStatus?: string;
  groupStatus?: string;
  internalLifecycleStatus?: InternalOrderLifecycleStatus;
}) {
  return {
    id: `group_${params.orderNumber}`,
    orderId: `order_${params.orderNumber}`,
    orderType: "SO",
    orderNumber: params.orderNumber,
    deliveryDate: params.deliveryDate,
    isActive: true,
    lineCount: 1,
    lastSeenAt: new Date("2026-08-20T00:00:00.000Z"),
    status: params.groupStatus ?? "Open",
    order: {
      id: `order_${params.orderNumber}`,
      orderType: "SO",
      orderNumber: params.orderNumber,
      status: params.orderStatus ?? "Open",
      internalLifecycleStatus: params.internalLifecycleStatus ?? InternalOrderLifecycleStatus.ACTIVE,
      buyerGroup: "Appliances",
      confirmVia: null,
      salespersonNumber: null,
      customerDescription: "Customer",
      locationDescription: "Residence",
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
        displayName: "Customer Person",
        firstName: "Customer",
        lastName: "Person",
        email: "customer@example.test",
        phone1: "8015550100",
        phone2: null,
        smsOptIn: true,
        emailOptIn: true,
        smsOptOuts: [],
        emailOptOuts: [],
      },
    },
  };
}

function fake42Client(groups: ReturnType<typeof fake42DeliveryGroup>[]) {
  const state = {
    events: [] as Array<Record<string, unknown>>,
  };
  const client = {
    orderDeliveryGroup: {
      findMany: async () => groups,
    },
    notificationEvent: {
      findUnique: async (args: { where: { dedupeKey: string } }) =>
        state.events.find((event) => event.dedupeKey === args.where.dedupeKey) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        const event = {
          id: `event_${state.events.length + 1}`,
          dedupeKey: args.data.dedupeKey,
          intervalType: args.data.intervalType,
          actionType: args.data.actionType,
          status: args.data.status,
          selectedChannel: args.data.selectedChannel,
          recipientEmail: args.data.recipientEmail,
          recipientPhone: args.data.recipientPhone,
          reasonSkipped: args.data.reasonSkipped,
          orderType: args.data.orderType,
          orderNumber: args.data.orderNumber,
        };
        state.events.push(event);
        return event;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const event = state.events.find((row) => row.id === args.where.id);
        if (!event) throw new Error(`Missing fake 42 event ${args.where.id}`);
        Object.assign(event, args.data);
        return event;
      },
    },
    deliveryConfirmation: {
      findUnique: async () => null,
    },
  };

  return { client, state };
}

async function run42OrderScopeValidation(failures: string[]) {
  const targetDeliveryDate = dateFromKey("2026-09-05");
  const scopedOrder = { orderType: "SO", orderNumber: "SO38056" };

  {
    const fake = fake42Client([
      fake42DeliveryGroup({ orderNumber: "SO38056", deliveryDate: targetDeliveryDate }),
      fake42DeliveryGroup({ orderNumber: "SO99999", deliveryDate: targetDeliveryDate }),
    ]);
    const summary = await create42DayDeliveryConfirmationEvents({
      runDate: "2026-07-25",
      now: new Date("2026-07-25T09:19:00.000Z"),
      dryRun: false,
      freshImport: false,
      prismaClient: fake.client as never,
      orderScope: scopedOrder,
    });
    assert(summary.orderScope.enabled === true, "42 scoped canary mode should be reported", failures);
    assert(summary.orderScope.unscopedCount === 2, "42 scoped canary should count unscoped candidates", failures);
    assert(summary.orderScope.scopedCount === 1, "42 scoped canary should evaluate one scoped candidate", failures);
    assert(fake.state.events.length === 1, "42 scoped canary should create only one scoped event", failures);
    assert(fake.state.events[0]?.orderNumber === "SO38056", "42 scoped canary should create SO38056 only", failures);
    assert(
      summary.eventReports.every((report) => report.orderType === "SO" && report.orderNumber === "SO38056"),
      "42 scoped canary reports should include only SO38056",
      failures
    );
  }

  {
    const fake = fake42Client([
      fake42DeliveryGroup({ orderNumber: "SO38056", deliveryDate: targetDeliveryDate, orderStatus: "Completed" }),
      fake42DeliveryGroup({ orderNumber: "SO99999", deliveryDate: targetDeliveryDate }),
    ]);
    const summary = await create42DayDeliveryConfirmationEvents({
      runDate: "2026-07-25",
      now: new Date("2026-07-25T09:19:00.000Z"),
      dryRun: false,
      freshImport: false,
      prismaClient: fake.client as never,
      orderScope: scopedOrder,
    });
    assert(summary.deliveryGroupsSkippedIneligible === 1, "42 scoped canary should not force production eligibility", failures);
    assert(fake.state.events.length === 0, "42 scoped ineligible order should create no event", failures);
    assert(
      summary.eventReports[0]?.reasonSkipped === "ineligible_order_or_delivery_group_status",
      "42 scoped ineligible order should report why it was skipped",
      failures
    );
  }

  {
    const fake = fake42Client([
      fake42DeliveryGroup({ orderNumber: "SO38056", deliveryDate: targetDeliveryDate }),
    ]);
    const summary = await create42DayDeliveryConfirmationEvents({
      runDate: "2026-07-25",
      now: new Date("2026-07-25T09:19:00.000Z"),
      dryRun: false,
      freshImport: false,
      prismaClient: fake.client as never,
      orderScope: { orderType: "SO", orderNumber: "SO-NOT-THERE" },
    });
    assert(summary.orderScope.scopedCount === 0, "42 wrong scoped order should evaluate zero candidates", failures);
    assert(fake.state.events.length === 0, "42 wrong scoped order should create nothing", failures);
    assert(summary.eventReports.length === 0, "42 wrong scoped order should report no touched orders", failures);
  }
}

async function runTwilioStatusValidation(failures: string[]) {
  {
    const fake = createFakeStatusClient({
      attempts: [fakeAttempt({ id: "attempt_queued", externalMessageId: "SM_QUEUED" })],
      events: [fakeEvent({ id: "event_1" })],
    });
    const result = await handleTwilioMessageStatus({
      payload: statusPayload("SM_QUEUED", "queued"),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:01:00.000Z"),
    });
    assert(result.matchStatus === "MATCHED_ATTEMPT", "QUEUED callback should match attempt", failures);
    assert(fake.state.attempts[0].status === "SUBMITTED", "QUEUED must keep attempt SUBMITTED", failures);
  }

  {
    const fake = createFakeStatusClient({
      attempts: [fakeAttempt({ id: "attempt_sent", externalMessageId: "SM_SENT" })],
      events: [fakeEvent({ id: "event_1" })],
    });
    await handleTwilioMessageStatus({
      payload: statusPayload("SM_SENT", "sent"),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:02:00.000Z"),
    });
    assert(fake.state.attempts[0].status === "SUBMITTED", "SENT must keep attempt SUBMITTED", failures);
  }

  {
    const fake = createFakeStatusClient({
      attempts: [fakeAttempt({ id: "attempt_delivered", externalMessageId: "SM_DELIVERED" })],
      events: [fakeEvent({ id: "event_1", status: "PENDING" })],
    });
    await handleTwilioMessageStatus({
      payload: statusPayload("SM_DELIVERED", "delivered"),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:03:00.000Z"),
    });
    assert(
      fake.state.attempts[0].status === "DELIVERED",
      "DELIVERED must promote attempt to DELIVERED",
      failures
    );
    assert(
      fake.state.attempts[0].providerCode === "DELIVERED",
      "DELIVERED must store providerCode DELIVERED",
      failures
    );
    assert(fake.state.events[0].status === "SENT", "DELIVERED must mark event successful/SENT", failures);
  }

  {
    const fake = createFakeStatusClient({
      attempts: [fakeAttempt({ id: "attempt_late", externalMessageId: "SM_LATE" })],
      events: [fakeEvent({ id: "event_1" })],
    });
    await handleTwilioMessageStatus({
      payload: statusPayload("SM_LATE", "delivered"),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:04:00.000Z"),
    });
    await handleTwilioMessageStatus({
      payload: statusPayload("SM_LATE", "queued"),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:05:00.000Z"),
    });
    await handleTwilioMessageStatus({
      payload: statusPayload("SM_LATE", "sent"),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:06:00.000Z"),
    });
    assert(
      fake.state.attempts[0].status === "DELIVERED",
      "SENT/QUEUED after DELIVERED must not downgrade attempt",
      failures
    );
  }

  {
    const fake = createFakeStatusClient({
      attempts: [fakeAttempt({ id: "attempt_failed", externalMessageId: "SM_FAILED" })],
      events: [fakeEvent({ id: "event_1" })],
    });
    await handleTwilioMessageStatus({
      payload: statusPayload("SM_FAILED", "undelivered", {
        ErrorCode: "30005",
        ErrorMessage: "Unknown destination handset",
      }),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:07:00.000Z"),
    });
    assert(fake.state.attempts[0].status === "FAILED", "UNDELIVERED must fail attempt", failures);
    assert(fake.state.events[0].status === "FAILED", "UNDELIVERED latest attempt must fail event", failures);
  }

  {
    const fake = createFakeStatusClient({
      attempts: [
        fakeAttempt({
          id: "attempt_old",
          externalMessageId: "SM_OLD",
          attemptNumber: 1,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
        }),
        fakeAttempt({
          id: "attempt_new",
          externalMessageId: "SM_NEW",
          attemptNumber: 2,
          status: "DELIVERED",
          createdAt: new Date("2026-08-20T00:01:00.000Z"),
        }),
      ],
      events: [fakeEvent({ id: "event_1", status: "SENT" })],
    });
    await handleTwilioMessageStatus({
      payload: statusPayload("SM_OLD", "failed", { ErrorCode: "30003" }),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:08:00.000Z"),
    });
    assert(fake.state.attempts[0].status === "FAILED", "Older failed callback should fail older attempt", failures);
    assert(fake.state.attempts[1].status === "DELIVERED", "Newer delivered attempt must remain delivered", failures);
    assert(fake.state.events[0].status === "SENT", "Older failed attempt must not fail event", failures);
  }

  {
    const fake = createFakeStatusClient({ attempts: [], events: [] });
    const result = await handleTwilioMessageStatus({
      payload: statusPayload("SM_UNMATCHED", "delivered"),
      prismaClient: fake.client as never,
      now: new Date("2026-08-20T00:09:00.000Z"),
    });
    assert(result.matchStatus === "UNMATCHED", "Unmatched callback should report UNMATCHED", failures);
    assert(fake.state.callbacks[0]?.matchStatus === "UNMATCHED", "Unmatched callback should be recorded", failures);
  }
}

async function main() {
  const failures: string[] = [];
  await run42OrderScopeValidation(failures);
  const cli = read("scripts/dispatch-delivery-notifications.ts");
  const packageJson = read("package.json");
  const productionIntervalRunner = read("scripts/run-delivery-interval.ts");
  const noResponseRunner = read("scripts/run-42-day-confirmation-no-response.ts");
  const dispatcher = read("lib/notifications/deliveryNotificationDispatcher.ts");
  const providers = read("lib/notifications/deliveryNotificationProviders.ts");
  const twilioStatus = read("lib/notifications/handleTwilioMessageStatus.ts");
  const freshImport = read("lib/notifications/freshDeliveryIntervalImport.ts");
  const createDeliveryReminderEvents = read("lib/notifications/createDeliveryReminderEvents.ts");
  const create42DayDeliveryConfirmationEvents = read(
    "lib/notifications/create42DayDeliveryConfirmationEvents.ts"
  );
  const create42DayScript = read("scripts/create-42-day-delivery-confirmation-events.ts");
  const scriptInventory = read("docs/delivery-notification-script-inventory.md");
  const schedulerDoc = read("docs/delivery-notification-production-scheduler.md");
  const writebackDoc = read("docs/delivery-notification-writeback-go-live-matrix.md");

  assert(
    includes(cli, "dispatchDeliveryNotifications") &&
      includes(cli, "--controlled-recipient-send") &&
      includes(cli, "--confirm") &&
      includes(cli, "sensitiveValuesPrinted: false"),
    "dispatcher CLI must call dispatcher library and support controlled-send confirmation",
    failures
  );
  assert(
    includes(packageJson, "\"run:delivery-interval\"") &&
      includes(packageJson, "scripts/run-delivery-interval.ts"),
    "package.json must expose the real production delivery interval runner",
    failures
  );
  assert(
    includes(productionIntervalRunner, "SUPPORTED_INTERVALS = [\"180\", \"90\", \"60\", \"42\", \"14\", \"12\", \"10\"]") &&
      includes(productionIntervalRunner, "RUN REAL 180 DAY CUSTOMER NOTIFICATIONS") &&
      includes(productionIntervalRunner, "RUN REAL 90 DAY CUSTOMER NOTIFICATIONS") &&
      includes(productionIntervalRunner, "RUN REAL 60 DAY CUSTOMER NOTIFICATIONS") &&
      includes(productionIntervalRunner, "RUN REAL 42 DAY CUSTOMER CONFIRMATION NOTIFICATIONS") &&
      includes(productionIntervalRunner, "RUN REAL 14 DAY CUSTOMER NOTIFICATIONS") &&
      includes(productionIntervalRunner, "RUN REAL 12 DAY CUSTOMER NOTIFICATIONS") &&
      includes(productionIntervalRunner, "RUN REAL 10 DAY CUSTOMER NOTIFICATIONS") &&
      includes(productionIntervalRunner, "options.confirmPhrase !== config.confirmPhrase") &&
      includes(productionIntervalRunner, "create180DayDeliveryReminderEvents") &&
      includes(productionIntervalRunner, "create90DayDeliveryReminderEvents") &&
      includes(productionIntervalRunner, "create60DayDeliveryReminderEvents") &&
      includes(productionIntervalRunner, "create42DayDeliveryConfirmationEvents") &&
      includes(productionIntervalRunner, "create14DayDeliveryReminderEvents") &&
      includes(productionIntervalRunner, "create12DayDeliveryPaymentRequestEvents") &&
      includes(productionIntervalRunner, "create10DayDeliveryPaymentRequestEvents") &&
      includes(productionIntervalRunner, "dispatchDeliveryNotifications") &&
      includes(productionIntervalRunner, "NotificationIntervalType.DAY_180") &&
      includes(productionIntervalRunner, "NotificationIntervalType.DAY_90") &&
      includes(productionIntervalRunner, "NotificationIntervalType.DAY_60") &&
      includes(productionIntervalRunner, "NotificationIntervalType.DAY_42") &&
      includes(productionIntervalRunner, "NotificationIntervalType.DAY_14") &&
      includes(productionIntervalRunner, "NotificationIntervalType.DAY_12") &&
      includes(productionIntervalRunner, "NotificationIntervalType.DAY_10") &&
      includes(productionIntervalRunner, "NotificationActionType.DELIVERY_REMINDER") &&
      includes(productionIntervalRunner, "NotificationActionType.DELIVERY_CONFIRMATION_REQUEST") &&
      includes(productionIntervalRunner, "NotificationActionType.PAYMENT_REQUEST") &&
      !includes(productionIntervalRunner, "NotificationIntervalType.DAY_8"),
    "production interval runner must support 180/90/60/42/14/12/10 with interval-specific confirmations, keep 8-day live runner blocked, and use production create/dispatch paths",
    failures
  );
  assert(
    includes(productionIntervalRunner, "USE_QUEUE_ERP") &&
      includes(productionIntervalRunner, "MLD_QUEUE_BASE_URL") &&
      includes(productionIntervalRunner, "MLD_QUEUE_TOKEN") &&
    includes(productionIntervalRunner, "freshImportForSummary(createSummary)") &&
      includes(productionIntervalRunner, "freshImport.perOrderFailed") &&
      includes(productionIntervalRunner, "deliveryGroupsSkippedFailedImport"),
    "production interval runner must require queue-backed import and fail closed on fresh-import failures",
    failures
  );
  assert(
    includes(productionIntervalRunner, "DELIVERY_REAL_CUSTOMER_SEND_ENABLED") &&
      includes(productionIntervalRunner, "DELIVERY_CONTROLLED_RECIPIENT_MODE") &&
      includes(productionIntervalRunner, "DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST") &&
      includes(productionIntervalRunner, "DEMO_NOTIFICATION_SEND_ENABLED") &&
      includes(productionIntervalRunner, "TWILIO_WEBHOOK_VALIDATE_SIGNATURES") &&
      includes(productionIntervalRunner, "finalRecipientIsTestRecipient") &&
      includes(productionIntervalRunner, "finalRecipientKind !== \"customer\"") &&
      includes(productionIntervalRunner, "attemptsAfter !== attemptsBefore"),
    "production interval runner must reject controlled/test routing and forced eligibility before real sends",
    failures
  );
  assert(
    includes(productionIntervalRunner, "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN") &&
      includes(productionIntervalRunner, "confirmationWritebackDryRunRequired: false") &&
      includes(productionIntervalRunner, "confirmationWritebackLivePayloadsEnabled") &&
      includes(productionIntervalRunner, "DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN") &&
      includes(productionIntervalRunner, "DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN") &&
      includes(productionIntervalRunner, "DELIVERY_PREPAYMENT_HOLD_DRY_RUN"),
    "production interval runner must require live 42 confirmation writeback posture while keeping unrelated writeback/hold dry-run flags protected",
    failures
  );
  assert(
    includes(productionIntervalRunner, "dispatchOnlyCurrentRunCreatedEvents: true") &&
      includes(productionIntervalRunner, "createdEventIdsForCurrentRun") &&
      includes(productionIntervalRunner, "currentRunCreatedEventIds") &&
      includes(productionIntervalRunner, "otherScheduledEventsForInterval") &&
      includes(productionIntervalRunner, "oldScheduledEventsWarning"),
    "42/14/12/10 production runner must dispatch only current-run created event ids and report old scheduled rows",
    failures
  );
  assert(
    includes(productionIntervalRunner, "--order-type") &&
      includes(productionIntervalRunner, "--order-number") &&
      includes(productionIntervalRunner, "normalizeDeliveryOrderScope") &&
      includes(productionIntervalRunner, "orderScope: options.orderScope") &&
      includes(productionIntervalRunner, "assertRowsWithinOrderScope(options.orderScope, createEventReports") &&
      includes(productionIntervalRunner, "assertRowsWithinOrderScope(options.orderScope, scheduledEvents") &&
      includes(productionIntervalRunner, "blastRadiusLimitedOnly") &&
      includes(productionIntervalRunner, "productionEligibilityStillRequired: true"),
    "42 production runner must support scoped canary mode without bypassing production eligibility",
    failures
  );
  assert(
    includes(noResponseRunner, "--order-type") &&
      includes(noResponseRunner, "--order-number") &&
      includes(noResponseRunner, "normalizeDeliveryOrderScope") &&
      includes(noResponseRunner, "orderScope: options.orderScope") &&
      includes(noResponseRunner, "assertRowsWithinOrderScope(options.orderScope, summary.eventReports") &&
      includes(noResponseRunner, "assertRowsWithinOrderScope(options.orderScope, events") &&
      includes(noResponseRunner, "touchHistoryStateMachineStillRequired: true"),
    "42 no-response runner must support scoped canary mode without bypassing touch-history state machine",
    failures
  );
  assert(
    includes(productionIntervalRunner, "shell: process.platform === \"win32\"") &&
      includes(productionIntervalRunner, "prisma\", \"migrate\", \"status\""),
    "production interval runner must use a Windows-safe subprocess for its internal Prisma migration status check",
    failures
  );
  assert(
    includes(dispatcher, "DELIVERY_REAL_CUSTOMER_SEND_ENABLED") &&
      includes(dispatcher, "DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION") &&
      includes(dispatcher, "USE_QUEUE_ERP") &&
      includes(dispatcher, "MLD_QUEUE_BASE_URL") &&
      includes(dispatcher, "MLD_QUEUE_TOKEN") &&
      includes(dispatcher, "TWILIO_WEBHOOK_VALIDATE_SIGNATURES") &&
      includes(dispatcher, "DELIVERY_CONTROLLED_RECIPIENT_CONFIRM_PHRASE") &&
      includes(dispatcher, "Controlled recipient confirmation phrase did not match."),
    "dispatcher preflight must gate real sends, queue-backed import, webhook signatures, and exact controlled confirmation",
    failures
  );
  assert(
    includes(dispatcher, "claimEventForDispatch") &&
      includes(dispatcher, "status: NotificationEventStatus.SCHEDULED") &&
      includes(dispatcher, "status: NotificationEventStatus.PENDING"),
    "dispatcher must claim SCHEDULED events before provider calls",
    failures
  );
  assert(
    includes(dispatcher, "resolveFinalRecipient") &&
      includes(dispatcher, "suppressedRecipient: params.productionRecipient") &&
      includes(dispatcher, "finalRecipientKind: \"test\""),
    "controlled-recipient mode must suppress the real recipient",
    failures
  );
  assert(
    includes(providers, "StatusCallback") &&
      includes(providers, "/api/webhooks/twilio/message-status"),
    "Twilio sends must include the delivery message-status callback URL",
    failures
  );
  assert(
    includes(twilioStatus, "const IN_FLIGHT_STATUSES = new Set([\"ACCEPTED\", \"QUEUED\", \"SENDING\", \"SENT\", \"SUBMITTED\"])") &&
      includes(twilioStatus, "const DELIVERED_STATUSES = new Set([\"DELIVERED\"])") &&
      includes(twilioStatus, "const ATTEMPT_DELIVERED = \"DELIVERED\"") &&
      includes(twilioStatus, "status: { in: [ATTEMPT_CREATED, ATTEMPT_SUBMITTED] }") &&
      includes(twilioStatus, "status: { not: ATTEMPT_DELIVERED }"),
    "Twilio callback mapping must keep in-flight statuses submitted and only delivered as delivered",
    failures
  );
  assert(
    includes(freshImport, "assertQueueBackedDeliveryImportConfigured") &&
      includes(freshImport, "MLD_QUEUE_BASE_URL") &&
      includes(freshImport, "MLD_QUEUE_TOKEN") &&
      includes(freshImport, "importSalesOrdersForLineRequestedOn"),
    "fresh interval import helper must require queue-backed ERP import configuration",
    failures
  );
  assert(
    includes(createDeliveryReminderEvents, "prepareFreshDeliveryIntervalImport") &&
      includes(createDeliveryReminderEvents, "summary.freshImport"),
    "180/90/60 shared reminder creation must prepare fresh import before event selection",
    failures
  );
  assert(
    includes(create42DayDeliveryConfirmationEvents, "prepareFreshDeliveryIntervalImport") &&
      includes(create42DayDeliveryConfirmationEvents, "summary.freshImport") &&
      includes(create42DayDeliveryConfirmationEvents, "filterByDeliveryOrderScope") &&
      includes(create42DayDeliveryConfirmationEvents, "orderScope: DeliveryOrderScopeReport"),
    "42-day confirmation creation must prepare fresh import and scoped canary filtering before event selection",
    failures
  );
  assert(
    includes(create42DayScript, "let dryRun = false") &&
      includes(create42DayScript, "arg === \"--dry-run\"") &&
      includes(create42DayScript, "create42DayDeliveryConfirmationEvents({ runDate, dryRun })"),
    "42-day production script must pass explicit dry-run mode and support --dry-run",
    failures
  );
  assert(
    includes(scriptInventory, "No current package script points to a missing") &&
      includes(scriptInventory, "Production Creation And Runtime") &&
      includes(scriptInventory, "Manual/Demo/Deprecated"),
    "script inventory doc must separate production, validation, preview, and deprecated scripts",
    failures
  );
  assert(
    includes(schedulerDoc, "Daily Run Order") &&
      includes(schedulerDoc, "create:180-day-delivery-reminder-events") &&
      includes(schedulerDoc, "dispatch:delivery-notifications"),
    "scheduler readiness doc must define production run order",
    failures
  );
  assert(
    includes(writebackDoc, "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN") &&
      includes(writebackDoc, "DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN") &&
      includes(writebackDoc, "DELIVERY_PREPAYMENT_HOLD_DRY_RUN") &&
      includes(writebackDoc, "DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN"),
    "writeback matrix must document all delivery writeback dry-run gates",
    failures
  );

  const safeEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DELIVERY_CONTROLLED_RECIPIENT_MODE: "true",
    DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST: "true",
    DELIVERY_CONTROLLED_RECIPIENT_CONFIRM_PHRASE: "SEND ONE CONTROLLED TEST NOTIFICATION TO JAMES ONLY",
    NOTIFICATIONS_TEST_EMAIL: "james@example.test",
    NOTIFICATIONS_TEST_PHONE: "+15555551629",
    DELIVERY_APP_BASE_URL: "https://mld-delivery.example.test",
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "secret",
    TWILIO_MESSAGING_SERVICE_SID: "MG123",
    MS_GRAPH_TENANT_ID: "tenant",
    MS_GRAPH_CLIENT_ID: "client",
    MS_GRAPH_CLIENT_SECRET: "secret",
    MS_GRAPH_FROM_EMAIL: "delivery@example.test",
  };

  const controlled = evaluateDeliveryDispatcherPreflight(
    {
      send: true,
      controlledRecipientSend: true,
      confirmPhrase: safeEnv.DELIVERY_CONTROLLED_RECIPIENT_CONFIRM_PHRASE,
      testRunId: "validation",
    },
    safeEnv
  );
  assert(controlled.ok, `controlled send preflight should pass: ${controlled.failures.join("; ")}`, failures);
  assert(controlled.controlledRecipientMode, "controlled preflight must report controlled mode", failures);
  assert(
    controlled.mode === "controlled-recipient send",
    "controlled preflight must report controlled-recipient send mode",
    failures
  );
  assert(
    controlled.forceContactEligibilityForTest,
    "controlled preflight must report forced test eligibility",
    failures
  );

  const broad = evaluateDeliveryDispatcherPreflight(
    { send: true, controlledRecipientSend: false, testRunId: "validation" },
    safeEnv
  );
  assert(!broad.ok, "real customer send mode must not pass preflight in this phase", failures);
  assert(
    broad.failures.includes("DELIVERY_REAL_CUSTOMER_SEND_ENABLED must be exactly true for real customer sends."),
    "broad-send preflight must require the real customer send gate",
    failures
  );
  assert(
    broad.failures.includes("DELIVERY_CONTROLLED_RECIPIENT_MODE must be false or unset for real customer sends."),
    "broad-send preflight must reject controlled-recipient env during real sends",
    failures
  );
  assert(
    broad.failures.includes("DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST must be false or unset for real customer sends."),
    "broad-send preflight must reject forced contact eligibility during real sends",
    failures
  );
  assert(
    broad.failures.includes("USE_QUEUE_ERP must be exactly true for real customer sends."),
    "broad-send preflight must require queue-backed ERP for real sends",
    failures
  );

  const productionRealSendEnv: NodeJS.ProcessEnv = {
    ...safeEnv,
    NODE_ENV: "production",
    DELIVERY_REAL_CUSTOMER_SEND_ENABLED: "true",
    DELIVERY_CONTROLLED_RECIPIENT_MODE: "false",
    DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST: "false",
    DEMO_NOTIFICATION_SEND_ENABLED: "false",
    USE_QUEUE_ERP: "true",
    MLD_QUEUE_BASE_URL: "https://mld-queue.example.test",
    MLD_QUEUE_TOKEN: "token",
    TWILIO_WEBHOOK_VALIDATE_SIGNATURES: "true",
  };
  const realCustomer = evaluateDeliveryDispatcherPreflight(
    { send: true, controlledRecipientSend: false, testRunId: "validation" },
    productionRealSendEnv
  );
  assert(
    realCustomer.ok,
    `real customer send preflight should pass only with production gate: ${realCustomer.failures.join("; ")}`,
    failures
  );
  assert(
    realCustomer.mode === "real-customer send" && realCustomer.realCustomerSendMode,
    "real customer preflight must report real-customer send mode",
    failures
  );

  const realCustomerWithForcedEligibility = evaluateDeliveryDispatcherPreflight(
    { send: true, controlledRecipientSend: false, testRunId: "validation" },
    { ...productionRealSendEnv, DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST: "true" }
  );
  assert(
    !realCustomerWithForcedEligibility.ok,
    "real customer preflight must reject forced contact eligibility",
    failures
  );
  assert(
    realCustomerWithForcedEligibility.failures.includes(
      "DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST must be false or unset for real customer sends."
    ),
    "real customer preflight must include forced eligibility rejection reason",
    failures
  );

  const realCustomerWithDemoMode = evaluateDeliveryDispatcherPreflight(
    { send: true, controlledRecipientSend: false, testRunId: "validation" },
    { ...productionRealSendEnv, DEMO_NOTIFICATION_SEND_ENABLED: "true" }
  );
  assert(!realCustomerWithDemoMode.ok, "real customer preflight must reject demo send mode", failures);
  assert(
    realCustomerWithDemoMode.failures.includes(
      "DEMO_NOTIFICATION_SEND_ENABLED must be false or unset for real customer sends."
    ),
    "real customer preflight must include demo mode rejection reason",
    failures
  );

  const realCustomerWithQueueDisabled = evaluateDeliveryDispatcherPreflight(
    { send: true, controlledRecipientSend: false, testRunId: "validation" },
    { ...productionRealSendEnv, USE_QUEUE_ERP: "false" }
  );
  assert(!realCustomerWithQueueDisabled.ok, "real customer preflight must reject disabled queue ERP", failures);
  assert(
    realCustomerWithQueueDisabled.failures.includes("USE_QUEUE_ERP must be exactly true for real customer sends."),
    "real customer preflight must include queue ERP rejection reason",
    failures
  );

  const realCustomerMissingTwilio = evaluateDeliveryDispatcherPreflight(
    { send: true, controlledRecipientSend: false, testRunId: "validation" },
    { ...productionRealSendEnv, TWILIO_AUTH_TOKEN: "" }
  );
  assert(!realCustomerMissingTwilio.ok, "real customer preflight must reject missing Twilio env", failures);
  assert(
    realCustomerMissingTwilio.failures.includes("TWILIO_AUTH_TOKEN is required for dispatcher sends."),
    "real customer preflight must include missing Twilio provider env reason",
    failures
  );

  const realCustomerMissingGraph = evaluateDeliveryDispatcherPreflight(
    { send: true, controlledRecipientSend: false, testRunId: "validation" },
    { ...productionRealSendEnv, MS_GRAPH_CLIENT_SECRET: "" }
  );
  assert(!realCustomerMissingGraph.ok, "real customer preflight must reject missing Graph env", failures);
  assert(
    realCustomerMissingGraph.failures.includes("MS_GRAPH_CLIENT_SECRET is required for dispatcher sends."),
    "real customer preflight must include missing Graph provider env reason",
    failures
  );

  const nonProductionRealSend = evaluateDeliveryDispatcherPreflight(
    { send: true, controlledRecipientSend: false, testRunId: "validation" },
    { ...productionRealSendEnv, NODE_ENV: "development" }
  );
  assert(!nonProductionRealSend.ok, "non-production real customer send must require override", failures);
  assert(
    nonProductionRealSend.failures.includes(
      "DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION must be exactly true for real customer sends outside NODE_ENV=production."
    ),
    "non-production real customer send must include explicit override reason",
    failures
  );

  const wrongConfirm = evaluateDeliveryDispatcherPreflight(
    {
      send: true,
      controlledRecipientSend: true,
      confirmPhrase: "wrong",
      testRunId: "validation",
    },
    safeEnv
  );
  assert(!wrongConfirm.ok, "wrong controlled confirmation phrase must fail", failures);
  assert(
    wrongConfirm.failures.includes("Controlled recipient confirmation phrase did not match."),
    "wrong confirm preflight must include phrase mismatch reason",
    failures
  );

  await runTwilioStatusValidation(failures);

  if (failures.length > 0) {
    console.error(
      JSON.stringify({ ok: false, failures, sensitiveValuesPrinted: false }, null, 2)
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dispatcherCliRestored: true,
        controlledPreflightVerified: true,
        realCustomerSendGateVerified: true,
        nonProductionRealSendBlocked: true,
        freshImportWiringVerified: true,
        productionDocsVerified: true,
        twilioStatusMappingVerified: true,
        twilioStatusTransitionScenariosVerified: true,
        sensitiveValuesPrinted: false,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
