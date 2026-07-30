import {
  isEligibleDeliveryPaymentTerm,
  type DeliveryGroupPaymentEvaluation,
} from "@/lib/delivery-payment/deliveryGroupPayment";
import {
  NotificationIntervalType,
  type Order,
  type OrderDeliveryGroup,
} from "@/lib/generated/prisma/client";
import { dateFromKey, dateKey } from "@/lib/notifications/helpers";
import {
  enqueueDeliveryTenDayConfirmationWriteback,
  type DeliveryTenDayConfirmationQueueResult,
  type EnqueueDeliveryTenDayConfirmationWritebackOptions,
  type EnqueueDeliveryTenDayConfirmationWritebackResult,
  type EnqueueDeliveryTenDayConfirmationWritebackParams,
} from "@/lib/notifications/deliveryTenDayConfirmationWritebackQueue";
import { prisma } from "@/lib/prisma";

export const DELIVERY_TEN_DAY_CONFIRMATION_REASONS = {
  nonPrepayTermsCleared: "non_prepay_terms_cleared",
  prepayBalanceCleared: "prepay_balance_cleared",
  prepayBalanceNotCleared: "prepay_balance_not_cleared",
  acumaticaAlreadyTrue: "one_week_confirmation_already_true",
  acumaticaWritten: "one_week_confirmation_written",
  dryRun: "dry_run",
  writebackRefused: "one_week_confirmation_writeback_failed",
  writebackFailed: "one_week_confirmation_writeback_failed",
  writebackQueued: "one_week_confirmation_writeback_pending",
  mismatchPaymentNotCleared: "acumatica_one_week_true_but_group_balance_due",
} as const;

export const DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES = {
  NOT_CLEARED: "NOT_CLEARED",
  DRY_RUN: "DRY_RUN",
  QUEUED: "QUEUED",
  WRITTEN: "WRITTEN",
  ALREADY_TRUE: "ALREADY_TRUE",
  FAILED: "FAILED",
  REFUSED: "REFUSED",
  MISMATCH_BALANCE_DUE: "MISMATCH_BALANCE_DUE",
} as const;

export type DeliveryTenDayConfirmationWritebackStatus =
  (typeof DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES)[keyof typeof DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES];

type DeliveryTenDayConfirmationDelegate = {
  findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  upsert(args: Record<string, unknown>): Promise<Record<string, unknown>>;
};

type DeliveryTenDayConfirmationClient = {
  deliveryGroupTenDayConfirmation?: DeliveryTenDayConfirmationDelegate;
};

type ExistingTenDayConfirmationRecord = {
  id: string;
  localConfirmed: boolean;
  acumaticaWritebackStatus: string | null;
  acumaticaWritebackJobId: string | null;
  confirmedReason: string | null;
  mismatchReason: string | null;
  paymentStatusAtEvaluation: string | null;
  amountDueAtEvaluation: unknown;
};

export type DeliveryTenDayConfirmationOrderInput = Pick<
  Order,
  "id" | "orderType" | "orderNumber" | "acumaticaOneWeekConfirmed"
>;

export type DeliveryTenDayConfirmationDeliveryGroupInput = Pick<
  OrderDeliveryGroup,
  "id" | "orderId" | "orderType" | "orderNumber" | "deliveryDate"
> & {
  order: DeliveryTenDayConfirmationOrderInput;
};

type WritebackEnqueuer = (
  params: EnqueueDeliveryTenDayConfirmationWritebackParams,
  options?: EnqueueDeliveryTenDayConfirmationWritebackOptions
) => Promise<EnqueueDeliveryTenDayConfirmationWritebackResult>;

