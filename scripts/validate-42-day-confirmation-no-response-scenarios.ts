import "dotenv/config";

import { readFileSync } from "fs";
import { join } from "path";

import {
  DeliveryConfirmationStatus,
  NotificationActionType,
  NotificationAttemptStatus,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  buildDeliveryConfirmationReminderDedupeKey,
  DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS,
  guardDeliveryConfirmationNoResponseDispatch,
  resolveDeliveryConfirmationTouchHistory,
  run42DayDeliveryConfirmationNoResponse,
  type DeliveryConfirmationNoResponseCandidate,
  type DeliveryConfirmationNoResponseClient,
  type DeliveryConfirmationNoResponseCurrentStateRefresher,
} from "../lib/notifications/deliveryConfirmationNoResponse";
import { confirmDeliveryFromWebpage } from "../lib/notifications/confirmDeliveryFromWebpage";
import { handleTwilioInboundSms } from "../lib/notifications/handleTwilioInboundSms";
import { addDays, buildNotificationDedupeKey, dateKey } from "../lib/notifications/helpers";

const ROOT = process.cwd();
const NOW = new Date("2026-07-29T10:00:00.000Z");
const DELIVERY_DATE = new Date("2026-09-08T00:00:00.000Z");
const TOUCH2_RUN = "2026-07-29";
const TOUCH3_RUN = "2026-07-30";
const ESCALATION_RUN = "2026-07-31";

type Failure = string;
type AnyRecord = Record<string, unknown>;

type FakeNotificationAttempt = {
  id: string;
  attemptNumber: number;
  channel: NotificationChannel;
  status: NotificationAttemptStatus;
  provider: string | null;
  providerCode: string | null;
  success: boolean;
  errorMessage: string | null;
  externalMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
};

function assert(condition: unknown, message: string, failures: Failure[]) {
  if (!condition) failures.push(message);
}

