import {
  DeliveryConfirmationStatus,
  NotificationChannel,
  type DeliveryConfirmation,
} from "@/lib/generated/prisma/client";
import {
  getSmsChangeRequestedNextStepMessage,
  getSmsInvalidDateFormatMessage,
  getSmsUnrecognizedResponseMessage,
  parseRequestedDeliveryDate,
  parseSmsConfirmationResponse,
} from "@/lib/notifications/deliveryConfirmationSms";
import { dateFromKey, dateKey } from "@/lib/notifications/helpers";
import { prisma } from "@/lib/prisma";

export type DeliveryConfirmationScope = {
  orderId: string;
  deliveryGroupId: string;
  notificationEventId?: string | null;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
  contactId: string;
  linkToken?: string | null;
  linkCreatedAt?: Date | string | null;
  linkExpiresAt?: Date | string | null;
};

export type RecordDeliveryConfirmationSmsResponseResult = {
  confirmation: DeliveryConfirmation;
  responseKind: "confirmed" | "change_requested" | "new_date_requested" | "unrecognized";
  replyMessage: string | null;
};

function dateTimeOrUndefined(value: Date | string | null | undefined) {
  if (!value) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function baseScopeData(scope: DeliveryConfirmationScope) {
  return {
    orderId: scope.orderId,
    deliveryGroupId: scope.deliveryGroupId,
    notificationEventId: scope.notificationEventId ?? undefined,
    orderType: scope.orderType,
    orderNumber: scope.orderNumber,
    deliveryDate: dateFromKey(scope.deliveryDate),
    contactId: scope.contactId,
    linkToken: scope.linkToken ?? undefined,
    linkCreatedAt: dateTimeOrUndefined(scope.linkCreatedAt),
    linkExpiresAt: dateTimeOrUndefined(scope.linkExpiresAt),
  };
}

function isAwaitingNewDate(status: DeliveryConfirmationStatus) {
  return (
    status === DeliveryConfirmationStatus.AWAITING_NEW_DATE ||
    status === DeliveryConfirmationStatus.CHANGE_REQUESTED
  );
}

export async function ensurePendingDeliveryConfirmation(scope: DeliveryConfirmationScope) {
  const scopeData = baseScopeData(scope);

  return prisma.deliveryConfirmation.upsert({
    where: {
      deliveryGroupId_deliveryDate: {
        deliveryGroupId: scope.deliveryGroupId,
        deliveryDate: scopeData.deliveryDate,
      },
    },
    create: {
      ...scopeData,
      status: DeliveryConfirmationStatus.PENDING,
    },
    update: {
      notificationEventId: scope.notificationEventId ?? undefined,
      linkToken: scope.linkToken ?? undefined,
      linkCreatedAt: dateTimeOrUndefined(scope.linkCreatedAt),
      linkExpiresAt: dateTimeOrUndefined(scope.linkExpiresAt),
    },
  });
}

export async function recordDeliveryConfirmationSmsResponse(params: {
  scope: DeliveryConfirmationScope;
  rawResponse: string;
  now?: Date;
}): Promise<RecordDeliveryConfirmationSmsResponseResult> {
  const now = params.now ?? new Date();
  const scopeData = baseScopeData(params.scope);
  const existing = await ensurePendingDeliveryConfirmation(params.scope);
  const parsedResponse = parseSmsConfirmationResponse(params.rawResponse);

  if (parsedResponse.kind === "confirmed") {
    const confirmation = await prisma.deliveryConfirmation.update({
      where: { id: existing.id },
      data: {
        status: DeliveryConfirmationStatus.CONFIRMED,
        responseChannel: NotificationChannel.SMS,
        rawResponse: parsedResponse.rawResponse,
        normalizedResponse: parsedResponse.normalizedResponse,
        confirmedAt: now,
      },
    });

    return { confirmation, responseKind: "confirmed", replyMessage: null };
  }

  if (parsedResponse.kind === "change_requested") {
    const confirmation = await prisma.deliveryConfirmation.update({
      where: { id: existing.id },
      data: {
        status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
        responseChannel: NotificationChannel.SMS,
        rawResponse: parsedResponse.rawResponse,
        normalizedResponse: parsedResponse.normalizedResponse,
        changeRequestedAt: now,
      },
    });

    return {
      confirmation,
      responseKind: "change_requested",
      replyMessage: getSmsChangeRequestedNextStepMessage(),
    };
  }

  if (isAwaitingNewDate(existing.status)) {
    const requestedDate = parseRequestedDeliveryDate(params.rawResponse);

    if (requestedDate.valid) {
      const confirmation = await prisma.deliveryConfirmation.update({
        where: { id: existing.id },
        data: {
          status: DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
          responseChannel: NotificationChannel.SMS,
          rawResponse: params.rawResponse,
          normalizedResponse: dateKey(requestedDate.date),
          requestedNewDate: requestedDate.date,
          requestedNewDateRaw: requestedDate.rawValue,
          requestedNewDateAt: now,
        },
      });

      return { confirmation, responseKind: "new_date_requested", replyMessage: null };
    }

    const confirmation = await prisma.deliveryConfirmation.update({
      where: { id: existing.id },
      data: {
        status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
        responseChannel: NotificationChannel.SMS,
        rawResponse: params.rawResponse,
        normalizedResponse: parsedResponse.normalizedResponse,
        requestedNewDateRaw: params.rawResponse,
      },
    });

    return {
      confirmation,
      responseKind: "unrecognized",
      replyMessage: getSmsInvalidDateFormatMessage(),
    };
  }

  const confirmation = await prisma.deliveryConfirmation.upsert({
    where: {
      deliveryGroupId_deliveryDate: {
        deliveryGroupId: params.scope.deliveryGroupId,
        deliveryDate: scopeData.deliveryDate,
      },
    },
    create: {
      ...scopeData,
      status: DeliveryConfirmationStatus.UNRECOGNIZED,
      responseChannel: NotificationChannel.SMS,
      rawResponse: parsedResponse.rawResponse,
      normalizedResponse: parsedResponse.normalizedResponse,
    },
    update: {
      status: DeliveryConfirmationStatus.UNRECOGNIZED,
      responseChannel: NotificationChannel.SMS,
      rawResponse: parsedResponse.rawResponse,
      normalizedResponse: parsedResponse.normalizedResponse,
    },
  });

  return {
    confirmation,
    responseKind: "unrecognized",
    replyMessage: getSmsUnrecognizedResponseMessage(),
  };
}
