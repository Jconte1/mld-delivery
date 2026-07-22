import {
  DeliveryConfirmationStatus,
  NotificationChannel,
  Prisma,
} from "@/lib/generated/prisma/client";
import {
  SMS_CONFIRMED_VIA_VALUE,
  enqueueDeliveryConfirmationAttributeWriteback,
  type EnqueueDeliveryConfirmationAttributeWritebackOptions,
} from "@/lib/notifications/deliveryConfirmationAttributeWritebackQueue";
import {
  DELIVERY_MANUAL_REVIEW_REASONS,
  formatManualReviewNote,
} from "@/lib/notifications/deliveryConfirmationManualReview";
import {
  getSmsAmbiguousReplyMessage,
  getSmsChangeRequestedNextStepMessage,
  getSmsConfirmedMessage,
  getSmsHelpMessage,
  getSmsNewDateReceivedMessage,
  getSmsOptInMessage,
  getSmsUnmatchedReplyMessage,
  getSmsUnrecognizedClarificationMessage,
  getSmsUnrecognizedFinalMessage,
  normalizeDeliverySmsBody,
  normalizePhoneToE164,
  parseDeliverySmsReplyIntent,
  phonesMatch,
  validateRequestedDeliveryDate,
  type DeliverySmsReplyIntent,
} from "@/lib/notifications/deliveryConfirmationSmsReplies";
import { dateFromKey, dateKey } from "@/lib/notifications/helpers";
import { prisma } from "@/lib/prisma";
import type { TwilioFormPayload } from "@/lib/notifications/twilioWebhook";

type DeliveryTwilioInboundClient = Pick<
  typeof prisma,
  "twilioInboundMessage" | "deliveryConfirmation" | "smsOptOut" | "contact"
>;

type InboundCandidate = Awaited<ReturnType<typeof findActiveDeliveryConfirmationCandidates>>[number];

export type HandleTwilioInboundSmsResult = {
  inboundMessageId: string;
  messageSid: string | null;
  parsedIntent: DeliverySmsReplyIntent;
  matchStatus:
    | "MATCHED"
    | "AMBIGUOUS"
    | "UNMATCHED"
    | "OPTED_OUT"
    | "OPTED_IN"
    | "HELP"
    | "DUPLICATE"
    | "ERROR";
  deliveryConfirmationId: string | null;
  notificationEventId: string | null;
  responseMessage: string | null;
  writebackJobId?: string | null;
  writebackError?: string | null;
  duplicate: boolean;
};

const ACTIVE_SMS_CONFIRMATION_STATUSES = [
  DeliveryConfirmationStatus.PENDING,
  DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  DeliveryConfirmationStatus.CHANGE_REQUESTED,
  DeliveryConfirmationStatus.UNRECOGNIZED,
  DeliveryConfirmationStatus.INCOMPLETE,
] as const;

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

function phoneLookupValues(phone: string | null) {
  if (!phone) return [];
  const digits = phone.replace(/\D/g, "");
  return Array.from(new Set([phone, digits, digits.startsWith("1") ? digits.slice(1) : digits]));
}

function isAwaitingNewDate(status: DeliveryConfirmationStatus) {
  return (
    status === DeliveryConfirmationStatus.AWAITING_NEW_DATE ||
    status === DeliveryConfirmationStatus.CHANGE_REQUESTED
  );
}

async function findExistingProcessedInboundMessage(
  client: DeliveryTwilioInboundClient,
  messageSid: string | null
) {
  if (!messageSid) return null;

  return client.twilioInboundMessage.findUnique({
    where: { messageSid },
    select: {
      id: true,
      messageSid: true,
      parsedIntent: true,
      matchStatus: true,
      deliveryConfirmationId: true,
      notificationEventId: true,
      responseMessage: true,
      processedAt: true,
    },
  });
}

