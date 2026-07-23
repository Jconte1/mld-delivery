import { randomBytes } from "crypto";

import { Prisma } from "@/lib/generated/prisma/client";
import { getDeliveryAppBaseUrl } from "@/lib/notifications/deliveryConfirmationLinks";
import { dateFromKey, dateKey } from "@/lib/notifications/helpers";
import { prisma } from "@/lib/prisma";

type DeliveryDetailsLinkClient = Pick<
  Prisma.TransactionClient,
  "deliveryDetailsLink" | "notificationEvent"
>;

export type EnsureDeliveryDetailsLinkParams = {
  orderId: string;
  orderDeliveryGroupId: string;
  deliveryDate: Date | string;
  createdFromNotificationEventId?: string | null;
  expiresAt?: Date | string | null;
};

export function newDeliveryDetailsLinkToken() {
  return `dd_${randomBytes(24).toString("hex")}`;
}

export function buildDeliveryDetailsLink(token: string) {
  return `${getDeliveryAppBaseUrl()}/delivery/details/${encodeURIComponent(token)}`;
}

function normalizeOptionalDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function ensureDeliveryDetailsLink(
  params: EnsureDeliveryDetailsLinkParams,
  client: DeliveryDetailsLinkClient = prisma
) {
  const deliveryDate = dateFromKey(dateKey(params.deliveryDate));
  const existing = await client.deliveryDetailsLink.findUnique({
    where: {
      orderDeliveryGroupId_deliveryDate: {
        orderDeliveryGroupId: params.orderDeliveryGroupId,
        deliveryDate,
      },
    },
  });

  if (existing) {
    const link =
      existing.orderId === params.orderId
        ? existing
        : await client.deliveryDetailsLink.update({
            where: { id: existing.id },
            data: { orderId: params.orderId },
          });

    return { link, created: false };
  }

  try {
    const link = await client.deliveryDetailsLink.create({
      data: {
        token: newDeliveryDetailsLinkToken(),
        orderId: params.orderId,
        orderDeliveryGroupId: params.orderDeliveryGroupId,
        deliveryDate,
        createdFromNotificationEventId: params.createdFromNotificationEventId ?? null,
        expiresAt: normalizeOptionalDate(params.expiresAt),
      },
    });
    return { link, created: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }

    const link = await client.deliveryDetailsLink.findUniqueOrThrow({
      where: {
        orderDeliveryGroupId_deliveryDate: {
          orderDeliveryGroupId: params.orderDeliveryGroupId,
          deliveryDate,
        },
      },
    });
    return { link, created: false };
  }
}

export async function attachDeliveryDetailsLinkToNotificationEvent(
  params: { notificationEventId: string; detailsLinkId: string },
  client: DeliveryDetailsLinkClient = prisma
) {
  await client.notificationEvent.update({
    where: { id: params.notificationEventId },
    data: { detailsLinkId: params.detailsLinkId },
  });
}

export async function markDeliveryDetailsLinkCreatedFromEvent(
  params: { detailsLinkId: string; notificationEventId: string },
  client: DeliveryDetailsLinkClient = prisma
) {
  const link = await client.deliveryDetailsLink.findUnique({
    where: { id: params.detailsLinkId },
    select: { createdFromNotificationEventId: true },
  });

  if (link?.createdFromNotificationEventId) return;

  await client.deliveryDetailsLink.update({
    where: { id: params.detailsLinkId },
    data: { createdFromNotificationEventId: params.notificationEventId },
  });
}

// TODO: Decide and enforce delivery details link expiration policy after later interval flows are complete.
