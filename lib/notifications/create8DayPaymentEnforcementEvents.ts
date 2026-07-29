import {
  getDeliveryGroupPaymentEvaluation,
  isEligibleDeliveryPaymentTerm,
  normalizeDeliveryPaymentTerms,
  type DeliveryGroupPaymentEvaluation,
} from "@/lib/delivery-payment/deliveryGroupPayment";
import {
  importSalesOrdersForLineRequestedOn,
  type ImportSalesOrdersResult,
} from "@/lib/erp/importSalesOrders";
import {
  DeliveryOrderHoldActionReason,
  DeliveryOrderHoldActionStatus,
  InternalNotificationAudienceType,
  InternalNotificationPurpose,
  InternalNotificationStatus,
  InternalOrderLifecycleStatus,
  NotificationActionType,
  NotificationEventStatus,
  NotificationIntervalType,
  Prisma,
} from "@/lib/generated/prisma/client";
import {
  attachDeliveryDetailsLinkToNotificationEvent,
  buildDeliveryDetailsLink,
  ensureDeliveryDetailsLink,
  markDeliveryDetailsLinkCreatedFromEvent,
} from "@/lib/notifications/deliveryDetailsLinks";
import {
  buildNotificationDedupeKey,
  dateFromKey,
  dateKey,
  DELIVERY_DATE_WEEKEND_SKIP_REASON,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getDeliveryDateCustomerNotificationSkipReason,
  getNotificationTargetDate,
  selectNotificationChannel,
  shouldSkipNotificationRunForWeekend,
} from "@/lib/notifications/helpers";
import {
  render8DayPaymentEnforcementCustomerEmail,
  render8DayPaymentEnforcementCustomerSms,
  render8DayPaymentEnforcementInternalFailure,
  render8DayPaymentEnforcementInternalSuccess,
} from "@/lib/notifications/deliveryPaymentEnforcement8Day";
import { getPaymentDeadlineDate } from "@/lib/notifications/paymentDeadlineBusinessDays";
import {
  enqueueDeliveryPrepaymentHold,
  shouldDryRunDeliveryPrepaymentHold,
  type DeliveryPrepaymentHoldQueueResult,
  type EnqueueDeliveryPrepaymentHoldOptions,
  type EnqueueDeliveryPrepaymentHoldParams,
  type EnqueueDeliveryPrepaymentHoldResult,
} from "@/lib/notifications/deliveryPrepaymentHoldQueue";
import {
  getActiveSalespersonContactMap,
} from "@/lib/notifications/salespersonContactCache";
import type { SalespersonContactInput } from "@/lib/notifications/salespersonContactDisplay";
import { prisma } from "@/lib/prisma";

export const DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_INTERVAL_DAYS = 8;
export const DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_REQUESTED_ON_TIME = "09:19:00.000Z";

export const DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS = {
  deliveryDateWeekend: DELIVERY_DATE_WEEKEND_SKIP_REASON,
  notConfirmedInAcumatica: "not_confirmed_in_acumatica",
  paymentTermsNotEligible: "payment_terms_not_eligible",
  missingOrderTotal: "missing_order_total",
  missingUnpaidBalance: "missing_unpaid_balance",
  noBalanceDue: "no_balance_due",
  noAutomatedChannelAvailable: "no_automated_channel_available",
  alreadyEnforced: "already_enforced",
  holdActionFailed: "hold_action_failed",
  holdWriteNotEnabled: "hold_write_not_enabled",
  noInternalNotificationRecipient: "no_internal_notification_recipient",
  dryRun: "dry_run",
} as const;

export type DeliveryPaymentEnforcement8DaySkipReason =
  (typeof DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS)[keyof typeof DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS];

type DeliveryPaymentEnforcement8DayClient = Pick<
  typeof prisma,
  | "orderDeliveryGroup"
  | "deliveryOrderHoldAction"
  | "notificationEvent"
  | "deliveryDetailsLink"
  | "internalNotificationEvent"
> &
  Partial<Pick<typeof prisma, "salespersonContact">>;

type DeliveryPaymentEnforcement8DayTargetGroup = Awaited<
  ReturnType<typeof find8DayPaymentEnforcementTargetGroups>
>[number];

type PaymentEvaluationLoader = (
  deliveryGroupId: string
) => Promise<DeliveryGroupPaymentEvaluation>;
type ImportSalesOrdersLoader = typeof importSalesOrdersForLineRequestedOn;
type SalespersonContactMapLoader = typeof getActiveSalespersonContactMap;
type HoldJobEnqueuer = (
  params: EnqueueDeliveryPrepaymentHoldParams,
  options?: EnqueueDeliveryPrepaymentHoldOptions
) => Promise<EnqueueDeliveryPrepaymentHoldResult>;

type HoldActionRecord = Awaited<ReturnType<typeof findHoldAction>>;

export type DeliveryPaymentEnforcement8DayEventReport = {
  orderType: string;
  orderNumber: string;
  deliveryGroupId: string;
  deliveryDate: string;
  holdActionId: string | null;
  holdActionCreated: boolean;
  holdActionStatus: string | null;
  queueJobId: string | null;
  queueResultStatus: string | null;
  queueResultReason: string | null;
  customerEventId: string | null;
  customerEventStatus: string | null;
  customerEventCreated: boolean;
  customerEventSkippedReason: string | null;
  selectedChannel: string | null;
  internalEventIds: string[];
  internalEventStatuses: string[];
  internalEventPurposes: string[];
  internalRecipientAvailable: boolean;
  acumaticaConfirmVia: string | null;
  paymentTerms: string | null;
  paymentStatus: string | null;
  amountDueNowRounded: string | null;
  paymentDeadlineDate: string | null;
  detailsLinkCreated: boolean;
  detailsLinkReused: boolean;
  detailsLinkTokenPresent: boolean;
  detailsLinkUrl: string | null;
  subject: string | null;
  renderedMessagePreview: string;
};

