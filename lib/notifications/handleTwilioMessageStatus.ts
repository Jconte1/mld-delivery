import { randomUUID } from "node:crypto";

import {
  NotificationAttemptStatus,
  NotificationChannel,
  NotificationEventStatus,
  Prisma,
} from "@/lib/generated/prisma/client";
import {
  DELIVERY_MANUAL_REVIEW_REASONS,
  formatManualReviewNote,
} from "@/lib/notifications/deliveryConfirmationManualReview";
import {
  normalizeDeliverySmsBody,
  normalizePhoneToE164,
} from "@/lib/notifications/deliveryConfirmationSmsReplies";
import { prisma } from "@/lib/prisma";
import type { TwilioFormPayload } from "@/lib/notifications/twilioWebhook";

type DeliveryTwilioStatusClient = Pick<
  typeof prisma,
  | "twilioMessageStatusCallback"
  | "notificationAttempt"
  | "notificationEvent"
  | "deliveryConfirmation"
>;

type StatusMatch =
  | {
      matchStatus: "MATCHED_ATTEMPT";
      notificationAttemptId: string;
      notificationEventId: string;
      deliveryConfirmationId: string | null;
      notificationAttemptNumber: number;
      notificationAttemptChannel: NotificationChannel;
    }
  | {
      matchStatus: "MATCHED_EVENT";
      notificationAttemptId: null;
      notificationEventId: string;
      deliveryConfirmationId: string | null;
    }
  | {
      matchStatus: "UNMATCHED";
      notificationAttemptId: null;
      notificationEventId: null;
      deliveryConfirmationId: null;
    };

export type HandleTwilioMessageStatusResult = {
  callbackId: string;
  callbackKey: string;
  messageSid: string;
  messageStatus: string;
  matchStatus: StatusMatch["matchStatus"] | "DUPLICATE";
  notificationAttemptId: string | null;
  notificationEventId: string | null;
  deliveryConfirmationId: string | null;
  manualReviewFlagged: boolean;
  duplicate: boolean;
};

const FAILURE_STATUSES = new Set(["FAILED", "UNDELIVERED"]);
const IN_FLIGHT_STATUSES = new Set(["ACCEPTED", "QUEUED", "SENDING", "SENT", "SUBMITTED"]);
const DELIVERED_STATUSES = new Set(["DELIVERED"]);
const ATTEMPT_CREATED = "CREATED" as NotificationAttemptStatus;
const ATTEMPT_SUBMITTED = "SUBMITTED" as NotificationAttemptStatus;
const ATTEMPT_DELIVERED = "DELIVERED" as NotificationAttemptStatus;
const ATTEMPT_FAILED = "FAILED" as NotificationAttemptStatus;
const EVENT_PENDING = "PENDING" as NotificationEventStatus;
const EVENT_SENT = "SENT" as NotificationEventStatus;
const EVENT_FAILED = "FAILED" as NotificationEventStatus;

