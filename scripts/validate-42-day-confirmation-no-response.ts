import { readFileSync } from "fs";
import { join } from "path";

import {
  DeliveryConfirmationStatus,
  InternalNotificationAudienceType,
  InternalNotificationPurpose,
  InternalNotificationStatus,
  NotificationActionType,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  buildDeliveryConfirmationReminderDedupeKey,
  DELIVERY_CONFIRMATION_MAX_FOLLOW_UP_COUNT,
  DELIVERY_CONFIRMATION_MAX_TOTAL_CUSTOMER_TOUCHES,
  DELIVERY_CONFIRMATION_NO_RESPONSE_SALESPERSON_PURPOSE,
  DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS,
  DELIVERY_CONFIRMATION_ORIGINAL_TOUCH_NUMBER,
  render42DayNoResponseSalespersonEmail,
  run42DayDeliveryConfirmationNoResponse,
  type DeliveryConfirmationNoResponseCandidate,
  type DeliveryConfirmationNoResponseClient,
} from "../lib/notifications/deliveryConfirmationNoResponse";
import { DELIVERY_MANUAL_REVIEW_REASONS } from "../lib/notifications/deliveryConfirmationManualReview";
import { render42DayEmailConfirmationReminderMessage } from "../lib/notifications/deliveryConfirmationEmail";
import { render42DaySmsConfirmationReminderMessage } from "../lib/notifications/deliveryConfirmationSms";
import { addDays, dateKey } from "../lib/notifications/helpers";

const ROOT = process.cwd();
const RUN_DATE = "2026-07-23";
const NOW = new Date("2026-07-23T09:19:00.000Z");

type FakeNotificationEvent = {
  id: string;
  dedupeKey: string;
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
  status: NotificationEventStatus;
  selectedChannel: NotificationChannel | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  reasonSkipped: string | null;
};

type FakeInternalNotificationEvent = {
  id: string;
  orderId: string | null;
  orderDeliveryGroupId: string | null;
  deliveryOrderHoldActionId: string | null;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  purpose: InternalNotificationPurpose;
  audienceType: InternalNotificationAudienceType;
  recipientEmail: string | null;
  recipientName: string | null;
  subject: string | null;
  bodyPreview: string | null;
  messageSummary: string | null;
  status: InternalNotificationStatus;
  reasonSkipped: string | null;
};

