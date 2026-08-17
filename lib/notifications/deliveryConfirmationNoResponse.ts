import type { ImportSalesOrdersResult } from "@/lib/erp/importSalesOrders";
import {
  DeliveryConfirmationStatus,
  InternalNotificationAudienceType,
  InternalNotificationPurpose,
  InternalNotificationStatus,
  InternalOrderLifecycleStatus,
  NotificationActionType,
  type NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "@/lib/generated/prisma/client";
import { DELIVERY_MANUAL_REVIEW_REASONS } from "@/lib/notifications/deliveryConfirmationManualReview";
import { buildDeliveryConfirmationLink } from "@/lib/notifications/deliveryConfirmationLinks";
import {
  render42DayEmailConfirmationReminderMessage,
} from "@/lib/notifications/deliveryConfirmationEmail";
import { render42DaySmsConfirmationReminderMessage } from "@/lib/notifications/deliveryConfirmationSms";
import {
  addDays,
  cleanNotificationText,
  dateFromKey,
  dateKey,
  DELIVERY_DATE_WEEKEND_SKIP_REASON,
  formatContactName,
  formatCustomerFriendlyDate,
  getDeliveryDateCustomerNotificationSkipReason,
  selectNotificationChannel,
  shouldSkipNotificationRunForWeekend,
} from "@/lib/notifications/helpers";
import {
  loadActiveNotificationOptOutAddresses,
  mergeNotificationOptOutAddresses,
  type ActiveNotificationOptOutAddresses,
} from "@/lib/notifications/notificationOptOutLookup";
import { getActiveSalespersonContactMap } from "@/lib/notifications/salespersonContactCache";
import type { SalespersonContactInput } from "@/lib/notifications/salespersonContactDisplay";

export const DELIVERY_CONFIRMATION_ORIGINAL_TOUCH_NUMBER = 1;
export const DELIVERY_CONFIRMATION_MAX_TOTAL_CUSTOMER_TOUCHES = 3;
export const DELIVERY_CONFIRMATION_MAX_FOLLOW_UP_COUNT =
  DELIVERY_CONFIRMATION_MAX_TOTAL_CUSTOMER_TOUCHES - DELIVERY_CONFIRMATION_ORIGINAL_TOUCH_NUMBER;
export const DELIVERY_CONFIRMATION_NO_RESPONSE_SALESPERSON_PURPOSE =
  InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE;

export const DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS = {
  weekendSendDate: "weekend_skip_no_shift",
  currentStateRefreshFailed: "current_state_refresh_failed",
  alreadyConfirmedInAcumatica: "already_confirmed_in_acumatica",
  deliveryDateWeekend: DELIVERY_DATE_WEEKEND_SKIP_REASON,
  staleDeliveryDate: "stale_delivery_confirmation_date",
  inactiveDeliveryGroup: "inactive_delivery_group",
  noActiveDeliveryLines: "no_active_delivery_lines",
  orderNotActive: "order_not_active",
  customerAlreadyResponded: "customer_already_responded",
  manualReviewAlreadyRequired: "manual_review_already_required",
  confirmationLinkMissing: "confirmation_link_missing",
  confirmationLinkExpired: "confirmation_link_expired",
  noAutomatedChannelAvailable: "no_automated_channel_available",
  noInternalNotificationRecipient: "no_internal_notification_recipient",
} as const;

type DeliveryConfirmationNoResponseSkipReason =
  (typeof DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS)[keyof typeof DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS];

export type DeliveryConfirmationNoResponseTouchNumber = 2 | 3;

type ContactForNotification = {
  contactId: string;
  companyName?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone1?: string | null;
  phone2?: string | null;
  smsOptIn?: boolean | null;
  emailOptIn?: boolean | null;
  smsOptOuts?: Array<{ phone: string }>;
  emailOptOuts?: Array<{ email: string }>;
};

type DeliveryConfirmationNoResponseOrder = {
  id: string;
  orderType: string;
  orderNumber: string;
  status?: string | null;
  internalLifecycleStatus?: string | null;
  buyerGroup?: string | null;
  confirmVia?: string | null;
  salespersonNumber?: string | null;
  customerDescription?: string | null;
  locationDescription?: string | null;
  address?: {
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  } | null;
  contact: ContactForNotification;
};

export type DeliveryConfirmationNoResponseCandidate = {
  id: string;
  orderId: string;
  deliveryGroupId: string;
  notificationEventId?: string | null;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  contactId: string;
  status: DeliveryConfirmationStatus;
  confirmedAt: Date | null;
  requestedNewDate: Date | null;
  manualReviewRequired: boolean;
  manualReviewReason: string | null;
  manualReviewMarkedAt: Date | null;
  manualReviewNotes: string | null;
  reminderSentAt: Date | null;
  noResponseAt: Date | null;
  confirmationFollowUpCount: number;
  linkToken: string | null;
  linkExpiresAt: Date | null;
  linkExpiredAt: Date | null;
  notificationEvent?: { selectedChannel: NotificationChannel | null } | null;
  orderDeliveryGroup: {
    id: string;
    deliveryDate: Date;
    isActive: boolean;
    status?: string | null;
    deliveryGroupLines?: Array<{ id: string }>;
    order: DeliveryConfirmationNoResponseOrder;
  };
};

type PlanCandidate = {
  id: string;
  notificationEvent?: { selectedChannel: NotificationChannel | null } | null;
};

type NotificationEventRecord = {
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

type InternalNotificationEventRecord = {
  id: string;
  purpose: InternalNotificationPurpose;
  audienceType: InternalNotificationAudienceType;
  status: InternalNotificationStatus;
  recipientEmail: string | null;
  recipientName: string | null;
  reasonSkipped: string | null;
};

export type DeliveryConfirmationNoResponseClient = {
  deliveryConfirmation: {
    findMany(args: unknown): Promise<unknown[]>;
    findUnique?(args: unknown): Promise<unknown | null>;
    count(args: unknown): Promise<number>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
      select?: unknown;
    }): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  notificationEvent?: {
    findUnique(args: unknown): Promise<NotificationEventRecord | null>;
    create(args: {
      data: Record<string, unknown>;
      select?: unknown;
    }): Promise<NotificationEventRecord>;
  };
  internalNotificationEvent?: {
    findFirst(args: unknown): Promise<InternalNotificationEventRecord | null>;
    upsert?(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      select?: unknown;
    }): Promise<InternalNotificationEventRecord>;
    create(args: {
      data: Record<string, unknown>;
      select?: unknown;
    }): Promise<InternalNotificationEventRecord>;
  };
  salespersonContact?: {
    findMany(args: unknown): Promise<Array<SalespersonContactInput & { salespersonNumber: string }>>;
  };
  smsOptOut?: {
    findMany(args: unknown): Promise<Array<{ phone: string }>>;
  };
  emailOptOut?: {
    findMany(args: unknown): Promise<Array<{ email: string }>>;
  };
};