export type Create8DayPaymentEnforcementEventsSummary = {
  runDate: string;
  targetDeliveryDate: string;
  importRequestedOn: string;
  importResult: ImportSalesOrdersResult | null;
  targetDeliveryGroups: number;
  eligibleDeliveryGroups: number;
  deliveryGroupsSkippedWeekendDeliveryDate: number;
  deliveryGroupsSkippedIneligible: number;
  deliveryGroupsSkippedFailedImport: number;
  holdActionsCreated: number;
  holdActionsReused: number;
  holdActionsPendingOrQueued: number;
  holdActionsQueued: number;
  holdActionsDryRun: number;
  holdActionsSucceeded: number;
  holdActionsAlreadySucceeded: number;
  holdActionsFailed: number;
  holdActionsSkipped: number;
  queueJobsAccepted: number;
  customerEventsCreated: number;
  customerEventsDeduped: number;
  customerEventsSkipped: number;
  customerEventsWouldCreate: number;
  internalEventsCreated: number;
  internalEventsDeduped: number;
  internalEventsSkipped: number;
  detailsLinksCreated: number;
  detailsLinksReused: number;
  paymentDueCount: number;
  weekendSkipped: boolean;
  dryRun: boolean;
  retryFailedHoldActions: boolean;
  skippedReasons: Record<string, number>;
  failedImportExclusions: Array<{
    orderType: string | null;
    orderNumber: string;
    reason: string;
  }>;
  eventReports: DeliveryPaymentEnforcement8DayEventReport[];
};

export type Create8DayPaymentEnforcementEventsOptions = {
  runDate?: Date | string;
  dryRun?: boolean;
  retryFailedHoldActions?: boolean;
  prismaClient?: DeliveryPaymentEnforcement8DayClient;
  importSalesOrders?: ImportSalesOrdersLoader;
  getPaymentEvaluation?: PaymentEvaluationLoader;
  getSalespersonContactMap?: SalespersonContactMapLoader;
  enqueueHoldJob?: HoldJobEnqueuer;
  queueOptions?: EnqueueDeliveryPrepaymentHoldOptions;
};

const holdActionSelect = {
  id: true,
  status: true,
  queueJobId: true,
  errorMessage: true,
  acumaticaResponseSummary: true,
  customerNotificationEventId: true,
} as const;

const notificationEventSelect = {
  id: true,
  dedupeKey: true,
  intervalType: true,
  actionType: true,
  status: true,
  selectedChannel: true,
  reasonSkipped: true,
  detailsLinkId: true,
} as const;

const internalNotificationEventSelect = {
  id: true,
  purpose: true,
  audienceType: true,
  status: true,
  recipientEmail: true,
  reasonSkipped: true,
} as const;

function emptySummary(params: {
  runDate: string;
  targetDeliveryDate: string;
  importRequestedOn: string;
  dryRun: boolean;
  retryFailedHoldActions: boolean;
}): Create8DayPaymentEnforcementEventsSummary {
  return {
    runDate: params.runDate,
    targetDeliveryDate: params.targetDeliveryDate,
    importRequestedOn: params.importRequestedOn,
    importResult: null,
    targetDeliveryGroups: 0,
    eligibleDeliveryGroups: 0,
    deliveryGroupsSkippedWeekendDeliveryDate: 0,
    deliveryGroupsSkippedIneligible: 0,
    deliveryGroupsSkippedFailedImport: 0,
    holdActionsCreated: 0,
    holdActionsReused: 0,
    holdActionsPendingOrQueued: 0,
    holdActionsQueued: 0,
    holdActionsDryRun: 0,
    holdActionsSucceeded: 0,
    holdActionsAlreadySucceeded: 0,
    holdActionsFailed: 0,
    holdActionsSkipped: 0,
    queueJobsAccepted: 0,
    customerEventsCreated: 0,
    customerEventsDeduped: 0,
    customerEventsSkipped: 0,
    customerEventsWouldCreate: 0,
    internalEventsCreated: 0,
    internalEventsDeduped: 0,
    internalEventsSkipped: 0,
    detailsLinksCreated: 0,
    detailsLinksReused: 0,
    paymentDueCount: 0,
    weekendSkipped: false,
    dryRun: params.dryRun,
    retryFailedHoldActions: params.retryFailedHoldActions,
    skippedReasons: {},
    failedImportExclusions: [],
    eventReports: [],
  };
}

function normalizeStatus(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
}

function isCompletedOrCancelledStatus(value: string | null | undefined) {
  return ["cancelled", "canceled", "completed", "closed"].includes(normalizeStatus(value));
}

function isBlockedLifecycleStatus(value: string | null | undefined) {
  const blockedStatuses = new Set<string>([
    InternalOrderLifecycleStatus.BLOCKED,
    InternalOrderLifecycleStatus.MANUAL_REVIEW,
    InternalOrderLifecycleStatus.COMPLETED,
    InternalOrderLifecycleStatus.CANCELLED,
  ]);
  return blockedStatuses.has(value ?? "");
}

function addSkippedReason(
  summary: Create8DayPaymentEnforcementEventsSummary,
  reason: string
) {
  summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
}