async function createInboundMessage(params: {
  client: DeliveryTwilioInboundClient;
  payload: TwilioFormPayload;
  messageSid: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  body: string | null;
  normalizedBody: string;
  parsedIntent: DeliverySmsReplyIntent;
  now: Date;
}) {
  const data = {
    messageSid: params.messageSid,
    accountSid: payloadValue(params.payload, ["AccountSid"]),
    messagingServiceSid: payloadValue(params.payload, ["MessagingServiceSid"]),
    fromPhone: params.fromPhone,
    toPhone: params.toPhone,
    body: params.body,
    normalizedBody: params.normalizedBody,
    parsedIntent: params.parsedIntent,
    matchStatus: "UNPROCESSED",
    rawPayload: rawPayloadJson(params.payload),
    receivedAt: params.now,
  };

  try {
    return await params.client.twilioInboundMessage.create({
      data,
      select: { id: true },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error) || !params.messageSid) throw error;
    const existing = await params.client.twilioInboundMessage.findUnique({
      where: { messageSid: params.messageSid },
      select: { id: true },
    });
    if (!existing) throw error;
    return existing;
  }
}

async function finishInboundMessage(params: {
  client: DeliveryTwilioInboundClient;
  id: string;
  matchStatus: HandleTwilioInboundSmsResult["matchStatus"];
  parsedIntent: DeliverySmsReplyIntent;
  deliveryConfirmationId?: string | null;
  notificationEventId?: string | null;
  responseMessage?: string | null;
  error?: string | null;
  now: Date;
}) {
  await params.client.twilioInboundMessage.update({
    where: { id: params.id },
    data: {
      matchStatus: params.matchStatus,
      parsedIntent: params.parsedIntent,
      deliveryConfirmationId: params.deliveryConfirmationId ?? undefined,
      notificationEventId: params.notificationEventId ?? undefined,
      responseMessage: params.responseMessage ?? null,
      responseSent: Boolean(params.responseMessage),
      error: params.error ?? null,
      processedAt: params.now,
    },
  });
}

async function findMatchingContactId(client: DeliveryTwilioInboundClient, phone: string | null) {
  const lookupValues = phoneLookupValues(phone);
  if (lookupValues.length === 0) return null;

  const contacts = await client.contact.findMany({
    where: {
      OR: [{ phone1: { in: lookupValues } }, { phone2: { in: lookupValues } }],
    },
    select: { contactId: true, phone1: true, phone2: true },
    take: 5,
  });
  const matching = contacts.filter(
    (contact) => phonesMatch(contact.phone1, phone) || phonesMatch(contact.phone2, phone)
  );

  return matching.length === 1 ? matching[0].contactId : null;
}

async function upsertSmsOptOut(params: {
  client: DeliveryTwilioInboundClient;
  phone: string;
  body: string | null;
  now: Date;
}) {
  const contactId = await findMatchingContactId(params.client, params.phone);
  const existing = await params.client.smsOptOut.findFirst({
    where: { phone: params.phone, isActive: true },
    select: { id: true },
  });

  if (existing) {
    await params.client.smsOptOut.update({
      where: { id: existing.id },
      data: {
        contactId,
        source: "TWILIO_INBOUND_KEYWORD",
        reason: params.body,
        optedOutAt: params.now,
        optedBackInAt: null,
        isActive: true,
      },
    });
    return;
  }

  await params.client.smsOptOut.create({
    data: {
      contactId,
      phone: params.phone,
      source: "TWILIO_INBOUND_KEYWORD",
      reason: params.body,
      optedOutAt: params.now,
      isActive: true,
    },
  });
}

async function optBackInSms(params: {
  client: DeliveryTwilioInboundClient;
  phone: string;
  body: string | null;
  now: Date;
}) {
  const lookupValues = phoneLookupValues(params.phone);
  await params.client.smsOptOut.updateMany({
    where: {
      isActive: true,
      phone: { in: lookupValues },
    },
    data: {
      source: "TWILIO_INBOUND_KEYWORD",
      reason: params.body,
      optedBackInAt: params.now,
      isActive: false,
    },
  });
}