type FollowUpPlan = {
  deliveryDate: string;
  intervalDay: 41 | 40;
  customerMessageAllowed: boolean;
  reason: string | null;
  candidateCount: number;
  noCustomerResponseCandidateCount: number;
  awaitingNewDateCandidateCount: number;
  selectedChannelCounts: {
    SMS: number;
    EMAIL: number;
    UNKNOWN: number;
  };
};

export type DeliveryConfirmationNoResponsePlan = {
  runDate: string;
  weekendSkipped: boolean;
  followUps: FollowUpPlan[];
  manualReviewCheckpoint: {
    deliveryDate: string;
    noCustomerResponseCandidates: number;
    awaitingNewDateCandidates: number;
  };
};

export type DeliveryConfirmationNoResponseEventReport = {
  confirmationId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: string;
  touchNumber: DeliveryConfirmationNoResponseTouchNumber | "salesperson_escalation";
  eventId: string | null;
  internalEventId: string | null;
  dedupeKey: string | null;
  status: string;
  selectedChannel: string | null;
  reasonSkipped: string | null;
  subject: string | null;
  renderedMessagePreview: string;
  confirmationFollowUpCountAfter: number;
  manualReviewRequiredAfter: boolean;
};

export type DeliveryConfirmationNoResponseRunSummary = {
  runDate: string;
  dryRun: boolean;
  weekendSkipped: boolean;
  touchDefinition: {
    original42DayRequestTouch: 1;
    firstReminderTouch: 2;
    secondReminderTouch: 3;
    maxFollowUpCount: 2;
  };
  targetDeliveryDates: {
    touch2: string;
    touch3: string;
    salespersonEscalation: string;
  };
  reminderCandidatesChecked: number;
  escalationCandidatesChecked: number;
  reminderCandidateCounts: {
    touch2: number;
    touch3: number;
  };
  escalationCandidateCount: number;
  currentStateRefreshesAttempted: number;
  currentStateRefreshesSucceeded: number;
  currentStateRefreshesFailed: number;
  externalConfirmationsStopped: number;
  staleConfirmationsExpired: number;
  reminderEventsCreated: number;
  reminderEventsWouldCreate: number;
  reminderEventsDeduped: number;
  reminderEventsSkipped: number;
  remindersScheduled: number;
  remindersScheduledByChannel: {
    SMS: number;
    EMAIL: number;
  };
  confirmationsUpdatedAfterReminder: number;
  internalEscalationsCreated: number;
  internalEscalationsWouldCreate: number;
  internalEscalationsDeduped: number;
  internalEscalationsSkipped: number;
  manualReviewMarked: number;
  noChannelEscalations: number;
  skippedReasons: Record<string, number>;
  eventReports: DeliveryConfirmationNoResponseEventReport[];
};

type ReminderSchedule = {
  intervalDay: 41 | 40;
  touchNumber: DeliveryConfirmationNoResponseTouchNumber;
  expectedFollowUpCountBeforeRun: 0 | 1;
  catchUpMinIntervalDay: 39 | 38;
};

const REMINDER_SCHEDULE: ReminderSchedule[] = [
  {
    intervalDay: 41,
    touchNumber: 2,
    expectedFollowUpCountBeforeRun: 0,
    catchUpMinIntervalDay: 39,
  },
  {
    intervalDay: 40,
    touchNumber: 3,
    expectedFollowUpCountBeforeRun: 1,
    catchUpMinIntervalDay: 38,
  },
];

const NO_CUSTOMER_RESPONSE_STATUSES = [
  DeliveryConfirmationStatus.PENDING,
  DeliveryConfirmationStatus.UNRECOGNIZED,
  DeliveryConfirmationStatus.INCOMPLETE,
] as const;

const AWAITING_NEW_DATE_STATUSES = [
  DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  DeliveryConfirmationStatus.CHANGE_REQUESTED,
] as const;

const notificationEventSelect = {
  id: true,
  dedupeKey: true,
  intervalType: true,
  actionType: true,
  status: true,
  selectedChannel: true,
  recipientEmail: true,
  recipientPhone: true,
  reasonSkipped: true,
} as const;

const internalNotificationEventSelect = {
  id: true,
  purpose: true,
  audienceType: true,
  status: true,
  recipientEmail: true,
  recipientName: true,
  reasonSkipped: true,
} as const;