function safeJobAddress(address: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}) {
  return formatJobAddress(address) || "the job site";
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function amountIsGreaterThanMeaningfulThreshold(value: string | null | undefined) {
  if (!value) return false;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 2;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function jsonSafe(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function queueResultStatus(result: DeliveryPrepaymentHoldQueueResult | null | undefined) {
  return clean(result?.status);
}

function queueResultReason(result: DeliveryPrepaymentHoldQueueResult | null | undefined) {
  return clean(result?.reason);
}

export function normalize8DayConfirmVia(value: unknown) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

export function requestedOnFor8DayTargetDate(targetDeliveryDate: Date | string) {
  return `${dateKey(targetDeliveryDate)}T${DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_REQUESTED_ON_TIME}`;
}

export function is8DayDeliveryGroupEligible(
  group: DeliveryPaymentEnforcement8DayTargetGroup
) {
  return !(
    isCompletedOrCancelledStatus(group.order.status) ||
    isCompletedOrCancelledStatus(group.status) ||
    isBlockedLifecycleStatus(group.order.internalLifecycleStatus)
  );
}

export function get8DayPaymentEnforcementSkipReason(params: {
  hasOrderTotal: boolean;
  paymentTerms: string | null | undefined;
  unpaidBalance: unknown;
  paymentStatus: string | null | undefined;
  amountDueNowRounded: string | null | undefined;
  calculationWarnings?: string[];
}): DeliveryPaymentEnforcement8DaySkipReason | null {
  if (!params.hasOrderTotal) {
    return DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.missingOrderTotal;
  }

  if (!isEligibleDeliveryPaymentTerm(params.paymentTerms)) {
    return DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.paymentTermsNotEligible;
  }

  if (params.unpaidBalance === null || params.unpaidBalance === undefined) {
    return DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.missingUnpaidBalance;
  }

  if (
    params.paymentStatus !== "balance_due" ||
    !amountIsGreaterThanMeaningfulThreshold(params.amountDueNowRounded) ||
    (params.calculationWarnings?.length ?? 0) > 0
  ) {
    return DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.noBalanceDue;
  }

  return null;
}

function importErrorLooksLikeFailedOrder(error: ImportSalesOrdersResult["errors"][number]) {
  return /failed|did not return/i.test(error.reason);
}

function importErrorMatchesOrder(
  error: ImportSalesOrdersResult["errors"][number],
  order: { orderType: string; orderNumber: string }
) {
  if (!error.orderNumber || error.orderNumber !== order.orderNumber) return false;
  return !error.orderType || error.orderType === order.orderType;
}

export function get8DayFailedImportExclusions(importResult: ImportSalesOrdersResult) {
  return importResult.errors
    .filter((error) => error.orderNumber && importErrorLooksLikeFailedOrder(error))
    .map((error) => ({
      orderType: error.orderType ?? null,
      orderNumber: error.orderNumber as string,
      reason: error.reason,
    }));
}

export function isOrderExcludedBy8DayFailedImport(params: {
  importResult: ImportSalesOrdersResult;
  orderType: string;
  orderNumber: string;
}) {
  return params.importResult.errors.some(
    (error) => importErrorLooksLikeFailedOrder(error) && importErrorMatchesOrder(error, params)
  );
}

export function holdQueueResultIsSuccess(result: DeliveryPrepaymentHoldQueueResult) {
  return result.status === "succeeded" || result.status === "already_on_hold";
}

export function holdQueueResultIsDryRun(result: DeliveryPrepaymentHoldQueueResult) {
  return result.status === "dry_run";
}

function holdQueueResultFailureReason(result: DeliveryPrepaymentHoldQueueResult) {
  if (result.status === "refused" && result.reason === "live_write_disabled") {
    return DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.holdWriteNotEnabled;
  }
  return (
    clean(result.reason) ??
    clean(result.status) ??
    DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.holdActionFailed
  );
}

function validateRenderedMessage(params: {
  orderType: string;
  orderNumber: string;
  subject: string | null;
  renderedMessagePreview: string;
}) {
  const combined = [params.subject, params.renderedMessagePreview].filter(Boolean).join("\n");
  if (/\b(null|undefined)\b/i.test(combined) || /:\s*MAIN\s*$/m.test(combined)) {
    throw new Error(
      `Rendered 8-day payment enforcement message contains placeholder text order=${params.orderType} ${params.orderNumber}`
    );
  }
}

export async function find8DayPaymentEnforcementTargetGroups(
  targetDeliveryDate: Date | string,
  client: DeliveryPaymentEnforcement8DayClient = prisma
) {
  return client.orderDeliveryGroup.findMany({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      isActive: true,
    },
    orderBy: [{ orderNumber: "asc" }, { id: "asc" }],
    select: {
      id: true,
      orderId: true,
      orderType: true,
      orderNumber: true,
      deliveryDate: true,
      isActive: true,
      lineCount: true,
      lastSeenAt: true,
      status: true,
      order: {
        select: {
          id: true,
          orderType: true,
          orderNumber: true,
          status: true,
          internalLifecycleStatus: true,
          buyerGroup: true,
          confirmVia: true,
          salespersonNumber: true,
          customerId: true,
          customerDescription: true,
          locationDescription: true,
          total: {
            select: {
              paymentTerms: true,
              unpaidBalance: true,
              orderTotal: true,
            },
          },
          address: {
            select: {
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              postalCode: true,
            },
          },
          contact: {
            select: {
              contactId: true,
              companyName: true,
              displayName: true,
              firstName: true,
              lastName: true,
              email: true,
              phone1: true,
              phone2: true,
              smsOptIn: true,
              emailOptIn: true,
              smsOptOuts: {
                where: { isActive: true },
                select: { phone: true },
              },
              emailOptOuts: {
                where: { isActive: true },
                select: { email: true },
              },
            },
          },
        },
      },
    },
  });
}

async function findHoldAction(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  deliveryGroup: DeliveryPaymentEnforcement8DayTargetGroup;
}) {
  return params.client.deliveryOrderHoldAction.findUnique({
    where: {
      orderDeliveryGroupId_deliveryDate_reason: {
        orderDeliveryGroupId: params.deliveryGroup.id,
        deliveryDate: dateFromKey(params.deliveryGroup.deliveryDate),
        reason: DeliveryOrderHoldActionReason.PAYMENT_NOT_RECEIVED_BY_DEADLINE,
      },
    },
    select: holdActionSelect,
  });
}

async function createOrReusePendingHoldAction(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  deliveryGroup: DeliveryPaymentEnforcement8DayTargetGroup;
  amountDueAtTrigger: string;
  paymentDeadlineDate: string;
  existing: HoldActionRecord;
}) {
  const order = params.deliveryGroup.order;
  if (params.existing) {
    const shouldReset =
      params.existing.status === DeliveryOrderHoldActionStatus.SKIPPED ||
      params.existing.status === DeliveryOrderHoldActionStatus.FAILED;
    const holdAction = shouldReset
      ? await params.client.deliveryOrderHoldAction.update({
          where: { id: params.existing.id },
          data: {
            amountDueAtTrigger: params.amountDueAtTrigger,
            paymentDeadline: dateFromKey(params.paymentDeadlineDate),
            status: DeliveryOrderHoldActionStatus.PENDING,
            errorMessage: null,
            acumaticaResponseSummary: Prisma.JsonNull,
            completedAt: null,
          },
          select: holdActionSelect,
        })
      : params.existing;
    return { holdAction, created: false };
  }

  try {
    const holdAction = await params.client.deliveryOrderHoldAction.create({
      data: {
        orderId: order.id,
        orderDeliveryGroupId: params.deliveryGroup.id,
        deliveryDate: dateFromKey(params.deliveryGroup.deliveryDate),
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        customerDescription: order.customerDescription,
        salespersonNumber: order.salespersonNumber,
        amountDueAtTrigger: params.amountDueAtTrigger,
        paymentDeadline: dateFromKey(params.paymentDeadlineDate),
        reason: DeliveryOrderHoldActionReason.PAYMENT_NOT_RECEIVED_BY_DEADLINE,
        status: DeliveryOrderHoldActionStatus.PENDING,
      },
      select: holdActionSelect,
    });
    return { holdAction, created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const holdAction = await findHoldAction({
      client: params.client,
      deliveryGroup: params.deliveryGroup,
    });
    if (!holdAction) throw error;
    return { holdAction, created: false };
  }
}

async function markHoldActionQueued(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  holdActionId: string;
  jobId: string;
}) {
  return params.client.deliveryOrderHoldAction.update({
    where: { id: params.holdActionId },
    data: {
      status: DeliveryOrderHoldActionStatus.QUEUED,
      queueJobId: params.jobId,
      queuedAt: new Date(),
      errorMessage: null,
    },
    select: holdActionSelect,
  });
}