async function findActiveDeliveryConfirmationCandidates(params: {
  client: DeliveryTwilioInboundClient;
  fromPhone: string;
  now: Date;
}) {
  const today = dateFromKey(dateKey(params.now));
  const recentFloor = new Date(params.now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const candidates = await params.client.deliveryConfirmation.findMany({
    where: {
      status: { in: [...ACTIVE_SMS_CONFIRMATION_STATUSES] },
      deliveryDate: { gte: today },
      OR: [
        { linkExpiresAt: null },
        { linkExpiresAt: { gte: params.now } },
        { createdAt: { gte: recentFloor } },
      ],
      contact: {
        OR: [{ phone1: { not: null } }, { phone2: { not: null } }],
      },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    include: {
      contact: {
        select: {
          contactId: true,
          displayName: true,
          companyName: true,
          firstName: true,
          lastName: true,
          email: true,
          phone1: true,
          phone2: true,
        },
      },
      notificationEvent: {
        select: {
          id: true,
          createdAt: true,
          scheduledAt: true,
          triggeredAt: true,
          sentAt: true,
        },
      },
      order: {
        select: {
          address: {
            select: {
              state: true,
              postalCode: true,
            },
          },
        },
      },
    },
  });

  return candidates.filter(
    (candidate) =>
      phonesMatch(candidate.contact.phone1, params.fromPhone) ||
      phonesMatch(candidate.contact.phone2, params.fromPhone)
  );
}

async function markAmbiguousCandidates(params: {
  client: DeliveryTwilioInboundClient;
  candidates: InboundCandidate[];
  fromPhone: string | null;
  body: string | null;
  now: Date;
}) {
  await params.client.deliveryConfirmation.updateMany({
    where: { id: { in: params.candidates.map((candidate) => candidate.id) } },
    data: {
      manualReviewRequired: true,
      manualReviewReason: DELIVERY_MANUAL_REVIEW_REASONS.AMBIGUOUS_SMS_REPLY,
      manualReviewMarkedAt: params.now,
      manualReviewNotes: formatManualReviewNote({
        reason: DELIVERY_MANUAL_REVIEW_REASONS.AMBIGUOUS_SMS_REPLY,
        phone: params.fromPhone,
        body: params.body,
      }),
    },
  });
}

async function applyInvalidDateResponse(params: {
  client: DeliveryTwilioInboundClient;
  candidate: InboundCandidate;
  body: string | null;
  normalizedBody: string;
  now: Date;
}) {
  const validation = validateRequestedDeliveryDate({
    rawValue: params.body ?? "",
    currentDeliveryDate: params.candidate.deliveryDate,
    address: params.candidate.order.address,
    now: params.now,
  });

  await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      responseChannel: NotificationChannel.SMS,
      rawResponse: params.body,
      normalizedResponse: validation.valid ? validation.dateKey : params.normalizedBody,
      requestedNewDateRaw: params.body,
      lastSmsResponseAt: params.now,
      lastSmsResponseBody: params.body,
    },
  });

  return validation.responseMessage;
}

async function applyRequestedDate(params: {
  client: DeliveryTwilioInboundClient;
  candidate: InboundCandidate;
  body: string | null;
  now: Date;
}) {
  const validation = validateRequestedDeliveryDate({
    rawValue: params.body ?? "",
    currentDeliveryDate: params.candidate.deliveryDate,
    address: params.candidate.order.address,
    now: params.now,
  });

  if (!validation.valid) {
    await params.client.deliveryConfirmation.update({
      where: { id: params.candidate.id },
      data: {
        responseChannel: NotificationChannel.SMS,
        rawResponse: params.body,
        normalizedResponse: validation.reason,
        requestedNewDateRaw: params.body,
        lastSmsResponseAt: params.now,
        lastSmsResponseBody: params.body,
      },
    });
    return validation.responseMessage;
  }

  await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      status: DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
      responseChannel: NotificationChannel.SMS,
      rawResponse: params.body,
      normalizedResponse: validation.dateKey,
      requestedNewDate: validation.date,
      requestedNewDateRaw: validation.rawValue,
      requestedNewDateAt: params.now,
      manualReviewRequired: true,
      manualReviewReason: DELIVERY_MANUAL_REVIEW_REASONS.NEW_DATE_REQUESTED,
      manualReviewMarkedAt: params.now,
      manualReviewNotes: formatManualReviewNote({
        reason: DELIVERY_MANUAL_REVIEW_REASONS.NEW_DATE_REQUESTED,
        phone: params.candidate.contact.phone1 ?? params.candidate.contact.phone2,
        body: params.body,
      }),
      lastSmsResponseAt: params.now,
      lastSmsResponseBody: params.body,
    },
  });

  return getSmsNewDateReceivedMessage(validation.date);
}