const deliveryConfirmationNoResponseSelect = {
  id: true,
  orderId: true,
  deliveryGroupId: true,
  notificationEventId: true,
  orderType: true,
  orderNumber: true,
  deliveryDate: true,
  contactId: true,
  status: true,
  confirmedAt: true,
  requestedNewDate: true,
  manualReviewRequired: true,
  manualReviewReason: true,
  manualReviewMarkedAt: true,
  manualReviewNotes: true,
  reminderSentAt: true,
  noResponseAt: true,
  confirmationFollowUpCount: true,
  linkToken: true,
  linkExpiresAt: true,
  linkExpiredAt: true,
  notificationEvent: {
    select: {
      selectedChannel: true,
    },
  },
  orderDeliveryGroup: {
    select: {
      id: true,
      deliveryDate: true,
      isActive: true,
      status: true,
      deliveryGroupLines: {
        where: { isActive: true },
        select: { id: true },
        take: 1,
      },
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
          customerDescription: true,
          locationDescription: true,
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
  },
} as const;

async function noResponseClient(value: DeliveryConfirmationNoResponseClient | undefined) {
  if (value) return value;
  const { prisma } = await import("@/lib/prisma");
  return prisma as unknown as DeliveryConfirmationNoResponseClient;
}

function emptySelectedChannelCounts() {
  return {
    SMS: 0,
    EMAIL: 0,
    UNKNOWN: 0,
  };
}

function selectedChannelBucket(value: NotificationChannel | null | undefined) {
  if (value === "SMS" || value === "EMAIL") return value;
  return "UNKNOWN";
}

function countSelectedChannels(candidates: PlanCandidate[]) {
  const counts = emptySelectedChannelCounts();
  for (const candidate of candidates) {
    counts[selectedChannelBucket(candidate.notificationEvent?.selectedChannel)] += 1;
  }
  return counts;
}

function addSkippedReason(summary: DeliveryConfirmationNoResponseRunSummary, reason: string) {
  summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
}

function emptyRunSummary(params: {
  runDate: string;
  dryRun: boolean;
}): DeliveryConfirmationNoResponseRunSummary {
  return {
    runDate: params.runDate,
    dryRun: params.dryRun,
    weekendSkipped: false,
    touchDefinition: {
      original42DayRequestTouch: 1,
      firstReminderTouch: 2,
      secondReminderTouch: 3,
      maxFollowUpCount: 2,
    },
    targetDeliveryDates: {
      touch2: dateKey(addDays(params.runDate, 41)),
      touch3: dateKey(addDays(params.runDate, 40)),
      salespersonEscalation: dateKey(addDays(params.runDate, 39)),
    },
    reminderCandidatesChecked: 0,
    escalationCandidatesChecked: 0,
    reminderCandidateCounts: {
      touch2: 0,
      touch3: 0,
    },
    escalationCandidateCount: 0,
    currentStateRefreshesAttempted: 0,
    currentStateRefreshesSucceeded: 0,
    currentStateRefreshesFailed: 0,
    externalConfirmationsStopped: 0,
    staleConfirmationsExpired: 0,
    reminderEventsCreated: 0,
    reminderEventsWouldCreate: 0,
    reminderEventsDeduped: 0,
    reminderEventsSkipped: 0,
    remindersScheduled: 0,
    remindersScheduledByChannel: {
      SMS: 0,
      EMAIL: 0,
    },
    confirmationsUpdatedAfterReminder: 0,
    internalEscalationsCreated: 0,
    internalEscalationsWouldCreate: 0,
    internalEscalationsDeduped: 0,
    internalEscalationsSkipped: 0,
    manualReviewMarked: 0,
    noChannelEscalations: 0,
    skippedReasons: {},
    eventReports: [],
  };
}

async function findFollowUpCandidates(params: {
  client: DeliveryConfirmationNoResponseClient;
  deliveryDate: Date;
  statuses: readonly DeliveryConfirmationStatus[];
  maxConfirmationFollowUpCountBeforeRun: number;
}) {
  const rows = await params.client.deliveryConfirmation.findMany({
    where: {
      deliveryDate: params.deliveryDate,
      status: { in: [...params.statuses] },
      confirmedAt: null,
      requestedNewDate: null,
      manualReviewRequired: false,
      confirmationFollowUpCount: { lte: params.maxConfirmationFollowUpCountBeforeRun },
    },
    select: {
      id: true,
      notificationEvent: {
        select: {
          selectedChannel: true,
        },
      },
    },
  });

  return rows as PlanCandidate[];
}

async function buildFollowUpPlan(params: {
  client: DeliveryConfirmationNoResponseClient;
  deliveryDate: Date;
  intervalDay: 41 | 40;
  maxConfirmationFollowUpCountBeforeRun: number;
  weekendSkipped: boolean;
}): Promise<FollowUpPlan> {
  if (params.weekendSkipped) {
    return {
      deliveryDate: dateKey(params.deliveryDate),
      intervalDay: params.intervalDay,
      customerMessageAllowed: false,
      reason: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.weekendSendDate,
      candidateCount: 0,
      noCustomerResponseCandidateCount: 0,
      awaitingNewDateCandidateCount: 0,
      selectedChannelCounts: emptySelectedChannelCounts(),
    };
  }

  const [noCustomerResponseCandidates, awaitingNewDateCandidates] = await Promise.all([
    findFollowUpCandidates({
      client: params.client,
      deliveryDate: params.deliveryDate,
      statuses: NO_CUSTOMER_RESPONSE_STATUSES,
      maxConfirmationFollowUpCountBeforeRun: params.maxConfirmationFollowUpCountBeforeRun,
    }),
    findFollowUpCandidates({
      client: params.client,
      deliveryDate: params.deliveryDate,
      statuses: AWAITING_NEW_DATE_STATUSES,
      maxConfirmationFollowUpCountBeforeRun: params.maxConfirmationFollowUpCountBeforeRun,
    }),
  ]);
  const candidates = [...noCustomerResponseCandidates, ...awaitingNewDateCandidates];

  return {
    deliveryDate: dateKey(params.deliveryDate),
    intervalDay: params.intervalDay,
    customerMessageAllowed: true,
    reason: null,
    candidateCount: candidates.length,
    noCustomerResponseCandidateCount: noCustomerResponseCandidates.length,
    awaitingNewDateCandidateCount: awaitingNewDateCandidates.length,
    selectedChannelCounts: countSelectedChannels(candidates),
  };
}

export async function planDeliveryConfirmationNoResponseWork(
  params: {
    runDate?: Date | string;
    prismaClient?: DeliveryConfirmationNoResponseClient;
  } = {}
): Promise<DeliveryConfirmationNoResponsePlan> {
  const client = await noResponseClient(params.prismaClient);
  const runDate = dateKey(params.runDate ?? new Date());
  const weekendSkipped = shouldSkipNotificationRunForWeekend(runDate);
  const day41DeliveryDate = addDays(runDate, 41);
  const day40DeliveryDate = addDays(runDate, 40);
  const day39DeliveryDate = addDays(runDate, 39);

  const [day41Plan, day40Plan, noCustomerResponseCandidates, awaitingNewDateCandidates] =
    await Promise.all([
      buildFollowUpPlan({
        client,
        deliveryDate: day41DeliveryDate,
        intervalDay: 41,
        maxConfirmationFollowUpCountBeforeRun: 0,
        weekendSkipped,
      }),
      buildFollowUpPlan({
        client,
        deliveryDate: day40DeliveryDate,
        intervalDay: 40,
        maxConfirmationFollowUpCountBeforeRun: 1,
        weekendSkipped,
      }),
      client.deliveryConfirmation.count({
        where: {
          deliveryDate: day39DeliveryDate,
          status: { in: [...NO_CUSTOMER_RESPONSE_STATUSES] },
          confirmedAt: null,
          requestedNewDate: null,
          manualReviewRequired: false,
        },
      }),
      client.deliveryConfirmation.count({
        where: {
          deliveryDate: day39DeliveryDate,
          status: { in: [...AWAITING_NEW_DATE_STATUSES] },
          confirmedAt: null,
          requestedNewDate: null,
          manualReviewRequired: false,
        },
      }),
    ]);

  return {
    runDate,
    weekendSkipped,
    followUps: [day41Plan, day40Plan],
    manualReviewCheckpoint: {
      deliveryDate: dateKey(day39DeliveryDate),
      noCustomerResponseCandidates,
      awaitingNewDateCandidates,
    },
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

function isNoCustomerResponseStatus(value: DeliveryConfirmationStatus) {
  return (NO_CUSTOMER_RESPONSE_STATUSES as readonly DeliveryConfirmationStatus[]).includes(value);
}

function isConfirmationLinkExpired(
  confirmation: Pick<
    DeliveryConfirmationNoResponseCandidate,
    "linkExpiresAt" | "linkExpiredAt"
  >,
  runDate: string
) {
  if (confirmation.linkExpiredAt) return true;
  if (!confirmation.linkExpiresAt) return false;
  return confirmation.linkExpiresAt.getTime() < dateFromKey(runDate).getTime();
}

function normalizeAcumaticaConfirmVia(value: unknown) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function candidateStopReason(
  confirmation: DeliveryConfirmationNoResponseCandidate,
  runDate: string
): DeliveryConfirmationNoResponseSkipReason | null {
  if (!isNoCustomerResponseStatus(confirmation.status) || confirmation.confirmedAt) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.customerAlreadyResponded;
  }

  if (confirmation.requestedNewDate) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.customerAlreadyResponded;
  }

  if (confirmation.manualReviewRequired || confirmation.noResponseAt) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.manualReviewAlreadyRequired;
  }

  if (!confirmation.linkToken) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.confirmationLinkMissing;
  }

  if (isConfirmationLinkExpired(confirmation, runDate)) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.confirmationLinkExpired;
  }

  const deliveryGroup = confirmation.orderDeliveryGroup;
  const order = deliveryGroup.order;
  if (normalizeAcumaticaConfirmVia(order.confirmVia)) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.alreadyConfirmedInAcumatica;
  }

  if (!deliveryGroup.isActive) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.inactiveDeliveryGroup;
  }

  if (dateKey(deliveryGroup.deliveryDate) !== dateKey(confirmation.deliveryDate)) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.staleDeliveryDate;
  }

  const deliveryDateSkipReason = getDeliveryDateCustomerNotificationSkipReason(
    deliveryGroup.deliveryDate
  );
  if (deliveryDateSkipReason) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.deliveryDateWeekend;
  }

  if ((deliveryGroup.deliveryGroupLines ?? []).length === 0) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.noActiveDeliveryLines;
  }

  if (
    isCompletedOrCancelledStatus(order.status) ||
    isCompletedOrCancelledStatus(deliveryGroup.status) ||
    isBlockedLifecycleStatus(order.internalLifecycleStatus)
  ) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.orderNotActive;
  }

  return null;
}