async function markHoldActionFromQueueResult(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  holdActionId: string;
  queueResult: DeliveryPrepaymentHoldQueueResult;
  fallbackJobId: string | null;
}) {
  if (holdQueueResultIsSuccess(params.queueResult)) {
    return params.client.deliveryOrderHoldAction.update({
      where: { id: params.holdActionId },
      data: {
        status: DeliveryOrderHoldActionStatus.SUCCEEDED,
        queueJobId: params.fallbackJobId ?? undefined,
        errorMessage: null,
        acumaticaResponseSummary: jsonSafe(params.queueResult),
        completedAt: new Date(),
      },
      select: holdActionSelect,
    });
  }

  if (holdQueueResultIsDryRun(params.queueResult)) {
    return params.client.deliveryOrderHoldAction.update({
      where: { id: params.holdActionId },
      data: {
        status: DeliveryOrderHoldActionStatus.SKIPPED,
        queueJobId: params.fallbackJobId ?? undefined,
        errorMessage: DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.dryRun,
        acumaticaResponseSummary: jsonSafe(params.queueResult),
        completedAt: new Date(),
      },
      select: holdActionSelect,
    });
  }

  return params.client.deliveryOrderHoldAction.update({
    where: { id: params.holdActionId },
    data: {
      status: DeliveryOrderHoldActionStatus.FAILED,
      queueJobId: params.fallbackJobId ?? undefined,
      errorMessage: truncate(
        params.queueResult.errorMessage ??
          holdQueueResultFailureReason(params.queueResult),
        2048
      ),
      acumaticaResponseSummary: jsonSafe(params.queueResult),
      completedAt: new Date(),
    },
    select: holdActionSelect,
  });
}

async function markHoldActionFailed(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  holdActionId: string;
  error: unknown;
}) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return params.client.deliveryOrderHoldAction.update({
    where: { id: params.holdActionId },
    data: {
      status: DeliveryOrderHoldActionStatus.FAILED,
      errorMessage: truncate(message, 2048),
      completedAt: new Date(),
    },
    select: holdActionSelect,
  });
}

async function ensureDetailsLinkForMessage(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  deliveryGroup: DeliveryPaymentEnforcement8DayTargetGroup;
  summary: Create8DayPaymentEnforcementEventsSummary;
}) {
  const result = await ensureDeliveryDetailsLink(
    {
      orderId: params.deliveryGroup.order.id,
      orderDeliveryGroupId: params.deliveryGroup.id,
      deliveryDate: params.deliveryGroup.deliveryDate,
    },
    params.client
  );
  if (result.created) params.summary.detailsLinksCreated += 1;
  else params.summary.detailsLinksReused += 1;

  return {
    detailsLinkId: result.link.id,
    detailsLinkUrl: buildDeliveryDetailsLink(result.link.token),
    detailsLinkCreated: result.created,
  };
}

function internalFallbackEmail() {
  const value = process.env.DELIVERY_PAYMENT_ENFORCEMENT_FALLBACK_EMAIL?.trim();
  return value?.split(",").map((email) => email.trim()).find(Boolean) ?? null;
}

function resolveInternalRecipient(salespersonContact: SalespersonContactInput | null) {
  const salespersonEmail =
    salespersonContact?.isActive === true ? clean(salespersonContact.salespersonEmail) : null;
  if (salespersonEmail) {
    return {
      audienceType: InternalNotificationAudienceType.SALESPERSON,
      recipientEmail: salespersonEmail,
      recipientName: clean(salespersonContact?.salespersonName),
      reasonSkipped: null,
    };
  }

  const fallback = internalFallbackEmail();
  if (fallback) {
    return {
      audienceType: InternalNotificationAudienceType.FALLBACK,
      recipientEmail: fallback,
      recipientName: "MLD Delivery Notifications",
      reasonSkipped: null,
    };
  }

  return {
    audienceType: InternalNotificationAudienceType.INTERNAL,
    recipientEmail: null,
    recipientName: null,
    reasonSkipped:
      DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.noInternalNotificationRecipient,
  };
}

async function createOrReuseInternalNotification(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  deliveryGroup: DeliveryPaymentEnforcement8DayTargetGroup;
  holdActionId: string;
  purpose: InternalNotificationPurpose;
  salespersonContact: SalespersonContactInput | null;
  subject: string;
  body: string;
  messageSummary: string;
  summary: Create8DayPaymentEnforcementEventsSummary;
}) {
  const recipient = resolveInternalRecipient(params.salespersonContact);
  const existing = await params.client.internalNotificationEvent.findFirst({
    where: {
      deliveryOrderHoldActionId: params.holdActionId,
      purpose: params.purpose,
      audienceType: recipient.audienceType,
      recipientEmail: recipient.recipientEmail,
    },
    select: internalNotificationEventSelect,
  });

  if (existing) {
    params.summary.internalEventsDeduped += 1;
    return existing;
  }

  const order = params.deliveryGroup.order;
  const status = recipient.reasonSkipped
    ? InternalNotificationStatus.SKIPPED
    : InternalNotificationStatus.PENDING;
  if (status === InternalNotificationStatus.SKIPPED) {
    params.summary.internalEventsSkipped += 1;
    addSkippedReason(params.summary, recipient.reasonSkipped as string);
  }

  const event = await params.client.internalNotificationEvent.create({
    data: {
      orderId: order.id,
      orderDeliveryGroupId: params.deliveryGroup.id,
      deliveryOrderHoldActionId: params.holdActionId,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: params.deliveryGroup.deliveryDate,
      purpose: params.purpose,
      audienceType: recipient.audienceType,
      recipientEmail: recipient.recipientEmail,
      recipientName: recipient.recipientName,
      subject: truncate(params.subject, 512),
      bodyPreview: truncate(params.body, 2048),
      messageSummary: truncate(params.messageSummary, 1024),
      status,
      reasonSkipped: recipient.reasonSkipped,
    },
    select: internalNotificationEventSelect,
  });

  params.summary.internalEventsCreated += 1;
  return event;
}