export type DeliveryTenDayConfirmationEvaluationResult = {
  deliveryGroupId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: string;
  localCleared: boolean;
  localConfirmed: boolean;
  wouldWrite: boolean;
  acumaticaOneWeekConfirmed: boolean | null;
  acumaticaWritebackStatus: DeliveryTenDayConfirmationWritebackStatus;
  acumaticaWritebackJobId: string | null;
  reason: string;
  mismatchReason: string | null;
  paymentStatusAtEvaluation: string | null;
  amountDueAtEvaluation: string | null;
  queueResult: DeliveryTenDayConfirmationQueueResult | null;
  errorMessage: string | null;
  dryRun: boolean;
};

export type EvaluateDeliveryTenDayConfirmationParams = {
  deliveryGroup: DeliveryTenDayConfirmationDeliveryGroupInput;
  payment: DeliveryGroupPaymentEvaluation;
  sourceInterval: NotificationIntervalType;
  dryRun?: boolean;
  now?: Date;
  prismaClient?: unknown;
  enqueueWriteback?: WritebackEnqueuer;
  queueOptions?: EnqueueDeliveryTenDayConfirmationWritebackOptions;
};

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function amountDueForStorage(payment: DeliveryGroupPaymentEvaluation) {
  return clean(payment.amountDueNowRounded) ?? clean(payment.amountDueNow);
}

function paymentIsPrepay(payment: DeliveryGroupPaymentEvaluation) {
  return isEligibleDeliveryPaymentTerm(payment.paymentTerms);
}

function getLocalClearanceReason(payment: DeliveryGroupPaymentEvaluation) {
  if (!paymentIsPrepay(payment)) {
    return {
      localCleared: true,
      reason: DELIVERY_TEN_DAY_CONFIRMATION_REASONS.nonPrepayTermsCleared,
    };
  }

  if (payment.paymentStatus === "no_balance_due" && payment.calculationWarnings.length === 0) {
    return {
      localCleared: true,
      reason: DELIVERY_TEN_DAY_CONFIRMATION_REASONS.prepayBalanceCleared,
    };
  }

  return {
    localCleared: false,
    reason: DELIVERY_TEN_DAY_CONFIRMATION_REASONS.prepayBalanceNotCleared,
  };
}

function queueResultStatus(result: DeliveryTenDayConfirmationQueueResult | null | undefined) {
  return clean(result?.status)?.toLowerCase() ?? null;
}

function queueResultReason(result: DeliveryTenDayConfirmationQueueResult | null | undefined) {
  return clean(result?.reason);
}

function writebackStatusFromQueueResult(
  result: DeliveryTenDayConfirmationQueueResult
): DeliveryTenDayConfirmationWritebackStatus {
  const status = queueResultStatus(result);
  if (status === "written") return DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.WRITTEN;
  if (status === "already_true") {
    return DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.ALREADY_TRUE;
  }
  if (status === "dry_run") return DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.DRY_RUN;
  if (status === "refused") return DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.REFUSED;
  return DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.FAILED;
}

export function isCompleteTenDayConfirmationWritebackStatus(value: string | null | undefined) {
  return (
    value === DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.WRITTEN ||
    value === DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.ALREADY_TRUE
  );
}

function resultBase(params: {
  deliveryGroup: DeliveryTenDayConfirmationDeliveryGroupInput;
  payment: DeliveryGroupPaymentEvaluation;
  localCleared: boolean;
  localConfirmed: boolean;
  wouldWrite: boolean;
  acumaticaWritebackStatus: DeliveryTenDayConfirmationWritebackStatus;
  acumaticaWritebackJobId?: string | null;
  reason: string;
  mismatchReason?: string | null;
  queueResult?: DeliveryTenDayConfirmationQueueResult | null;
  errorMessage?: string | null;
  dryRun: boolean;
}): DeliveryTenDayConfirmationEvaluationResult {
  return {
    deliveryGroupId: params.deliveryGroup.id,
    orderType: params.deliveryGroup.order.orderType,
    orderNumber: params.deliveryGroup.order.orderNumber,
    deliveryDate: dateKey(params.deliveryGroup.deliveryDate),
    localCleared: params.localCleared,
    localConfirmed: params.localConfirmed,
    wouldWrite: params.wouldWrite,
    acumaticaOneWeekConfirmed: params.deliveryGroup.order.acumaticaOneWeekConfirmed ?? null,
    acumaticaWritebackStatus: params.acumaticaWritebackStatus,
    acumaticaWritebackJobId: params.acumaticaWritebackJobId ?? null,
    reason: params.reason,
    mismatchReason: params.mismatchReason ?? null,
    paymentStatusAtEvaluation: params.payment.paymentStatus,
    amountDueAtEvaluation: amountDueForStorage(params.payment),
    queueResult: params.queueResult ?? null,
    errorMessage: params.errorMessage ?? null,
    dryRun: params.dryRun,
  };
}