type CurrentStateRefreshResult =
  | {
      ok: true;
      candidate: DeliveryConfirmationNoResponseCandidate;
      importResult: ImportSalesOrdersResult | null;
    }
  | {
      ok: false;
      reason: typeof DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.currentStateRefreshFailed;
      error: string;
    };

export type DeliveryConfirmationNoResponseCurrentStateRefresher = (params: {
  candidate: DeliveryConfirmationNoResponseCandidate;
  client: DeliveryConfirmationNoResponseClient;
}) => Promise<CurrentStateRefreshResult>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function importErrorMatchesCandidate(
  error: ImportSalesOrdersResult["errors"][number],
  candidate: DeliveryConfirmationNoResponseCandidate
) {
  if (error.orderNumber && error.orderNumber !== candidate.orderNumber) return false;
  if (error.orderType && error.orderType !== candidate.orderType) return false;
  return true;
}

function importResultHasHardFailure(
  importResult: ImportSalesOrdersResult,
  candidate: DeliveryConfirmationNoResponseCandidate
) {
  return importResult.errors.some(
    (error) =>
      importErrorMatchesCandidate(error, candidate) &&
      /step 2|full salesorder|salesorder import failed|missing required contactid/i.test(
        error.reason
      )
  );
}

async function reloadNoResponseCandidate(
  client: DeliveryConfirmationNoResponseClient,
  candidateId: string
) {
  if (!client.deliveryConfirmation.findUnique) {
    throw new Error("deliveryConfirmation.findUnique is required for current-state refresh");
  }

  const reloaded = await client.deliveryConfirmation.findUnique({
    where: { id: candidateId },
    select: deliveryConfirmationNoResponseSelect,
  });

  return reloaded as DeliveryConfirmationNoResponseCandidate | null;
}

async function defaultCurrentStateRefresher(params: {
  candidate: DeliveryConfirmationNoResponseCandidate;
  client: DeliveryConfirmationNoResponseClient;
}): Promise<CurrentStateRefreshResult> {
  try {
    const { importSalesOrdersForLineRequestedOn } = await import("@/lib/erp/importSalesOrders");
    const importResult = await importSalesOrdersForLineRequestedOn(params.candidate.deliveryDate, {
      orderLookups: [
        {
          orderNumber: params.candidate.orderNumber,
          orderType: params.candidate.orderType,
        },
      ],
      includeUnqualifiedOrderLookups: true,
    });

    if (importResultHasHardFailure(importResult, params.candidate)) {
      return {
        ok: false,
        reason: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.currentStateRefreshFailed,
        error: "ERP import returned a hard failure for this order",
      };
    }

    const reloaded = await reloadNoResponseCandidate(params.client, params.candidate.id);
    if (!reloaded) {
      return {
        ok: false,
        reason: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.currentStateRefreshFailed,
        error: "DeliveryConfirmation was not found after current-state refresh",
      };
    }

    return { ok: true, candidate: reloaded, importResult };
  } catch (error) {
    return {
      ok: false,
      reason: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.currentStateRefreshFailed,
      error: errorMessage(error),
    };
  }
}

async function noopCurrentStateRefresher(params: {
  candidate: DeliveryConfirmationNoResponseCandidate;
  client: DeliveryConfirmationNoResponseClient;
}): Promise<CurrentStateRefreshResult> {
  return { ok: true, candidate: params.candidate, importResult: null };
}

async function refreshCandidateForNoResponse(params: {
  candidate: DeliveryConfirmationNoResponseCandidate;
  client: DeliveryConfirmationNoResponseClient;
  refresher: DeliveryConfirmationNoResponseCurrentStateRefresher;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  params.summary.currentStateRefreshesAttempted += 1;
  const result = await params.refresher({
    candidate: params.candidate,
    client: params.client,
  });

  if (!result.ok) {
    params.summary.currentStateRefreshesFailed += 1;
    addSkippedReason(params.summary, result.reason);
    return result;
  }

  params.summary.currentStateRefreshesSucceeded += 1;
  return result;
}

async function markExternallyConfirmed(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  now: Date;
  dryRun: boolean;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  params.summary.externalConfirmationsStopped += 1;
  if (params.dryRun) return;

  await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      status: DeliveryConfirmationStatus.CONFIRMED,
      confirmedAt: params.candidate.confirmedAt ?? params.now,
      responseChannel: null,
      rawResponse: null,
      normalizedResponse: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.alreadyConfirmedInAcumatica,
    },
    select: { id: true },
  });
}

async function expireStaleConfirmation(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  now: Date;
  dryRun: boolean;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  params.summary.staleConfirmationsExpired += 1;
  if (params.dryRun) return;

  await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      status: DeliveryConfirmationStatus.EXPIRED,
      linkExpiredAt: params.candidate.linkExpiredAt ?? params.now,
      normalizedResponse: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.staleDeliveryDate,
    },
    select: { id: true },
  });
}

async function applyStopSideEffect(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  stopReason: DeliveryConfirmationNoResponseSkipReason;
  now: Date;
  dryRun: boolean;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  if (params.stopReason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.alreadyConfirmedInAcumatica) {
    await markExternallyConfirmed(params);
    return;
  }

  if (
    params.stopReason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.staleDeliveryDate ||
    params.stopReason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.inactiveDeliveryGroup
  ) {
    await expireStaleConfirmation(params);
  }
}