async function createOrReuseCustomerNotificationEvent(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  deliveryGroup: DeliveryPaymentEnforcement8DayTargetGroup;
  holdActionId: string;
  runDate: string;
  dryRun: boolean;
  amountDueNowRounded: string;
  detailsLinkId: string;
  detailsLinkUrl: string;
  salespersonContact: SalespersonContactInput | null;
  summary: Create8DayPaymentEnforcementEventsSummary;
}) {
  const order = params.deliveryGroup.order;
  const dedupeKey = buildNotificationDedupeKey({
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: params.deliveryGroup.deliveryDate,
    intervalType: NotificationIntervalType.DAY_8,
    actionType: NotificationActionType.PAYMENT_ENFORCEMENT,
  });
  const existingEvent = await params.client.notificationEvent.findUnique({
    where: { dedupeKey },
    select: notificationEventSelect,
  });

  if (existingEvent) {
    params.summary.customerEventsDeduped += 1;
    await params.client.deliveryOrderHoldAction.update({
      where: { id: params.holdActionId },
      data: { customerNotificationEventId: existingEvent.id },
      select: holdActionSelect,
    });
    return {
      event: existingEvent,
      created: false,
      selectedChannel: existingEvent.selectedChannel,
      reasonSkipped: existingEvent.reasonSkipped,
      subject: null,
      renderedMessagePreview: existingEvent.reasonSkipped ?? "Existing event deduped.",
    };
  }

  const channel = selectNotificationChannel(order.contact, {
    activeSmsOptOutPhones: order.contact.smsOptOuts.map((optOut) => optOut.phone),
    activeEmailOptOutEmails: order.contact.emailOptOuts.map((optOut) => optOut.email),
  });

  if (channel.selectedChannel === null) {
    addSkippedReason(
      params.summary,
      DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.noAutomatedChannelAvailable
    );
    const event = await params.client.notificationEvent.create({
      data: {
        orderId: order.id,
        deliveryGroupId: params.deliveryGroup.id,
        contactId: order.contact.contactId,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryDate: params.deliveryGroup.deliveryDate,
        intervalType: NotificationIntervalType.DAY_8,
        actionType: NotificationActionType.PAYMENT_ENFORCEMENT,
        dedupeKey,
        selectedChannel: null,
        channelReason: DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.noAutomatedChannelAvailable,
        recipientEmail: null,
        recipientPhone: null,
        status: NotificationEventStatus.SKIPPED,
        reasonSkipped:
          DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.noAutomatedChannelAvailable,
        scheduledAt: null,
      },
      select: notificationEventSelect,
    });

    await params.client.deliveryOrderHoldAction.update({
      where: { id: params.holdActionId },
      data: { customerNotificationEventId: event.id },
      select: holdActionSelect,
    });

    params.summary.customerEventsCreated += 1;
    params.summary.customerEventsSkipped += 1;
    return {
      event,
      created: true,
      selectedChannel: null,
      reasonSkipped: event.reasonSkipped,
      subject: null,
      renderedMessagePreview:
        DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.noAutomatedChannelAvailable,
    };
  }

  const contactName = formatContactName(order.contact);
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const jobAddress = safeJobAddress(order.address ?? {});
  const smsMessage = render8DayPaymentEnforcementCustomerSms({
    contactName,
    buyerGroup: order.buyerGroup,
    jobName,
    jobAddress,
    deliveryDate: params.deliveryGroup.deliveryDate,
    detailsLink: params.detailsLinkUrl,
    amountDueNowRounded: params.amountDueNowRounded,
    salespersonContact: params.salespersonContact,
  });
  const emailMessage = render8DayPaymentEnforcementCustomerEmail({
    contactName,
    buyerGroup: order.buyerGroup,
    jobName,
    jobAddress,
    deliveryDate: params.deliveryGroup.deliveryDate,
    detailsLink: params.detailsLinkUrl,
    amountDueNowRounded: params.amountDueNowRounded,
    salespersonContact: params.salespersonContact,
  });
  const subject = channel.selectedChannel === "EMAIL" ? emailMessage.subject : null;
  const renderedMessagePreview =
    channel.selectedChannel === "EMAIL" ? emailMessage.body : smsMessage;

  validateRenderedMessage({
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    subject,
    renderedMessagePreview,
  });

  const event = await params.client.notificationEvent.create({
    data: {
      orderId: order.id,
      deliveryGroupId: params.deliveryGroup.id,
      contactId: order.contact.contactId,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: params.deliveryGroup.deliveryDate,
      intervalType: NotificationIntervalType.DAY_8,
      actionType: NotificationActionType.PAYMENT_ENFORCEMENT,
      dedupeKey,
      selectedChannel: channel.selectedChannel,
      channelReason: channel.channelReason,
      recipientEmail: channel.selectedChannel === "EMAIL" ? channel.recipientEmail : null,
      recipientPhone: channel.selectedChannel === "SMS" ? channel.recipientPhone : null,
      status: NotificationEventStatus.SCHEDULED,
      reasonSkipped: null,
      scheduledAt: dateFromKey(params.runDate),
      detailsLinkId: params.detailsLinkId,
    },
    select: notificationEventSelect,
  });

  await attachDeliveryDetailsLinkToNotificationEvent(
    { notificationEventId: event.id, detailsLinkId: params.detailsLinkId },
    params.client
  );
  await markDeliveryDetailsLinkCreatedFromEvent(
    { detailsLinkId: params.detailsLinkId, notificationEventId: event.id },
    params.client
  );
  await params.client.deliveryOrderHoldAction.update({
    where: { id: params.holdActionId },
    data: { customerNotificationEventId: event.id },
    select: holdActionSelect,
  });

  params.summary.customerEventsCreated += 1;
  return {
    event,
    created: true,
    selectedChannel: event.selectedChannel,
    reasonSkipped: null,
    subject,
    renderedMessagePreview,
  };
}

function customerNameForInternal(group: DeliveryPaymentEnforcement8DayTargetGroup) {
  return (
    clean(group.order.customerDescription) ??
    formatContactName(group.order.contact)
  );
}

function customerPhoneForInternal(group: DeliveryPaymentEnforcement8DayTargetGroup) {
  return clean(group.order.contact.phone1) ?? clean(group.order.contact.phone2);
}

function buildFailureSummary(params: {
  queueResult?: DeliveryPrepaymentHoldQueueResult | null;
  errorMessage?: string | null;
}) {
  return (
    clean(params.errorMessage) ??
    clean(params.queueResult?.errorMessage) ??
    holdQueueResultFailureReason(params.queueResult ?? {})
  );
}