async function findExistingTenDayConfirmation(params: {
  client: Required<DeliveryTenDayConfirmationClient>;
  deliveryGroupId: string;
}): Promise<ExistingTenDayConfirmationRecord | null> {
  const existing = await params.client.deliveryGroupTenDayConfirmation.findUnique({
    where: { orderDeliveryGroupId: params.deliveryGroupId },
    select: {
      id: true,
      localConfirmed: true,
      acumaticaWritebackStatus: true,
      acumaticaWritebackJobId: true,
      confirmedReason: true,
      mismatchReason: true,
      paymentStatusAtEvaluation: true,
      amountDueAtEvaluation: true,
    },
  });
  return existing as ExistingTenDayConfirmationRecord | null;
}

async function upsertTenDayConfirmation(params: {
  client: Required<DeliveryTenDayConfirmationClient>;
  deliveryGroup: DeliveryTenDayConfirmationDeliveryGroupInput;
  payment: DeliveryGroupPaymentEvaluation;
  sourceInterval: NotificationIntervalType;
  localConfirmed: boolean;
  confirmedAt: Date | null;
  confirmedReason: string;
  acumaticaWritebackStatus: DeliveryTenDayConfirmationWritebackStatus;
  acumaticaWritebackJobId?: string | null;
  acumaticaWritebackError?: string | null;
  mismatchReason?: string | null;
}) {
  const amountDue = amountDueForStorage(params.payment);
  const data = {
    orderId: params.deliveryGroup.order.id,
    orderType: params.deliveryGroup.order.orderType,
    orderNumber: params.deliveryGroup.order.orderNumber,
    deliveryDate: dateFromKey(params.deliveryGroup.deliveryDate),
    localConfirmed: params.localConfirmed,
    acumaticaOneWeekConfirmed: params.deliveryGroup.order.acumaticaOneWeekConfirmed ?? null,
    confirmedAt: params.confirmedAt,
    confirmedReason: params.confirmedReason,
    sourceInterval: params.sourceInterval,
    paymentStatusAtEvaluation: params.payment.paymentStatus,
    amountDueAtEvaluation: amountDue,
    acumaticaWritebackStatus: params.acumaticaWritebackStatus,
    acumaticaWritebackJobId: params.acumaticaWritebackJobId ?? null,
    acumaticaWritebackError: params.acumaticaWritebackError
      ? truncate(params.acumaticaWritebackError, 2048)
      : null,
    mismatchReason: params.mismatchReason ?? null,
  };

  return params.client.deliveryGroupTenDayConfirmation.upsert({
    where: { orderDeliveryGroupId: params.deliveryGroup.id },
    create: {
      orderDeliveryGroupId: params.deliveryGroup.id,
      ...data,
    },
    update: data,
  });
}

function requireTenDayConfirmationClient(
  client: DeliveryTenDayConfirmationClient
): Required<DeliveryTenDayConfirmationClient> {
  if (!client.deliveryGroupTenDayConfirmation) {
    throw new Error("deliveryGroupTenDayConfirmation delegate is required outside dry-run");
  }
  return { deliveryGroupTenDayConfirmation: client.deliveryGroupTenDayConfirmation };
}