function truncate(value: string | null | undefined, maxLength: number) {
  if (!value) return null;
  return value.length <= maxLength ? value : value.slice(0, maxLength - 1);
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
      `Rendered 42-day no-response message contains placeholder text order=${params.orderType} ${params.orderNumber}`
    );
  }
}

export function buildDeliveryConfirmationReminderDedupeKey(params: {
  confirmationId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
  touchNumber: DeliveryConfirmationNoResponseTouchNumber;
}) {
  return [
    "delivery_confirmation_reminder",
    params.confirmationId.trim(),
    params.orderType.trim(),
    params.orderNumber.trim(),
    dateKey(params.deliveryDate),
    `touch_${params.touchNumber}`,
  ].join(":");
}

function selectedChannelCountsKey(value: NotificationChannel | null) {
  if (value === "SMS") return "SMS";
  if (value === "EMAIL") return "EMAIL";
  return null;
}

function selectCandidateChannel(
  candidate: DeliveryConfirmationNoResponseCandidate,
  activeOptOutAddresses: ActiveNotificationOptOutAddresses
) {
  const contact = candidate.orderDeliveryGroup.order.contact;
  return selectNotificationChannel(
    contact,
    mergeNotificationOptOutAddresses(activeOptOutAddresses, {
      activeSmsOptOutPhones: contact.smsOptOuts?.map((optOut) => optOut.phone) ?? [],
      activeEmailOptOutEmails: contact.emailOptOuts?.map((optOut) => optOut.email) ?? [],
    })
  );
}

async function findReminderCandidates(params: {
  client: DeliveryConfirmationNoResponseClient;
  deliveryDateFrom: Date;
  deliveryDateTo: Date;
  expectedFollowUpCountBeforeRun: 0 | 1;
}) {
  const rows = await params.client.deliveryConfirmation.findMany({
    where: {
      deliveryDate: {
        gte: params.deliveryDateFrom,
        lte: params.deliveryDateTo,
      },
      status: { in: [...NO_CUSTOMER_RESPONSE_STATUSES] },
      confirmedAt: null,
      requestedNewDate: null,
      manualReviewRequired: false,
      noResponseAt: null,
      confirmationFollowUpCount: params.expectedFollowUpCountBeforeRun,
    },
    orderBy: [{ orderNumber: "asc" }, { id: "asc" }],
    select: deliveryConfirmationNoResponseSelect,
  });

  return rows as DeliveryConfirmationNoResponseCandidate[];
}

async function findEscalationCandidates(params: {
  client: DeliveryConfirmationNoResponseClient;
  deliveryDateFrom: Date;
  deliveryDateTo: Date;
}) {
  const rows = await params.client.deliveryConfirmation.findMany({
    where: {
      deliveryDate: {
        gte: params.deliveryDateFrom,
        lte: params.deliveryDateTo,
      },
      status: { in: [...NO_CUSTOMER_RESPONSE_STATUSES] },
      confirmedAt: null,
      requestedNewDate: null,
      manualReviewRequired: false,
      noResponseAt: null,
      confirmationFollowUpCount: { gte: DELIVERY_CONFIRMATION_MAX_FOLLOW_UP_COUNT },
    },
    orderBy: [{ orderNumber: "asc" }, { id: "asc" }],
    select: deliveryConfirmationNoResponseSelect,
  });

  return rows as DeliveryConfirmationNoResponseCandidate[];
}

function salespersonNumberForCandidate(candidate: DeliveryConfirmationNoResponseCandidate) {
  return cleanNotificationText(candidate.orderDeliveryGroup.order.salespersonNumber);
}

async function loadSalespersonContactsForCandidates(
  candidates: DeliveryConfirmationNoResponseCandidate[],
  client: DeliveryConfirmationNoResponseClient
) {
  return getActiveSalespersonContactMap(
    candidates.map(salespersonNumberForCandidate),
    client as unknown as Parameters<typeof getActiveSalespersonContactMap>[1]
  );
}

async function loadSalespersonContactForCandidate(
  candidate: DeliveryConfirmationNoResponseCandidate,
  client: DeliveryConfirmationNoResponseClient
) {
  const salespersonNumber = salespersonNumberForCandidate(candidate);
  if (!salespersonNumber) return null;
  const contacts = await getActiveSalespersonContactMap(
    [salespersonNumber],
    client as unknown as Parameters<typeof getActiveSalespersonContactMap>[1]
  );
  return contacts.get(salespersonNumber) ?? null;
}

function contactNameForCandidate(candidate: DeliveryConfirmationNoResponseCandidate) {
  return formatContactName(candidate.orderDeliveryGroup.order.contact);
}

function customerPhoneForCandidate(candidate: DeliveryConfirmationNoResponseCandidate) {
  const contact = candidate.orderDeliveryGroup.order.contact;
  return cleanNotificationText(contact.phone1) ?? cleanNotificationText(contact.phone2);
}

export function getDeliveryConfirmationNoResponseFallbackEmail() {
  const value =
    process.env.DELIVERY_CONFIRMATION_NO_RESPONSE_FALLBACK_EMAIL?.trim() ??
    process.env.DELIVERY_PAYMENT_ENFORCEMENT_FALLBACK_EMAIL?.trim();
  return value?.split(",").map((email) => email.trim()).find(Boolean) ?? null;
}

function resolveInternalRecipient(salespersonContact: SalespersonContactInput | null) {
  const salespersonEmail =
    salespersonContact?.isActive === true
      ? cleanNotificationText(salespersonContact.salespersonEmail)
      : null;
  if (salespersonEmail) {
    return {
      audienceType: InternalNotificationAudienceType.SALESPERSON,
      recipientEmail: salespersonEmail,
      recipientName: cleanNotificationText(salespersonContact?.salespersonName),
      reasonSkipped: null,
    };
  }

  const fallback = getDeliveryConfirmationNoResponseFallbackEmail();
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
    reasonSkipped: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.noInternalNotificationRecipient,
  };
}

export function render42DayNoResponseSalespersonEmail(params: {
  salespersonName?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
  confirmationLink: string;
  currentStatus: string;
  reason: string;
}) {
  const salespersonName = cleanNotificationText(params.salespersonName) ?? "there";
  const customerEmail = cleanNotificationText(params.customerEmail);
  const customerPhone = cleanNotificationText(params.customerPhone);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const customerContact = [customerEmail, customerPhone].filter(Boolean).join(" / ") || "not available";
  const messageSummary =
    "Customer did not respond after 3 total 42-day delivery confirmation touches.";
  const subject = `No response: Delivery confirmation for Order ${params.orderNumber}`;
  const body = [
    `Hello ${salespersonName},`,
    "",
    messageSummary,
    "",
    `Order: ${params.orderType} ${params.orderNumber}`,
    `Delivery date: ${deliveryDate}`,
    `Customer: ${params.customerName}`,
    `Customer contact: ${customerContact}`,
    `Current confirmation status: ${params.currentStatus}`,
    `Reason: ${params.reason}`,
    "",
    "Recommended action: contact the customer manually to confirm delivery or update the delivery date.",
    "",
    "Confirmation link:",
    params.confirmationLink,
  ].join("\n");

  return {
    subject,
    body,
    messageSummary,
  };
}