async function applyUnrecognizedResponse(params: {
  client: DeliveryTwilioInboundClient;
  candidate: InboundCandidate;
  body: string | null;
  normalizedBody: string;
  now: Date;
}) {
  const currentCount = params.candidate.unrecognizedResponseCount ?? 0;
  const newCount = currentCount + 1;
  const tooMany = newCount >= 3;

  await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      status: DeliveryConfirmationStatus.UNRECOGNIZED,
      responseChannel: NotificationChannel.SMS,
      rawResponse: params.body,
      normalizedResponse: params.normalizedBody,
      unrecognizedResponseCount: { increment: 1 },
      lastSmsResponseAt: params.now,
      lastSmsResponseBody: params.body,
      manualReviewRequired: tooMany ? true : undefined,
      manualReviewReason: tooMany
        ? DELIVERY_MANUAL_REVIEW_REASONS.TOO_MANY_UNRECOGNIZED_RESPONSES
        : undefined,
      manualReviewMarkedAt: tooMany ? params.now : undefined,
      manualReviewNotes: tooMany
        ? formatManualReviewNote({
            reason: DELIVERY_MANUAL_REVIEW_REASONS.TOO_MANY_UNRECOGNIZED_RESPONSES,
            phone: params.candidate.contact.phone1 ?? params.candidate.contact.phone2,
            body: params.body,
          })
        : undefined,
    },
  });

  if (newCount < 3) return getSmsUnrecognizedClarificationMessage();
  if (newCount === 3) return getSmsUnrecognizedFinalMessage();
  return null;
}