function assertEqual<T>(actual: T, expected: T, message: string, failures: Failure[]) {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`, failures);
}

function assertIncludes(source: string, pattern: string, message: string, failures: Failure[]) {
  assert(source.includes(pattern), message, failures);
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" ? (value as AnyRecord) : {};
}

function valueDateKey(value: unknown) {
  if (value instanceof Date || typeof value === "string") return dateKey(value);
  return null;
}

function matchesWhere(confirmation: DeliveryConfirmationNoResponseCandidate, where: AnyRecord) {
  const deliveryDate = valueDateKey(where.deliveryDate);
  if (deliveryDate && dateKey(confirmation.deliveryDate) !== deliveryDate) return false;

  const deliveryDateFilter = asRecord(where.deliveryDate);
  const gte = valueDateKey(deliveryDateFilter.gte);
  const lte = valueDateKey(deliveryDateFilter.lte);
  const confirmationDate = dateKey(confirmation.deliveryDate);
  if (gte && confirmationDate < gte) return false;
  if (lte && confirmationDate > lte) return false;

  const statusFilter = asRecord(where.status);
  if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(confirmation.status)) return false;
  if (where.confirmedAt === null && confirmation.confirmedAt !== null) return false;
  if (where.requestedNewDate === null && confirmation.requestedNewDate !== null) return false;
  if (
    typeof where.manualReviewRequired === "boolean" &&
    confirmation.manualReviewRequired !== where.manualReviewRequired
  ) {
    return false;
  }
  if (where.noResponseAt === null && confirmation.noResponseAt !== null) return false;

  const followUp = where.confirmationFollowUpCount;
  if (typeof followUp === "number") return confirmation.confirmationFollowUpCount === followUp;
  const followUpFilter = asRecord(followUp);
  if (typeof followUpFilter.gte === "number" && confirmation.confirmationFollowUpCount < followUpFilter.gte) {
    return false;
  }
  if (typeof followUpFilter.lte === "number" && confirmation.confirmationFollowUpCount > followUpFilter.lte) {
    return false;
  }

  return true;
}

class FakeDeliveryStore {
  confirmations: DeliveryConfirmationNoResponseCandidate[] = [];
  notificationEvents: AnyRecord[] = [];
  seededNotificationEvents: AnyRecord[] = [];
  internalNotificationEvents: AnyRecord[] = [];
  updates = 0;

  readonly client = {
    deliveryConfirmation: {
      findMany: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return this.confirmations.filter((confirmation) => matchesWhere(confirmation, where));
      },
      findUnique: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        const id = where.id;
        const composite = asRecord(where.deliveryGroupId_deliveryDate);
        if (composite.deliveryGroupId && composite.deliveryDate) {
          return (
            this.confirmations.find(
              (confirmation) =>
                confirmation.deliveryGroupId === composite.deliveryGroupId &&
                dateKey(confirmation.deliveryDate) === valueDateKey(composite.deliveryDate)
            ) ?? null
          );
        }
        return this.confirmations.find((confirmation) => confirmation.id === id) ?? null;
      },
      count: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return this.confirmations.filter((confirmation) => matchesWhere(confirmation, where)).length;
      },
      update: async (args: { where: { id: string }; data: AnyRecord }) => {
        const confirmation = this.confirmations.find((row) => row.id === args.where.id);
        if (!confirmation) throw new Error(`Missing confirmation ${args.where.id}`);
        Object.assign(confirmation, args.data);
        this.updates += 1;
        return confirmation;
      },
      updateMany: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        const data = asRecord(asRecord(args).data);
        const rows = this.confirmations.filter((confirmation) => matchesWhere(confirmation, where));
        for (const row of rows) Object.assign(row, data);
        this.updates += rows.length;
        return { count: rows.length };
      },
    },
    notificationEvent: {
      findUnique: async (args: unknown) => {
        const dedupeKey = asRecord(asRecord(args).where).dedupeKey;
        return (
          [...this.notificationEvents, ...this.seededNotificationEvents].find(
            (event) => event.dedupeKey === dedupeKey
          ) ?? null
        );
      },
      create: async (args: { data: AnyRecord }) => {
        const event = {
          id: `event_${this.notificationEvents.length + 1}`,
          dedupeKey: String(args.data.dedupeKey),
          orderType: args.data.orderType,
          orderNumber: args.data.orderNumber,
          intervalType: args.data.intervalType as NotificationIntervalType,
          actionType: args.data.actionType as NotificationActionType,
          deliveryGroupId: args.data.deliveryGroupId,
          deliveryDate: args.data.deliveryDate,
          status: args.data.status as string,
          selectedChannel: (args.data.selectedChannel as string | null | undefined) ?? null,
          recipientEmail: (args.data.recipientEmail as string | null | undefined) ?? null,
          recipientPhone: (args.data.recipientPhone as string | null | undefined) ?? null,
          reasonSkipped: (args.data.reasonSkipped as string | null | undefined) ?? null,
          attempts: [],
        };
        this.notificationEvents.push(event);
        return event;
      },
    },
    internalNotificationEvent: {
      findFirst: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return (
          this.internalNotificationEvents.find(
            (event) =>
              event.orderDeliveryGroupId === where.orderDeliveryGroupId &&
              event.purpose === where.purpose &&
              event.orderType === where.orderType &&
              event.orderNumber === where.orderNumber &&
              valueDateKey(event.deliveryDate) === valueDateKey(where.deliveryDate)
          ) ?? null
        );
      },
      upsert: async (args: { where: AnyRecord; create: AnyRecord }) => {
        const key = asRecord(args.where.orderDeliveryGroupId_deliveryDate_purpose);
        const existing = this.internalNotificationEvents.find(
          (event) =>
            event.orderDeliveryGroupId === key.orderDeliveryGroupId &&
            valueDateKey(event.deliveryDate) === valueDateKey(key.deliveryDate) &&
            event.purpose === key.purpose
        );
        if (existing) return existing;
        const event = {
          id: `internal_${this.internalNotificationEvents.length + 1}`,
          ...args.create,
        };
        this.internalNotificationEvents.push(event);
        return event;
      },
      create: async (args: { data: AnyRecord }) => {
        const event = {
          id: `internal_${this.internalNotificationEvents.length + 1}`,
          ...args.data,
        };
        this.internalNotificationEvents.push(event);
        return event;
      },
    },
    salespersonContact: {
      findMany: async () => [
        {
          salespersonNumber: "SP1",
          salespersonName: "Sales Person",
          salespersonEmail: "salesperson@example.test",
          salespersonPhone: "8015557777",
          isActive: true,
        },
      ],
    },
    smsOptOut: { findMany: async () => [] },
    emailOptOut: { findMany: async () => [] },
  } as unknown as DeliveryConfirmationNoResponseClient;

  private seedCompletedTouch(params: {
    eventId: string;
    dedupeKey: string;
    actionType: NotificationActionType;
    status?: NotificationAttemptStatus;
    providerCode?: string | null;
  }) {
    const event = {
      id: params.eventId,
      dedupeKey: params.dedupeKey,
      intervalType: NotificationIntervalType.DAY_42,
      actionType: params.actionType,
      status:
        params.status === NotificationAttemptStatus.FAILED
          ? NotificationEventStatus.FAILED
          : NotificationEventStatus.SENT,
      selectedChannel: NotificationChannel.SMS,
      recipientEmail: null,
      recipientPhone: "8015550100",
      reasonSkipped: null,
      attempts: [
        {
          id: `attempt_${params.eventId}`,
          attemptNumber: 1,
          channel: NotificationChannel.SMS,
          status: params.status ?? NotificationAttemptStatus.SUBMITTED,
          provider: "twilio",
          providerCode: params.providerCode ?? "SENT",
          success: params.status !== NotificationAttemptStatus.FAILED,
          errorMessage:
            params.status === NotificationAttemptStatus.FAILED ? "provider failed" : null,
          externalMessageId: `SM_${params.eventId}`,
          sentAt: NOW,
          createdAt: NOW,
        } satisfies FakeNotificationAttempt,
      ],
    };
    this.seededNotificationEvents.push(event);
    return event;
  }

  markCreatedEventsSubmitted() {
    for (const event of this.notificationEvents) {
      const attempts = Array.isArray(event.attempts) ? event.attempts : [];
      if (attempts.length > 0) continue;
      event.status = NotificationEventStatus.SENT;
      attempts.push({
        id: `attempt_${String(event.id)}`,
        attemptNumber: 1,
        channel: (event.selectedChannel as NotificationChannel | null) ?? NotificationChannel.SMS,
        status: NotificationAttemptStatus.SUBMITTED,
        provider: event.selectedChannel === NotificationChannel.EMAIL ? "ms_graph" : "twilio",
        providerCode: "SENT",
        success: true,
        errorMessage: null,
        externalMessageId: `MSG_${String(event.id)}`,
        sentAt: NOW,
        createdAt: NOW,
      } satisfies FakeNotificationAttempt);
      event.attempts = attempts;
    }
  }

  seed(options: Partial<{
    id: string;
    orderNumber: string;
    deliveryDate: Date;
    status: DeliveryConfirmationStatus;
    confirmationFollowUpCount: number;
    smsOptIn: boolean;
    emailOptIn: boolean;
    phone1: string | null;
    email: string | null;
    groupIsActive: boolean;
    groupDeliveryDate: Date;
    confirmVia: string | null;
    hasActiveLines: boolean;
    requestedNewDate: Date | null;
    confirmedAt: Date | null;
    initialTouchCompleted: boolean;
    initialTouchExists: boolean;
    reminder1Completed: boolean;
    reminder2Completed: boolean;
    initialTouchFailed: boolean;
    initialAttemptStatus: NotificationAttemptStatus;
    initialProviderCode: string | null;
  }> = {}) {
    const id = options.id ?? `confirmation_${this.confirmations.length + 1}`;
    const deliveryDate = options.deliveryDate ?? DELIVERY_DATE;
    const orderNumber = options.orderNumber ?? `SO-${id}`;
    const originalEventId = `original_${id}`;
    const initialTouchExists = options.initialTouchExists ?? true;
    const initialTouchCompleted = options.initialTouchCompleted ?? true;
    const reminder1Completed =
      options.reminder1Completed ?? (options.confirmationFollowUpCount ?? 0) >= 1;
    const reminder2Completed =
      options.reminder2Completed ?? (options.confirmationFollowUpCount ?? 0) >= 2;
    const originalEvent = !initialTouchExists
      ? null
      : initialTouchCompleted || options.initialTouchFailed
      ? this.seedCompletedTouch({
          eventId: originalEventId,
          dedupeKey: buildNotificationDedupeKey({
            orderType: "SO",
            orderNumber,
            deliveryDate,
            intervalType: NotificationIntervalType.DAY_42,
            actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
          }),
          actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
          status: options.initialTouchFailed
            ? NotificationAttemptStatus.FAILED
            : options.initialAttemptStatus,
          providerCode: options.initialTouchFailed
            ? "FAILED"
            : options.initialProviderCode ?? "SENT",
        })
      : {
          id: originalEventId,
          dedupeKey: buildNotificationDedupeKey({
            orderType: "SO",
            orderNumber,
            deliveryDate,
            intervalType: NotificationIntervalType.DAY_42,
            actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
          }),
          intervalType: NotificationIntervalType.DAY_42,
          actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
          status: NotificationEventStatus.SCHEDULED,
          selectedChannel: NotificationChannel.SMS,
          recipientEmail: null,
          recipientPhone: "8015550100",
          reasonSkipped: null,
          attempts: [],
        };
    if (originalEvent && initialTouchExists && !initialTouchCompleted && !options.initialTouchFailed) {
      this.seededNotificationEvents.push(originalEvent);
    }
    if (reminder1Completed) {
      this.seedCompletedTouch({
        eventId: `reminder1_${id}`,
        dedupeKey: buildDeliveryConfirmationReminderDedupeKey({
          confirmationId: id,
          orderType: "SO",
          orderNumber,
          deliveryDate,
          touchNumber: 2,
        }),
        actionType: NotificationActionType.DELIVERY_CONFIRMATION_REMINDER,
      });
    }
    if (reminder2Completed) {
      this.seedCompletedTouch({
        eventId: `reminder2_${id}`,
        dedupeKey: buildDeliveryConfirmationReminderDedupeKey({
          confirmationId: id,
          orderType: "SO",
          orderNumber,
          deliveryDate,
          touchNumber: 3,
        }),
        actionType: NotificationActionType.DELIVERY_CONFIRMATION_REMINDER,
      });
    }
    const confirmation: DeliveryConfirmationNoResponseCandidate = {
      id,
      orderId: `order_${id}`,
      deliveryGroupId: `group_${id}`,
      notificationEventId: originalEvent ? String(originalEvent.id) : null,
      orderType: "SO",
      orderNumber,
      deliveryDate,
      contactId: `contact_${id}`,
      status: options.status ?? DeliveryConfirmationStatus.PENDING,
      confirmedAt: options.confirmedAt ?? null,
      requestedNewDate: options.requestedNewDate ?? null,
      manualReviewRequired: false,
      manualReviewReason: null,
      manualReviewMarkedAt: null,
      manualReviewNotes: null,
      reminderSentAt: null,
      noResponseAt: null,
      confirmationFollowUpCount: options.confirmationFollowUpCount ?? 0,
      linkToken: `token_${id}`,
      linkExpiresAt: new Date("2026-12-31T00:00:00.000Z"),
      linkExpiredAt: null,
      notificationEvent: originalEvent,
      orderDeliveryGroup: {
        id: `group_${id}`,
        deliveryDate: options.groupDeliveryDate ?? deliveryDate,
        isActive: options.groupIsActive ?? true,
        status: "Open",
        deliveryGroupLines: options.hasActiveLines === false ? [] : [{ id: `line_${id}` }],
        order: {
          id: `order_${id}`,
          orderType: "SO",
          orderNumber,
          status: "Open",
          internalLifecycleStatus: "ACTIVE",
          buyerGroup: "Appliances",
          confirmVia: options.confirmVia ?? null,
          salespersonNumber: "SP1",
          customerDescription: "Customer",
          locationDescription: "Residence",
          address: { addressLine1: "123 Main", addressLine2: null, city: "SLC", state: "UT", postalCode: "84101" },
          contact: {
            contactId: `contact_${id}`,
            companyName: null,
            displayName: "Customer Person",
            firstName: "Customer",
            lastName: "Person",
            email: options.email === undefined ? "customer@example.test" : options.email,
            phone1: options.phone1 === undefined ? "8015550100" : options.phone1,
            phone2: null,
            smsOptIn: options.smsOptIn ?? true,
            emailOptIn: options.emailOptIn ?? true,
            smsOptOuts: [],
            emailOptOuts: [],
          },
        },
      },
    };
    this.confirmations.push(confirmation);
    return confirmation;
  }
}

const noopRefresh: DeliveryConfirmationNoResponseCurrentStateRefresher = async ({ candidate }) => ({
  ok: true,
  candidate,
  importResult: null,
});

function mutateRefresh(
  mutate: (candidate: DeliveryConfirmationNoResponseCandidate) => void
): DeliveryConfirmationNoResponseCurrentStateRefresher {
  return async ({ candidate }) => {
    mutate(candidate);
    return { ok: true, candidate, importResult: null };
  };
}

async function validateCoreAndCounting(failures: Failure[]) {
  const store = new FakeDeliveryStore();
  const confirmation = store.seed();
  await run42DayDeliveryConfirmationNoResponse({
    runDate: TOUCH2_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: store.client,
    currentStateRefresher: noopRefresh,
  });
  store.markCreatedEventsSubmitted();
  await run42DayDeliveryConfirmationNoResponse({
    runDate: TOUCH3_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: store.client,
    currentStateRefresher: noopRefresh,
  });
  store.markCreatedEventsSubmitted();
  await run42DayDeliveryConfirmationNoResponse({
    runDate: ESCALATION_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: store.client,
    currentStateRefresher: noopRefresh,
  });

  assertEqual(store.notificationEvents.length, 2, "core creates exactly two follow-up customer reminders", failures);
  assertEqual(confirmation.confirmationFollowUpCount, 2, "follow-up count represents reminders after original", failures);
  assertEqual(store.internalNotificationEvents.length, 1, "core creates one salesperson escalation", failures);
  assertEqual(confirmation.manualReviewRequired, true, "core marks manual review after three touches", failures);
}

async function validateTouchHistoryStateMachine(failures: Failure[]) {
  for (const [label, options] of [
    ["missing initial event", { initialTouchExists: false }],
    ["initial event no attempt", { initialTouchCompleted: false }],
    ["initial provider failed", { initialTouchFailed: true }],
  ] as const) {
    const store = new FakeDeliveryStore();
    const confirmation = store.seed({
      deliveryDate: addDays(TOUCH3_RUN, 40),
      confirmationFollowUpCount: 1,
      ...options,
    });
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: TOUCH3_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
    });
    const event = store.notificationEvents[0];
    assertEqual(event?.actionType, NotificationActionType.DELIVERY_CONFIRMATION_REQUEST, `${label} sends initial catch-up request`, failures);
    assert(String(event?.dedupeKey ?? "").includes("delivery_confirmation_initial_catchup"), `${label} uses catch-up dedupe`, failures);
    assertEqual(summary.initialCatchUpEventsCreated, 1, `${label} counts initial catch-up`, failures);
    assertEqual(confirmation.confirmationFollowUpCount, 1, `${label} keeps follow-up count from driving decision`, failures);
  }

  {
    const store = new FakeDeliveryStore();
    store.seed({
      deliveryDate: addDays(TOUCH3_RUN, 40),
      confirmationFollowUpCount: 0,
    });
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: TOUCH3_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
    });
    const event = store.notificationEvents[0];
    assertEqual(event?.actionType, NotificationActionType.DELIVERY_CONFIRMATION_REMINDER, "40-day initial completed sends reminder 1, not final", failures);
    assert(String(event?.dedupeKey ?? "").includes("touch_2"), "40-day initial completed uses touch 2", failures);
    assertEqual(summary.reminderEventsCreatedByTouch.touch2, 1, "40-day reminder 1 counted", failures);
    assertEqual(summary.reminderEventsCreatedByTouch.touch3, 0, "40-day reminder 1 does not create final", failures);
  }

  for (const [label, options, expected] of [
    [
      "39 no initial",
      { initialTouchExists: false, initialTouchCompleted: false, confirmationFollowUpCount: 0 },
      NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    ],
    [
      "39 only initial",
      { confirmationFollowUpCount: 0 },
      "touch_2",
    ],
    [
      "39 initial plus reminder 1",
      { confirmationFollowUpCount: 1 },
      "touch_3",
    ],
  ] as const) {
    const store = new FakeDeliveryStore();
    store.seed({
      deliveryDate: addDays(ESCALATION_RUN, 39),
      ...options,
    });
    await run42DayDeliveryConfirmationNoResponse({
      runDate: ESCALATION_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
    });
    assertEqual(store.notificationEvents.length, 1, `${label} creates next customer touch at 39`, failures);
    assertEqual(store.internalNotificationEvents.length, 0, `${label} does not escalate at 39`, failures);
    if (expected === NotificationActionType.DELIVERY_CONFIRMATION_REQUEST) {
      assertEqual(
        store.notificationEvents[0]?.actionType,
        NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
        `${label} sends initial catch-up`,
        failures
      );
    } else {
      assertIncludes(
        String(store.notificationEvents[0]?.dedupeKey ?? ""),
        String(expected),
        `${label} sends ${expected}`,
        failures
      );
    }
  }

  {
    const store = new FakeDeliveryStore();
    store.seed({
      deliveryDate: addDays(ESCALATION_RUN, 39),
      confirmationFollowUpCount: 2,
    });
    await run42DayDeliveryConfirmationNoResponse({
      runDate: ESCALATION_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
    });
    assert(
      String(store.internalNotificationEvents[0]?.bodyPreview ?? "").includes(
        "Customer did not respond after 3 total 42-day confirmation touches."
      ),
      "39 full sequence completed uses normal no-response escalation",
      failures
    );
  }

  for (const [label, status, providerCode] of [
    ["submitted", NotificationAttemptStatus.SUBMITTED, "SENT"],
    ["delivered", NotificationAttemptStatus.DELIVERED, "DELIVERED"],
  ] as const) {
    const store = new FakeDeliveryStore();
    const confirmation = store.seed({
      initialAttemptStatus: status,
      initialProviderCode: providerCode,
    });
    const history = await resolveDeliveryConfirmationTouchHistory({
      client: store.client,
      candidate: confirmation,
    });
    assertEqual(history.initial.completed, true, `${label} initial attempt counts`, failures);
  }
}

async function validatePreDispatchGuard(failures: Failure[]) {
  const readyStore = new FakeDeliveryStore();
  readyStore.seed({ deliveryDate: addDays(TOUCH2_RUN, 41) });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: TOUCH2_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: readyStore.client,
    currentStateRefresher: noopRefresh,
  });
  const readyEvent = readyStore.notificationEvents[0];
  const readyGuard = await guardDeliveryConfirmationNoResponseDispatch({
    client: readyStore.client,
    event: readyEvent as never,
    now: new Date(`${TOUCH2_RUN}T12:00:00.000Z`),
  });
  assertEqual(readyGuard.ok, true, "pre-dispatch guard allows current correct reminder", failures);

  for (const [label, mutate, expectedReason] of [
    [
      "confirmed before dispatch",
      (confirmation: DeliveryConfirmationNoResponseCandidate) => {
        confirmation.status = DeliveryConfirmationStatus.CONFIRMED;
        confirmation.confirmedAt = NOW;
      },
      DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.customerAlreadyResponded,
    ],
    [
      "requested date before dispatch",
      (confirmation: DeliveryConfirmationNoResponseCandidate) => {
        confirmation.requestedNewDate = addDays(TOUCH2_RUN, 45);
      },
      DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.customerAlreadyResponded,
    ],
    [
      "Acumatica confirmVia before dispatch",
      (confirmation: DeliveryConfirmationNoResponseCandidate) => {
        confirmation.orderDeliveryGroup.order.confirmVia = "SMS";
      },
      DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.alreadyConfirmedInAcumatica,
    ],
    [
      "date changed before dispatch",
      (confirmation: DeliveryConfirmationNoResponseCandidate) => {
        confirmation.orderDeliveryGroup.deliveryDate = addDays(TOUCH2_RUN, 42);
      },
      DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.staleDeliveryDate,
    ],
  ] as const) {
    const store = new FakeDeliveryStore();
    const confirmation = store.seed({ deliveryDate: addDays(TOUCH2_RUN, 41) });
    await run42DayDeliveryConfirmationNoResponse({
      runDate: TOUCH2_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
    });
    const event = store.notificationEvents[0];
    mutate(confirmation);
    const guard = await guardDeliveryConfirmationNoResponseDispatch({
      client: store.client,
      event: event as never,
      now: new Date(`${TOUCH2_RUN}T12:00:00.000Z`),
    });
    assertEqual(guard.ok, false, `${label} blocks dispatch`, failures);
    assertEqual(guard.reason, expectedReason, `${label} guard reason`, failures);
    assertEqual((event.attempts as unknown[]).length, 0, `${label} creates no attempt in guard validation`, failures);
  }
}

async function validateOrderScopedNoResponseCanary(failures: Failure[]) {
  const scope = { orderType: "SO", orderNumber: "SO38056" };

  {
    const store = new FakeDeliveryStore();
    store.seed({
      id: "scoped_canary",
      orderNumber: "SO38056",
      deliveryDate: addDays(TOUCH2_RUN, 41),
    });
    store.seed({
      id: "unrelated_order",
      orderNumber: "SO99999",
      deliveryDate: addDays(TOUCH2_RUN, 41),
    });
    store.seededNotificationEvents.push({
      id: "old_unrelated_day_42",
      dedupeKey: "delivery_confirmation_reminder:old:SO:SO99999:2026-09-08:touch_2",
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REMINDER,
      deliveryGroupId: "group_unrelated_order",
      deliveryDate: addDays(TOUCH2_RUN, 41),
      status: NotificationEventStatus.SCHEDULED,
      selectedChannel: NotificationChannel.SMS,
      recipientEmail: null,
      recipientPhone: "8015550199",
      reasonSkipped: null,
      attempts: [],
    });

    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: TOUCH2_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
      orderScope: scope,
    });

    assertEqual(summary.orderScope.enabled, true, "canary scope is reported enabled", failures);
    assertEqual(summary.orderScope.orderType, "SO", "canary scope reports order type", failures);
    assertEqual(summary.orderScope.orderNumber, "SO38056", "canary scope reports order number", failures);
    assertEqual(summary.orderScope.unscopedCount, 2, "canary scope reports unscoped count", failures);
    assertEqual(summary.orderScope.scopedCount, 1, "canary scope reports scoped count", failures);
    assertEqual(summary.eventReports.length, 1, "canary scope reports only scoped order", failures);
    assertEqual(store.notificationEvents.length, 1, "canary scope creates only one scoped event", failures);
    assertEqual(store.notificationEvents[0]?.orderNumber, "SO38056", "canary scope created event is SO38056 only", failures);
    assertEqual(
      summary.eventReports[0]?.orderNumber,
      "SO38056",
      "canary scope event report is SO38056 only",
      failures
    );
    assert(
      summary.dispatchableReminderEventIdsCreatedThisRun.every((id) =>
        store.notificationEvents.some((event) => event.id === id)
      ),
      "canary dispatch list includes only current scoped created events",
      failures
    );
  }

  {
    const store = new FakeDeliveryStore();
    store.seed({
      id: "wrong_scope_source",
      orderNumber: "SO38056",
      deliveryDate: addDays(TOUCH2_RUN, 41),
    });
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: TOUCH2_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
      orderScope: { orderType: "SO", orderNumber: "SO-NOT-THERE" },
    });
    assertEqual(summary.orderScope.scopedCount, 0, "wrong order scope has zero scoped candidates", failures);
    assertEqual(store.notificationEvents.length, 0, "wrong order scope creates no customer events", failures);
    assertEqual(summary.eventReports.length, 0, "wrong order scope reports no touched orders", failures);
  }

  {
    const store = new FakeDeliveryStore();
    store.seed({
      id: "scoped_no_channel",
      orderNumber: "SO38056",
      deliveryDate: addDays(TOUCH2_RUN, 41),
      smsOptIn: false,
      emailOptIn: false,
      phone1: null,
      email: null,
    });
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: TOUCH2_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
      orderScope: scope,
    });
    assertEqual(summary.remindersScheduled, 0, "canary scope does not force channel eligibility", failures);
    assertEqual(
      summary.skippedReasons[DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.noAutomatedChannelAvailable],
      1,
      "canary scope respects opt-in/opt-out no-channel result",
      failures
    );
  }

  {
    const store = new FakeDeliveryStore();
    store.seed({
      id: "scoped_incomplete_39",
      orderNumber: "SO38056",
      deliveryDate: addDays(ESCALATION_RUN, 39),
      initialTouchCompleted: false,
    });
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: ESCALATION_RUN,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: noopRefresh,
      orderScope: scope,
    });
    assertEqual(store.notificationEvents.length, 1, "canary scope follows 39-day touch-history catch-up decision", failures);
    assertEqual(summary.internalEscalationsCreated, 0, "canary scope does not escalate before missing customer touch", failures);
    assertEqual(summary.manualReviewMarked, 0, "canary scope does not mark manual review before touch sequence completes", failures);
  }
}

async function validateManualErpConfirmationStops(failures: Failure[]) {
  for (const [label, runDate, followUpCount] of [
    ["after touch 1 before touch 2", TOUCH2_RUN, 0],
    ["after touch 2 before touch 3", TOUCH3_RUN, 1],
    ["after touch 3 before escalation", ESCALATION_RUN, 2],
  ] as const) {
    const store = new FakeDeliveryStore();
    const confirmation = store.seed({ confirmationFollowUpCount: followUpCount });
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: mutateRefresh((candidate) => {
        candidate.orderDeliveryGroup.order.confirmVia = "Manual";
      }),
    });
    assertEqual(store.notificationEvents.length, 0, `manual CONFIRMVIA creates no customer event ${label}`, failures);
    assertEqual(store.internalNotificationEvents.length, 0, `manual CONFIRMVIA creates no escalation ${label}`, failures);
    assertEqual(summary.externalConfirmationsStopped, 1, `manual CONFIRMVIA counted ${label}`, failures);
    assertEqual(confirmation.status, DeliveryConfirmationStatus.CONFIRMED, `manual CONFIRMVIA marks local confirmed ${label}`, failures);
  }
}

async function validateDateBumpsAndWeekend(failures: Failure[]) {
  for (const [label, runDate, followUpCount] of [
    ["before touch 2", TOUCH2_RUN, 0],
    ["before touch 3", TOUCH3_RUN, 1],
    ["before escalation", ESCALATION_RUN, 2],
  ] as const) {
    const store = new FakeDeliveryStore();
    const confirmation = store.seed({ confirmationFollowUpCount: followUpCount });
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate,
      now: NOW,
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: mutateRefresh((candidate) => {
        candidate.orderDeliveryGroup.isActive = false;
      }),
    });
    assertEqual(store.notificationEvents.length, 0, `date bump creates no customer event ${label}`, failures);
    assertEqual(store.internalNotificationEvents.length, 0, `date bump creates no escalation ${label}`, failures);
    assertEqual(summary.staleConfirmationsExpired, 1, `date bump expires stale confirmation ${label}`, failures);
    assertEqual(confirmation.status, DeliveryConfirmationStatus.EXPIRED, `date bump status expired ${label}`, failures);
  }

  const saturdayStore = new FakeDeliveryStore();
  saturdayStore.seed({ deliveryDate: addDays("2026-07-25", 41) });
  const weekendSummary = await run42DayDeliveryConfirmationNoResponse({
    runDate: "2026-07-25",
    now: NOW,
    dryRun: false,
    prismaClient: saturdayStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertEqual(weekendSummary.weekendSkipped, true, "weekend run skips customer send", failures);
  assertEqual(saturdayStore.notificationEvents.length, 0, "weekend run does not count/create touch", failures);

  const deferredStore = new FakeDeliveryStore();
  const deferred = deferredStore.seed({ deliveryDate: addDays("2026-07-27", 39) });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: "2026-07-27",
    now: NOW,
    dryRun: false,
    prismaClient: deferredStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertEqual(deferredStore.notificationEvents.length, 1, "39-day incomplete weekend catch-up creates next customer touch", failures);
  assertIncludes(
    String(deferredStore.notificationEvents[0]?.dedupeKey ?? ""),
    "touch_2",
    "39-day catch-up sends reminder 1",
    failures
  );
  assertEqual(deferredStore.internalNotificationEvents.length, 0, "39-day incomplete weekend catch-up does not escalate internally", failures);
  assertEqual(deferred.confirmationFollowUpCount, 1, "39-day catch-up advances follow-up count", failures);
}

async function validateBusinessDayCatchUpBeforeEscalation(failures: Failure[]) {
  const mondayRun = "2026-07-27";
  const tuesdayRun = "2026-07-28";
  const wednesdayRun = "2026-07-29";

  const caseAStore = new FakeDeliveryStore();
  caseAStore.seed({
    id: "case_a",
    deliveryDate: addDays(mondayRun, 39),
    confirmationFollowUpCount: 0,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: mondayRun,
    now: NOW,
    dryRun: false,
    prismaClient: caseAStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertIncludes(
    String(caseAStore.notificationEvents[0]?.dedupeKey ?? ""),
    "touch_2",
    "case A Monday sends reminder 1",
    failures
  );
  assertEqual(caseAStore.internalNotificationEvents.length, 0, "case A Monday does not escalate", failures);

  const caseBStore = new FakeDeliveryStore();
  caseBStore.seed({
    id: "case_b",
    deliveryDate: addDays(tuesdayRun, 38),
    confirmationFollowUpCount: 1,
    reminder1Completed: true,
    reminder2Completed: false,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: tuesdayRun,
    now: NOW,
    dryRun: false,
    prismaClient: caseBStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertIncludes(
    String(caseBStore.notificationEvents[0]?.dedupeKey ?? ""),
    "touch_3",
    "case B Tuesday sends final reminder",
    failures
  );
  assertEqual(caseBStore.internalNotificationEvents.length, 0, "case B Tuesday does not escalate", failures);

  const caseCStore = new FakeDeliveryStore();
  caseCStore.seed({
    id: "case_c",
    deliveryDate: addDays(wednesdayRun, 37),
    confirmationFollowUpCount: 2,
    reminder1Completed: true,
    reminder2Completed: true,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: wednesdayRun,
    now: NOW,
    dryRun: false,
    prismaClient: caseCStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertEqual(caseCStore.notificationEvents.length, 0, "case C Wednesday creates no customer touch", failures);
  assertEqual(caseCStore.internalNotificationEvents.length, 1, "case C Wednesday escalates after all touches", failures);

  const caseDStore = new FakeDeliveryStore();
  caseDStore.seed({
    id: "case_d",
    deliveryDate: addDays(mondayRun, 39),
    initialTouchExists: false,
    initialTouchCompleted: false,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: mondayRun,
    now: NOW,
    dryRun: false,
    prismaClient: caseDStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertEqual(
    caseDStore.notificationEvents[0]?.actionType,
    NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    "case D sends initial catch-up",
    failures
  );
  assertEqual(caseDStore.internalNotificationEvents.length, 0, "case D does not escalate", failures);

  const caseEStore = new FakeDeliveryStore();
  caseEStore.seed({
    id: "case_e",
    deliveryDate: addDays(mondayRun, 39),
    confirmationFollowUpCount: 0,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: mondayRun,
    now: NOW,
    dryRun: false,
    prismaClient: caseEStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertIncludes(
    String(caseEStore.notificationEvents[0]?.dedupeKey ?? ""),
    "touch_2",
    "case E sends reminder 1",
    failures
  );
  assertEqual(caseEStore.internalNotificationEvents.length, 0, "case E does not escalate", failures);

  const caseFStore = new FakeDeliveryStore();
  caseFStore.seed({
    id: "case_f",
    deliveryDate: addDays(mondayRun, 39),
    confirmationFollowUpCount: 1,
    reminder1Completed: true,
    reminder2Completed: false,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: mondayRun,
    now: NOW,
    dryRun: false,
    prismaClient: caseFStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertIncludes(
    String(caseFStore.notificationEvents[0]?.dedupeKey ?? ""),
    "touch_3",
    "case F sends final reminder",
    failures
  );
  assertEqual(caseFStore.internalNotificationEvents.length, 0, "case F does not escalate", failures);

  const caseGStore = new FakeDeliveryStore();
  caseGStore.seed({
    id: "case_g",
    deliveryDate: addDays(mondayRun, 39),
    confirmationFollowUpCount: 2,
    reminder1Completed: true,
    reminder2Completed: true,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: mondayRun,
    now: NOW,
    dryRun: false,
    prismaClient: caseGStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertEqual(caseGStore.notificationEvents.length, 0, "case G creates no customer touch", failures);
  assertEqual(caseGStore.internalNotificationEvents.length, 1, "case G escalates after completed sequence", failures);
}

async function validateNoChannelAndDedupe(failures: Failure[]) {
  const noChannelStore = new FakeDeliveryStore();
  const noChannel = noChannelStore.seed({ smsOptIn: false, emailOptIn: false, phone1: null, email: null });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: TOUCH2_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: noChannelStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertEqual(noChannel.confirmationFollowUpCount, 0, "no-channel does not increment follow-up count", failures);
  assertEqual(noChannel.manualReviewRequired, true, "no-channel escalates/manual review immediately", failures);

  const dedupeStore = new FakeDeliveryStore();
  dedupeStore.seed();
  await run42DayDeliveryConfirmationNoResponse({
    runDate: TOUCH2_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: dedupeStore.client,
    currentStateRefresher: noopRefresh,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: TOUCH2_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: dedupeStore.client,
    currentStateRefresher: noopRefresh,
  });
  assertEqual(dedupeStore.notificationEvents.length, 1, "rerun touch 2 creates one event", failures);

  const escalationDedupe = new FakeDeliveryStore();
  escalationDedupe.seed({ confirmationFollowUpCount: 2 });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: ESCALATION_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: escalationDedupe.client,
    currentStateRefresher: noopRefresh,
  });
  await run42DayDeliveryConfirmationNoResponse({
    runDate: ESCALATION_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: escalationDedupe.client,
    currentStateRefresher: noopRefresh,
  });
  assertEqual(escalationDedupe.internalNotificationEvents.length, 1, "rerun escalation creates one internal event", failures);
}

async function validateStaleWebAndSms(failures: Failure[]) {
  let webUpdateCount = 0;
  const staleWebConfirmation: AnyRecord = {
    id: "web_stale",
    status: DeliveryConfirmationStatus.PENDING,
    confirmedAt: null,
    orderType: "SO",
    orderNumber: "SO-WEB",
    deliveryGroupId: "group_web",
    deliveryDate: DELIVERY_DATE,
    linkExpiresAt: new Date("2026-12-31T00:00:00.000Z"),
    linkExpiredAt: null,
    contact: { displayName: null, companyName: null, firstName: null, lastName: null, email: null },
    orderDeliveryGroup: {
      id: "group_web",
      isActive: false,
      deliveryDate: DELIVERY_DATE,
      order: { id: "order_web", confirmVia: null, address: { state: "UT", postalCode: "84101" } },
    },
  };
  const webClient: AnyRecord = {
    deliveryConfirmation: {
      findUnique: async () => staleWebConfirmation,
      update: async () => {
        webUpdateCount += 1;
        return staleWebConfirmation;
      },
    },
  };
  const webResult = await confirmDeliveryFromWebpage({
    linkToken: "token_web",
    prismaClient: webClient as NonNullable<
      Parameters<typeof confirmDeliveryFromWebpage>[0]["prismaClient"]
    >,
    refreshCurrentState: async () => {},
  });
  assertEqual(webResult.outcome, "stale", "stale webpage confirm is rejected", failures);
  assertEqual(webUpdateCount, 0, "stale webpage confirm does not update confirmation", failures);

  let smsUpdateCount = 0;
  let smsWritebackCalled = false;
  const smsClient: AnyRecord = {
    twilioInboundMessage: {
      findUnique: async () => null,
      create: async () => ({ id: "inbound_1" }),
      update: async () => ({ id: "inbound_1" }),
    },
    deliveryConfirmation: {
      findMany: async () => [
        {
          id: "sms_stale",
          notificationEventId: "event_sms",
          orderType: "SO",
          orderNumber: "SO-SMS",
          deliveryGroupId: "group_sms",
          deliveryDate: DELIVERY_DATE,
          status: DeliveryConfirmationStatus.PENDING,
          linkExpiresAt: new Date("2026-12-31T00:00:00.000Z"),
          linkExpiredAt: null,
          contact: {
            displayName: null,
            companyName: null,
            firstName: null,
            lastName: null,
            email: null,
            phone1: "+18015550100",
            phone2: null,
          },
          notificationEvent: { id: "event_sms" },
          orderDeliveryGroup: {
            id: "group_sms",
            isActive: false,
            deliveryDate: DELIVERY_DATE,
            order: { confirmVia: null },
          },
          order: { confirmVia: null, address: { state: "UT", postalCode: "84101" } },
        },
      ],
      findUnique: async () => null,
      update: async () => {
        smsUpdateCount += 1;
        return {};
      },
      updateMany: async () => ({ count: 0 }),
    },
    smsOptOut: { findMany: async () => [], update: async () => ({}), create: async () => ({}) },
    contact: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  };
  const smsResult = await handleTwilioInboundSms({
    payload: { MessageSid: "SM-STale", From: "+18015550100", To: "+18015550999", Body: "Y" },
    prismaClient: smsClient as NonNullable<
      Parameters<typeof handleTwilioInboundSms>[0]["prismaClient"]
    >,
    queueOptions: {
      fetchImpl: async () => {
        smsWritebackCalled = true;
        throw new Error("writeback should not be called");
      },
    },
  });
  assertEqual(smsResult.matchStatus, "MATCHED", "stale SMS still records matched inbound", failures);
  assert(Boolean(smsResult.responseMessage?.includes("no longer valid")), "stale SMS returns safe response", failures);
  assertEqual(smsUpdateCount, 0, "stale SMS does not update confirmation", failures);
  assertEqual(smsWritebackCalled, false, "stale SMS does not enqueue writeback", failures);
}

function validateStaticSafety(failures: Failure[]) {
  const noResponse = readFileSync(join(ROOT, "lib/notifications/deliveryConfirmationNoResponse.ts"), "utf8");
  const runner = readFileSync(join(ROOT, "scripts/run-42-day-confirmation-no-response.ts"), "utf8");
  const web = readFileSync(join(ROOT, "lib/notifications/confirmDeliveryFromWebpage.ts"), "utf8");
  const sms = readFileSync(join(ROOT, "lib/notifications/handleTwilioInboundSms.ts"), "utf8");

  assert(noResponse.includes("includeUnqualifiedOrderLookups: true"), "no-response refresh imports explicit order lookup", failures);
  assert(noResponse.includes("currentStateRefreshesFailed"), "no-response reports refresh failures", failures);
  assert(noResponse.includes("dispatchableReminderEventIdsCreatedThisRun"), "no-response exposes current-run dispatch ids", failures);
  assert(noResponse.includes("reminderEventsCreatedByTouch"), "no-response reports touch-specific creates", failures);
  assert(runner.includes("RUN REAL 42 DAY NO RESPONSE FOLLOW UPS"), "no-response runner requires exact production phrase", failures);
  assert(runner.includes("dispatchDeliveryNotifications"), "no-response runner uses shared dispatcher", failures);
  assert(runner.includes("dispatchableReminderEventIdsCreatedThisRun"), "no-response runner dispatches only created ids", failures);
  assert(runner.includes("oldScheduledDay42Events"), "no-response runner reports old scheduled DAY_42 rows", failures);
  assert(runner.includes("controlledRecipientSend: false"), "no-response runner does not use controlled routing", failures);
  assert(runner.includes("finalRecipientKind !== \"customer\""), "no-response runner validates real-customer routing", failures);
  assert(web.includes("guardDeliveryConfirmationWebAction"), "web actions use server-side guard helper", failures);
  assert(sms.includes("smsCurrentStateBlockMessage"), "SMS inbound uses stale/current-state guard", failures);

  for (const [label, source] of [["no-response", noResponse], ["runner", runner]] as const) {
    for (const forbidden of [
      "twilio.messages.create",
      "client.messages.create",
      "sendMail",
      "sendEmail",
      "sendSms",
      "placeHold",
      "enqueueDeliveryPrepaymentHold",
      "ONEWEEKCON",
      "CONFIRMWTH",
    ]) {
      assert(!source.includes(forbidden), `${label} excludes ${forbidden}`, failures);
    }
  }

  assertEqual(
    buildDeliveryConfirmationReminderDedupeKey({
      confirmationId: "conf",
      orderType: "SO",
      orderNumber: "SO1",
      deliveryDate: "2026-09-08",
      touchNumber: 2,
    }),
    "delivery_confirmation_reminder:conf:SO:SO1:2026-09-08:touch_2",
    "touch dedupe includes confirmation/date/touch",
    failures
  );
  assert(
    buildNotificationDedupeKey({
      orderType: "SO",
      orderNumber: "SO1",
      deliveryDate: "2026-09-08",
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    }) !==
      buildNotificationDedupeKey({
        orderType: "SO",
        orderNumber: "SO1",
        deliveryDate: "2026-09-15",
        intervalType: NotificationIntervalType.DAY_42,
        actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
      }),
    "new bumped date gets a distinct 42-day dedupe key",
    failures
  );
}

async function main() {
  const failures: Failure[] = [];
  await validateCoreAndCounting(failures);
  await validateTouchHistoryStateMachine(failures);
  await validatePreDispatchGuard(failures);
  await validateOrderScopedNoResponseCanary(failures);
  await validateManualErpConfirmationStops(failures);
  await validateDateBumpsAndWeekend(failures);
  await validateBusinessDayCatchUpBeforeEscalation(failures);
  await validateNoChannelAndDedupe(failures);
  await validateStaleWebAndSms(failures);
  validateStaticSafety(failures);

  if (failures.length > 0) {
    console.error("42-day confirmation no-response scenario validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        validation: "passed",
        scenarioGroups: {
          coreThreeTouchFlow: true,
          manualErpConfirmViaStops: true,
          deliveryDateBumpStopsOldChain: true,
          staleWebConfirmRejected: true,
          staleSmsConfirmRejected: true,
          weekendTouchCatchUp: true,
          noChannelDoesNotCountAsTouch: true,
          reminderAndEscalationDedupe: true,
          newDateDedupeAllowed: true,
          orderScopedCanaryMode: true,
        },
        safety: {
          noRealSms: true,
          noRealCustomerEmail: true,
          noProviderDispatch: true,
          noAcumaticaWrites: true,
          noConfirmViaConfirmWithOneWeekConWrites: true,
          noHoldWrites: true,
          noRealDeliveryDateOrOrderLineMutation: true,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