async function updateConfirmationAfterReminder(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  followUpCountAfter: number;
  now: Date;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      confirmationFollowUpCount: Math.max(
        params.candidate.confirmationFollowUpCount,
        params.followUpCountAfter
      ),
      reminderSentAt: params.now,
    },
    select: { id: true },
  });
  params.candidate.confirmationFollowUpCount = Math.max(
    params.candidate.confirmationFollowUpCount,
    params.followUpCountAfter
  );
  params.candidate.reminderSentAt = params.now;
  params.summary.confirmationsUpdatedAfterReminder += 1;
}

async function markManualReviewForNoResponse(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  now: Date;
  note: string;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      manualReviewRequired: true,
      manualReviewReason: DELIVERY_MANUAL_REVIEW_REASONS.NO_CUSTOMER_RESPONSE,
      manualReviewMarkedAt: params.now,
      noResponseAt: params.now,
      manualReviewNotes: params.note,
    },
    select: { id: true },
  });
  params.candidate.manualReviewRequired = true;
  params.candidate.manualReviewReason = DELIVERY_MANUAL_REVIEW_REASONS.NO_CUSTOMER_RESPONSE;
  params.candidate.manualReviewMarkedAt = params.now;
  params.candidate.manualReviewNotes = params.note;
  params.candidate.noResponseAt = params.now;
  params.summary.manualReviewMarked += 1;
}

async function createOrReuseSalespersonEscalation(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  salespersonContact: SalespersonContactInput | null;
  runDate: string;
  now: Date;
  dryRun: boolean;
  reason: string;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  const candidate = params.candidate;
  const deliveryGroup = candidate.orderDeliveryGroup;
  const order = deliveryGroup.order;
  const recipient = resolveInternalRecipient(params.salespersonContact);
  const confirmationLink = candidate.linkToken ? buildDeliveryConfirmationLink(candidate.linkToken) : "";
  const rendered = render42DayNoResponseSalespersonEmail({
    salespersonName: params.salespersonContact?.salespersonName,
    customerName: contactNameForCandidate(candidate),
    customerEmail: order.contact.email,
    customerPhone: customerPhoneForCandidate(candidate),
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: deliveryGroup.deliveryDate,
    confirmationLink,
    currentStatus: candidate.status,
    reason: params.reason,
  });

  validateRenderedMessage({
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    subject: rendered.subject,
    renderedMessagePreview: rendered.body,
  });

  let internalEvent: InternalNotificationEventRecord | null = null;
  const existing = params.client.internalNotificationEvent
    ? await params.client.internalNotificationEvent.findFirst({
        where: {
          orderDeliveryGroupId: deliveryGroup.id,
          purpose: DELIVERY_CONFIRMATION_NO_RESPONSE_SALESPERSON_PURPOSE,
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          deliveryDate: deliveryGroup.deliveryDate,
        },
        select: internalNotificationEventSelect,
      })
    : null;

  if (existing) {
    params.summary.internalEscalationsDeduped += 1;
    internalEvent = existing;
  } else if (params.dryRun) {
    params.summary.internalEscalationsWouldCreate += 1;
  } else {
    if (!params.client.internalNotificationEvent) {
      throw new Error("internalNotificationEvent client is required when dryRun=false");
    }

    const status = recipient.reasonSkipped
      ? InternalNotificationStatus.SKIPPED
      : InternalNotificationStatus.PENDING;
    const createData = {
      orderId: order.id,
      orderDeliveryGroupId: deliveryGroup.id,
      deliveryOrderHoldActionId: null,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: deliveryGroup.deliveryDate,
      purpose: DELIVERY_CONFIRMATION_NO_RESPONSE_SALESPERSON_PURPOSE,
      audienceType: recipient.audienceType,
      recipientEmail: recipient.recipientEmail,
      recipientName: recipient.recipientName,
      subject: truncate(rendered.subject, 512),
      bodyPreview: truncate(rendered.body, 2048),
      messageSummary: truncate(rendered.messageSummary, 1024),
      status,
      reasonSkipped: recipient.reasonSkipped,
    };

    if (params.client.internalNotificationEvent.upsert) {
      internalEvent = await params.client.internalNotificationEvent.upsert({
        where: {
          orderDeliveryGroupId_deliveryDate_purpose: {
            orderDeliveryGroupId: deliveryGroup.id,
            deliveryDate: deliveryGroup.deliveryDate,
            purpose: DELIVERY_CONFIRMATION_NO_RESPONSE_SALESPERSON_PURPOSE,
          },
        },
        create: createData,
        update: {},
        select: internalNotificationEventSelect,
      });
    } else {
      internalEvent = await params.client.internalNotificationEvent.create({
        data: createData,
        select: internalNotificationEventSelect,
      });
    }
    params.summary.internalEscalationsCreated += 1;
    if (status === InternalNotificationStatus.SKIPPED) {
      params.summary.internalEscalationsSkipped += 1;
      addSkippedReason(params.summary, recipient.reasonSkipped as string);
    }
  }

  if (!params.dryRun) {
    await markManualReviewForNoResponse({
      client: params.client,
      candidate,
      now: params.now,
      note:
        "39-day checkpoint: customer did not respond after 3 total 42-day confirmation touches.",
      summary: params.summary,
    });
  }

  params.summary.eventReports.push({
    confirmationId: candidate.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: dateKey(deliveryGroup.deliveryDate),
    touchNumber: "salesperson_escalation",
    eventId: null,
    internalEventId: internalEvent?.id ?? null,
    dedupeKey: null,
    status: internalEvent?.status ?? (params.dryRun ? "DRY_RUN" : InternalNotificationStatus.PENDING),
    selectedChannel: null,
    reasonSkipped: recipient.reasonSkipped,
    subject: rendered.subject,
    renderedMessagePreview: rendered.body,
    confirmationFollowUpCountAfter: candidate.confirmationFollowUpCount,
    manualReviewRequiredAfter: !params.dryRun || candidate.manualReviewRequired,
  });
}