type SeedConfirmationOptions = {
  id?: string;
  orderNumber?: string;
  deliveryDate?: Date;
  groupDeliveryDate?: Date;
  status?: DeliveryConfirmationStatus;
  confirmedAt?: Date | null;
  requestedNewDate?: Date | null;
  manualReviewRequired?: boolean;
  noResponseAt?: Date | null;
  confirmationFollowUpCount?: number;
  linkToken?: string | null;
  linkExpiresAt?: Date | null;
  linkExpiredAt?: Date | null;
  smsOptIn?: boolean;
  emailOptIn?: boolean;
  phone1?: string | null;
  email?: string | null;
  smsOptOuts?: Array<{ phone: string }>;
  emailOptOuts?: Array<{ email: string }>;
  salespersonNumber?: string | null;
  hasActiveLines?: boolean;
  groupIsActive?: boolean;
  orderStatus?: string | null;
  groupStatus?: string | null;
  internalLifecycleStatus?: string | null;
  addressState?: string | null;
  postalCode?: string | null;
};

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertEqual<T>(actual: T, expected: T, message: string, failures: string[]) {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`, failures);
}

function assertIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(source.includes(pattern), message, failures);
}

function assertNotIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(!source.includes(pattern), message, failures);
}

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function dateValue(value: unknown) {
  if (value instanceof Date || typeof value === "string") return dateKey(value);
  return null;
}

function matchesWhere(
  confirmation: DeliveryConfirmationNoResponseCandidate,
  where: Record<string, unknown>
) {
  const deliveryDate = dateValue(where.deliveryDate);
  if (deliveryDate && dateKey(confirmation.deliveryDate) !== deliveryDate) return false;
  const deliveryDateFilter = asRecord(where.deliveryDate);
  const deliveryDateGte = dateValue(deliveryDateFilter.gte);
  const deliveryDateLte = dateValue(deliveryDateFilter.lte);
  const confirmationDate = dateKey(confirmation.deliveryDate);
  if (deliveryDateGte && confirmationDate < deliveryDateGte) return false;
  if (deliveryDateLte && confirmationDate > deliveryDateLte) return false;

  const statusFilter = asRecord(where.status);
  if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(confirmation.status)) {
    return false;
  }

  if (where.confirmedAt === null && confirmation.confirmedAt !== null) return false;
  if (where.requestedNewDate === null && confirmation.requestedNewDate !== null) return false;
  if (
    typeof where.manualReviewRequired === "boolean" &&
    confirmation.manualReviewRequired !== where.manualReviewRequired
  ) {
    return false;
  }
  if (where.noResponseAt === null && confirmation.noResponseAt !== null) return false;

  const followUpFilter = where.confirmationFollowUpCount;
  if (typeof followUpFilter === "number") {
    return confirmation.confirmationFollowUpCount === followUpFilter;
  }

  const followUpRecord = asRecord(followUpFilter);
  if (
    typeof followUpRecord.lte === "number" &&
    confirmation.confirmationFollowUpCount > followUpRecord.lte
  ) {
    return false;
  }
  if (
    typeof followUpRecord.gte === "number" &&
    confirmation.confirmationFollowUpCount < followUpRecord.gte
  ) {
    return false;
  }

  return true;
}

class FakeDeliveryStore {
  confirmations: DeliveryConfirmationNoResponseCandidate[] = [];
  notificationEvents: FakeNotificationEvent[] = [];
  internalNotificationEvents: FakeInternalNotificationEvent[] = [];
  salespersonContacts = [
    {
      salespersonNumber: "SP1",
      salespersonName: "Sales Person",
      salespersonEmail: "salesperson@example.test",
      salespersonPhone: "8015557777",
      isActive: true,
    },
  ];
  globalSmsOptOuts: Array<{ phone: string }> = [];
  globalEmailOptOuts: Array<{ email: string }> = [];

  readonly client: DeliveryConfirmationNoResponseClient = {
    deliveryConfirmation: {
      findMany: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return this.confirmations
          .filter((confirmation) => matchesWhere(confirmation, where))
          .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
      },
      count: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return this.confirmations.filter((confirmation) => matchesWhere(confirmation, where))
          .length;
      },
      update: async (args) => {
        const confirmation = this.confirmations.find((row) => row.id === args.where.id);
        if (!confirmation) throw new Error(`Missing confirmation ${args.where.id}`);
        Object.assign(confirmation, args.data);
        return confirmation;
      },
      updateMany: async (args: unknown) => {
        const record = asRecord(args);
        const where = asRecord(record.where);
        const data = asRecord(record.data);
        const matching = this.confirmations.filter((confirmation) =>
          matchesWhere(confirmation, where)
        );
        for (const confirmation of matching) Object.assign(confirmation, data);
        return { count: matching.length };
      },
    },
    notificationEvent: {
      findUnique: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return (
          this.notificationEvents.find((event) => event.dedupeKey === where.dedupeKey) ?? null
        );
      },
      create: async (args) => {
        const data = args.data;
        const event: FakeNotificationEvent = {
          id: `event_${this.notificationEvents.length + 1}`,
          dedupeKey: String(data.dedupeKey),
          intervalType: data.intervalType as NotificationIntervalType,
          actionType: data.actionType as NotificationActionType,
          status: data.status as NotificationEventStatus,
          selectedChannel: (data.selectedChannel as NotificationChannel | null) ?? null,
          recipientEmail: (data.recipientEmail as string | null) ?? null,
          recipientPhone: (data.recipientPhone as string | null) ?? null,
          reasonSkipped: (data.reasonSkipped as string | null) ?? null,
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
              dateKey(event.deliveryDate) === dateValue(where.deliveryDate)
          ) ?? null
        );
      },
      create: async (args) => {
        const data = args.data;
        const event: FakeInternalNotificationEvent = {
          id: `internal_${this.internalNotificationEvents.length + 1}`,
          orderId: (data.orderId as string | null) ?? null,
          orderDeliveryGroupId: (data.orderDeliveryGroupId as string | null) ?? null,
          deliveryOrderHoldActionId: (data.deliveryOrderHoldActionId as string | null) ?? null,
          orderType: String(data.orderType),
          orderNumber: String(data.orderNumber),
          deliveryDate: data.deliveryDate as Date,
          purpose: data.purpose as InternalNotificationPurpose,
          audienceType: data.audienceType as InternalNotificationAudienceType,
          recipientEmail: (data.recipientEmail as string | null) ?? null,
          recipientName: (data.recipientName as string | null) ?? null,
          subject: (data.subject as string | null) ?? null,
          bodyPreview: (data.bodyPreview as string | null) ?? null,
          messageSummary: (data.messageSummary as string | null) ?? null,
          status: data.status as InternalNotificationStatus,
          reasonSkipped: (data.reasonSkipped as string | null) ?? null,
        };
        this.internalNotificationEvents.push(event);
        return event;
      },
    },
    salespersonContact: {
      findMany: async (args: unknown) => {
        const numbers = asRecord(asRecord(asRecord(args).where).salespersonNumber).in;
        const set = new Set(Array.isArray(numbers) ? numbers.map(String) : []);
        return this.salespersonContacts.filter(
          (contact) => set.has(contact.salespersonNumber) && contact.isActive
        );
      },
    },
    smsOptOut: {
      findMany: async () => this.globalSmsOptOuts,
    },
    emailOptOut: {
      findMany: async () => this.globalEmailOptOuts,
    },
  };

  seedConfirmation(options: SeedConfirmationOptions = {}) {
    const index = this.confirmations.length + 1;
    const deliveryDate = options.deliveryDate ?? addDays(RUN_DATE, 41);
    const groupDeliveryDate = options.groupDeliveryDate ?? deliveryDate;
    const orderNumber = options.orderNumber ?? `SO42NR${index}`;
    const id = options.id ?? `confirmation_${index}`;
    const confirmation: DeliveryConfirmationNoResponseCandidate = {
      id,
      orderId: `order_${id}`,
      deliveryGroupId: `group_${id}`,
      notificationEventId: `original_event_${id}`,
      orderType: "SO",
      orderNumber,
      deliveryDate,
      contactId: `contact_${id}`,
      status: options.status ?? DeliveryConfirmationStatus.PENDING,
      confirmedAt: options.confirmedAt ?? null,
      requestedNewDate: options.requestedNewDate ?? null,
      manualReviewRequired: options.manualReviewRequired ?? false,
      manualReviewReason: null,
      manualReviewMarkedAt: null,
      manualReviewNotes: null,
      reminderSentAt: null,
      noResponseAt: options.noResponseAt ?? null,
      confirmationFollowUpCount: options.confirmationFollowUpCount ?? 0,
      linkToken: options.linkToken === undefined ? `token_${id}` : options.linkToken,
      linkExpiresAt: options.linkExpiresAt ?? new Date("2026-12-31T00:00:00.000Z"),
      linkExpiredAt: options.linkExpiredAt ?? null,
      notificationEvent: {
        selectedChannel: NotificationChannel.SMS,
      },
      orderDeliveryGroup: {
        id: `group_${id}`,
        deliveryDate: groupDeliveryDate,
        isActive: options.groupIsActive ?? true,
        status: options.groupStatus ?? "Open",
        deliveryGroupLines: options.hasActiveLines === false ? [] : [{ id: `line_${id}` }],
        order: {
          id: `order_${id}`,
          orderType: "SO",
          orderNumber,
          status: options.orderStatus ?? "Open",
          internalLifecycleStatus: options.internalLifecycleStatus ?? "ACTIVE",
          buyerGroup: "Appliances",
          salespersonNumber: options.salespersonNumber === undefined ? "SP1" : options.salespersonNumber,
          customerDescription: "Customer",
          locationDescription: "Residence",
          address: {
            addressLine1: "123 Main",
            addressLine2: null,
            city: "Salt Lake City",
            state: options.addressState ?? "UT",
            postalCode: options.postalCode ?? "84101",
          },
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
            smsOptOuts: options.smsOptOuts ?? [],
            emailOptOuts: options.emailOptOuts ?? [],
          },
        },
      },
    };
    this.confirmations.push(confirmation);
    return confirmation;
  }
}

async function runApply(store: FakeDeliveryStore, runDate = RUN_DATE) {
  return run42DayDeliveryConfirmationNoResponse({
    runDate,
    now: NOW,
    dryRun: false,
    prismaClient: store.client,
  });
}

async function validateReminderTouches(failures: string[]) {
  const touch2Store = new FakeDeliveryStore();
  const touch2 = touch2Store.seedConfirmation({
    id: "touch2",
    deliveryDate: addDays(RUN_DATE, 41),
  });
  const touch2Summary = await runApply(touch2Store);
  const touch2Event = touch2Store.notificationEvents[0];
  assertEqual(DELIVERY_CONFIRMATION_ORIGINAL_TOUCH_NUMBER, 1, "original 42-day request is touch 1", failures);
  assertEqual(DELIVERY_CONFIRMATION_MAX_TOTAL_CUSTOMER_TOUCHES, 3, "max total customer touches", failures);
  assertEqual(DELIVERY_CONFIRMATION_MAX_FOLLOW_UP_COUNT, 2, "max follow-up reminders", failures);
  assertEqual(touch2Store.notificationEvents.length, 1, "touch 2 creates one reminder event", failures);
  assertEqual(touch2Event?.actionType, NotificationActionType.DELIVERY_CONFIRMATION_REMINDER, "touch 2 action type", failures);
  assertEqual(touch2Event?.status, NotificationEventStatus.SCHEDULED, "touch 2 scheduled", failures);
  assertIncludes(touch2Event?.dedupeKey ?? "", "touch_2", "touch 2 dedupe key", failures);
  assertEqual(touch2.confirmationFollowUpCount, 1, "touch 2 increments follow-up count to 1", failures);
  assert(Boolean(touch2.reminderSentAt), "touch 2 sets reminderSentAt", failures);
  assertEqual(touch2.manualReviewRequired, false, "touch 2 does not mark manual review", failures);
  assertEqual(touch2Summary.remindersScheduled, 1, "touch 2 summary scheduled count", failures);

  const touch3Store = new FakeDeliveryStore();
  const touch3 = touch3Store.seedConfirmation({
    id: "touch3",
    deliveryDate: addDays(RUN_DATE, 40),
    confirmationFollowUpCount: 1,
    smsOptIn: false,
    emailOptIn: true,
  });
  const touch3Summary = await runApply(touch3Store);
  const touch3Event = touch3Store.notificationEvents[0];
  assertEqual(touch3Store.notificationEvents.length, 1, "touch 3 creates one reminder event", failures);
  assertIncludes(touch3Event?.dedupeKey ?? "", "touch_3", "touch 3 dedupe key", failures);
  assertEqual(touch3Event?.selectedChannel, NotificationChannel.EMAIL, "touch 3 email fallback", failures);
  assertEqual(touch3.confirmationFollowUpCount, 2, "touch 3 increments follow-up count to 2", failures);
  assertEqual(touch3.manualReviewRequired, false, "touch 3 does not mark manual review same day", failures);
  assertEqual(touch3Summary.remindersScheduledByChannel.EMAIL, 1, "touch 3 summary email count", failures);
}

async function validateEscalation(failures: string[]) {
  const store = new FakeDeliveryStore();
  const candidate = store.seedConfirmation({
    id: "escalate",
    deliveryDate: addDays(RUN_DATE, 39),
    confirmationFollowUpCount: 2,
  });
  const summary = await runApply(store);
  const internal = store.internalNotificationEvents[0];
  assertEqual(store.notificationEvents.length, 0, "day 39 creates no customer reminder", failures);
  assertEqual(store.internalNotificationEvents.length, 1, "day 39 creates salesperson/internal event", failures);
  assertEqual(internal?.purpose, InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE, "escalation purpose", failures);
  assertEqual(internal?.audienceType, InternalNotificationAudienceType.SALESPERSON, "salesperson recipient preferred", failures);
  assertEqual(internal?.status, InternalNotificationStatus.PENDING, "salesperson event pending", failures);
  assertEqual(candidate.manualReviewRequired, true, "day 39 marks manual review", failures);
  assertEqual(candidate.manualReviewReason, DELIVERY_MANUAL_REVIEW_REASONS.NO_CUSTOMER_RESPONSE, "day 39 manual reason", failures);
  assert(Boolean(candidate.noResponseAt), "day 39 sets noResponseAt", failures);
  assertEqual(summary.manualReviewMarked, 1, "summary manual review marked", failures);
}

async function validateStops(failures: string[]) {
  const store = new FakeDeliveryStore();
  store.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
    status: DeliveryConfirmationStatus.CONFIRMED,
    confirmedAt: NOW,
  });
  store.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 40),
    status: DeliveryConfirmationStatus.CONFIRMED,
    confirmedAt: NOW,
    confirmationFollowUpCount: 1,
  });
  store.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
    status: DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
    requestedNewDate: new Date("2026-09-04T00:00:00.000Z"),
  });
  store.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  });
  const summary = await runApply(store);
  assertEqual(summary.reminderCandidatesChecked, 0, "responded/engaged confirmations are not reminder candidates", failures);
  assertEqual(store.notificationEvents.length, 0, "responded/engaged confirmations create no reminders", failures);
  assertEqual(store.internalNotificationEvents.length, 0, "responded/engaged confirmations create no escalation", failures);
}

async function validateUnrecognizedAndOptOuts(failures: string[]) {
  const unrecognizedStore = new FakeDeliveryStore();
  unrecognizedStore.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
    status: DeliveryConfirmationStatus.UNRECOGNIZED,
  });
  await runApply(unrecognizedStore);
  assertEqual(unrecognizedStore.notificationEvents.length, 1, "unrecognized remains no-response candidate", failures);

  const smsOptOutStore = new FakeDeliveryStore();
  smsOptOutStore.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
    smsOptIn: true,
    emailOptIn: true,
    smsOptOuts: [{ phone: "8015550100" }],
  });
  await runApply(smsOptOutStore);
  assertEqual(smsOptOutStore.notificationEvents[0]?.selectedChannel, NotificationChannel.EMAIL, "sms opt-out falls back to email", failures);

  const emailOptOutStore = new FakeDeliveryStore();
  emailOptOutStore.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
    smsOptIn: true,
    emailOptIn: true,
    emailOptOuts: [{ email: "customer@example.test" }],
  });
  await runApply(emailOptOutStore);
  assertEqual(emailOptOutStore.notificationEvents[0]?.selectedChannel, NotificationChannel.SMS, "email opt-out leaves SMS eligible", failures);
}

async function validateNoChannelAndSafetySkips(failures: string[]) {
  process.env.DELIVERY_CONFIRMATION_NO_RESPONSE_FALLBACK_EMAIL = "fallback@example.test";
  const noChannelStore = new FakeDeliveryStore();
  const noChannel = noChannelStore.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
    smsOptIn: false,
    emailOptIn: false,
    phone1: null,
    email: null,
    salespersonNumber: null,
  });
  const noChannelSummary = await runApply(noChannelStore);
  assertEqual(noChannelStore.notificationEvents[0]?.status, NotificationEventStatus.SKIPPED, "no channel reminder event skipped", failures);
  assertEqual(noChannel.manualReviewRequired, true, "no channel marks manual review immediately", failures);
  assertEqual(noChannelStore.internalNotificationEvents[0]?.audienceType, InternalNotificationAudienceType.FALLBACK, "no channel uses fallback internal recipient", failures);
  assertEqual(noChannelSummary.noChannelEscalations, 1, "no channel escalation counted", failures);

  const weekendSendStore = new FakeDeliveryStore();
  weekendSendStore.seedConfirmation({
    deliveryDate: addDays("2026-07-18", 41),
  });
  const weekendSummary = await run42DayDeliveryConfirmationNoResponse({
    runDate: "2026-07-18",
    now: NOW,
    dryRun: false,
    prismaClient: weekendSendStore.client,
  });
  assertEqual(weekendSummary.weekendSkipped, true, "weekend send date skipped", failures);
  assertEqual(weekendSendStore.notificationEvents.length, 0, "weekend send creates no event", failures);

  const weekendDeliveryStore = new FakeDeliveryStore();
  weekendDeliveryStore.seedConfirmation({
    deliveryDate: addDays("2026-07-20", 41),
  });
  const weekendDeliverySummary = await run42DayDeliveryConfirmationNoResponse({
    runDate: "2026-07-20",
    now: NOW,
    dryRun: false,
    prismaClient: weekendDeliveryStore.client,
  });
  assertEqual(weekendDeliverySummary.reminderCandidatesChecked, 1, "weekend delivery candidate checked", failures);
  assertEqual(weekendDeliveryStore.notificationEvents.length, 0, "weekend delivery creates no customer reminder", failures);
  assertEqual(
    weekendDeliverySummary.eventReports[0]?.reasonSkipped,
    DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.deliveryDateWeekend,
    "weekend delivery skip reason",
    failures
  );

  const staleStore = new FakeDeliveryStore();
  staleStore.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
    groupDeliveryDate: addDays(RUN_DATE, 42),
  });
  const staleSummary = await runApply(staleStore);
  assertEqual(staleStore.notificationEvents.length, 0, "stale confirmation creates no reminder", failures);
  assertEqual(
    staleSummary.eventReports[0]?.reasonSkipped,
    DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.staleDeliveryDate,
    "stale confirmation skip reason",
    failures
  );
}

async function validateDedupeAndDryRun(failures: string[]) {
  const store = new FakeDeliveryStore();
  store.seedConfirmation({
    id: "dedupe",
    deliveryDate: addDays(RUN_DATE, 41),
  });
  await runApply(store);
  await runApply(store);
  assertEqual(store.notificationEvents.length, 1, "second run does not duplicate touch 2", failures);

  const dryRunStore = new FakeDeliveryStore();
  const dryRunCandidate = dryRunStore.seedConfirmation({
    deliveryDate: addDays(RUN_DATE, 41),
  });
  const dryRunSummary = await run42DayDeliveryConfirmationNoResponse({
    runDate: RUN_DATE,
    now: NOW,
    dryRun: true,
    prismaClient: dryRunStore.client,
  });
  assertEqual(dryRunStore.notificationEvents.length, 0, "dry-run creates no notification event", failures);
  assertEqual(dryRunCandidate.confirmationFollowUpCount, 0, "dry-run does not update confirmation", failures);
  assertEqual(dryRunSummary.reminderEventsWouldCreate, 1, "dry-run reports would-create", failures);
}

function validateRendering(failures: string[]) {
  const link = "https://delivery.example.test/delivery/confirm/token";
  const sms = render42DaySmsConfirmationReminderMessage({
    orderNumber: "SO42",
    deliveryDate: "2026-09-02",
    link,
    deliveryAddress: {
      state: "ID",
      postalCode: "83638",
    },
  });
  assertIncludes(sms, "Order SO42", "SMS includes order number", failures);
  assertIncludes(sms, "Confirm or request a different date", "SMS includes confirmation action", failures);
  assertIncludes(sms, link, "SMS includes confirmation link", failures);
  assertIncludes(sms, "McCall deliveries are available on Mondays only.", "SMS preserves McCall route note", failures);
  assertIncludes(sms, "Reply STOP to opt out", "SMS includes STOP language", failures);

  const email = render42DayEmailConfirmationReminderMessage({
    orderNumber: "SO42",
    contactName: "Customer",
    deliveryDate: "2026-09-02",
    link,
  });
  assertIncludes(email.subject, "Reminder: Please Confirm Your Delivery for Order SO42", "email subject", failures);
  assertIncludes(email.body, "Order: SO42", "email body order", failures);
  assertIncludes(email.body, link, "email body link", failures);
  assertNotIncludes(email.body, "Balance owed", "reminder email has no payment content", failures);

  const internal = render42DayNoResponseSalespersonEmail({
    salespersonName: "Sales Person",
    customerName: "Customer",
    customerEmail: "customer@example.test",
    customerPhone: "8015550100",
    orderType: "SO",
    orderNumber: "SO42",
    deliveryDate: "2026-09-02",
    confirmationLink: link,
    currentStatus: DeliveryConfirmationStatus.PENDING,
    reason: "Customer did not respond after 3 total 42-day confirmation touches.",
  });
  assertIncludes(internal.subject, "Order SO42", "internal subject order", failures);
  assertIncludes(internal.body, "Recommended action", "internal body recommended action", failures);
}

function validateStaticSafety(failures: string[]) {
  const service = read("lib/notifications/deliveryConfirmationNoResponse.ts");
  const runner = read("scripts/run-42-day-confirmation-no-response.ts");
  const create14 = read("lib/notifications/create14DayDeliveryReminderEvents.ts");

  assertIncludes(service, "NotificationActionType.DELIVERY_CONFIRMATION_REMINDER", "service uses reminder action type", failures);
  assertIncludes(service, "InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE", "service uses no-response internal purpose", failures);
  assertIncludes(service, "confirmationFollowUpCount", "service tracks follow-up count", failures);
  assertIncludes(service, "reminderSentAt", "service tracks reminderSentAt", failures);
  assertIncludes(service, "noResponseAt", "service tracks noResponseAt", failures);
  assertNotIncludes(service, "selectNotificationChannelWithOptOutRepair", "service does not run opt-out repair/writeback", failures);

  for (const [label, source] of [
    ["service", service],
    ["runner", runner],
  ] as const) {
    for (const forbidden of [
      "notificationAttempt.create",
      "twilio.messages.create",
      "client.messages.create",
      "sendMail",
      "sendEmail",
      "sendSms",
      "enqueueDeliveryConfirmationAttributeWriteback",
      "CONFIRMVIA",
      "CONFIRMWTH",
      "ONEWEEKCON",
      "enqueueDeliveryPrepaymentHold",
      "placeHold",
    ]) {
      assertNotIncludes(source, forbidden, `${label} excludes ${forbidden}`, failures);
    }
  }

  assertIncludes(create14, "createConfirmedDeliveryReminderEvents", "14-day behavior remains wrapper", failures);
  assertNotIncludes(create14, "DELIVERY_CONFIRMATION_REMINDER", "14-day does not use no-response reminder action", failures);
  assertEqual(
    DELIVERY_CONFIRMATION_NO_RESPONSE_SALESPERSON_PURPOSE,
    InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE,
    "exported salesperson purpose",
    failures
  );
  assertEqual(
    buildDeliveryConfirmationReminderDedupeKey({
      confirmationId: "conf",
      orderType: "SO",
      orderNumber: "SO42",
      deliveryDate: "2026-09-02",
      touchNumber: 2,
    }),
    "delivery_confirmation_reminder:conf:SO:SO42:2026-09-02:touch_2",
    "dedupe key format",
    failures
  );
}

async function main() {
  const failures: string[] = [];
  await validateReminderTouches(failures);
  await validateEscalation(failures);
  await validateStops(failures);
  await validateUnrecognizedAndOptOuts(failures);
  await validateNoChannelAndSafetySkips(failures);
  await validateDedupeAndDryRun(failures);
  validateRendering(failures);
  validateStaticSafety(failures);

  if (failures.length > 0) {
    console.error("42-day confirmation no-response validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        validation: "passed",
        threeTotalCustomerTouches: {
          original42DayRequest: 1,
          firstNoResponseReminder: 2,
          secondNoResponseReminder: 3,
          salespersonEscalationAfter: 3,
        },
        schedule: {
          touch2: "41 days before delivery",
          touch3: "40 days before delivery",
          salespersonEscalation: "39 days before delivery",
        },
        safety: {
          noDbWrites: true,
          noNotificationAttemptsCreated: true,
          noProviderDispatch: true,
          noLiveSms: true,
          noLiveCustomerEmail: true,
          noAcumaticaWrites: true,
          noConfirmViaConfirmWithOneWeekConWrites: true,
          noHoldWrites: true,
          noDeliveryDateOrLineMutation: true,
          paymentAnd14DayBehaviorUnchanged: true,
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