export async function evaluateAndRecordDeliveryTenDayConfirmation(
  params: EvaluateDeliveryTenDayConfirmationParams
): Promise<DeliveryTenDayConfirmationEvaluationResult> {
  const client = (params.prismaClient ?? prisma) as DeliveryTenDayConfirmationClient;
  const enqueueWriteback =
    params.enqueueWriteback ?? enqueueDeliveryTenDayConfirmationWriteback;
  const now = params.now ?? new Date();
  const dryRun = params.dryRun ?? false;
  const clearance = getLocalClearanceReason(params.payment);
  const acumaticaAlreadyTrue = params.deliveryGroup.order.acumaticaOneWeekConfirmed === true;

  if (acumaticaAlreadyTrue && !clearance.localCleared) {
    const mismatchReason =
      DELIVERY_TEN_DAY_CONFIRMATION_REASONS.mismatchPaymentNotCleared;
    if (!dryRun) {
      const writeClient = requireTenDayConfirmationClient(client);
      await upsertTenDayConfirmation({
        client: writeClient,
        deliveryGroup: params.deliveryGroup,
        payment: params.payment,
        sourceInterval: params.sourceInterval,
        localConfirmed: false,
        confirmedAt: null,
        confirmedReason: mismatchReason,
        acumaticaWritebackStatus:
          DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.MISMATCH_BALANCE_DUE,
        mismatchReason,
      });
    }
    return resultBase({
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      localCleared: false,
      localConfirmed: false,
      wouldWrite: false,
      acumaticaWritebackStatus:
        DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.MISMATCH_BALANCE_DUE,
      reason: mismatchReason,
      mismatchReason,
      dryRun,
    });
  }

  if (!clearance.localCleared) {
    if (!dryRun) {
      const writeClient = requireTenDayConfirmationClient(client);
      await upsertTenDayConfirmation({
        client: writeClient,
        deliveryGroup: params.deliveryGroup,
        payment: params.payment,
        sourceInterval: params.sourceInterval,
        localConfirmed: false,
        confirmedAt: null,
        confirmedReason: clearance.reason,
        acumaticaWritebackStatus:
          DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.NOT_CLEARED,
      });
    }
    return resultBase({
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      localCleared: false,
      localConfirmed: false,
      wouldWrite: false,
      acumaticaWritebackStatus:
        DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.NOT_CLEARED,
      reason: clearance.reason,
      dryRun,
    });
  }

  if (dryRun) {
    return resultBase({
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      localCleared: true,
      localConfirmed: false,
      wouldWrite: !acumaticaAlreadyTrue,
      acumaticaWritebackStatus: DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.DRY_RUN,
      reason: DELIVERY_TEN_DAY_CONFIRMATION_REASONS.dryRun,
      dryRun: true,
    });
  }

  const writeClient = requireTenDayConfirmationClient(client);
  const existing = await findExistingTenDayConfirmation({
    client: writeClient,
    deliveryGroupId: params.deliveryGroup.id,
  });
  if (
    existing?.localConfirmed &&
    isCompleteTenDayConfirmationWritebackStatus(existing.acumaticaWritebackStatus)
  ) {
    return resultBase({
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      localCleared: true,
      localConfirmed: true,
      wouldWrite: false,
      acumaticaWritebackStatus:
        existing.acumaticaWritebackStatus as DeliveryTenDayConfirmationWritebackStatus,
      acumaticaWritebackJobId: existing.acumaticaWritebackJobId,
      reason:
        existing.confirmedReason ??
        DELIVERY_TEN_DAY_CONFIRMATION_REASONS.acumaticaAlreadyTrue,
      mismatchReason: existing.mismatchReason,
      dryRun: false,
    });
  }

  if (acumaticaAlreadyTrue) {
    await upsertTenDayConfirmation({
      client: writeClient,
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      sourceInterval: params.sourceInterval,
      localConfirmed: true,
      confirmedAt: now,
      confirmedReason: DELIVERY_TEN_DAY_CONFIRMATION_REASONS.acumaticaAlreadyTrue,
      acumaticaWritebackStatus:
        DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.ALREADY_TRUE,
    });
    return resultBase({
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      localCleared: true,
      localConfirmed: true,
      wouldWrite: false,
      acumaticaWritebackStatus:
        DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.ALREADY_TRUE,
      reason: DELIVERY_TEN_DAY_CONFIRMATION_REASONS.acumaticaAlreadyTrue,
      dryRun: false,
    });
  }

  let acceptedJobId: string | null = null;
  try {
    const queued = await enqueueWriteback(
      {
        orderType: params.deliveryGroup.order.orderType,
        orderNumber: params.deliveryGroup.order.orderNumber,
        deliveryDate: params.deliveryGroup.deliveryDate,
        sourceInterval: params.sourceInterval,
      },
      {
        ...params.queueOptions,
        onJobAccepted: async (jobId) => {
          acceptedJobId = jobId;
          await params.queueOptions?.onJobAccepted?.(jobId);
        },
      }
    );
    const status = writebackStatusFromQueueResult(queued.result);
    const localConfirmed = isCompleteTenDayConfirmationWritebackStatus(status);
    const reason =
      status === DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.WRITTEN
        ? DELIVERY_TEN_DAY_CONFIRMATION_REASONS.acumaticaWritten
        : status === DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.ALREADY_TRUE
          ? DELIVERY_TEN_DAY_CONFIRMATION_REASONS.acumaticaAlreadyTrue
          : status === DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.DRY_RUN
            ? DELIVERY_TEN_DAY_CONFIRMATION_REASONS.dryRun
            : status === DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.REFUSED
              ? DELIVERY_TEN_DAY_CONFIRMATION_REASONS.writebackRefused
              : DELIVERY_TEN_DAY_CONFIRMATION_REASONS.writebackFailed;
    const errorMessage =
      queued.result.errorMessage ??
      (localConfirmed ? null : queueResultReason(queued.result));

    await upsertTenDayConfirmation({
      client: writeClient,
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      sourceInterval: params.sourceInterval,
      localConfirmed,
      confirmedAt: localConfirmed ? now : null,
      confirmedReason: reason,
      acumaticaWritebackStatus: status,
      acumaticaWritebackJobId: queued.jobId,
      acumaticaWritebackError: errorMessage,
    });

    return resultBase({
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      localCleared: true,
      localConfirmed,
      wouldWrite: queued.result.wouldWrite ?? true,
      acumaticaWritebackStatus: status,
      acumaticaWritebackJobId: queued.jobId,
      reason,
      queueResult: queued.result,
      errorMessage,
      dryRun: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = acceptedJobId
      ? DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.QUEUED
      : DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.FAILED;
    const reason = acceptedJobId
      ? DELIVERY_TEN_DAY_CONFIRMATION_REASONS.writebackQueued
      : DELIVERY_TEN_DAY_CONFIRMATION_REASONS.writebackFailed;

    await upsertTenDayConfirmation({
      client: writeClient,
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      sourceInterval: params.sourceInterval,
      localConfirmed: false,
      confirmedAt: null,
      confirmedReason: reason,
      acumaticaWritebackStatus: status,
      acumaticaWritebackJobId: acceptedJobId,
      acumaticaWritebackError: message,
    });

    return resultBase({
      deliveryGroup: params.deliveryGroup,
      payment: params.payment,
      localCleared: true,
      localConfirmed: false,
      wouldWrite: true,
      acumaticaWritebackStatus: status,
      acumaticaWritebackJobId: acceptedJobId,
      reason,
      errorMessage: message,
      dryRun: false,
    });
  }
}