async function applyConfirmation(params: {
  client: DeliveryTwilioInboundClient;
  candidate: InboundCandidate;
  body: string | null;
  normalizedBody: string;
  now: Date;
  queueOptions?: EnqueueDeliveryConfirmationAttributeWritebackOptions;
}) {
  const updated = await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      status: DeliveryConfirmationStatus.CONFIRMED,
      responseChannel: NotificationChannel.SMS,
      rawResponse: params.body,
      normalizedResponse: params.normalizedBody,
      confirmedAt: params.now,
      requestedNewDate: null,
      requestedNewDateRaw: null,
      requestedNewDateAt: null,
      lastSmsResponseAt: params.now,
      lastSmsResponseBody: params.body,
      manualReviewRequired: false,
      manualReviewReason: null,
      manualReviewMarkedAt: null,
      manualReviewNotes: null,
    },
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      deliveryGroupId: true,
      deliveryDate: true,
    },
  });

  try {
    const queued = await enqueueDeliveryConfirmationAttributeWriteback(
      {
        orderType: updated.orderType,
        orderNumber: updated.orderNumber,
        deliveryConfirmationId: updated.id,
        deliveryGroupId: updated.deliveryGroupId,
        deliveryDate: updated.deliveryDate,
        confirmedVia: SMS_CONFIRMED_VIA_VALUE,
        source: "SMS",
        contact: {
          displayName: params.candidate.contact.displayName,
          companyName: params.candidate.contact.companyName,
          firstName: params.candidate.contact.firstName,
          lastName: params.candidate.contact.lastName,
          email: params.candidate.contact.email,
          phone: params.candidate.contact.phone1 ?? params.candidate.contact.phone2,
        },
      },
      params.queueOptions
    );

    return { responseMessage: getSmsConfirmedMessage(), writebackJobId: queued.jobId, error: null };
  } catch (error) {
    return {
      responseMessage: getSmsConfirmedMessage(),
      writebackJobId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function result(params: {
  inboundMessageId: string;
  messageSid: string | null;
  parsedIntent: DeliverySmsReplyIntent;
  matchStatus: HandleTwilioInboundSmsResult["matchStatus"];
  deliveryConfirmationId?: string | null;
  notificationEventId?: string | null;
  responseMessage?: string | null;
  writebackJobId?: string | null;
  writebackError?: string | null;
  duplicate?: boolean;
}): HandleTwilioInboundSmsResult {
  return {
    inboundMessageId: params.inboundMessageId,
    messageSid: params.messageSid,
    parsedIntent: params.parsedIntent,
    matchStatus: params.matchStatus,
    deliveryConfirmationId: params.deliveryConfirmationId ?? null,
    notificationEventId: params.notificationEventId ?? null,
    responseMessage: params.responseMessage ?? null,
    writebackJobId: params.writebackJobId,
    writebackError: params.writebackError,
    duplicate: params.duplicate ?? false,
  };
}

export async function handleTwilioInboundSms(params: {
  payload: TwilioFormPayload;
  prismaClient?: DeliveryTwilioInboundClient;
  now?: Date;
  queueOptions?: EnqueueDeliveryConfirmationAttributeWritebackOptions;
}): Promise<HandleTwilioInboundSmsResult> {
  const client = params.prismaClient ?? prisma;
  const now = params.now ?? new Date();
  const messageSid = payloadValue(params.payload, ["MessageSid", "SmsMessageSid", "SmsSid"]);
  const fromPhone = normalizePhoneToE164(payloadValue(params.payload, ["From"]));
  const toPhone = normalizePhoneToE164(payloadValue(params.payload, ["To"]));
  const body = payloadValue(params.payload, ["Body"]) ?? "";
  const normalizedBody = normalizeDeliverySmsBody(body);
  const parsedIntent = parseDeliverySmsReplyIntent(body);

  const existing = await findExistingProcessedInboundMessage(client, messageSid);
  if (existing?.processedAt) {
    return result({
      inboundMessageId: existing.id,
      messageSid,
      parsedIntent: existing.parsedIntent as DeliverySmsReplyIntent,
      matchStatus: "DUPLICATE",
      deliveryConfirmationId: existing.deliveryConfirmationId,
      notificationEventId: existing.notificationEventId,
      responseMessage: existing.responseMessage,
      duplicate: true,
    });
  }

  const inbound = existing ?? (await createInboundMessage({
    client,
    payload: params.payload,
    messageSid,
    fromPhone,
    toPhone,
    body,
    normalizedBody,
    parsedIntent,
    now,
  }));

  try {
    if (!fromPhone) {
      await finishInboundMessage({
        client,
        id: inbound.id,
        parsedIntent,
        matchStatus: "UNMATCHED",
        responseMessage: null,
        now,
      });
      return result({
        inboundMessageId: inbound.id,
        messageSid,
        parsedIntent,
        matchStatus: "UNMATCHED",
      });
    }

    if (parsedIntent === "STOP") {
      await upsertSmsOptOut({ client, phone: fromPhone, body, now });
      await finishInboundMessage({
        client,
        id: inbound.id,
        parsedIntent,
        matchStatus: "OPTED_OUT",
        responseMessage: null,
        now,
      });
      return result({
        inboundMessageId: inbound.id,
        messageSid,
        parsedIntent,
        matchStatus: "OPTED_OUT",
      });
    }

    if (parsedIntent === "START") {
      const responseMessage = getSmsOptInMessage();
      await optBackInSms({ client, phone: fromPhone, body, now });
      await finishInboundMessage({
        client,
        id: inbound.id,
        parsedIntent,
        matchStatus: "OPTED_IN",
        responseMessage,
        now,
      });
      return result({
        inboundMessageId: inbound.id,
        messageSid,
        parsedIntent,
        matchStatus: "OPTED_IN",
        responseMessage,
      });
    }

    if (parsedIntent === "HELP") {
      const responseMessage = getSmsHelpMessage();
      await finishInboundMessage({
        client,
        id: inbound.id,
        parsedIntent,
        matchStatus: "HELP",
        responseMessage,
        now,
      });
      return result({
        inboundMessageId: inbound.id,
        messageSid,
        parsedIntent,
        matchStatus: "HELP",
        responseMessage,
      });
    }

    const candidates = await findActiveDeliveryConfirmationCandidates({ client, fromPhone, now });

    if (candidates.length === 0) {
      const responseMessage = getSmsUnmatchedReplyMessage();
      await finishInboundMessage({
        client,
        id: inbound.id,
        parsedIntent,
        matchStatus: "UNMATCHED",
        responseMessage,
        now,
      });
      return result({
        inboundMessageId: inbound.id,
        messageSid,
        parsedIntent,
        matchStatus: "UNMATCHED",
        responseMessage,
      });
    }

    if (candidates.length > 1) {
      const responseMessage = getSmsAmbiguousReplyMessage();
      await markAmbiguousCandidates({ client, candidates, fromPhone, body, now });
      await finishInboundMessage({
        client,
        id: inbound.id,
        parsedIntent,
        matchStatus: "AMBIGUOUS",
        responseMessage,
        now,
      });
      return result({
        inboundMessageId: inbound.id,
        messageSid,
        parsedIntent,
        matchStatus: "AMBIGUOUS",
        responseMessage,
      });
    }

    const candidate = candidates[0];
    let responseMessage: string | null = null;
    let writebackJobId: string | null | undefined;
    let writebackError: string | null | undefined;

    if (parsedIntent === "CONFIRM") {
      const confirmationResult = await applyConfirmation({
        client,
        candidate,
        body,
        normalizedBody,
        now,
        queueOptions: params.queueOptions,
      });
      responseMessage = confirmationResult.responseMessage;
      writebackJobId = confirmationResult.writebackJobId;
      writebackError = confirmationResult.error;
    } else if (parsedIntent === "CHANGE_REQUEST") {
      responseMessage = getSmsChangeRequestedNextStepMessage();
      await client.deliveryConfirmation.update({
        where: { id: candidate.id },
        data: {
          status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
          responseChannel: NotificationChannel.SMS,
          rawResponse: body,
          normalizedResponse: normalizedBody,
          changeRequestedAt: now,
          lastSmsResponseAt: now,
          lastSmsResponseBody: body,
        },
      });
    } else if (parsedIntent === "REQUESTED_DATE") {
      responseMessage = await applyRequestedDate({ client, candidate, body, now });
    } else if (isAwaitingNewDate(candidate.status)) {
      responseMessage = await applyInvalidDateResponse({
        client,
        candidate,
        body,
        normalizedBody,
        now,
      });
    } else {
      responseMessage = await applyUnrecognizedResponse({
        client,
        candidate,
        body,
        normalizedBody,
        now,
      });
    }

    await finishInboundMessage({
      client,
      id: inbound.id,
      parsedIntent,
      matchStatus: "MATCHED",
      deliveryConfirmationId: candidate.id,
      notificationEventId: candidate.notificationEventId,
      responseMessage,
      error: writebackError ?? null,
      now,
    });

    return result({
      inboundMessageId: inbound.id,
      messageSid,
      parsedIntent,
      matchStatus: "MATCHED",
      deliveryConfirmationId: candidate.id,
      notificationEventId: candidate.notificationEventId,
      responseMessage,
      writebackJobId,
      writebackError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishInboundMessage({
      client,
      id: inbound.id,
      parsedIntent,
      matchStatus: "ERROR",
      responseMessage: null,
      error: message,
      now,
    });
    throw error;
  }
}