function payloadValue(payload: TwilioFormPayload, keys: string[]) {
  for (const key of keys) {
    const value = payload[key]?.trim();
    if (value) return value;
  }
  return null;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function rawPayloadJson(payload: TwilioFormPayload) {
  return payload as Prisma.InputJsonObject;
}

function callbackKey(params: {
  messageSid: string;
  messageStatus: string;
  errorCode: string | null;
}) {
  return [params.messageSid, params.messageStatus, params.errorCode ?? "none"].join(":");
}

async function createStatusCallback(params: {
  client: DeliveryTwilioStatusClient;
  payload: TwilioFormPayload;
  callbackKey: string;
  messageSid: string;
  messageStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  now: Date;
}) {
  try {
    return await params.client.twilioMessageStatusCallback.create({
      data: {
        callbackKey: params.callbackKey,
        messageSid: params.messageSid,
        accountSid: payloadValue(params.payload, ["AccountSid"]),
        messagingServiceSid: payloadValue(params.payload, ["MessagingServiceSid"]),
        messageStatus: params.messageStatus,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
        fromPhone: params.fromPhone,
        toPhone: params.toPhone,
        rawPayload: rawPayloadJson(params.payload),
        receivedAt: params.now,
      },
      select: { id: true },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await params.client.twilioMessageStatusCallback.findUnique({
      where: { callbackKey: params.callbackKey },
      select: { id: true },
    });
    if (!existing) throw error;
    return existing;
  }
}

async function findStatusMatch(
  client: DeliveryTwilioStatusClient,
  messageSid: string
): Promise<StatusMatch> {
  const attempt = await client.notificationAttempt.findFirst({
    where: { externalMessageId: messageSid },
    orderBy: { createdAt: "desc" },
    include: {
      notificationEvent: {
        include: {
          deliveryConfirmations: {
            orderBy: { createdAt: "desc" },
            take: 2,
            select: { id: true },
          },
        },
      },
    },
  });

  if (attempt) {
    const confirmations = attempt.notificationEvent.deliveryConfirmations;
    return {
      matchStatus: "MATCHED_ATTEMPT",
      notificationAttemptId: attempt.id,
      notificationEventId: attempt.notificationEventId,
      deliveryConfirmationId: confirmations.length === 1 ? confirmations[0].id : null,
      notificationAttemptNumber: attempt.attemptNumber,
      notificationAttemptChannel: attempt.channel,
    };
  }

  const event = await client.notificationEvent.findFirst({
    where: { externalMessageId: messageSid },
    orderBy: { createdAt: "desc" },
    include: {
      deliveryConfirmations: {
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { id: true },
      },
    },
  });

  if (event) {
    return {
      matchStatus: "MATCHED_EVENT",
      notificationAttemptId: null,
      notificationEventId: event.id,
      deliveryConfirmationId:
        event.deliveryConfirmations.length === 1 ? event.deliveryConfirmations[0].id : null,
    };
  }

  return {
    matchStatus: "UNMATCHED",
    notificationAttemptId: null,
    notificationEventId: null,
    deliveryConfirmationId: null,
  };
}

async function updateMatchedAttempt(params: {
  client: DeliveryTwilioStatusClient;
  match: StatusMatch;
  messageStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  now: Date;
}) {
  if (params.match.matchStatus !== "MATCHED_ATTEMPT") return;

  const delivered = DELIVERED_STATUSES.has(params.messageStatus);
  const inFlight = IN_FLIGHT_STATUSES.has(params.messageStatus);
  const failed = FAILURE_STATUSES.has(params.messageStatus);

  if (delivered) {
    await params.client.notificationAttempt.updateMany({
      where: {
        id: params.match.notificationAttemptId,
        status: { not: ATTEMPT_FAILED },
      },
      data: {
        provider: "twilio",
        providerCode: params.errorCode ?? params.messageStatus,
        status: ATTEMPT_DELIVERED,
        errorMessage: null,
        success: true,
        sentAt: params.now,
      },
    });
    return;
  }

  if (inFlight) {
    await params.client.notificationAttempt.updateMany({
      where: {
        id: params.match.notificationAttemptId,
        status: { in: [ATTEMPT_CREATED, ATTEMPT_SUBMITTED] },
      },
      data: {
        provider: "twilio",
        providerCode: params.errorCode ?? params.messageStatus,
        status: ATTEMPT_SUBMITTED,
        success: true,
      },
    });
    return;
  }

  if (failed) {
    await params.client.notificationAttempt.updateMany({
      where: {
        id: params.match.notificationAttemptId,
        status: { not: ATTEMPT_DELIVERED },
      },
      data: {
        provider: "twilio",
        providerCode: params.errorCode ?? params.messageStatus,
        status: ATTEMPT_FAILED,
        errorMessage: params.errorMessage,
        success: false,
      },
    });
  }
}

async function latestAttemptForEvent(
  client: DeliveryTwilioStatusClient,
  notificationEventId: string
) {
  return client.notificationAttempt.findFirst({
    where: { notificationEventId },
    orderBy: { attemptNumber: "desc" },
    select: { id: true, status: true },
  });
}

async function matchedAttemptCanUpdateEvent(params: {
  client: DeliveryTwilioStatusClient;
  match: StatusMatch;
}) {
  if (params.match.matchStatus !== "MATCHED_ATTEMPT") return true;
  if (!params.match.notificationEventId) return false;

  const latestAttempt = await latestAttemptForEvent(
    params.client,
    params.match.notificationEventId
  );
  return latestAttempt?.id === params.match.notificationAttemptId;
}

async function updateMatchedEventFromStatus(params: {
  client: DeliveryTwilioStatusClient;
  match: StatusMatch;
  messageSid: string;
  messageStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  now: Date;
}) {
  if (!params.match.notificationEventId) return false;

  if (DELIVERED_STATUSES.has(params.messageStatus) || IN_FLIGHT_STATUSES.has(params.messageStatus)) {
    if (!(await matchedAttemptCanUpdateEvent({ client: params.client, match: params.match }))) {
      return false;
    }

    const result = await params.client.notificationEvent.updateMany({
      where: {
        id: params.match.notificationEventId,
        status: { in: [EVENT_PENDING, EVENT_SENT] },
      },
      data: {
        status: EVENT_SENT,
        provider: "twilio",
        externalMessageId: params.messageSid,
        sentAt: DELIVERED_STATUSES.has(params.messageStatus) ? params.now : undefined,
        reasonFailed: null,
      },
    });
    return result.count > 0;
  }

  if (!FAILURE_STATUSES.has(params.messageStatus)) return false;

  if (params.match.matchStatus === "MATCHED_ATTEMPT") {
    const latestAttempt = await latestAttemptForEvent(
      params.client,
      params.match.notificationEventId
    );
    if (
      !latestAttempt ||
      latestAttempt.id !== params.match.notificationAttemptId ||
      latestAttempt.status === ATTEMPT_DELIVERED
    ) {
      return false;
    }
  }

  await params.client.notificationEvent.update({
    where: { id: params.match.notificationEventId },
    data: {
      status: EVENT_FAILED,
      provider: "twilio",
      reasonFailed: [
        `Twilio SMS delivery ${params.messageStatus.toLowerCase()}`,
        params.errorCode,
        params.errorMessage,
      ]
        .filter(Boolean)
        .join(": ")
        .slice(0, 1000),
    },
  });
  return true;
}

async function flagSmsDeliveryFailureForManualReview(params: {
  client: DeliveryTwilioStatusClient;
  deliveryConfirmationId: string | null;
  messageStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  toPhone: string | null;
  now: Date;
}) {
  if (!FAILURE_STATUSES.has(params.messageStatus) || !params.deliveryConfirmationId) {
    return false;
  }

  await params.client.deliveryConfirmation.update({
    where: { id: params.deliveryConfirmationId },
    data: {
      manualReviewRequired: true,
      manualReviewReason: DELIVERY_MANUAL_REVIEW_REASONS.SMS_DELIVERY_FAILED,
      manualReviewMarkedAt: params.now,
      manualReviewNotes: formatManualReviewNote({
        reason: DELIVERY_MANUAL_REVIEW_REASONS.SMS_DELIVERY_FAILED,
        phone: params.toPhone,
        body: [params.messageStatus, params.errorCode, params.errorMessage]
          .filter(Boolean)
          .join(" "),
      }),
    },
  });

  return true;
}

export async function handleTwilioMessageStatus(params: {
  payload: TwilioFormPayload;
  prismaClient?: DeliveryTwilioStatusClient;
  now?: Date;
}): Promise<HandleTwilioMessageStatusResult> {
  const client = params.prismaClient ?? prisma;
  const now = params.now ?? new Date();
  const messageSid =
    payloadValue(params.payload, ["MessageSid", "SmsMessageSid", "SmsSid"]) ??
    `missing-${randomUUID()}`;
  const messageStatus = normalizeDeliverySmsBody(
    payloadValue(params.payload, ["MessageStatus", "SmsStatus", "MessageDeliveryStatus"]) ??
      "UNKNOWN"
  );
  const errorCode = payloadValue(params.payload, ["ErrorCode"]);
  const errorMessage = payloadValue(params.payload, ["ErrorMessage"]);
  const fromPhone = normalizePhoneToE164(payloadValue(params.payload, ["From"]));
  const toPhone = normalizePhoneToE164(payloadValue(params.payload, ["To"]));
  const key = callbackKey({ messageSid, messageStatus, errorCode });

  const existing = await client.twilioMessageStatusCallback.findUnique({
    where: { callbackKey: key },
    select: {
      id: true,
      callbackKey: true,
      messageSid: true,
      messageStatus: true,
      notificationAttemptId: true,
      notificationEventId: true,
      deliveryConfirmationId: true,
      matchStatus: true,
      processedAt: true,
    },
  });

  if (existing?.processedAt) {
    return {
      callbackId: existing.id,
      callbackKey: existing.callbackKey,
      messageSid: existing.messageSid,
      messageStatus: existing.messageStatus,
      matchStatus: "DUPLICATE",
      notificationAttemptId: existing.notificationAttemptId,
      notificationEventId: existing.notificationEventId,
      deliveryConfirmationId: existing.deliveryConfirmationId,
      manualReviewFlagged: false,
      duplicate: true,
    };
  }

  const callback =
    existing ??
    (await createStatusCallback({
      client,
      payload: params.payload,
      callbackKey: key,
      messageSid,
      messageStatus,
      errorCode,
      errorMessage,
      fromPhone,
      toPhone,
      now,
    }));

  const match = await findStatusMatch(client, messageSid);
  await updateMatchedAttempt({ client, match, messageStatus, errorCode, errorMessage, now });
  await updateMatchedEventFromStatus({
    client,
    match,
    messageSid,
    messageStatus,
    errorCode,
    errorMessage,
    now,
  });
  const manualReviewFlagged = await flagSmsDeliveryFailureForManualReview({
    client,
    deliveryConfirmationId: match.deliveryConfirmationId,
    messageStatus,
    errorCode,
    errorMessage,
    toPhone,
    now,
  });

  await client.twilioMessageStatusCallback.update({
    where: { id: callback.id },
    data: {
      matchStatus: match.matchStatus,
      notificationAttemptId: match.notificationAttemptId,
      notificationEventId: match.notificationEventId,
      deliveryConfirmationId: match.deliveryConfirmationId,
      processedAt: now,
    },
  });

  return {
    callbackId: callback.id,
    callbackKey: key,
    messageSid,
    messageStatus,
    matchStatus: match.matchStatus,
    notificationAttemptId: match.notificationAttemptId,
    notificationEventId: match.notificationEventId,
    deliveryConfirmationId: match.deliveryConfirmationId,
    manualReviewFlagged,
    duplicate: false,
  };
}