async function processReminderCandidate(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  schedule: ReminderSchedule;
  activeOptOutAddresses: ActiveNotificationOptOutAddresses;
  salespersonContact: SalespersonContactInput | null;
  currentStateRefresher: DeliveryConfirmationNoResponseCurrentStateRefresher;
  runDate: string;
  now: Date;
  dryRun: boolean;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  let candidate = params.candidate;
  let deliveryGroup = candidate.orderDeliveryGroup;
  let order = deliveryGroup.order;
  const followUpCountAfter = params.schedule.touchNumber - 1;

  const refreshResult = await refreshCandidateForNoResponse({
    client: params.client,
    candidate,
    refresher: params.currentStateRefresher,
    summary: params.summary,
  });
  if (!refreshResult.ok) {
    params.summary.eventReports.push({
      confirmationId: candidate.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: dateKey(candidate.deliveryDate),
      touchNumber: params.schedule.touchNumber,
      eventId: null,
      internalEventId: null,
      dedupeKey: null,
      status: NotificationEventStatus.SKIPPED,
      selectedChannel: null,
      reasonSkipped: refreshResult.reason,
      subject: null,
      renderedMessagePreview: refreshResult.error,
      confirmationFollowUpCountAfter: candidate.confirmationFollowUpCount,
      manualReviewRequiredAfter: candidate.manualReviewRequired,
    });
    return;
  }

  candidate = refreshResult.candidate;
  deliveryGroup = candidate.orderDeliveryGroup;
  order = deliveryGroup.order;
  const salespersonContact = await loadSalespersonContactForCandidate(candidate, params.client);

  const stopReason = candidateStopReason(candidate, params.runDate);
  if (stopReason) {
    addSkippedReason(params.summary, stopReason);
    await applyStopSideEffect({
      client: params.client,
      candidate,
      stopReason,
      now: params.now,
      dryRun: params.dryRun,
      summary: params.summary,
    });
    params.summary.eventReports.push({
      confirmationId: candidate.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: dateKey(candidate.deliveryDate),
      touchNumber: params.schedule.touchNumber,
      eventId: null,
      internalEventId: null,
      dedupeKey: null,
      status: NotificationEventStatus.SKIPPED,
      selectedChannel: null,
      reasonSkipped: stopReason,
      subject: null,
      renderedMessagePreview: stopReason,
      confirmationFollowUpCountAfter: candidate.confirmationFollowUpCount,
      manualReviewRequiredAfter: candidate.manualReviewRequired,
    });
    return;
  }

  const link = buildDeliveryConfirmationLink(candidate.linkToken as string);
  const channel = selectCandidateChannel(candidate, params.activeOptOutAddresses);
  const dedupeKey = buildDeliveryConfirmationReminderDedupeKey({
    confirmationId: candidate.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: deliveryGroup.deliveryDate,
    touchNumber: params.schedule.touchNumber,
  });
  const noChannel = channel.selectedChannel === null;
  const smsMessage = render42DaySmsConfirmationReminderMessage({
    orderNumber: order.orderNumber,
    deliveryDate: deliveryGroup.deliveryDate,
    link,
    deliveryAddress: order.address,
  });
  const emailMessage = render42DayEmailConfirmationReminderMessage({
    orderNumber: order.orderNumber,
    contactName: contactNameForCandidate(candidate),
    deliveryDate: deliveryGroup.deliveryDate,
    link,
  });
  const subject = channel.selectedChannel === "EMAIL" ? emailMessage.subject : null;
  const renderedMessagePreview =
    channel.selectedChannel === "EMAIL"
      ? emailMessage.body
      : noChannel
        ? channel.channelReason
        : smsMessage;

  validateRenderedMessage({
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    subject,
    renderedMessagePreview,
  });

  let event: NotificationEventRecord | null = null;
  const existingEvent = params.client.notificationEvent
    ? await params.client.notificationEvent.findUnique({
        where: { dedupeKey },
        select: notificationEventSelect,
      })
    : null;

  if (existingEvent) {
    params.summary.reminderEventsDeduped += 1;
    event = existingEvent;
  } else if (params.dryRun) {
    params.summary.reminderEventsWouldCreate += 1;
  } else {
    if (!params.client.notificationEvent) {
      throw new Error("notificationEvent client is required when dryRun=false");
    }

    event = await params.client.notificationEvent.create({
      data: {
        orderId: order.id,
        deliveryGroupId: deliveryGroup.id,
        contactId: order.contact.contactId,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryDate: deliveryGroup.deliveryDate,
        intervalType: NotificationIntervalType.DAY_42,
        actionType: NotificationActionType.DELIVERY_CONFIRMATION_REMINDER,
        dedupeKey,
        selectedChannel: channel.selectedChannel,
        channelReason: channel.channelReason,
        recipientEmail: channel.selectedChannel === "EMAIL" ? channel.recipientEmail : null,
        recipientPhone: channel.selectedChannel === "SMS" ? channel.recipientPhone : null,
        status: noChannel ? NotificationEventStatus.SKIPPED : NotificationEventStatus.SCHEDULED,
        reasonSkipped: noChannel ? channel.channelReason : null,
        scheduledAt: noChannel ? null : dateFromKey(params.runDate),
      },
      select: notificationEventSelect,
    });
    params.summary.reminderEventsCreated += 1;
  }

  if (noChannel) {
    params.summary.reminderEventsSkipped += 1;
    params.summary.noChannelEscalations += 1;
    addSkippedReason(
      params.summary,
      DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.noAutomatedChannelAvailable
    );
    await createOrReuseSalespersonEscalation({
      client: params.client,
      candidate,
      salespersonContact,
      runDate: params.runDate,
      now: params.now,
      dryRun: params.dryRun,
      reason:
        "No eligible customer SMS/email channel was available for the 42-day no-response reminder.",
      summary: params.summary,
    });
  } else {
    params.summary.remindersScheduled += 1;
    const scheduledChannel = selectedChannelCountsKey(channel.selectedChannel);
    if (scheduledChannel) params.summary.remindersScheduledByChannel[scheduledChannel] += 1;
    if (!params.dryRun) {
      await updateConfirmationAfterReminder({
        client: params.client,
        candidate,
        followUpCountAfter,
        now: params.now,
        summary: params.summary,
      });
    }
  }

  params.summary.eventReports.push({
    confirmationId: candidate.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: dateKey(deliveryGroup.deliveryDate),
    touchNumber: params.schedule.touchNumber,
    eventId: event?.id ?? null,
    internalEventId: null,
    dedupeKey,
    status:
      event?.status ??
      (params.dryRun
        ? noChannel
          ? NotificationEventStatus.SKIPPED
          : "DRY_RUN"
        : NotificationEventStatus.SCHEDULED),
    selectedChannel: channel.selectedChannel,
    reasonSkipped: noChannel ? channel.channelReason : null,
    subject,
    renderedMessagePreview,
    confirmationFollowUpCountAfter: params.dryRun
      ? followUpCountAfter
      : candidate.confirmationFollowUpCount,
    manualReviewRequiredAfter: candidate.manualReviewRequired,
  });
}

