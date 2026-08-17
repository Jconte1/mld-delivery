import "dotenv/config";

import { readFileSync } from "fs";
import { join } from "path";

import {
  DeliveryConfirmationStatus,
  NotificationActionType,
  NotificationChannel,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  buildDeliveryConfirmationReminderDedupeKey,
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

function assert(condition: unknown, message: string, failures: Failure[]) {
  if (!condition) failures.push(message);
}

function assertEqual<T>(actual: T, expected: T, message: string, failures: Failure[]) {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`, failures);
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
  internalNotificationEvents: AnyRecord[] = [];
  updates = 0;

  readonly client = {
    deliveryConfirmation: {
      findMany: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return this.confirmations.filter((confirmation) => matchesWhere(confirmation, where));
      },
      findUnique: async (args: unknown) => {
        const id = asRecord(asRecord(args).where).id;
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
        return this.notificationEvents.find((event) => event.dedupeKey === dedupeKey) ?? null;
      },
      create: async (args: { data: AnyRecord }) => {
        const event = {
          id: `event_${this.notificationEvents.length + 1}`,
          dedupeKey: String(args.data.dedupeKey),
          intervalType: args.data.intervalType as NotificationIntervalType,
          actionType: args.data.actionType as NotificationActionType,
          status: args.data.status as string,
          selectedChannel: (args.data.selectedChannel as string | null | undefined) ?? null,
          recipientEmail: (args.data.recipientEmail as string | null | undefined) ?? null,
          recipientPhone: (args.data.recipientPhone as string | null | undefined) ?? null,
          reasonSkipped: (args.data.reasonSkipped as string | null | undefined) ?? null,
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

  seed(options: Partial<{
    id: string;
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
  }> = {}) {
    const id = options.id ?? `confirmation_${this.confirmations.length + 1}`;
    const deliveryDate = options.deliveryDate ?? DELIVERY_DATE;
    const confirmation: DeliveryConfirmationNoResponseCandidate = {
      id,
      orderId: `order_${id}`,
      deliveryGroupId: `group_${id}`,
      notificationEventId: `original_${id}`,
      orderType: "SO",
      orderNumber: `SO-${id}`,
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
      notificationEvent: { selectedChannel: NotificationChannel.SMS },
      orderDeliveryGroup: {
        id: `group_${id}`,
        deliveryDate: options.groupDeliveryDate ?? deliveryDate,
        isActive: options.groupIsActive ?? true,
        status: "Open",
        deliveryGroupLines: options.hasActiveLines === false ? [] : [{ id: `line_${id}` }],
        order: {
          id: `order_${id}`,
          orderType: "SO",
          orderNumber: `SO-${id}`,
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
  await run42DayDeliveryConfirmationNoResponse({
    runDate: TOUCH3_RUN,
    now: NOW,
    dryRun: false,
    prismaClient: store.client,
    currentStateRefresher: noopRefresh,
  });
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
  assertEqual(deferredStore.notificationEvents.length, 1, "touch 2 catches up Monday after weekend", failures);
  assertEqual(deferred.confirmationFollowUpCount, 1, "deferred touch counts only when scheduled", failures);
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
  const web = readFileSync(join(ROOT, "lib/notifications/confirmDeliveryFromWebpage.ts"), "utf8");
  const sms = readFileSync(join(ROOT, "lib/notifications/handleTwilioInboundSms.ts"), "utf8");

  assert(noResponse.includes("includeUnqualifiedOrderLookups: true"), "no-response refresh imports explicit order lookup", failures);
  assert(noResponse.includes("currentStateRefreshesFailed"), "no-response reports refresh failures", failures);
  assert(web.includes("guardDeliveryConfirmationWebAction"), "web actions use server-side guard helper", failures);
  assert(sms.includes("smsCurrentStateBlockMessage"), "SMS inbound uses stale/current-state guard", failures);

  for (const [label, source] of [["no-response", noResponse]] as const) {
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
  await validateManualErpConfirmationStops(failures);
  await validateDateBumpsAndWeekend(failures);
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
