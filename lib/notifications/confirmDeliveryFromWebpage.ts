import { DeliveryConfirmationStatus } from "@/lib/generated/prisma/client";
import {
  buildDeliveryConfirmationAttributeWritebackPayload,
  enqueueDeliveryConfirmationAttributeWriteback,
  type DeliveryConfirmationAttributeWritebackPayload,
  type EnqueueDeliveryConfirmationAttributeWritebackOptions,
} from "@/lib/notifications/deliveryConfirmationAttributeWritebackQueue";
import { dateKey } from "@/lib/notifications/helpers";

export type ConfirmDeliveryFromWebpageClient = {
  deliveryConfirmation: {
    findUnique(args: unknown): Promise<unknown | null>;
    update(args: unknown): Promise<unknown>;
  };
};

type WebConfirmationSnapshot = {
  id: string;
  status: DeliveryConfirmationStatus;
  confirmedAt: Date | null;
  orderType: string;
  orderNumber: string;
  deliveryGroupId: string;
  deliveryDate: Date;
  linkExpiresAt: Date | null;
  linkExpiredAt: Date | null;
  contact: {
    displayName: string | null;
    companyName: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  };
  orderDeliveryGroup: {
    id: string;
    isActive: boolean;
    deliveryDate: Date;
    order: {
      id: string;
      confirmVia: string | null;
      address: {
        state: string | null;
        postalCode: string | null;
      } | null;
    };
  };
};

type ConfirmedDeliverySnapshot = {
  id: string;
  status: DeliveryConfirmationStatus;
  confirmedAt: Date | null;
  orderType: string;
  orderNumber: string;
  deliveryGroupId: string;
  deliveryDate: Date;
};

export type DeliveryConfirmationWebActionGuardResult =
  | { outcome: "eligible"; confirmation: WebConfirmationSnapshot }
  | { outcome: "not_found"; confirmation: null }
  | {
      outcome:
        | "already_final"
        | "expired"
        | "stale"
        | "refresh_failed"
        | "already_confirmed_in_acumatica";
      confirmation: WebConfirmationSnapshot;
      error?: string | null;
    };