async function createInternalSuccessNotification(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  deliveryGroup: DeliveryPaymentEnforcement8DayTargetGroup;
  holdActionId: string;
  salespersonContact: SalespersonContactInput | null;
  paymentDeadlineDate: string;
  amountDueNowRounded: string;
  detailsLinkUrl: string;
  summary: Create8DayPaymentEnforcementEventsSummary;
}) {
  const order = params.deliveryGroup.order;
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const rendered = render8DayPaymentEnforcementInternalSuccess({
    salespersonName: params.salespersonContact?.salespersonName,
    customerName: customerNameForInternal(params.deliveryGroup),
    customerEmail: order.contact.email,
    customerPhone: customerPhoneForInternal(params.deliveryGroup),
    orderNumber: order.orderNumber,
    jobName,
    deliveryDate: params.deliveryGroup.deliveryDate,
    paymentDeadlineDate: params.paymentDeadlineDate,
    amountDueNowRounded: params.amountDueNowRounded,
    detailsLink: params.detailsLinkUrl,
  });

  return createOrReuseInternalNotification({
    client: params.client,
    deliveryGroup: params.deliveryGroup,
    holdActionId: params.holdActionId,
    purpose: InternalNotificationPurpose.PAYMENT_ENFORCEMENT_HOLD_SUCCEEDED,
    salespersonContact: params.salespersonContact,
    subject: rendered.subject,
    body: rendered.body,
    messageSummary: rendered.messageSummary,
    summary: params.summary,
  });
}

async function createInternalFailureNotification(params: {
  client: DeliveryPaymentEnforcement8DayClient;
  deliveryGroup: DeliveryPaymentEnforcement8DayTargetGroup;
  holdActionId: string;
  salespersonContact: SalespersonContactInput | null;
  paymentDeadlineDate: string;
  amountDueNowRounded: string;
  detailsLinkUrl: string;
  queueResult?: DeliveryPrepaymentHoldQueueResult | null;
  errorMessage?: string | null;
  summary: Create8DayPaymentEnforcementEventsSummary;
}) {
  const order = params.deliveryGroup.order;
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const rendered = render8DayPaymentEnforcementInternalFailure({
    salespersonName: params.salespersonContact?.salespersonName,
    customerName: customerNameForInternal(params.deliveryGroup),
    orderNumber: order.orderNumber,
    jobName,
    deliveryDate: params.deliveryGroup.deliveryDate,
    paymentDeadlineDate: params.paymentDeadlineDate,
    amountDueNowRounded: params.amountDueNowRounded,
    detailsLink: params.detailsLinkUrl,
    errorSummary: buildFailureSummary({
      queueResult: params.queueResult,
      errorMessage: params.errorMessage,
    }),
  });

  return createOrReuseInternalNotification({
    client: params.client,
    deliveryGroup: params.deliveryGroup,
    holdActionId: params.holdActionId,
    purpose: InternalNotificationPurpose.PAYMENT_ENFORCEMENT_HOLD_FAILED,
    salespersonContact: params.salespersonContact,
    subject: rendered.subject,
    body: rendered.body,
    messageSummary: rendered.messageSummary,
    summary: params.summary,
  });
}

function baseReport(params: {
  deliveryGroup: DeliveryPaymentEnforcement8DayTargetGroup;
  acumaticaConfirmVia: string | null;
  payment?: DeliveryGroupPaymentEvaluation | null;
  paymentDeadlineDate?: string | null;
  renderedMessagePreview: string;
}): DeliveryPaymentEnforcement8DayEventReport {
  const order = params.deliveryGroup.order;
  return {
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryGroupId: params.deliveryGroup.id,
    deliveryDate: dateKey(params.deliveryGroup.deliveryDate),
    holdActionId: null,
    holdActionCreated: false,
    holdActionStatus: null,
    queueJobId: null,
    queueResultStatus: null,
    queueResultReason: null,
    customerEventId: null,
    customerEventStatus: null,
    customerEventCreated: false,
    customerEventSkippedReason: null,
    selectedChannel: null,
    internalEventIds: [],
    internalEventStatuses: [],
    internalEventPurposes: [],
    internalRecipientAvailable: false,
    acumaticaConfirmVia: params.acumaticaConfirmVia,
    paymentTerms:
      params.payment?.paymentTerms ?? normalizeDeliveryPaymentTerms(order.total?.paymentTerms ?? null),
    paymentStatus: params.payment?.paymentStatus ?? null,
    amountDueNowRounded: params.payment?.amountDueNowRounded ?? null,
    paymentDeadlineDate: params.paymentDeadlineDate ?? null,
    detailsLinkCreated: false,
    detailsLinkReused: false,
    detailsLinkTokenPresent: false,
    detailsLinkUrl: null,
    subject: null,
    renderedMessagePreview: params.renderedMessagePreview,
  };
}

function appendInternalEventReport(
  report: DeliveryPaymentEnforcement8DayEventReport,
  event: Awaited<ReturnType<typeof createOrReuseInternalNotification>> | null
) {
  if (!event) return;
  report.internalEventIds.push(event.id);
  report.internalEventStatuses.push(event.status);
  report.internalEventPurposes.push(event.purpose);
  if (event.recipientEmail) report.internalRecipientAvailable = true;
}

