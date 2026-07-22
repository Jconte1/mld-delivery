import "dotenv/config";

import { POST as inboundSmsPost } from "../app/api/webhooks/twilio/inbound-sms/route";
import {
  DeliveryConfirmationStatus,
  NotificationActionType,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import { handleTwilioInboundSms } from "../lib/notifications/handleTwilioInboundSms";
import { handleTwilioMessageStatus } from "../lib/notifications/handleTwilioMessageStatus";
import { DELIVERY_MANUAL_REVIEW_REASONS } from "../lib/notifications/deliveryConfirmationManualReview";
import {
  getSmsConfirmedMessage,
} from "../lib/notifications/deliveryConfirmationSmsReplies";
import {
  mark39DayNoResponseManualReview,
  planDeliveryConfirmationNoResponseWork,
} from "../lib/notifications/deliveryConfirmationNoResponse";
import { addDays, dateKey } from "../lib/notifications/helpers";

type ContactRecord = {
  contactId: string;
  displayName: string | null;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone1: string | null;
  phone2: string | null;
};

type NotificationEventRecord = {
  id: string;
  orderId: string;
  deliveryGroupId: string;
  contactId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
  dedupeKey: string;
  selectedChannel: NotificationChannel | null;
  status: NotificationEventStatus;
  externalMessageId: string | null;
  createdAt: Date;
  scheduledAt: Date | null;
  triggeredAt: Date | null;
  sentAt: Date | null;
};

type NotificationAttemptRecord = {
  id: string;
  notificationEventId: string;
  attemptNumber: number;
  channel: NotificationChannel;
  provider: string | null;
  success: boolean;
  errorMessage: string | null;
  providerCode: string | null;
  httpStatus: number | null;
  externalMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
};

type DeliveryConfirmationRecord = {
  id: string;
  orderId: string;
  deliveryGroupId: string;
  notificationEventId: string | null;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  contactId: string;
  status: DeliveryConfirmationStatus;
  responseChannel: NotificationChannel | null;
  rawResponse: string | null;
  normalizedResponse: string | null;
  confirmedAt: Date | null;
  changeRequestedAt: Date | null;
  requestedNewDate: Date | null;
  requestedNewDateRaw: string | null;
  requestedNewDateAt: Date | null;
  reminderSentAt: Date | null;
  noResponseAt: Date | null;
  manualReviewRequired: boolean;
  manualReviewReason: string | null;
  manualReviewMarkedAt: Date | null;
  manualReviewNotes: string | null;
  unrecognizedResponseCount: number;
  confirmationFollowUpCount: number;
  lastSmsResponseAt: Date | null;
  lastSmsResponseBody: string | null;
  linkToken: string | null;
  linkCreatedAt: Date | null;
  linkExpiresAt: Date | null;
  linkExpiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  address: {
    state: string | null;
    postalCode: string | null;
  } | null;
};

type SmsOptOutRecord = {
  id: string;
  contactId: string | null;
  phone: string;
  source: string | null;
  reason: string | null;
  optedOutAt: Date;
  optedBackInAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type TwilioInboundRecord = {
  id: string;
  messageSid: string | null;
  parsedIntent: string;
  matchStatus: string;
  deliveryConfirmationId: string | null;
  notificationEventId: string | null;
  rawPayload: Record<string, string>;
  processedAt: Date | null;
  responseMessage: string | null;
  responseSent: boolean;
};

type TwilioStatusRecord = {
  id: string;
  callbackKey: string;
  messageSid: string;
  messageStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  notificationAttemptId: string | null;
  notificationEventId: string | null;
  deliveryConfirmationId: string | null;
  matchStatus: string;
  rawPayload: Record<string, string>;
  processedAt: Date | null;
};

type QueueRequest = {
  url: string;
  payload: Record<string, unknown>;
};

const NOW = new Date("2026-07-21T12:00:00.000Z");
const TO_PHONE = "+13855550100";

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertIncludes(value: string | null | undefined, expected: string, label: string) {
  if (!value?.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(value)} to include ${expected}`);
  }
}

function applyData(record: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === "object" &&
      "increment" in value &&
      typeof value.increment === "number"
    ) {
      record[key] = Number(record[key] ?? 0) + value.increment;
      continue;
    }
    record[key] = value;
  }
}

function selectFields(record: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return record;
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, include]) => include)
      .map(([key]) => [key, record[key]])
  );
}

function matchesDate(left: Date | null, right: Date) {
  return Boolean(left && dateKey(left) === dateKey(right));
}

class MockDeliveryStore {
  contacts: ContactRecord[] = [];
  notificationEvents: NotificationEventRecord[] = [];
  notificationAttempts: NotificationAttemptRecord[] = [];
  deliveryConfirmations: DeliveryConfirmationRecord[] = [];
  smsOptOuts: SmsOptOutRecord[] = [];
  inboundMessages: TwilioInboundRecord[] = [];
  statusCallbacks: TwilioStatusRecord[] = [];
  private sequence = 1;

  readonly client = {
    contact: {
      findMany: async (args: { where?: { OR?: Array<Record<string, { in: string[] }>> } }) => {
        const values = new Set<string>();
        for (const condition of args.where?.OR ?? []) {
          const phone1 = condition.phone1?.in ?? [];
          const phone2 = condition.phone2?.in ?? [];
          for (const value of [...phone1, ...phone2]) values.add(value);
        }

        return this.contacts.filter(
          (contact) =>
            !values.size ||
            (contact.phone1 && values.has(contact.phone1)) ||
            (contact.phone2 && values.has(contact.phone2))
        );
      },
    },
    smsOptOut: {
      findFirst: async (args: { where: { phone?: string; isActive?: boolean } }) =>
        this.smsOptOuts.find(
          (row) =>
            (args.where.phone === undefined || row.phone === args.where.phone) &&
            (args.where.isActive === undefined || row.isActive === args.where.isActive)
        ) ?? null,
      create: async (args: { data: Partial<SmsOptOutRecord> }) => {
        const record: SmsOptOutRecord = {
          id: this.id("sms_opt_out"),
          contactId: args.data.contactId ?? null,
          phone: String(args.data.phone),
          source: args.data.source ?? null,
          reason: args.data.reason ?? null,
          optedOutAt: args.data.optedOutAt ?? NOW,
          optedBackInAt: args.data.optedBackInAt ?? null,
          isActive: args.data.isActive ?? true,
          createdAt: NOW,
          updatedAt: NOW,
        };
        this.smsOptOuts.push(record);
        return record;
      },
      update: async (args: { where: { id: string }; data: Partial<SmsOptOutRecord> }) => {
        const record = this.smsOptOuts.find((row) => row.id === args.where.id);
        if (!record) throw new Error(`Missing SmsOptOut ${args.where.id}`);
        applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
        return record;
      },
      updateMany: async (args: {
        where: { isActive?: boolean; phone?: { in: string[] } };
        data: Partial<SmsOptOutRecord>;
      }) => {
        let count = 0;
        for (const record of this.smsOptOuts) {
          const matches =
            (args.where.isActive === undefined || record.isActive === args.where.isActive) &&
            (!args.where.phone?.in || args.where.phone.in.includes(record.phone));
          if (!matches) continue;
          applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
          count += 1;
        }
        return { count };
      },
    },
    twilioInboundMessage: {
      findUnique: async (args: { where: { messageSid?: string | null; id?: string }; select?: Record<string, boolean> }) => {
        const record = args.where.id
          ? this.inboundMessages.find((row) => row.id === args.where.id)
          : this.inboundMessages.find((row) => row.messageSid === args.where.messageSid);
        return record ? selectFields(record as unknown as Record<string, unknown>, args.select) : null;
      },
      create: async (args: { data: Partial<TwilioInboundRecord>; select?: Record<string, boolean> }) => {
        if (
          args.data.messageSid &&
          this.inboundMessages.some((row) => row.messageSid === args.data.messageSid)
        ) {
          throw new Error("unique messageSid");
        }
        const record: TwilioInboundRecord = {
          id: this.id("twilio_inbound"),
          messageSid: args.data.messageSid ?? null,
          parsedIntent: String(args.data.parsedIntent ?? "UNKNOWN"),
          matchStatus: String(args.data.matchStatus ?? "UNPROCESSED"),
          deliveryConfirmationId: args.data.deliveryConfirmationId ?? null,
          notificationEventId: args.data.notificationEventId ?? null,
          rawPayload: args.data.rawPayload ?? {},
          processedAt: args.data.processedAt ?? null,
          responseMessage: args.data.responseMessage ?? null,
          responseSent: args.data.responseSent ?? false,
        };
        this.inboundMessages.push(record);
        return selectFields(record as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<TwilioInboundRecord> }) => {
        const record = this.inboundMessages.find((row) => row.id === args.where.id);
        if (!record) throw new Error(`Missing TwilioInboundMessage ${args.where.id}`);
        applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
        return record;
      },
    },
    deliveryConfirmation: {
      findMany: async (args: { where?: Record<string, unknown> }) =>
        this.deliveryConfirmations
          .filter((record) => this.confirmationMatchesWhere(record, args.where))
          .map((record) => this.decorateConfirmation(record)),
      update: async (args: {
        where: { id: string };
        data: Partial<DeliveryConfirmationRecord>;
        select?: Record<string, boolean>;
      }) => {
        const record = this.deliveryConfirmations.find((row) => row.id === args.where.id);
        if (!record) throw new Error(`Missing DeliveryConfirmation ${args.where.id}`);
        applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
        record.updatedAt = NOW;
        return selectFields(record as unknown as Record<string, unknown>, args.select);
      },
      updateMany: async (args: {
        where?: Record<string, unknown>;
        data: Partial<DeliveryConfirmationRecord>;
      }) => {
        let count = 0;
        for (const record of this.deliveryConfirmations) {
          if (!this.confirmationMatchesWhere(record, args.where)) continue;
          applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
          record.updatedAt = NOW;
          count += 1;
        }
        return { count };
      },
      count: async (args: { where?: Record<string, unknown> }) =>
        this.deliveryConfirmations.filter((record) => this.confirmationMatchesWhere(record, args.where))
          .length,
    },
    notificationAttempt: {
      findFirst: async (args: { where: { externalMessageId?: string | null } }) => {
        const attempt = this.notificationAttempts.find(
          (row) => row.externalMessageId === args.where.externalMessageId
        );
        if (!attempt) return null;
        const event = this.decorateNotificationEvent(
          this.notificationEvents.find((row) => row.id === attempt.notificationEventId)
        );
        return { ...attempt, notificationEvent: event };
      },
      update: async (args: { where: { id: string }; data: Partial<NotificationAttemptRecord> }) => {
        const record = this.notificationAttempts.find((row) => row.id === args.where.id);
        if (!record) throw new Error(`Missing NotificationAttempt ${args.where.id}`);
        applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
        return record;
      },
    },
    notificationEvent: {
      findFirst: async (args: { where: { externalMessageId?: string | null } }) => {
        const event = this.notificationEvents.find(
          (row) => row.externalMessageId === args.where.externalMessageId
        );
        return this.decorateNotificationEvent(event);
      },
    },
    twilioMessageStatusCallback: {
      findUnique: async (args: { where: { callbackKey: string }; select?: Record<string, boolean> }) => {
        const record = this.statusCallbacks.find((row) => row.callbackKey === args.where.callbackKey);
        return record ? selectFields(record as unknown as Record<string, unknown>, args.select) : null;
      },
      create: async (args: { data: Partial<TwilioStatusRecord>; select?: Record<string, boolean> }) => {
        if (
          args.data.callbackKey &&
          this.statusCallbacks.some((row) => row.callbackKey === args.data.callbackKey)
        ) {
          throw new Error("unique callbackKey");
        }
        const record: TwilioStatusRecord = {
          id: this.id("twilio_status"),
          callbackKey: String(args.data.callbackKey),
          messageSid: String(args.data.messageSid),
          messageStatus: String(args.data.messageStatus),
          errorCode: args.data.errorCode ?? null,
          errorMessage: args.data.errorMessage ?? null,
          notificationAttemptId: args.data.notificationAttemptId ?? null,
          notificationEventId: args.data.notificationEventId ?? null,
          deliveryConfirmationId: args.data.deliveryConfirmationId ?? null,
          matchStatus: String(args.data.matchStatus ?? "UNPROCESSED"),
          rawPayload: args.data.rawPayload ?? {},
          processedAt: args.data.processedAt ?? null,
        };
        this.statusCallbacks.push(record);
        return selectFields(record as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<TwilioStatusRecord> }) => {
        const record = this.statusCallbacks.find((row) => row.id === args.where.id);
        if (!record) throw new Error(`Missing TwilioMessageStatusCallback ${args.where.id}`);
        applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
        return record;
      },
    },
  } as never;

  seedConfirmation(params: {
    phone: string;
    status?: DeliveryConfirmationStatus;
    deliveryDate?: Date;
    addressState?: string | null;
    postalCode?: string | null;
    confirmationFollowUpCount?: number;
    selectedChannel?: NotificationChannel;
    unrecognizedResponseCount?: number;
    externalMessageId?: string | null;
  }) {
    const id = this.id("confirmation");
    const contactId = this.id("contact");
    const orderId = this.id("order");
    const deliveryGroupId = this.id("delivery_group");
    const eventId = this.id("event");
    const orderNumber = this.id("SO");
    const deliveryDate = params.deliveryDate ?? day("2026-08-31");

    this.contacts.push({
      contactId,
      displayName: "Fixture Customer",
      companyName: "Fixture Company",
      firstName: "Fixture",
      lastName: "Customer",
      email: "fixture@example.test",
      phone1: params.phone,
      phone2: null,
    });
    this.notificationEvents.push({
      id: eventId,
      orderId,
      deliveryGroupId,
      contactId,
      orderType: "SO",
      orderNumber,
      deliveryDate,
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
      dedupeKey: this.id("dedupe"),
      selectedChannel: params.selectedChannel ?? NotificationChannel.SMS,
      status: NotificationEventStatus.SENT,
      externalMessageId: params.externalMessageId ?? null,
      createdAt: NOW,
      scheduledAt: NOW,
      triggeredAt: NOW,
      sentAt: NOW,
    });

    const confirmation: DeliveryConfirmationRecord = {
      id,
      orderId,
      deliveryGroupId,
      notificationEventId: eventId,
      orderType: "SO",
      orderNumber,
      deliveryDate,
      contactId,
      status: params.status ?? DeliveryConfirmationStatus.PENDING,
      responseChannel: null,
      rawResponse: null,
      normalizedResponse: null,
      confirmedAt: null,
      changeRequestedAt: null,
      requestedNewDate: null,
      requestedNewDateRaw: null,
      requestedNewDateAt: null,
      reminderSentAt: null,
      noResponseAt: null,
      manualReviewRequired: false,
      manualReviewReason: null,
      manualReviewMarkedAt: null,
      manualReviewNotes: null,
      unrecognizedResponseCount: params.unrecognizedResponseCount ?? 0,
      confirmationFollowUpCount: params.confirmationFollowUpCount ?? 0,
      lastSmsResponseAt: null,
      lastSmsResponseBody: null,
      linkToken: this.id("token"),
      linkCreatedAt: NOW,
      linkExpiresAt: day("2026-08-20"),
      linkExpiredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      address: {
        state: params.addressState ?? "UT",
        postalCode: params.postalCode ?? "84101",
      },
    };
    this.deliveryConfirmations.push(confirmation);
    return confirmation;
  }

  seedAttempt(params: { notificationEventId: string; externalMessageId: string }) {
    const attempt: NotificationAttemptRecord = {
      id: this.id("attempt"),
      notificationEventId: params.notificationEventId,
      attemptNumber: 1,
      channel: NotificationChannel.SMS,
      provider: "twilio",
      success: false,
      errorMessage: null,
      providerCode: null,
      httpStatus: null,
      externalMessageId: params.externalMessageId,
      sentAt: null,
      createdAt: NOW,
    };
    this.notificationAttempts.push(attempt);
    return attempt;
  }

  seedActiveOptOut(phone: string) {
    this.smsOptOuts.push({
      id: this.id("sms_opt_out"),
      contactId: null,
      phone,
      source: "test",
      reason: "STOP",
      optedOutAt: NOW,
      optedBackInAt: null,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  private id(prefix: string) {
    const value = `${prefix}_${this.sequence}`;
    this.sequence += 1;
    return value;
  }

  private decorateConfirmation(record: DeliveryConfirmationRecord) {
    return {
      ...record,
      contact: this.contacts.find((contact) => contact.contactId === record.contactId),
      notificationEvent: this.notificationEvents.find((event) => event.id === record.notificationEventId),
      order: {
        address: record.address,
      },
    };
  }

  private decorateNotificationEvent(event: NotificationEventRecord | undefined) {
    if (!event) return null;
    return {
      ...event,
      deliveryConfirmations: this.deliveryConfirmations
        .filter((confirmation) => confirmation.notificationEventId === event.id)
        .map((confirmation) => ({ id: confirmation.id })),
    };
  }

  private confirmationMatchesWhere(
    record: DeliveryConfirmationRecord,
    where: Record<string, unknown> | undefined
  ) {
    if (!where) return true;

    const idWhere = where.id as { in?: string[] } | undefined;
    if (idWhere?.in && !idWhere.in.includes(record.id)) return false;

    const statusWhere = where.status as { in?: DeliveryConfirmationStatus[] } | undefined;
    if (statusWhere?.in && !statusWhere.in.includes(record.status)) return false;

    const deliveryDateWhere = where.deliveryDate as { gte?: Date } | Date | undefined;
    if (deliveryDateWhere instanceof Date && !matchesDate(record.deliveryDate, deliveryDateWhere)) {
      return false;
    }
    if (
      deliveryDateWhere &&
      !(deliveryDateWhere instanceof Date) &&
      deliveryDateWhere.gte &&
      record.deliveryDate.getTime() < deliveryDateWhere.gte.getTime()
    ) {
      return false;
    }

    if (where.confirmedAt === null && record.confirmedAt !== null) return false;
    if (where.requestedNewDate === null && record.requestedNewDate !== null) return false;
    if (
      typeof where.manualReviewRequired === "boolean" &&
      record.manualReviewRequired !== where.manualReviewRequired
    ) {
      return false;
    }

    const confirmationFollowUpWhere = where.confirmationFollowUpCount as { lte?: number } | undefined;
    if (
      typeof confirmationFollowUpWhere?.lte === "number" &&
      record.confirmationFollowUpCount > confirmationFollowUpWhere.lte
    ) {
      return false;
    }

    return true;
  }
}

function inboundPayload(body: string, messageSid: string, from = "+18015550123") {
  return {
    AccountSid: "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    MessagingServiceSid: "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    MessageSid: messageSid,
    From: from,
    To: TO_PHONE,
    Body: body,
  };
}

function statusPayload(params: {
  messageSid: string;
  messageStatus: string;
  errorCode?: string;
  errorMessage?: string;
}) {
  return {
    AccountSid: "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    MessagingServiceSid: "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    MessageSid: params.messageSid,
    From: TO_PHONE,
    To: "+18015550123",
    MessageStatus: params.messageStatus,
    ...(params.errorCode ? { ErrorCode: params.errorCode } : {}),
    ...(params.errorMessage ? { ErrorMessage: params.errorMessage } : {}),
  };
}

function mockQueueFetch(requests: QueueRequest[]) {
  return async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      payload: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ jobId: `mock-job-${requests.length}` }), { status: 202 });
  };
}

async function runInboundReplyValidation() {
  const confirmedInputs = ["Y", "YES", "CONFIRM"] as const;
  for (const input of confirmedInputs) {
    const store = new MockDeliveryStore();
    const confirmation = store.seedConfirmation({ phone: "+18015550123" });
    const requests: QueueRequest[] = [];
    const result = await handleTwilioInboundSms({
      payload: inboundPayload(input, `SM-CONFIRM-${input}`),
      prismaClient: store.client,
      now: NOW,
      queueOptions: {
        baseUrl: "http://mld-queue.local.test",
        token: "test-token",
        fetchImpl: mockQueueFetch(requests),
      },
    });

    assertEqual(result.matchStatus, "MATCHED", `${input} match status`);
    assertEqual(confirmation.status, DeliveryConfirmationStatus.CONFIRMED, `${input} status`);
    assert(confirmation.confirmedAt, `${input} confirmedAt`);
    assertEqual(requests.length, 1, `${input} writeback request count`);
    assertEqual(requests[0].payload.confirmedVia, "AUTOTXT", `${input} confirmedVia`);
    assertEqual(requests[0].payload.source, "SMS", `${input} source`);
    assert(!/acumatica/i.test(requests[0].url), `${input} must not call Acumatica`);
    assertIncludes(result.responseMessage, getSmsConfirmedMessage(), `${input} response`);
  }

  const duplicateStore = new MockDeliveryStore();
  duplicateStore.seedConfirmation({ phone: "+18015550123" });
  const duplicateRequests: QueueRequest[] = [];
  const duplicateOptions = {
    baseUrl: "http://mld-queue.local.test",
    token: "test-token",
    fetchImpl: mockQueueFetch(duplicateRequests),
  };
  await handleTwilioInboundSms({
    payload: inboundPayload("Y", "SM-DUPLICATE"),
    prismaClient: duplicateStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  const duplicateResult = await handleTwilioInboundSms({
    payload: inboundPayload("Y", "SM-DUPLICATE"),
    prismaClient: duplicateStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(duplicateResult.duplicate, true, "duplicate MessageSid result");
  assertEqual(duplicateRequests.length, 1, "duplicate MessageSid must not enqueue twice");

  const changeStore = new MockDeliveryStore();
  const changeConfirmation = changeStore.seedConfirmation({ phone: "+18015550123" });
  const changeResult = await handleTwilioInboundSms({
    payload: inboundPayload("N", "SM-CHANGE"),
    prismaClient: changeStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(changeConfirmation.status, DeliveryConfirmationStatus.AWAITING_NEW_DATE, "N status");
  assertIncludes(changeResult.responseMessage, "preferred delivery date", "N response");

  const dateAfterNStore = new MockDeliveryStore();
  const dateAfterN = dateAfterNStore.seedConfirmation({
    phone: "+18015550123",
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  });
  await handleTwilioInboundSms({
    payload: inboundPayload("09/01/2026", "SM-DATE-AFTER-N"),
    prismaClient: dateAfterNStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(
    dateAfterN.status,
    DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
    "date after N status"
  );
  assertEqual(
    dateKey(dateAfterN.requestedNewDate as Date),
    "2026-09-01",
    "date after N requested date"
  );
  assertEqual(dateAfterN.manualReviewRequired, true, "date after N manual review");

  const dateWithoutNStore = new MockDeliveryStore();
  const dateWithoutN = dateWithoutNStore.seedConfirmation({ phone: "+18015550123" });
  await handleTwilioInboundSms({
    payload: inboundPayload("09/01/2026", "SM-DATE-WITHOUT-N"),
    prismaClient: dateWithoutNStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(
    dateWithoutN.status,
    DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
    "date without N status"
  );

  const invalidDateStore = new MockDeliveryStore();
  invalidDateStore.seedConfirmation({
    phone: "+18015550123",
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  });
  const invalidDateResult = await handleTwilioInboundSms({
    payload: inboundPayload("tomorrow", "SM-INVALID-DATE"),
    prismaClient: invalidDateStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertIncludes(invalidDateResult.responseMessage, "MM/DD/YYYY", "invalid date response");

  const weekendResult = await handleTwilioInboundSms({
    payload: inboundPayload("08/29/2026", "SM-WEEKEND-DATE"),
    prismaClient: newStoreWithAwaitingConfirmation().client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertIncludes(weekendResult.responseMessage, "weekend", "weekend date response");

  const pastResult = await handleTwilioInboundSms({
    payload: inboundPayload("07/20/2026", "SM-PAST-DATE"),
    prismaClient: newStoreWithAwaitingConfirmation().client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertIncludes(pastResult.responseMessage, "already passed", "past date response");

  const sameDateStore = new MockDeliveryStore();
  sameDateStore.seedConfirmation({ phone: "+18015550123", deliveryDate: day("2026-08-31") });
  const sameDateResult = await handleTwilioInboundSms({
    payload: inboundPayload("08/31/2026", "SM-SAME-DATE"),
    prismaClient: sameDateStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertIncludes(sameDateResult.responseMessage, "already your current", "same date response");

  const wyomingInvalidStore = new MockDeliveryStore();
  const wyomingInvalid = wyomingInvalidStore.seedConfirmation({
    phone: "+18015550123",
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
    deliveryDate: day("2026-09-03"),
    addressState: "WY",
    postalCode: "82001",
  });
  const wyomingInvalidResult = await handleTwilioInboundSms({
    payload: inboundPayload("08/31/2026", "SM-WY-MONDAY-DATE"),
    prismaClient: wyomingInvalidStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(
    wyomingInvalid.status,
    DeliveryConfirmationStatus.AWAITING_NEW_DATE,
    "Wyoming invalid weekday must keep awaiting status"
  );
  assertEqual(wyomingInvalid.requestedNewDate, null, "Wyoming invalid weekday must not set date");
  assertIncludes(
    wyomingInvalidResult.responseMessage,
    "Wyoming on Tuesdays only",
    "Wyoming invalid weekday response"
  );

  const wyomingValidStore = new MockDeliveryStore();
  const wyomingValid = wyomingValidStore.seedConfirmation({
    phone: "+18015550123",
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
    deliveryDate: day("2026-09-03"),
    addressState: "Wyoming",
    postalCode: "82001",
  });
  await handleTwilioInboundSms({
    payload: inboundPayload("09/01/2026", "SM-WY-TUESDAY-DATE"),
    prismaClient: wyomingValidStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(
    wyomingValid.status,
    DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
    "Wyoming Tuesday must set requested date"
  );
  assertEqual(dateKey(wyomingValid.requestedNewDate as Date), "2026-09-01", "Wyoming Tuesday date");
  assertEqual(wyomingValid.manualReviewRequired, true, "Wyoming Tuesday manual review");

  const mccallInvalidStore = new MockDeliveryStore();
  const mccallInvalid = mccallInvalidStore.seedConfirmation({
    phone: "+18015550123",
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
    deliveryDate: day("2026-09-03"),
    addressState: "ID",
    postalCode: "83638",
  });
  const mccallInvalidResult = await handleTwilioInboundSms({
    payload: inboundPayload("09/01/2026", "SM-MCCALL-TUESDAY-DATE"),
    prismaClient: mccallInvalidStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(
    mccallInvalid.status,
    DeliveryConfirmationStatus.AWAITING_NEW_DATE,
    "McCall invalid weekday must keep awaiting status"
  );
  assertEqual(mccallInvalid.requestedNewDate, null, "McCall invalid weekday must not set date");
  assertIncludes(
    mccallInvalidResult.responseMessage,
    "McCall, Idaho on Mondays only",
    "McCall invalid weekday response"
  );

  const mccallValidStore = new MockDeliveryStore();
  const mccallValid = mccallValidStore.seedConfirmation({
    phone: "+18015550123",
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
    deliveryDate: day("2026-09-03"),
    addressState: "ID",
    postalCode: "83635-1234",
  });
  await handleTwilioInboundSms({
    payload: inboundPayload("08/31/2026", "SM-MCCALL-MONDAY-DATE"),
    prismaClient: mccallValidStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(
    mccallValid.status,
    DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
    "McCall Monday must set requested date"
  );
  assertEqual(dateKey(mccallValid.requestedNewDate as Date), "2026-08-31", "McCall Monday date");
  assertEqual(mccallValid.manualReviewRequired, true, "McCall Monday manual review");

  const unrecognizedStore = new MockDeliveryStore();
  const unrecognized = unrecognizedStore.seedConfirmation({ phone: "+18015550123" });
  const one = await handleTwilioInboundSms({
    payload: inboundPayload("maybe", "SM-UNREC-1"),
    prismaClient: unrecognizedStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  const two = await handleTwilioInboundSms({
    payload: inboundPayload("who is this", "SM-UNREC-2"),
    prismaClient: unrecognizedStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  const three = await handleTwilioInboundSms({
    payload: inboundPayload("asdf", "SM-UNREC-3"),
    prismaClient: unrecognizedStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertIncludes(one.responseMessage, "did not understand", "first unrecognized");
  assertIncludes(two.responseMessage, "did not understand", "second unrecognized");
  assertIncludes(three.responseMessage, "team will follow up", "third unrecognized");
  assertEqual(unrecognized.unrecognizedResponseCount, 3, "unrecognized count");
  assertEqual(
    unrecognized.manualReviewReason,
    DELIVERY_MANUAL_REVIEW_REASONS.TOO_MANY_UNRECOGNIZED_RESPONSES,
    "too many unrecognized manual reason"
  );

  const stopStore = new MockDeliveryStore();
  stopStore.seedConfirmation({ phone: "+18015550123" });
  await handleTwilioInboundSms({
    payload: inboundPayload("STOP", "SM-STOP"),
    prismaClient: stopStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(stopStore.smsOptOuts.length, 1, "STOP creates opt-out");
  assertEqual(stopStore.smsOptOuts[0].isActive, true, "STOP opt-out active");

  const startStore = new MockDeliveryStore();
  startStore.seedActiveOptOut("+18015550123");
  const startResult = await handleTwilioInboundSms({
    payload: inboundPayload("START", "SM-START"),
    prismaClient: startStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(startStore.smsOptOuts[0].isActive, false, "START deactivates opt-out");
  assertIncludes(startResult.responseMessage, "opted in", "START response");

  const helpResult = await handleTwilioInboundSms({
    payload: inboundPayload("HELP", "SM-HELP"),
    prismaClient: new MockDeliveryStore().client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertIncludes(helpResult.responseMessage, "Reply Y", "HELP response");

  const unmatchedStore = new MockDeliveryStore();
  const unmatchedResult = await handleTwilioInboundSms({
    payload: inboundPayload("Y", "SM-UNMATCHED"),
    prismaClient: unmatchedStore.client,
    now: NOW,
    queueOptions: duplicateOptions,
  });
  assertEqual(unmatchedResult.matchStatus, "UNMATCHED", "unmatched match status");
  assertEqual(unmatchedStore.inboundMessages[0].rawPayload.Body, "Y", "unmatched raw stored");

  const ambiguousStore = new MockDeliveryStore();
  const ambiguousA = ambiguousStore.seedConfirmation({ phone: "+18015550123" });
  const ambiguousB = ambiguousStore.seedConfirmation({ phone: "+18015550123" });
  const ambiguousRequests: QueueRequest[] = [];
  const ambiguousResult = await handleTwilioInboundSms({
    payload: inboundPayload("Y", "SM-AMBIGUOUS"),
    prismaClient: ambiguousStore.client,
    now: NOW,
    queueOptions: {
      baseUrl: "http://mld-queue.local.test",
      token: "test-token",
      fetchImpl: mockQueueFetch(ambiguousRequests),
    },
  });
  assertEqual(ambiguousResult.matchStatus, "AMBIGUOUS", "ambiguous match status");
  assertEqual(ambiguousA.status, DeliveryConfirmationStatus.PENDING, "ambiguous A not confirmed");
  assertEqual(ambiguousB.status, DeliveryConfirmationStatus.PENDING, "ambiguous B not confirmed");
  assertEqual(ambiguousRequests.length, 0, "ambiguous does not enqueue writeback");
  assertEqual(
    ambiguousA.manualReviewReason,
    DELIVERY_MANUAL_REVIEW_REASONS.AMBIGUOUS_SMS_REPLY,
    "ambiguous manual reason"
  );

  return {
    confirmedInputs: confirmedInputs.length,
    duplicateMessageSidIdempotent: true,
    changeRequestHandled: true,
    requestedDateHandled: true,
    invalidDatesHandled: true,
    unrecognizedEscalationHandled: true,
    optOutHandled: true,
    optInHandled: true,
    helpHandled: true,
    unmatchedStored: true,
    ambiguousRejected: true,
  };
}

function newStoreWithAwaitingConfirmation() {
  const store = new MockDeliveryStore();
  store.seedConfirmation({
    phone: "+18015550123",
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  });
  return store;
}

async function runStatusCallbackValidation() {
  const store = new MockDeliveryStore();
  const confirmation = store.seedConfirmation({
    phone: "+18015550123",
    externalMessageId: "SM-STATUS",
  });
  const attempt = store.seedAttempt({
    notificationEventId: confirmation.notificationEventId as string,
    externalMessageId: "SM-STATUS",
  });

  const delivered = await handleTwilioMessageStatus({
    payload: statusPayload({ messageSid: "SM-STATUS", messageStatus: "delivered" }),
    prismaClient: store.client,
    now: NOW,
  });
  assertEqual(delivered.matchStatus, "MATCHED_ATTEMPT", "delivered match");
  assertEqual(attempt.success, true, "delivered attempt success");
  assertEqual(attempt.providerCode, "DELIVERED", "delivered provider status");

  const failed = await handleTwilioMessageStatus({
    payload: statusPayload({
      messageSid: "SM-STATUS",
      messageStatus: "failed",
      errorCode: "30005",
      errorMessage: "Unknown destination handset",
    }),
    prismaClient: store.client,
    now: NOW,
  });
  assertEqual(failed.manualReviewFlagged, true, "failed manual review flagged");
  assertEqual(
    confirmation.manualReviewReason,
    DELIVERY_MANUAL_REVIEW_REASONS.SMS_DELIVERY_FAILED,
    "failed manual reason"
  );
  assertEqual(store.smsOptOuts.length, 0, "failed callback does not opt out");

  const duplicateFailed = await handleTwilioMessageStatus({
    payload: statusPayload({
      messageSid: "SM-STATUS",
      messageStatus: "failed",
      errorCode: "30005",
      errorMessage: "Unknown destination handset",
    }),
    prismaClient: store.client,
    now: NOW,
  });
  assertEqual(duplicateFailed.duplicate, true, "duplicate status callback");

  const unmatchedStore = new MockDeliveryStore();
  const unmatched = await handleTwilioMessageStatus({
    payload: statusPayload({ messageSid: "SM-UNMATCHED-STATUS", messageStatus: "sent" }),
    prismaClient: unmatchedStore.client,
    now: NOW,
  });
  assertEqual(unmatched.matchStatus, "UNMATCHED", "unmatched status callback");
  assertEqual(unmatchedStore.statusCallbacks.length, 1, "unmatched status stored");

  const undeliveredStore = new MockDeliveryStore();
  const undeliveredConfirmation = undeliveredStore.seedConfirmation({
    phone: "+18015550123",
    externalMessageId: "SM-UNDELIVERED",
  });
  undeliveredStore.seedAttempt({
    notificationEventId: undeliveredConfirmation.notificationEventId as string,
    externalMessageId: "SM-UNDELIVERED",
  });
  await handleTwilioMessageStatus({
    payload: statusPayload({
      messageSid: "SM-UNDELIVERED",
      messageStatus: "undelivered",
      errorCode: "30007",
    }),
    prismaClient: undeliveredStore.client,
    now: NOW,
  });
  assertEqual(
    undeliveredConfirmation.manualReviewReason,
    DELIVERY_MANUAL_REVIEW_REASONS.SMS_DELIVERY_FAILED,
    "undelivered manual reason"
  );
  assertEqual(undeliveredStore.smsOptOuts.length, 0, "undelivered does not opt out");

  return {
    deliveredStored: true,
    failedStoredWithError: true,
    undeliveredStoredWithError: true,
    failedDoesNotOptOut: true,
    duplicateStatusIdempotent: true,
    unmatchedStatusStored: true,
  };
}

async function runNoResponseValidation() {
  const runDate = "2026-07-20";
  const store = new MockDeliveryStore();
  const emailSelected = store.seedConfirmation({
    phone: "+18015550123",
    deliveryDate: addDays(runDate, 41),
    selectedChannel: NotificationChannel.EMAIL,
  });
  const smsSelected = store.seedConfirmation({
    phone: "+18015550124",
    deliveryDate: addDays(runDate, 41),
    selectedChannel: NotificationChannel.SMS,
  });
  store.seedConfirmation({
    phone: "+18015550125",
    deliveryDate: addDays(runDate, 40),
    confirmationFollowUpCount: 1,
    selectedChannel: NotificationChannel.SMS,
  });
  store.seedConfirmation({
    phone: "+18015550132",
    deliveryDate: addDays(runDate, 40),
    confirmationFollowUpCount: 1,
    selectedChannel: NotificationChannel.EMAIL,
  });
  const noResponse = store.seedConfirmation({
    phone: "+18015550126",
    deliveryDate: addDays(runDate, 39),
  });
  const awaitingNewDate = store.seedConfirmation({
    phone: "+18015550127",
    deliveryDate: addDays(runDate, 39),
    status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  });

  const plan = await planDeliveryConfirmationNoResponseWork({
    runDate,
    prismaClient: store.client,
  });
  assertEqual(plan.followUps[0].candidateCount, 2, "41-day follow-up candidates");
  assertEqual(
    plan.followUps[0].selectedChannelCounts.EMAIL,
    1,
    "41-day email-selected candidates"
  );
  assertEqual(
    plan.followUps[0].selectedChannelCounts.SMS,
    1,
    "41-day sms-selected candidates"
  );
  assertEqual(plan.followUps[1].candidateCount, 2, "40-day follow-up candidates");
  assertEqual(
    plan.followUps[1].selectedChannelCounts.SMS,
    1,
    "40-day sms-selected candidates"
  );
  assertEqual(
    plan.followUps[1].selectedChannelCounts.EMAIL,
    1,
    "40-day email-selected candidates"
  );
  assertEqual(
    plan.manualReviewCheckpoint.noCustomerResponseCandidates,
    1,
    "39-day no response candidates"
  );
  assertEqual(
    plan.manualReviewCheckpoint.awaitingNewDateCandidates,
    1,
    "39-day awaiting new date candidates"
  );

  emailSelected.status = DeliveryConfirmationStatus.CONFIRMED;
  emailSelected.confirmedAt = NOW;
  const webpageConfirmedPlan = await planDeliveryConfirmationNoResponseWork({
    runDate,
    prismaClient: store.client,
  });
  assertEqual(
    webpageConfirmedPlan.followUps[0].candidateCount,
    1,
    "webpage confirmation stops follow-ups"
  );

  smsSelected.status = DeliveryConfirmationStatus.CONFIRMED;
  smsSelected.confirmedAt = NOW;
  const smsConfirmedPlan = await planDeliveryConfirmationNoResponseWork({
    runDate,
    prismaClient: store.client,
  });
  assertEqual(smsConfirmedPlan.followUps[0].candidateCount, 0, "SMS confirmation stops follow-ups");

  const webpageNewDateStore = new MockDeliveryStore();
  const webpageNewDate = webpageNewDateStore.seedConfirmation({
    phone: "+18015550128",
    deliveryDate: addDays(runDate, 41),
    selectedChannel: NotificationChannel.EMAIL,
  });
  webpageNewDate.status = DeliveryConfirmationStatus.NEW_DATE_REQUESTED;
  webpageNewDate.requestedNewDate = day("2026-09-01");
  webpageNewDate.requestedNewDateRaw = "2026-09-01";
  webpageNewDate.requestedNewDateAt = NOW;
  webpageNewDate.manualReviewRequired = true;
  webpageNewDate.manualReviewReason = DELIVERY_MANUAL_REVIEW_REASONS.NEW_DATE_REQUESTED;
  const webpageNewDatePlan = await planDeliveryConfirmationNoResponseWork({
    runDate,
    prismaClient: webpageNewDateStore.client,
  });
  assertEqual(
    webpageNewDatePlan.followUps[0].candidateCount,
    0,
    "webpage request different date stops follow-ups"
  );
  assertEqual(
    webpageNewDate.manualReviewReason,
    DELIVERY_MANUAL_REVIEW_REASONS.NEW_DATE_REQUESTED,
    "webpage request different date flags manual review"
  );

  const smsNewDateStore = new MockDeliveryStore();
  const smsNewDate = smsNewDateStore.seedConfirmation({
    phone: "+18015550129",
    deliveryDate: addDays(runDate, 41),
    selectedChannel: NotificationChannel.SMS,
  });
  const queueRequests: QueueRequest[] = [];
  await handleTwilioInboundSms({
    payload: inboundPayload("N", "SM-NO-RESPONSE-N", "+18015550129"),
    prismaClient: smsNewDateStore.client,
    now: NOW,
    queueOptions: {
      baseUrl: "http://mld-queue.local.test",
      token: "test-token",
      fetchImpl: mockQueueFetch(queueRequests),
    },
  });
  await handleTwilioInboundSms({
    payload: inboundPayload("09/01/2026", "SM-NO-RESPONSE-DATE", "+18015550129"),
    prismaClient: smsNewDateStore.client,
    now: NOW,
    queueOptions: {
      baseUrl: "http://mld-queue.local.test",
      token: "test-token",
      fetchImpl: mockQueueFetch(queueRequests),
    },
  });
  const smsNewDatePlan = await planDeliveryConfirmationNoResponseWork({
    runDate,
    prismaClient: smsNewDateStore.client,
  });
  assertEqual(
    smsNewDate.status,
    DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
    "SMS N then valid date stores new-date request"
  );
  assertEqual(
    smsNewDate.manualReviewReason,
    DELIVERY_MANUAL_REVIEW_REASONS.NEW_DATE_REQUESTED,
    "SMS N then valid date flags manual review"
  );
  assertEqual(
    smsNewDatePlan.followUps[0].candidateCount,
    0,
    "SMS N then valid date stops follow-ups"
  );

  const invalidSmsStore = new MockDeliveryStore();
  invalidSmsStore.seedConfirmation({
    phone: "+18015550130",
    deliveryDate: addDays(runDate, 41),
    selectedChannel: NotificationChannel.SMS,
  });
  await handleTwilioInboundSms({
    payload: inboundPayload("maybe", "SM-NO-RESPONSE-INVALID", "+18015550130"),
    prismaClient: invalidSmsStore.client,
    now: NOW,
    queueOptions: {
      baseUrl: "http://mld-queue.local.test",
      token: "test-token",
      fetchImpl: mockQueueFetch([]),
    },
  });
  const invalidSmsPlan = await planDeliveryConfirmationNoResponseWork({
    runDate,
    prismaClient: invalidSmsStore.client,
  });
  assertEqual(
    invalidSmsPlan.followUps[0].candidateCount,
    1,
    "invalid/unrecognized SMS remains a no-response follow-up candidate"
  );

  const failedSmsStore = new MockDeliveryStore();
  const failedSmsConfirmation = failedSmsStore.seedConfirmation({
    phone: "+18015550131",
    deliveryDate: addDays(runDate, 41),
    selectedChannel: NotificationChannel.SMS,
    externalMessageId: "SM-NO-RESPONSE-FAILED",
  });
  failedSmsStore.seedAttempt({
    notificationEventId: failedSmsConfirmation.notificationEventId as string,
    externalMessageId: "SM-NO-RESPONSE-FAILED",
  });
  await handleTwilioMessageStatus({
    payload: statusPayload({
      messageSid: "SM-NO-RESPONSE-FAILED",
      messageStatus: "undelivered",
      errorCode: "30005",
    }),
    prismaClient: failedSmsStore.client,
    now: NOW,
  });
  assertEqual(
    failedSmsConfirmation.status,
    DeliveryConfirmationStatus.PENDING,
    "failed/undelivered SMS does not become a valid customer response"
  );
  assertEqual(failedSmsConfirmation.confirmedAt, null, "failed/undelivered SMS does not confirm");
  assertEqual(
    failedSmsConfirmation.requestedNewDate,
    null,
    "failed/undelivered SMS does not request new date"
  );

  const marked = await mark39DayNoResponseManualReview({
    runDate,
    prismaClient: store.client,
    now: NOW,
  });
  assertEqual(marked.customerMessagesSent, 0, "39 checkpoint sends no customer messages");
  assertEqual(marked.acumaticaWritebackQueued, 0, "39 checkpoint queues no Acumatica writeback");
  assertEqual(
    noResponse.manualReviewReason,
    DELIVERY_MANUAL_REVIEW_REASONS.NO_CUSTOMER_RESPONSE,
    "39 no response manual reason"
  );
  assertEqual(
    awaitingNewDate.manualReviewReason,
    DELIVERY_MANUAL_REVIEW_REASONS.AWAITING_NEW_DATE_NO_RESPONSE,
    "39 awaiting new date manual reason"
  );

  const weekendStore = new MockDeliveryStore();
  weekendStore.seedConfirmation({ phone: "+18015550127", deliveryDate: addDays("2026-07-18", 41) });
  const weekendPlan = await planDeliveryConfirmationNoResponseWork({
    runDate: "2026-07-18",
    prismaClient: weekendStore.client,
  });
  assertEqual(weekendPlan.weekendSkipped, true, "weekend skip flag");
  assertEqual(weekendPlan.followUps[0].candidateCount, 0, "weekend follow-up skipped");
  assertEqual(weekendPlan.followUps[0].reason, "weekend_skip_no_shift", "weekend no shift");

  return {
    maxThreeAttemptsPlanned: true,
    emailSelected42DayIncluded: true,
    smsSelected42DayIncluded: true,
    webpageConfirmationStopsFollowUps: true,
    smsConfirmationStopsFollowUps: true,
    webpageRequestDifferentDateStopsFollowUps: true,
    smsNewDateStopsFollowUps: true,
    invalidSmsDoesNotCountAsResponse: true,
    failedSmsDoesNotCountAsResponse: true,
    weekendFollowUpsSkippedNotShifted: true,
    day39ManualReviewNoMessage: true,
    noAcumaticaNoResponseWriteback: true,
  };
}

async function runSignatureValidation() {
  const previousAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const previousValidate = process.env.TWILIO_WEBHOOK_VALIDATE_SIGNATURES;
  const previousBaseUrl = process.env.DELIVERY_APP_BASE_URL;

  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_WEBHOOK_VALIDATE_SIGNATURES = "true";
  process.env.DELIVERY_APP_BASE_URL = "https://mld-delivery.vercel.app";

  try {
    const body = new URLSearchParams(inboundPayload("Y", "SM-BAD-SIGNATURE"));
    const response = await inboundSmsPost(
      new Request("https://mld-delivery.vercel.app/api/webhooks/twilio/inbound-sms", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "invalid-signature",
        },
        body,
      })
    );
    assertEqual(response.status, 403, "invalid Twilio signature status");
  } finally {
    if (previousAuthToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previousAuthToken;
    if (previousValidate === undefined) delete process.env.TWILIO_WEBHOOK_VALIDATE_SIGNATURES;
    else process.env.TWILIO_WEBHOOK_VALIDATE_SIGNATURES = previousValidate;
    if (previousBaseUrl === undefined) delete process.env.DELIVERY_APP_BASE_URL;
    else process.env.DELIVERY_APP_BASE_URL = previousBaseUrl;
  }

  return {
    invalidSignatureRejected: true,
  };
}

async function main() {
  const inbound = await runInboundReplyValidation();
  const status = await runStatusCallbackValidation();
  const noResponse = await runNoResponseValidation();
  const signature = await runSignatureValidation();

  console.log(
    JSON.stringify(
      {
        inbound,
        status,
        noResponse,
        signature,
        liveSmsSent: false,
        liveEmailSent: false,
        acumaticaCalledDirectly: false,
        mldQueueUsedForSmsConfirmationWriteback: true,
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