export type ConfirmDeliveryFromWebpageResult =
  | {
      outcome: "not_found" | "expired" | "stale" | "refresh_failed";
      writeback: null;
      error?: string | null;
    }
  | {
      outcome: "already_final" | "already_confirmed_in_acumatica";
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

function normalizeAcumaticaConfirmVia(value: unknown) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function isConfirmationExpired(confirmation: WebConfirmationSnapshot, now: Date) {
  if (confirmation.linkExpiredAt) return true;
  return Boolean(confirmation.linkExpiresAt && confirmation.linkExpiresAt.getTime() < now.getTime());
}

function isConfirmationStale(confirmation: WebConfirmationSnapshot) {
  if (confirmation.status === DeliveryConfirmationStatus.EXPIRED) return true;
  const deliveryGroup = confirmation.orderDeliveryGroup;
  if (!deliveryGroup.isActive) return true;
  return dateKey(deliveryGroup.deliveryDate) !== dateKey(confirmation.deliveryDate);
}

async function defaultConfirmDeliveryFromWebpageClient() {
  const { prisma } = await import("@/lib/prisma");
  return prisma as unknown as ConfirmDeliveryFromWebpageClient;
}

async function findWebConfirmation(
  client: ConfirmDeliveryFromWebpageClient,
  linkToken: string
) {
  const confirmation = await client.deliveryConfirmation.findUnique({
    where: { linkToken },
    select: {
      id: true,
      status: true,
      confirmedAt: true,
      orderType: true,
      orderNumber: true,
      deliveryGroupId: true,
      deliveryDate: true,
      linkExpiresAt: true,
      linkExpiredAt: true,
      contact: {
        select: {
          displayName: true,
          companyName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      orderDeliveryGroup: {
        select: {
          id: true,
          isActive: true,
          deliveryDate: true,
          order: {
            select: {
              id: true,
              confirmVia: true,
              address: {
                select: {
                  state: true,
                  postalCode: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return confirmation as WebConfirmationSnapshot | null;
}

async function refreshWebConfirmationCurrentState(confirmation: WebConfirmationSnapshot) {
  const { importSalesOrdersForLineRequestedOn } = await import("@/lib/erp/importSalesOrders");
  await importSalesOrdersForLineRequestedOn(confirmation.deliveryDate, {
    orderLookups: [
      {
        orderNumber: confirmation.orderNumber,
        orderType: confirmation.orderType,
      },
    ],
    includeUnqualifiedOrderLookups: true,
  });
}

export async function guardDeliveryConfirmationWebAction(params: {
  linkToken: string;
  prismaClient?: ConfirmDeliveryFromWebpageClient;
  now?: Date;
  refreshCurrentState?: (confirmation: WebConfirmationSnapshot) => Promise<void>;
}): Promise<DeliveryConfirmationWebActionGuardResult> {
  const client = params.prismaClient ?? (await defaultConfirmDeliveryFromWebpageClient());
  const now = params.now ?? new Date();
  const initial = await findWebConfirmation(client, params.linkToken);

  if (!initial) return { outcome: "not_found", confirmation: null };
  if (isConfirmationExpired(initial, now)) return { outcome: "expired", confirmation: initial };
  if (isFinalConfirmationStatus(initial.status)) {
    return { outcome: "already_final", confirmation: initial };
  }

  try {
    await (params.refreshCurrentState ?? refreshWebConfirmationCurrentState)(initial);
  } catch (error) {
    return {
      outcome: "refresh_failed",
      confirmation: initial,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const refreshed = await findWebConfirmation(client, params.linkToken);
  if (!refreshed) return { outcome: "not_found", confirmation: null };
  if (isConfirmationExpired(refreshed, now)) return { outcome: "expired", confirmation: refreshed };
  if (isFinalConfirmationStatus(refreshed.status)) {
    return { outcome: "already_final", confirmation: refreshed };
  }
  if (isConfirmationStale(refreshed)) return { outcome: "stale", confirmation: refreshed };
  if (normalizeAcumaticaConfirmVia(refreshed.orderDeliveryGroup.order.confirmVia)) {
    return { outcome: "already_confirmed_in_acumatica", confirmation: refreshed };
  }

  return { outcome: "eligible", confirmation: refreshed };
}

export async function confirmDeliveryFromWebpage(params: {
  linkToken: string;
  prismaClient?: ConfirmDeliveryFromWebpageClient;
  now?: Date;
  queueOptions?: EnqueueDeliveryConfirmationAttributeWritebackOptions;
  refreshCurrentState?: (confirmation: WebConfirmationSnapshot) => Promise<void>;
}): Promise<ConfirmDeliveryFromWebpageResult> {
  const client = params.prismaClient ?? (await defaultConfirmDeliveryFromWebpageClient());
  const guard = await guardDeliveryConfirmationWebAction({
    linkToken: params.linkToken,
    prismaClient: client,
    now: params.now,
    refreshCurrentState: params.refreshCurrentState,
  });

  if (guard.outcome === "not_found") return { outcome: "not_found", writeback: null };
  if (guard.outcome === "expired") return { outcome: "expired", writeback: null };
  if (guard.outcome === "stale") return { outcome: "stale", writeback: null };
  if (guard.outcome === "refresh_failed") {
    return { outcome: "refresh_failed", writeback: null, error: guard.error };
  }

  if (guard.outcome === "already_final" || guard.outcome === "already_confirmed_in_acumatica") {
    return {
      outcome: guard.outcome,
      confirmation: {
        id: guard.confirmation.id,
        status: guard.confirmation.status,
      },
      writeback: null,
    };
  }

  const confirmation = guard.confirmation;
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
      confirmation: updated as ConfirmedDeliverySnapshot,
      writeback: {
        payload: queued.payload,
        jobId: queued.jobId,
        error: null,
      },
    };
  } catch (error) {
    return {
      outcome: "confirmed",
      confirmation: updated as ConfirmedDeliverySnapshot,
      writeback: {
        payload,
        jobId: null,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
