import { DeliveryConfirmationStatus } from "@/lib/generated/prisma/client";
import {
  buildDeliveryConfirmationAttributeWritebackPayload,
  enqueueDeliveryConfirmationAttributeWriteback,
  type DeliveryConfirmationAttributeWritebackPayload,
  type EnqueueDeliveryConfirmationAttributeWritebackOptions,
} from "@/lib/notifications/deliveryConfirmationAttributeWritebackQueue";
import { prisma } from "@/lib/prisma";

export type ConfirmDeliveryFromWebpageClient = Pick<typeof prisma, "deliveryConfirmation">;

type ConfirmedDeliverySnapshot = {
  id: string;
  status: DeliveryConfirmationStatus;
  confirmedAt: Date | null;
  orderType: string;
  orderNumber: string;
  deliveryGroupId: string;
  deliveryDate: Date;
};

export type ConfirmDeliveryFromWebpageResult =
  | {
      outcome: "not_found";
      writeback: null;
    }
  | {
      outcome: "already_final";
      confirmation: Pick<ConfirmedDeliverySnapshot, "id" | "status">;
      writeback: null;
    }
  | {
      outcome: "confirmed";
      confirmation: ConfirmedDeliverySnapshot;
      writeback: {
        payload: DeliveryConfirmationAttributeWritebackPayload;
        jobId: string | null;
        error: string | null;
      };
    };

function isFinalConfirmationStatus(value: DeliveryConfirmationStatus) {
  return (
    value === DeliveryConfirmationStatus.CONFIRMED ||
    value === DeliveryConfirmationStatus.NEW_DATE_REQUESTED
  );
}

export async function confirmDeliveryFromWebpage(params: {
  linkToken: string;
  prismaClient?: ConfirmDeliveryFromWebpageClient;
  now?: Date;
  queueOptions?: EnqueueDeliveryConfirmationAttributeWritebackOptions;
}): Promise<ConfirmDeliveryFromWebpageResult> {
  const client = params.prismaClient ?? prisma;
  const confirmation = await client.deliveryConfirmation.findUnique({
    where: { linkToken: params.linkToken },
    select: {
      id: true,
      status: true,
      orderType: true,
      orderNumber: true,
      deliveryGroupId: true,
      deliveryDate: true,
      contact: {
        select: {
          displayName: true,
          companyName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  if (!confirmation) {
    return { outcome: "not_found", writeback: null };
  }

  if (isFinalConfirmationStatus(confirmation.status)) {
    return {
      outcome: "already_final",
      confirmation: {
        id: confirmation.id,
        status: confirmation.status,
      },
      writeback: null,
    };
  }

  const confirmedAt = params.now ?? new Date();
  const updated = await client.deliveryConfirmation.update({
    where: { id: confirmation.id },
    data: {
      status: DeliveryConfirmationStatus.CONFIRMED,
      confirmedAt,
    },
    select: {
      id: true,
      status: true,
      confirmedAt: true,
      orderType: true,
      orderNumber: true,
      deliveryGroupId: true,
      deliveryDate: true,
    },
  });

  const payload = buildDeliveryConfirmationAttributeWritebackPayload({
    orderType: confirmation.orderType,
    orderNumber: confirmation.orderNumber,
    deliveryConfirmationId: confirmation.id,
    deliveryGroupId: confirmation.deliveryGroupId,
    deliveryDate: confirmation.deliveryDate,
    contact: confirmation.contact,
  });

  try {
    const queued = await enqueueDeliveryConfirmationAttributeWriteback(
      {
        orderType: confirmation.orderType,
        orderNumber: confirmation.orderNumber,
        deliveryConfirmationId: confirmation.id,
        deliveryGroupId: confirmation.deliveryGroupId,
        deliveryDate: confirmation.deliveryDate,
        contact: confirmation.contact,
      },
      params.queueOptions
    );

    return {
      outcome: "confirmed",
      confirmation: updated,
      writeback: {
        payload: queued.payload,
        jobId: queued.jobId,
        error: null,
      },
    };
  } catch (error) {
    return {
      outcome: "confirmed",
      confirmation: updated,
      writeback: {
        payload,
        jobId: null,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