async function processEscalationCandidate(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  salespersonContact: SalespersonContactInput | null;
  currentStateRefresher: DeliveryConfirmationNoResponseCurrentStateRefresher;
  runDate: string;
  now: Date;
  dryRun: boolean;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  const refreshResult = await refreshCandidateForNoResponse({
    client: params.client,
    candidate: params.candidate,
    refresher: params.currentStateRefresher,
    summary: params.summary,
  });
  if (!refreshResult.ok) {
    params.summary.eventReports.push({
      confirmationId: params.candidate.id,
      orderType: params.candidate.orderType,
      orderNumber: params.candidate.orderNumber,
      deliveryDate: dateKey(params.candidate.deliveryDate),
      touchNumber: "salesperson_escalation",
      eventId: null,
      internalEventId: null,
      dedupeKey: null,
      status: InternalNotificationStatus.SKIPPED,
      selectedChannel: null,
      reasonSkipped: refreshResult.reason,
      subject: null,
      renderedMessagePreview: refreshResult.error,
      confirmationFollowUpCountAfter: params.candidate.confirmationFollowUpCount,
      manualReviewRequiredAfter: params.candidate.manualReviewRequired,
    });
    return;
  }

  const stopReason = candidateStopReason(refreshResult.candidate, params.runDate);
  if (stopReason) {
    addSkippedReason(params.summary, stopReason);
    await applyStopSideEffect({
      client: params.client,
      candidate: refreshResult.candidate,
      stopReason,
      now: params.now,
      dryRun: params.dryRun,
      summary: params.summary,
    });
    return;
  }

  await createOrReuseSalespersonEscalation({
    ...params,
    candidate: refreshResult.candidate,
    salespersonContact: await loadSalespersonContactForCandidate(
      refreshResult.candidate,
      params.client
    ),
    reason: "Customer did not respond after 3 total 42-day confirmation touches.",
  });
}

export async function run42DayDeliveryConfirmationNoResponse(
  params: {
    runDate?: Date | string;
    now?: Date;
    dryRun?: boolean;
    prismaClient?: DeliveryConfirmationNoResponseClient;
    currentStateRefresher?: DeliveryConfirmationNoResponseCurrentStateRefresher;
  } = {}
): Promise<DeliveryConfirmationNoResponseRunSummary> {
  const client = await noResponseClient(params.prismaClient);
  const runDate = dateKey(params.runDate ?? new Date());
  const now = params.now ?? new Date();
  const dryRun = params.dryRun ?? true;
  const currentStateRefresher =
    params.currentStateRefresher ??
    (params.prismaClient ? noopCurrentStateRefresher : defaultCurrentStateRefresher);
  const summary = emptyRunSummary({ runDate, dryRun });

  if (shouldSkipNotificationRunForWeekend(runDate)) {
    summary.weekendSkipped = true;
    addSkippedReason(summary, DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.weekendSendDate);
    return summary;
  }

  const activeOptOutAddresses = await loadActiveNotificationOptOutAddresses(client);
  const reminderCandidateSets = await Promise.all(
    REMINDER_SCHEDULE.map(async (schedule) => ({
      schedule,
      candidates: await findReminderCandidates({
        client,
        deliveryDateFrom: addDays(runDate, schedule.catchUpMinIntervalDay),
        deliveryDateTo: addDays(runDate, schedule.intervalDay),
        expectedFollowUpCountBeforeRun: schedule.expectedFollowUpCountBeforeRun,
      }),
    }))
  );
  const escalationCandidates = await findEscalationCandidates({
    client,
    deliveryDateFrom: addDays(runDate, 37),
    deliveryDateTo: addDays(runDate, 39),
  });
  const allCandidates = [
    ...reminderCandidateSets.flatMap((set) => set.candidates),
    ...escalationCandidates,
  ];
  const salespersonContactsByNumber = await loadSalespersonContactsForCandidates(
    allCandidates,
    client
  );

  for (const { schedule, candidates } of reminderCandidateSets) {
    if (schedule.touchNumber === 2) summary.reminderCandidateCounts.touch2 = candidates.length;
    if (schedule.touchNumber === 3) summary.reminderCandidateCounts.touch3 = candidates.length;

    for (const candidate of candidates) {
      summary.reminderCandidatesChecked += 1;
      const salespersonNumber = salespersonNumberForCandidate(candidate);
      await processReminderCandidate({
        client,
        candidate,
        schedule,
        activeOptOutAddresses,
        salespersonContact: salespersonNumber
          ? salespersonContactsByNumber.get(salespersonNumber) ?? null
          : null,
        currentStateRefresher,
        runDate,
        now,
        dryRun,
        summary,
      });
    }
  }

  summary.escalationCandidateCount = escalationCandidates.length;
  for (const candidate of escalationCandidates) {
    summary.escalationCandidatesChecked += 1;
    const salespersonNumber = salespersonNumberForCandidate(candidate);
    await processEscalationCandidate({
      client,
      candidate,
      salespersonContact: salespersonNumber
        ? salespersonContactsByNumber.get(salespersonNumber) ?? null
        : null,
      currentStateRefresher,
      runDate,
      now,
      dryRun,
      summary,
    });
  }

  return summary;
}

export async function mark39DayNoResponseManualReview(params: {
  runDate?: Date | string;
  prismaClient?: DeliveryConfirmationNoResponseClient;
  now?: Date;
}) {
  const client = await noResponseClient(params.prismaClient);
  const now = params.now ?? new Date();
  const runDate = dateKey(params.runDate ?? now);
  const deliveryDate = dateFromKey(dateKey(addDays(runDate, 39)));

  const noCustomerResponse = await client.deliveryConfirmation.updateMany({
    where: {
      deliveryDate,
      status: { in: [...NO_CUSTOMER_RESPONSE_STATUSES] },
      confirmedAt: null,
      requestedNewDate: null,
      manualReviewRequired: false,
    },
    data: {
      manualReviewRequired: true,
      manualReviewReason: DELIVERY_MANUAL_REVIEW_REASONS.NO_CUSTOMER_RESPONSE,
      manualReviewMarkedAt: now,
      noResponseAt: now,
      manualReviewNotes:
        "39-day checkpoint: no customer response after available 42-day confirmation attempts.",
    },
  });

  const awaitingNewDateNoResponse = await client.deliveryConfirmation.updateMany({
    where: {
      deliveryDate,
      status: { in: [...AWAITING_NEW_DATE_STATUSES] },
      confirmedAt: null,
      requestedNewDate: null,
      manualReviewRequired: false,
    },
    data: {
      manualReviewRequired: true,
      manualReviewReason: DELIVERY_MANUAL_REVIEW_REASONS.AWAITING_NEW_DATE_NO_RESPONSE,
      manualReviewMarkedAt: now,
      noResponseAt: now,
      manualReviewNotes:
        "39-day checkpoint: customer requested a different date but did not provide one.",
    },
  });

  return {
    runDate,
    deliveryDate: dateKey(deliveryDate),
    noCustomerResponseMarked: noCustomerResponse.count,
    awaitingNewDateNoResponseMarked: awaitingNewDateNoResponse.count,
    customerMessagesSent: 0,
    acumaticaWritebackQueued: 0,
  };
}