export async function create8DayPaymentEnforcementEvents(
  options: Create8DayPaymentEnforcementEventsOptions = {}
): Promise<Create8DayPaymentEnforcementEventsSummary> {
  const client = options.prismaClient ?? prisma;
  const importSalesOrders = options.importSalesOrders ?? importSalesOrdersForLineRequestedOn;
  const loadPayment = options.getPaymentEvaluation ?? getDeliveryGroupPaymentEvaluation;
  const loadSalespersonContactMap =
    options.getSalespersonContactMap ?? getActiveSalespersonContactMap;
  const enqueueHoldJob = options.enqueueHoldJob ?? enqueueDeliveryPrepaymentHold;
  const runDate = dateKey(options.runDate ?? new Date());
  const dryRun = options.dryRun ?? shouldDryRunDeliveryPrepaymentHold();
  const retryFailedHoldActions = options.retryFailedHoldActions ?? false;
  const targetDeliveryDate = dateKey(
    getNotificationTargetDate(runDate, DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_INTERVAL_DAYS)
  );
  const importRequestedOn = requestedOnFor8DayTargetDate(targetDeliveryDate);
  const summary = emptySummary({
    runDate,
    targetDeliveryDate,
    importRequestedOn,
    dryRun,
    retryFailedHoldActions,
  });

  if (shouldSkipNotificationRunForWeekend(runDate)) {
    summary.weekendSkipped = true;
    return summary;
  }

  const deliveryDateSkipReason = getDeliveryDateCustomerNotificationSkipReason(targetDeliveryDate);
  if (!deliveryDateSkipReason) {
    summary.importResult = await importSalesOrders(importRequestedOn);
    summary.failedImportExclusions = get8DayFailedImportExclusions(summary.importResult);
  }

  const deliveryGroups = await find8DayPaymentEnforcementTargetGroups(
    targetDeliveryDate,
    client
  );
  summary.targetDeliveryGroups = deliveryGroups.length;

  const salespersonContactsByNumber = deliveryDateSkipReason
    ? new Map()
    : await loadSalespersonContactMap(
        deliveryGroups.map((deliveryGroup) => deliveryGroup.order.salespersonNumber),
        client
      );

  for (const deliveryGroup of deliveryGroups) {
    const order = deliveryGroup.order;

    if (!is8DayDeliveryGroupEligible(deliveryGroup)) {
      summary.deliveryGroupsSkippedIneligible += 1;
      continue;
    }

    if (
      summary.importResult &&
      isOrderExcludedBy8DayFailedImport({
        importResult: summary.importResult,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
      })
    ) {
      summary.deliveryGroupsSkippedFailedImport += 1;
      summary.eventReports.push(
        baseReport({
          deliveryGroup,
          acumaticaConfirmVia: normalize8DayConfirmVia(order.confirmVia),
          renderedMessagePreview: "Fresh import failed for this order; stale DB data was not evaluated.",
        })
      );
      continue;
    }

    if (deliveryDateSkipReason) {
      summary.deliveryGroupsSkippedWeekendDeliveryDate += 1;
      addSkippedReason(summary, deliveryDateSkipReason);
      summary.eventReports.push(
        baseReport({
          deliveryGroup,
          acumaticaConfirmVia: normalize8DayConfirmVia(order.confirmVia),
          renderedMessagePreview: deliveryDateSkipReason,
        })
      );
      continue;
    }

    const acumaticaConfirmVia = normalize8DayConfirmVia(order.confirmVia);
    if (!acumaticaConfirmVia) {
      addSkippedReason(
        summary,
        DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.notConfirmedInAcumatica
      );
      summary.eventReports.push(
        baseReport({
          deliveryGroup,
          acumaticaConfirmVia: null,
          renderedMessagePreview:
            DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.notConfirmedInAcumatica,
        })
      );
      continue;
    }

    const payment = await loadPayment(deliveryGroup.id);
    const paymentSkipReason = get8DayPaymentEnforcementSkipReason({
      hasOrderTotal: Boolean(order.total),
      paymentTerms: order.total?.paymentTerms ?? null,
      unpaidBalance: order.total?.unpaidBalance,
      paymentStatus: payment.paymentStatus,
      amountDueNowRounded: payment.amountDueNowRounded,
      calculationWarnings: payment.calculationWarnings,
    });

    if (paymentSkipReason) {
      addSkippedReason(summary, paymentSkipReason);
      summary.eventReports.push(
        baseReport({
          deliveryGroup,
          acumaticaConfirmVia,
          payment,
          renderedMessagePreview: paymentSkipReason,
        })
      );
      continue;
    }

    summary.eligibleDeliveryGroups += 1;
    summary.paymentDueCount += 1;

    const amountDueNowRounded = payment.amountDueNowRounded as string;
    const paymentDeadlineDate = getPaymentDeadlineDate(deliveryGroup.deliveryDate);
    const salespersonContact = order.salespersonNumber
      ? salespersonContactsByNumber.get(order.salespersonNumber) ?? null
      : null;
    const existingHoldAction = await findHoldAction({ client, deliveryGroup });

    if (existingHoldAction?.status === DeliveryOrderHoldActionStatus.SUCCEEDED) {
      summary.holdActionsAlreadySucceeded += 1;
      addSkippedReason(summary, DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.alreadyEnforced);
      const report = baseReport({
        deliveryGroup,
        acumaticaConfirmVia,
        payment,
        paymentDeadlineDate,
        renderedMessagePreview: DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.alreadyEnforced,
      });
      report.holdActionId = existingHoldAction.id;
      report.holdActionStatus = existingHoldAction.status;
      report.queueJobId = existingHoldAction.queueJobId;

      if (!dryRun) {
        const details = await ensureDetailsLinkForMessage({ client, deliveryGroup, summary });
        report.detailsLinkCreated = details.detailsLinkCreated;
        report.detailsLinkReused = !details.detailsLinkCreated;
        report.detailsLinkTokenPresent = true;
        report.detailsLinkUrl = details.detailsLinkUrl;

        const customer = await createOrReuseCustomerNotificationEvent({
          client,
          deliveryGroup,
          holdActionId: existingHoldAction.id,
          runDate,
          dryRun,
          amountDueNowRounded,
          detailsLinkId: details.detailsLinkId,
          detailsLinkUrl: details.detailsLinkUrl,
          salespersonContact,
          summary,
        });
        report.customerEventId = customer.event.id;
        report.customerEventStatus = customer.event.status;
        report.customerEventCreated = customer.created;
        report.customerEventSkippedReason = customer.reasonSkipped;
        report.selectedChannel = customer.selectedChannel;
        report.subject = customer.subject;
        report.renderedMessagePreview = customer.renderedMessagePreview;

        const internalEvent = await createInternalSuccessNotification({
          client,
          deliveryGroup,
          holdActionId: existingHoldAction.id,
          salespersonContact,
          paymentDeadlineDate,
          amountDueNowRounded,
          detailsLinkUrl: details.detailsLinkUrl,
          summary,
        });
        appendInternalEventReport(report, internalEvent);
      }

      summary.eventReports.push(report);
      continue;
    }

    if (
      existingHoldAction &&
      (existingHoldAction.status === DeliveryOrderHoldActionStatus.PENDING ||
        existingHoldAction.status === DeliveryOrderHoldActionStatus.QUEUED)
    ) {
      summary.holdActionsPendingOrQueued += 1;
      const report = baseReport({
        deliveryGroup,
        acumaticaConfirmVia,
        payment,
        paymentDeadlineDate,
        renderedMessagePreview: `Existing hold action is ${existingHoldAction.status}.`,
      });
      report.holdActionId = existingHoldAction.id;
      report.holdActionStatus = existingHoldAction.status;
      report.queueJobId = existingHoldAction.queueJobId;
      summary.eventReports.push(report);
      continue;
    }

    if (
      existingHoldAction?.status === DeliveryOrderHoldActionStatus.FAILED &&
      !retryFailedHoldActions
    ) {
      summary.holdActionsFailed += 1;
      addSkippedReason(summary, DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.holdActionFailed);
      const report = baseReport({
        deliveryGroup,
        acumaticaConfirmVia,
        payment,
        paymentDeadlineDate,
        renderedMessagePreview:
          existingHoldAction.errorMessage ??
          DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.holdActionFailed,
      });
      report.holdActionId = existingHoldAction.id;
      report.holdActionStatus = existingHoldAction.status;
      report.queueJobId = existingHoldAction.queueJobId;

      if (!dryRun) {
        const details = await ensureDetailsLinkForMessage({ client, deliveryGroup, summary });
        report.detailsLinkCreated = details.detailsLinkCreated;
        report.detailsLinkReused = !details.detailsLinkCreated;
        report.detailsLinkTokenPresent = true;
        report.detailsLinkUrl = details.detailsLinkUrl;
        const internalEvent = await createInternalFailureNotification({
          client,
          deliveryGroup,
          holdActionId: existingHoldAction.id,
          salespersonContact,
          paymentDeadlineDate,
          amountDueNowRounded,
          detailsLinkUrl: details.detailsLinkUrl,
          errorMessage: existingHoldAction.errorMessage,
          summary,
        });
        appendInternalEventReport(report, internalEvent);
      }

      summary.eventReports.push(report);
      continue;
    }

    const { holdAction, created } = await createOrReusePendingHoldAction({
      client,
      deliveryGroup,
      amountDueAtTrigger: amountDueNowRounded,
      paymentDeadlineDate,
      existing: existingHoldAction,
    });
    if (created) summary.holdActionsCreated += 1;
    else summary.holdActionsReused += 1;

    const report = baseReport({
      deliveryGroup,
      acumaticaConfirmVia,
      payment,
      paymentDeadlineDate,
      renderedMessagePreview: "Hold action created or reused.",
    });
    report.holdActionId = holdAction.id;
    report.holdActionCreated = created;
    report.holdActionStatus = holdAction.status;

    let queueResult: DeliveryPrepaymentHoldQueueResult | null = null;
    let queuedJobId: string | null = null;
    let finalHoldAction = holdAction;

    try {
      const queued = await enqueueHoldJob(
        {
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          dryRun,
          deliveryDate: deliveryGroup.deliveryDate,
          amountDueAtTrigger: amountDueNowRounded,
          paymentDeadline: paymentDeadlineDate,
        },
        {
          ...options.queueOptions,
          onJobAccepted: async (jobId) => {
            queuedJobId = jobId;
            summary.queueJobsAccepted += 1;
            summary.holdActionsQueued += 1;
            finalHoldAction = await markHoldActionQueued({
              client,
              holdActionId: holdAction.id,
              jobId,
            });
          },
        }
      );

      queuedJobId = queued.jobId;
      queueResult = queued.result;
      finalHoldAction = await markHoldActionFromQueueResult({
        client,
        holdActionId: holdAction.id,
        queueResult,
        fallbackJobId: queuedJobId,
      });
    } catch (error) {
      finalHoldAction = await markHoldActionFailed({
        client,
        holdActionId: holdAction.id,
        error,
      });
      queueResult = {
        status: "failed",
        reason: "queue_enqueue_or_poll_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    report.holdActionStatus = finalHoldAction.status;
    report.queueJobId = queuedJobId ?? finalHoldAction.queueJobId;
    report.queueResultStatus = queueResultStatus(queueResult);
    report.queueResultReason = queueResultReason(queueResult);

    if (finalHoldAction.status === DeliveryOrderHoldActionStatus.SKIPPED) {
      summary.holdActionsDryRun += 1;
      summary.holdActionsSkipped += 1;
      addSkippedReason(summary, DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.dryRun);
      report.renderedMessagePreview = DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.dryRun;
      summary.eventReports.push(report);
      continue;
    }

    if (finalHoldAction.status === DeliveryOrderHoldActionStatus.FAILED) {
      summary.holdActionsFailed += 1;
      const reason = holdQueueResultFailureReason(queueResult ?? {});
      addSkippedReason(summary, reason);
      report.renderedMessagePreview = buildFailureSummary({
        queueResult,
        errorMessage: finalHoldAction.errorMessage,
      });

      if (!dryRun) {
        const details = await ensureDetailsLinkForMessage({ client, deliveryGroup, summary });
        report.detailsLinkCreated = details.detailsLinkCreated;
        report.detailsLinkReused = !details.detailsLinkCreated;
        report.detailsLinkTokenPresent = true;
        report.detailsLinkUrl = details.detailsLinkUrl;
        const internalEvent = await createInternalFailureNotification({
          client,
          deliveryGroup,
          holdActionId: finalHoldAction.id,
          salespersonContact,
          paymentDeadlineDate,
          amountDueNowRounded,
          detailsLinkUrl: details.detailsLinkUrl,
          queueResult,
          errorMessage: finalHoldAction.errorMessage,
          summary,
        });
        appendInternalEventReport(report, internalEvent);
      }

      summary.eventReports.push(report);
      continue;
    }

    if (finalHoldAction.status === DeliveryOrderHoldActionStatus.SUCCEEDED) {
      summary.holdActionsSucceeded += 1;

      if (dryRun) {
        summary.eventReports.push(report);
        continue;
      }

      const details = await ensureDetailsLinkForMessage({ client, deliveryGroup, summary });
      report.detailsLinkCreated = details.detailsLinkCreated;
      report.detailsLinkReused = !details.detailsLinkCreated;
      report.detailsLinkTokenPresent = true;
      report.detailsLinkUrl = details.detailsLinkUrl;
      const customer = await createOrReuseCustomerNotificationEvent({
        client,
        deliveryGroup,
        holdActionId: finalHoldAction.id,
        runDate,
        dryRun,
        amountDueNowRounded,
        detailsLinkId: details.detailsLinkId,
        detailsLinkUrl: details.detailsLinkUrl,
        salespersonContact,
        summary,
      });
      report.customerEventId = customer.event.id;
      report.customerEventStatus = customer.event.status;
      report.customerEventCreated = customer.created;
      report.customerEventSkippedReason = customer.reasonSkipped;
      report.selectedChannel = customer.selectedChannel;
      report.subject = customer.subject;
      report.renderedMessagePreview = customer.renderedMessagePreview;

      const internalEvent = await createInternalSuccessNotification({
        client,
        deliveryGroup,
        holdActionId: finalHoldAction.id,
        salespersonContact,
        paymentDeadlineDate,
        amountDueNowRounded,
        detailsLinkUrl: details.detailsLinkUrl,
        summary,
      });
      appendInternalEventReport(report, internalEvent);
    }

    summary.eventReports.push(report);
  }

  return summary;
}
