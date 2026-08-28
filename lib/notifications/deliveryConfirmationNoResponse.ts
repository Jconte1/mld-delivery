import type { ImportSalesOrdersResult } from "@/lib/erp/importSalesOrders";
import {
  DeliveryConfirmationStatus,
  InternalNotificationAudienceType,
  InternalNotificationPurpose,
  InternalNotificationStatus,
  InternalOrderLifecycleStatus,
  NotificationActionType,
  NotificationAttemptStatus,
  type NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "@/lib/generated/prisma/client";
import { DELIVERY_MANUAL_REVIEW_REASONS } from "@/lib/notifications/deliveryConfirmationManualReview";
import { buildDeliveryConfirmationLink } from "@/lib/notifications/deliveryConfirmationLinks";
import {
  render42DayEmailConfirmationMessage,
  render42DayEmailConfirmationReminderMessage,
} from "@/lib/notifications/deliveryConfirmationEmail";
import {
  render42DaySmsConfirmationMessage,
  render42DaySmsConfirmationReminderMessage,
} from "@/lib/notifications/deliveryConfirmationSms";
import {
  addDays,
  buildNotificationDedupeKey,
  cleanNotificationText,
  dateFromKey,
  dateKey,
  DELIVERY_DATE_WEEKEND_SKIP_REASON,
  formatContactName,
  formatCustomerFriendlyDate,
  formatJobAddress,
  formatJobName,
  getDeliveryDateCustomerNotificationSkipReason,
  selectNotificationChannel,
  shouldSkipNotificationRunForWeekend,
} from "@/lib/notifications/helpers";
import {
  loadActiveNotificationOptOutAddresses,
  mergeNotificationOptOutAddresses,
  type ActiveNotificationOptOutAddresses,
} from "@/lib/notifications/notificationOptOutLookup";
import {
  deliveryOrderScopeReport,
  filterByDeliveryOrderScope,
  type DeliveryOrderScope,
  type DeliveryOrderScopeReport,
} from "@/lib/notifications/orderScope";
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
  initialTouchMissing: "initial_touch_missing",
  touchEventUnattempted: "touch_event_unattempted",
  touchProviderFailed: "touch_provider_failed",
  incompleteTouchSequenceDueToCatchup: "incomplete_touch_sequence_due_to_catchup",
  noResponseActionMismatch: "no_response_action_mismatch",
  dispatchGuardConfirmationMismatch: "dispatch_guard_confirmation_mismatch",
} as const;

type DeliveryConfirmationNoResponseSkipReason =
  (typeof DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS)[keyof typeof DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS];

export type DeliveryConfirmationNoResponseReminderTouchNumber = 2 | 3;
export type DeliveryConfirmationNoResponseTouchNumber = 1 | 2 | 3;
type DeliveryConfirmationNoResponseTouchKey = "initial" | "reminder1" | "reminder2";
type DeliveryConfirmationNoResponseCustomerAction =
  | "SEND_INITIAL_CATCH_UP"
  | "SEND_REMINDER_1"
  | "SEND_REMINDER_2";

export type DeliveryConfirmationNoResponseState =
  | "NO_CONFIRMATION"
  | "INITIAL_PENDING"
  | "INITIAL_SENT"
  | "REMINDER_1_SENT"
  | "REMINDER_2_SENT"
  | "CONFIRMED"
  | "REQUESTED_NEW_DATE"
  | "MANUAL_REVIEW"
  | "STALE_DATE"
  | "NO_RESPONSE_ESCALATED";

export type DeliveryConfirmationNoResponseAction =
  | DeliveryConfirmationNoResponseCustomerAction
  | "ESCALATE_NO_RESPONSE"
  | "ESCALATE_INCOMPLETE_TOUCH_SEQUENCE"
  | "SKIP_CONFIRMED"
  | "SKIP_REQUESTED_NEW_DATE"
  | "SKIP_STALE"
  | "SKIP_MANUAL_REVIEW"
  | "SKIP_ACUMATICA_CONFIRMED"
  | "SKIP_NO_CHANNEL"
  | "SKIP_TOO_EARLY"
  | "SKIP_REFRESH_FAILED";

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
  notificationEvent?: ({ selectedChannel: NotificationChannel | null } & Partial<NotificationEventRecord>) | null;
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
  attempts?: NotificationAttemptForTouch[];
};

type NotificationAttemptForTouch = {
  id: string;
  attemptNumber: number;
  channel: NotificationChannel;
  status: NotificationAttemptStatus;
  provider?: string | null;
  providerCode?: string | null;
  success?: boolean | null;
  errorMessage?: string | null;
  externalMessageId?: string | null;
  sentAt?: Date | null;
  createdAt?: Date | null;
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
    update?(args: {
      where: { id: string };
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
  orderScope: DeliveryOrderScopeReport;
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
  initialCatchUpEventsCreated: number;
  initialCatchUpEventsWouldCreate: number;
  initialCatchUpEventsDeduped: number;
  initialCatchUpsScheduled: number;
  reminderEventsCreatedByTouch: {
    touch2: number;
    touch3: number;
  };
  reminderEventsWouldCreateByTouch: {
    touch2: number;
    touch3: number;
  };
  reminderEventsDedupedByTouch: {
    touch2: number;
    touch3: number;
  };
  remindersScheduledByTouch: {
    touch2: number;
    touch3: number;
  };
  dispatchableReminderEventIdsCreatedThisRun: string[];
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
  internalEscalationEventIdsCreatedThisRun: string[];
  manualReviewMarked: number;
  noChannelEscalations: number;
  skippedReasons: Record<string, number>;
  eventReports: DeliveryConfirmationNoResponseEventReport[];
};

const NO_CUSTOMER_RESPONSE_STATUSES = [
  DeliveryConfirmationStatus.PENDING,
  DeliveryConfirmationStatus.UNRECOGNIZED,
  DeliveryConfirmationStatus.INCOMPLETE,
] as const;

const AWAITING_NEW_DATE_STATUSES = [
  DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  DeliveryConfirmationStatus.CHANGE_REQUESTED,
] as const;

type LegacyReminderSchedule = {
  intervalDay: 41 | 40;
  touchNumber: DeliveryConfirmationNoResponseReminderTouchNumber;
  expectedFollowUpCountBeforeRun: 0 | 1;
  catchUpMinIntervalDay: 39 | 38;
};

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
  attempts: {
    orderBy: [{ attemptNumber: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      attemptNumber: true,
      channel: true,
      status: true,
      provider: true,
      providerCode: true,
      success: true,
      errorMessage: true,
      externalMessageId: true,
      sentAt: true,
      createdAt: true,
    },
  },
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
      id: true,
      dedupeKey: true,
      intervalType: true,
      actionType: true,
      status: true,
      selectedChannel: true,
      recipientEmail: true,
      recipientPhone: true,
      reasonSkipped: true,
      attempts: {
        orderBy: [{ attemptNumber: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          attemptNumber: true,
          channel: true,
          status: true,
          provider: true,
          providerCode: true,
          success: true,
          errorMessage: true,
          externalMessageId: true,
          sentAt: true,
          createdAt: true,
        },
      },
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

function touchSummaryKey(
  touchNumber: DeliveryConfirmationNoResponseReminderTouchNumber
): "touch2" | "touch3" {
  return touchNumber === 2 ? "touch2" : "touch3";
}

export function deliveryConfirmationReminderTouchNumberFromDedupeKey(
  dedupeKey: string | null | undefined
): DeliveryConfirmationNoResponseReminderTouchNumber | null {
  if (!dedupeKey) return null;
  if (/:touch_2$/.test(dedupeKey)) return 2;
  if (/:touch_3$/.test(dedupeKey)) return 3;
  return null;
}

export function deliveryConfirmationNoResponseTouchNumberFromDedupeKey(
  dedupeKey: string | null | undefined
): DeliveryConfirmationNoResponseTouchNumber | null {
  if (!dedupeKey) return null;
  if (/:touch_1(?:$|:)/.test(dedupeKey)) return 1;
  return deliveryConfirmationReminderTouchNumberFromDedupeKey(dedupeKey);
}

function emptyRunSummary(params: {
  runDate: string;
  dryRun: boolean;
}): DeliveryConfirmationNoResponseRunSummary {
  return {
    runDate: params.runDate,
    dryRun: params.dryRun,
    weekendSkipped: false,
    orderScope: deliveryOrderScopeReport({
      scope: null,
      unscopedCount: 0,
      scopedCount: 0,
    }),
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
    initialCatchUpEventsCreated: 0,
    initialCatchUpEventsWouldCreate: 0,
    initialCatchUpEventsDeduped: 0,
    initialCatchUpsScheduled: 0,
    reminderEventsCreatedByTouch: {
      touch2: 0,
      touch3: 0,
    },
    reminderEventsWouldCreateByTouch: {
      touch2: 0,
      touch3: 0,
    },
    reminderEventsDedupedByTouch: {
      touch2: 0,
      touch3: 0,
    },
    remindersScheduledByTouch: {
      touch2: 0,
      touch3: 0,
    },
    dispatchableReminderEventIdsCreatedThisRun: [],
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
    internalEscalationEventIdsCreatedThisRun: [],
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
  touchNumber: DeliveryConfirmationNoResponseReminderTouchNumber;
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

export function buildDeliveryConfirmationInitialCatchUpDedupeKey(params: {
  confirmationId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
}) {
  return [
    "delivery_confirmation_initial_catchup",
    params.confirmationId.trim(),
    params.orderType.trim(),
    params.orderNumber.trim(),
    dateKey(params.deliveryDate),
    "touch_1",
  ].join(":");
}

type DeliveryConfirmationNoResponseTouchEventLookup = {
  initialOriginalDedupeKey: string;
  initialCatchUpDedupeKey: string;
  reminder1DedupeKey: string;
  reminder2DedupeKey: string;
};

export type DeliveryConfirmationNoResponseTouchRecord = {
  key: DeliveryConfirmationNoResponseTouchKey;
  touchNumber: DeliveryConfirmationNoResponseTouchNumber;
  eventExists: boolean;
  completed: boolean;
  failed: boolean;
  eventId: string | null;
  eventIds: string[];
  attemptIds: string[];
  strongestStatus: string | null;
  completedAt: Date | null;
  failureReason: string | null;
};

export type DeliveryConfirmationNoResponseTouchHistory = {
  initial: DeliveryConfirmationNoResponseTouchRecord;
  reminder1: DeliveryConfirmationNoResponseTouchRecord;
  reminder2: DeliveryConfirmationNoResponseTouchRecord;
  completedTouchCount: number;
  missingTouches: DeliveryConfirmationNoResponseTouchKey[];
  failedTouches: DeliveryConfirmationNoResponseTouchKey[];
  eventCreatedButUnattempted: DeliveryConfirmationNoResponseTouchKey[];
  summary: string;
};

export type DeliveryConfirmationNoResponseDecision = {
  state: DeliveryConfirmationNoResponseState;
  action: DeliveryConfirmationNoResponseAction;
  reason: string | null;
  touchNumber: DeliveryConfirmationNoResponseTouchNumber | "salesperson_escalation" | null;
  customerAction: DeliveryConfirmationNoResponseCustomerAction | null;
  expectedEventActionType: NotificationActionType | null;
  expectedDedupeKey: string | null;
};

function touchDedupeKeysForCandidate(
  candidate: DeliveryConfirmationNoResponseCandidate
): DeliveryConfirmationNoResponseTouchEventLookup {
  const order = candidate.orderDeliveryGroup.order;
  const deliveryDate = candidate.orderDeliveryGroup.deliveryDate;
  return {
    initialOriginalDedupeKey: buildNotificationDedupeKey({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate,
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    }),
    initialCatchUpDedupeKey: buildDeliveryConfirmationInitialCatchUpDedupeKey({
      confirmationId: candidate.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate,
    }),
    reminder1DedupeKey: buildDeliveryConfirmationReminderDedupeKey({
      confirmationId: candidate.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate,
      touchNumber: 2,
    }),
    reminder2DedupeKey: buildDeliveryConfirmationReminderDedupeKey({
      confirmationId: candidate.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate,
      touchNumber: 3,
    }),
  };
}

async function findNotificationEventByDedupeKey(
  client: DeliveryConfirmationNoResponseClient,
  dedupeKey: string
) {
  if (!client.notificationEvent) return null;
  return client.notificationEvent.findUnique({
    where: { dedupeKey },
    select: notificationEventSelect,
  });
}

function uniqueEvents(events: Array<NotificationEventRecord | null | undefined>) {
  const byId = new Map<string, NotificationEventRecord>();
  for (const event of events) {
    if (!event?.id) continue;
    byId.set(event.id, event);
  }
  return [...byId.values()];
}

function eventMatchesDedupe(event: NotificationEventRecord | null | undefined, dedupeKey: string) {
  return event?.dedupeKey === dedupeKey ? event : null;
}

function completeNotificationEventRecord(
  event: ({ selectedChannel: NotificationChannel | null } & Partial<NotificationEventRecord>) | null | undefined
) {
  if (
    event?.id &&
    event.dedupeKey &&
    event.intervalType &&
    event.actionType &&
    event.status &&
    "recipientEmail" in event &&
    "recipientPhone" in event &&
    "reasonSkipped" in event
  ) {
    return event as NotificationEventRecord;
  }
  return null;
}

function sortedAttempts(attempts: NotificationAttemptForTouch[]) {
  return [...attempts].sort((left, right) => {
    const attemptNumberDiff = left.attemptNumber - right.attemptNumber;
    if (attemptNumberDiff !== 0) return attemptNumberDiff;
    return (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
  });
}

function attemptStatusLabel(attempt: NotificationAttemptForTouch) {
  return [attempt.status, attempt.providerCode].filter(Boolean).join("/") || null;
}

function attemptIsSubmittedOrStronger(attempt: NotificationAttemptForTouch) {
  return (
    attempt.status === NotificationAttemptStatus.SUBMITTED ||
    attempt.status === NotificationAttemptStatus.DELIVERED ||
    attempt.success === true
  );
}

function attemptIsFailedOrUndelivered(attempt: NotificationAttemptForTouch) {
  const providerCode = attempt.providerCode?.trim().toUpperCase();
  return (
    attempt.status === NotificationAttemptStatus.FAILED ||
    providerCode === "FAILED" ||
    providerCode === "UNDELIVERED"
  );
}

function resolveTouchRecord(params: {
  key: DeliveryConfirmationNoResponseTouchKey;
  touchNumber: DeliveryConfirmationNoResponseTouchNumber;
  events: NotificationEventRecord[];
}): DeliveryConfirmationNoResponseTouchRecord {
  const attempts = sortedAttempts(params.events.flatMap((event) => event.attempts ?? []));
  let latestCompletedIndex = -1;
  let completedAt: Date | null = null;
  attempts.forEach((attempt, index) => {
    if (!attemptIsSubmittedOrStronger(attempt)) return;
    latestCompletedIndex = index;
    completedAt = attempt.sentAt ?? attempt.createdAt ?? completedAt;
  });
  const failedAfterCompleted = attempts
    .slice(Math.max(latestCompletedIndex + 1, 0))
    .some(attemptIsFailedOrUndelivered);
  const completed = latestCompletedIndex >= 0 && !failedAfterCompleted;
  const failed =
    !completed &&
    (attempts.some(attemptIsFailedOrUndelivered) ||
      params.events.some((event) => event.status === NotificationEventStatus.FAILED));
  const strongestAttempt =
    attempts.findLast((attempt) => attempt.status === NotificationAttemptStatus.DELIVERED) ??
    attempts.findLast((attempt) => attemptIsSubmittedOrStronger(attempt)) ??
    attempts.at(-1);
  const failedAttempt = attempts.findLast(attemptIsFailedOrUndelivered);
  const failureReason = failed
    ? cleanNotificationText(failedAttempt?.errorMessage) ??
      cleanNotificationText(failedAttempt?.providerCode) ??
      params.events.find((event) => event.reasonSkipped)?.reasonSkipped ??
      "provider_touch_failed"
    : null;

  return {
    key: params.key,
    touchNumber: params.touchNumber,
    eventExists: params.events.length > 0,
    completed,
    failed,
    eventId: params.events.at(-1)?.id ?? null,
    eventIds: params.events.map((event) => event.id),
    attemptIds: attempts.map((attempt) => attempt.id),
    strongestStatus: strongestAttempt ? attemptStatusLabel(strongestAttempt) : null,
    completedAt,
    failureReason,
  };
}

function touchHistorySummary(history: Omit<DeliveryConfirmationNoResponseTouchHistory, "summary">) {
  const describe = (touch: DeliveryConfirmationNoResponseTouchRecord) => {
    if (touch.completed) return `${touch.key}=completed(${touch.strongestStatus ?? "submitted"})`;
    if (touch.failed) return `${touch.key}=failed(${touch.failureReason ?? "provider_failed"})`;
    if (touch.eventExists) return `${touch.key}=event_unattempted`;
    return `${touch.key}=missing`;
  };
  return [history.initial, history.reminder1, history.reminder2].map(describe).join("; ");
}

export async function resolveDeliveryConfirmationTouchHistory(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
}): Promise<DeliveryConfirmationNoResponseTouchHistory> {
  const keys = touchDedupeKeysForCandidate(params.candidate);
  const [initialOriginalEvent, initialCatchUpEvent, reminder1Event, reminder2Event] =
    await Promise.all([
      findNotificationEventByDedupeKey(params.client, keys.initialOriginalDedupeKey),
      findNotificationEventByDedupeKey(params.client, keys.initialCatchUpDedupeKey),
      findNotificationEventByDedupeKey(params.client, keys.reminder1DedupeKey),
      findNotificationEventByDedupeKey(params.client, keys.reminder2DedupeKey),
    ]);
  const linkedEvent = completeNotificationEventRecord(params.candidate.notificationEvent);
  const initial = resolveTouchRecord({
    key: "initial",
    touchNumber: 1,
    events: uniqueEvents([
      eventMatchesDedupe(linkedEvent, keys.initialOriginalDedupeKey),
      eventMatchesDedupe(linkedEvent, keys.initialCatchUpDedupeKey),
      initialOriginalEvent,
      initialCatchUpEvent,
    ]),
  });
  const reminder1 = resolveTouchRecord({
    key: "reminder1",
    touchNumber: 2,
    events: uniqueEvents([eventMatchesDedupe(linkedEvent, keys.reminder1DedupeKey), reminder1Event]),
  });
  const reminder2 = resolveTouchRecord({
    key: "reminder2",
    touchNumber: 3,
    events: uniqueEvents([eventMatchesDedupe(linkedEvent, keys.reminder2DedupeKey), reminder2Event]),
  });
  const records = [initial, reminder1, reminder2];
  const withoutSummary = {
    initial,
    reminder1,
    reminder2,
    completedTouchCount: records.filter((touch) => touch.completed).length,
    missingTouches: records
      .filter((touch) => !touch.eventExists)
      .map((touch) => touch.key),
    failedTouches: records
      .filter((touch) => touch.failed)
      .map((touch) => touch.key),
    eventCreatedButUnattempted: records
      .filter((touch) => touch.eventExists && touch.attemptIds.length === 0)
      .map((touch) => touch.key),
  };

  return {
    ...withoutSummary,
    summary: touchHistorySummary(withoutSummary),
  };
}

function deliveryIntervalDay(runDate: string, deliveryDate: Date | string) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(
    (dateFromKey(dateKey(deliveryDate)).getTime() - dateFromKey(runDate).getTime()) / msPerDay
  );
}

function stateFromTouchHistory(
  candidate: DeliveryConfirmationNoResponseCandidate,
  history: DeliveryConfirmationNoResponseTouchHistory
): DeliveryConfirmationNoResponseState {
  if (!isNoCustomerResponseStatus(candidate.status) || candidate.confirmedAt) return "CONFIRMED";
  if (candidate.requestedNewDate) return "REQUESTED_NEW_DATE";
  if (candidate.manualReviewRequired || candidate.noResponseAt) return "MANUAL_REVIEW";
  if (dateKey(candidate.orderDeliveryGroup.deliveryDate) !== dateKey(candidate.deliveryDate)) {
    return "STALE_DATE";
  }
  if (history.reminder2.completed) return "REMINDER_2_SENT";
  if (history.reminder1.completed) return "REMINDER_1_SENT";
  if (history.initial.completed) return "INITIAL_SENT";
  if (history.initial.eventExists) return "INITIAL_PENDING";
  return "NO_CONFIRMATION";
}

function stopReasonToDecision(
  reason: DeliveryConfirmationNoResponseSkipReason
): DeliveryConfirmationNoResponseAction {
  if (reason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.customerAlreadyResponded) {
    return "SKIP_CONFIRMED";
  }
  if (reason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.alreadyConfirmedInAcumatica) {
    return "SKIP_ACUMATICA_CONFIRMED";
  }
  if (
    reason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.staleDeliveryDate ||
    reason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.inactiveDeliveryGroup ||
    reason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.orderNotActive
  ) {
    return "SKIP_STALE";
  }
  if (reason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.manualReviewAlreadyRequired) {
    return "SKIP_MANUAL_REVIEW";
  }
  if (reason === DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.noAutomatedChannelAvailable) {
    return "SKIP_NO_CHANNEL";
  }
  return "SKIP_TOO_EARLY";
}

function initialTouchIncompleteReason(history: DeliveryConfirmationNoResponseTouchHistory) {
  if (history.initial.failed) return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.touchProviderFailed;
  if (history.initial.eventExists) return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.touchEventUnattempted;
  return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.initialTouchMissing;
}

function reminderTouchIncompleteReason(history: DeliveryConfirmationNoResponseTouchHistory) {
  if (history.failedTouches.length > 0) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.touchProviderFailed;
  }
  if (history.eventCreatedButUnattempted.length > 0) {
    return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.touchEventUnattempted;
  }
  return DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.incompleteTouchSequenceDueToCatchup;
}

function expectedCustomerEventForAction(params: {
  candidate: DeliveryConfirmationNoResponseCandidate;
  action: DeliveryConfirmationNoResponseCustomerAction;
}): {
  actionType: NotificationActionType;
  touchNumber: DeliveryConfirmationNoResponseTouchNumber;
  dedupeKey: string;
} {
  const order = params.candidate.orderDeliveryGroup.order;
  const deliveryDate = params.candidate.orderDeliveryGroup.deliveryDate;
  if (params.action === "SEND_INITIAL_CATCH_UP") {
    return {
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
      touchNumber: 1 as const,
      dedupeKey: buildDeliveryConfirmationInitialCatchUpDedupeKey({
        confirmationId: params.candidate.id,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryDate,
      }),
    };
  }

  const touchNumber: DeliveryConfirmationNoResponseReminderTouchNumber =
    params.action === "SEND_REMINDER_1" ? 2 : 3;
  return {
    actionType: NotificationActionType.DELIVERY_CONFIRMATION_REMINDER,
    touchNumber,
    dedupeKey: buildDeliveryConfirmationReminderDedupeKey({
      confirmationId: params.candidate.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate,
      touchNumber,
    }),
  };
}

export function chooseDeliveryConfirmationNoResponseAction(params: {
  runDate: Date | string;
  candidate: DeliveryConfirmationNoResponseCandidate;
  touchHistory: DeliveryConfirmationNoResponseTouchHistory;
}): DeliveryConfirmationNoResponseDecision {
  const runDate = dateKey(params.runDate);
  const stopReason = candidateStopReason(params.candidate, runDate);
  if (stopReason) {
    const state = stateFromTouchHistory(params.candidate, params.touchHistory);
    const action =
      state === "REQUESTED_NEW_DATE"
        ? "SKIP_REQUESTED_NEW_DATE"
        : stopReasonToDecision(stopReason);
    return {
      state,
      action,
      reason: stopReason,
      touchNumber: null,
      customerAction: null,
      expectedEventActionType: null,
      expectedDedupeKey: null,
    };
  }

  const state = stateFromTouchHistory(params.candidate, params.touchHistory);
  const intervalDay = deliveryIntervalDay(runDate, params.candidate.deliveryDate);

  let customerAction: DeliveryConfirmationNoResponseCustomerAction | null = null;
  let action: DeliveryConfirmationNoResponseAction = "SKIP_TOO_EARLY";
  let reason: string | null = null;

  if (intervalDay === 41 || intervalDay === 40) {
    if (!params.touchHistory.initial.completed) {
      customerAction = "SEND_INITIAL_CATCH_UP";
      action = customerAction;
      reason = initialTouchIncompleteReason(params.touchHistory);
    } else if (!params.touchHistory.reminder1.completed) {
      customerAction = "SEND_REMINDER_1";
      action = customerAction;
      reason = reminderTouchIncompleteReason(params.touchHistory);
    } else if (intervalDay === 40 && !params.touchHistory.reminder2.completed) {
      customerAction = "SEND_REMINDER_2";
      action = customerAction;
      reason = reminderTouchIncompleteReason(params.touchHistory);
    } else {
      action = "SKIP_TOO_EARLY";
      reason = "waiting_for_39_day_no_response_checkpoint";
    }
  } else if (intervalDay === 39) {
    if (params.touchHistory.completedTouchCount >= DELIVERY_CONFIRMATION_MAX_TOTAL_CUSTOMER_TOUCHES) {
      action = "ESCALATE_NO_RESPONSE";
      reason = "Customer did not respond after 3 total 42-day confirmation touches.";
    } else {
      action = "ESCALATE_INCOMPLETE_TOUCH_SEQUENCE";
      reason = [
        DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.incompleteTouchSequenceDueToCatchup,
        params.touchHistory.summary,
      ].join(": ");
    }
  } else {
    action = "SKIP_TOO_EARLY";
    reason = `delivery_interval_day_${intervalDay}_outside_41_40_39_no_response_window`;
  }

  const expected = customerAction
    ? expectedCustomerEventForAction({ candidate: params.candidate, action: customerAction })
    : null;

  return {
    state,
    action,
    reason,
    touchNumber: expected?.touchNumber ?? (action.startsWith("ESCALATE") ? "salesperson_escalation" : null),
    customerAction,
    expectedEventActionType: expected?.actionType ?? null,
    expectedDedupeKey: expected?.dedupeKey ?? null,
  };
}

export type DeliveryConfirmationNoResponseDispatchGuardEvent = {
  id: string;
  dedupeKey: string;
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
  deliveryGroupId: string;
  deliveryDate: Date;
};

export function isDeliveryConfirmationNoResponseManagedEvent(
  event: Pick<
    DeliveryConfirmationNoResponseDispatchGuardEvent,
    "dedupeKey" | "intervalType" | "actionType"
  >
) {
  return (
    event.intervalType === NotificationIntervalType.DAY_42 &&
    (event.dedupeKey.startsWith("delivery_confirmation_reminder:") ||
      event.dedupeKey.startsWith("delivery_confirmation_initial_catchup:")) &&
    (event.actionType === NotificationActionType.DELIVERY_CONFIRMATION_REMINDER ||
      event.actionType === NotificationActionType.DELIVERY_CONFIRMATION_REQUEST)
  );
}

export async function guardDeliveryConfirmationNoResponseDispatch(params: {
  client: DeliveryConfirmationNoResponseClient;
  event: DeliveryConfirmationNoResponseDispatchGuardEvent;
  now?: Date;
}) {
  if (!isDeliveryConfirmationNoResponseManagedEvent(params.event)) {
    return { ok: true as const, reason: null, decision: null };
  }

  if (!params.client.deliveryConfirmation.findUnique) {
    return {
      ok: false as const,
      reason: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.dispatchGuardConfirmationMismatch,
      decision: null,
    };
  }

  const candidate = (await params.client.deliveryConfirmation.findUnique({
    where: {
      deliveryGroupId_deliveryDate: {
        deliveryGroupId: params.event.deliveryGroupId,
        deliveryDate: params.event.deliveryDate,
      },
    },
    select: deliveryConfirmationNoResponseSelect,
  })) as DeliveryConfirmationNoResponseCandidate | null;

  if (!candidate || candidate.notificationEventId !== params.event.id) {
    return {
      ok: false as const,
      reason: DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.dispatchGuardConfirmationMismatch,
      decision: null,
    };
  }

  const touchHistory = await resolveDeliveryConfirmationTouchHistory({
    client: params.client,
    candidate,
  });
  const decision = chooseDeliveryConfirmationNoResponseAction({
    runDate: params.now ?? new Date(),
    candidate,
    touchHistory,
  });

  if (
    !decision.customerAction ||
    decision.expectedDedupeKey !== params.event.dedupeKey ||
    decision.expectedEventActionType !== params.event.actionType
  ) {
    return {
      ok: false as const,
      reason: decision.reason ?? DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.noResponseActionMismatch,
      decision,
    };
  }

  return { ok: true as const, reason: null, decision };
}

function reportTouchForCandidate(
  runDate: string,
  candidate: DeliveryConfirmationNoResponseCandidate,
  decision: DeliveryConfirmationNoResponseDecision
): DeliveryConfirmationNoResponseTouchNumber | "salesperson_escalation" {
  if (decision.touchNumber) return decision.touchNumber;
  return deliveryIntervalDay(runDate, candidate.deliveryDate) === 39 ? "salesperson_escalation" : 2;
}

function eventHasAttempts(event: NotificationEventRecord | null | undefined) {
  return (event?.attempts ?? []).length > 0;
}

function customerActionTouchSummaryKey(action: DeliveryConfirmationNoResponseCustomerAction) {
  if (action === "SEND_REMINDER_1") return "touch2" as const;
  if (action === "SEND_REMINDER_2") return "touch3" as const;
  return null;
}

function renderCustomerTouchMessages(params: {
  candidate: DeliveryConfirmationNoResponseCandidate;
  action: DeliveryConfirmationNoResponseCustomerAction;
  link: string;
  salespersonContact: SalespersonContactInput | null;
}) {
  const order = params.candidate.orderDeliveryGroup.order;
  const deliveryGroup = params.candidate.orderDeliveryGroup;
  if (params.action === "SEND_INITIAL_CATCH_UP") {
    const jobName = formatJobName({
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
    });
    const jobAddress = order.address ? formatJobAddress(order.address) : null;
    const smsMessage = render42DaySmsConfirmationMessage({
      orderNumber: order.orderNumber,
      contactName: contactNameForCandidate(params.candidate),
      buyerGroup: order.buyerGroup,
      jobName,
      deliveryDate: deliveryGroup.deliveryDate,
      link: params.link,
      deliveryAddress: order.address,
    });
    const emailMessage = render42DayEmailConfirmationMessage({
      orderNumber: order.orderNumber,
      contactName: contactNameForCandidate(params.candidate),
      buyerGroup: order.buyerGroup,
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
      jobName,
      jobAddress,
      deliveryDate: deliveryGroup.deliveryDate,
      link: params.link,
      paymentReminderApplies: false,
      amountDueNowRounded: null,
      salespersonContact: params.salespersonContact,
    });
    return { smsMessage, emailMessage };
  }

  const touchNumber = params.action === "SEND_REMINDER_1" ? 2 : 3;
  return {
    smsMessage: render42DaySmsConfirmationReminderMessage({
      orderNumber: order.orderNumber,
      deliveryDate: deliveryGroup.deliveryDate,
      link: params.link,
      deliveryAddress: order.address,
      touchNumber,
    }),
    emailMessage: render42DayEmailConfirmationReminderMessage({
      orderNumber: order.orderNumber,
      contactName: contactNameForCandidate(params.candidate),
      deliveryDate: deliveryGroup.deliveryDate,
      link: params.link,
      touchNumber,
    }),
  };
}

async function updateConfirmationAfterCustomerTouch(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  eventId: string | null;
  followUpCountAfter: number;
  now: Date;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  await params.client.deliveryConfirmation.update({
    where: { id: params.candidate.id },
    data: {
      notificationEventId: params.eventId ?? params.candidate.notificationEventId,
      confirmationFollowUpCount: Math.max(
        params.candidate.confirmationFollowUpCount,
        params.followUpCountAfter
      ),
      reminderSentAt: params.now,
    },
    select: { id: true },
  });
  params.candidate.notificationEventId = params.eventId ?? params.candidate.notificationEventId;
  params.candidate.confirmationFollowUpCount = Math.max(
    params.candidate.confirmationFollowUpCount,
    params.followUpCountAfter
  );
  params.candidate.reminderSentAt = params.now;
  params.summary.confirmationsUpdatedAfterReminder += 1;
}

async function createOrReuseCustomerTouchEvent(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  decision: DeliveryConfirmationNoResponseDecision;
  activeOptOutAddresses: ActiveNotificationOptOutAddresses;
  salespersonContact: SalespersonContactInput | null;
  runDate: string;
  now: Date;
  dryRun: boolean;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  if (!params.decision.customerAction || !params.decision.expectedDedupeKey || !params.decision.expectedEventActionType) {
    throw new Error("state_machine_customer_action_missing_event_metadata");
  }

  const candidate = params.candidate;
  const deliveryGroup = candidate.orderDeliveryGroup;
  const order = deliveryGroup.order;
  const touchNumber = params.decision.touchNumber as DeliveryConfirmationNoResponseTouchNumber;
  const reminderTouchKey = customerActionTouchSummaryKey(params.decision.customerAction);
  const followUpCountAfter =
    params.decision.customerAction === "SEND_INITIAL_CATCH_UP" ? 0 : touchNumber - 1;
  const link = buildDeliveryConfirmationLink(candidate.linkToken as string);
  const channel = selectCandidateChannel(candidate, params.activeOptOutAddresses);
  const noChannel = channel.selectedChannel === null;
  const messages = renderCustomerTouchMessages({
    candidate,
    action: params.decision.customerAction,
    link,
    salespersonContact: params.salespersonContact,
  });
  const subject = channel.selectedChannel === "EMAIL" ? messages.emailMessage.subject : null;
  const renderedMessagePreview =
    channel.selectedChannel === "EMAIL"
      ? messages.emailMessage.body
      : noChannel
        ? channel.channelReason
        : messages.smsMessage;

  validateRenderedMessage({
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    subject,
    renderedMessagePreview,
  });

  let event: NotificationEventRecord | null = null;
  const existingEvent = params.client.notificationEvent
    ? await params.client.notificationEvent.findUnique({
        where: { dedupeKey: params.decision.expectedDedupeKey },
        select: notificationEventSelect,
      })
    : null;

  if (existingEvent) {
    if (params.decision.customerAction === "SEND_INITIAL_CATCH_UP") {
      params.summary.initialCatchUpEventsDeduped += 1;
    } else {
      params.summary.reminderEventsDeduped += 1;
      if (reminderTouchKey) params.summary.reminderEventsDedupedByTouch[reminderTouchKey] += 1;
    }
    event = existingEvent;
  } else if (params.dryRun) {
    if (params.decision.customerAction === "SEND_INITIAL_CATCH_UP") {
      params.summary.initialCatchUpEventsWouldCreate += 1;
    } else {
      params.summary.reminderEventsWouldCreate += 1;
      if (reminderTouchKey) params.summary.reminderEventsWouldCreateByTouch[reminderTouchKey] += 1;
    }
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
        actionType: params.decision.expectedEventActionType,
        dedupeKey: params.decision.expectedDedupeKey,
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
    if (params.decision.customerAction === "SEND_INITIAL_CATCH_UP") {
      params.summary.initialCatchUpEventsCreated += 1;
    } else {
      params.summary.reminderEventsCreated += 1;
      if (reminderTouchKey) params.summary.reminderEventsCreatedByTouch[reminderTouchKey] += 1;
    }
  }

  const dispatchable =
    !noChannel &&
    event?.status === NotificationEventStatus.SCHEDULED &&
    !eventHasAttempts(event);
  if (dispatchable && event?.id && !params.summary.dispatchableReminderEventIdsCreatedThisRun.includes(event.id)) {
    params.summary.dispatchableReminderEventIdsCreatedThisRun.push(event.id);
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
      salespersonContact: params.salespersonContact,
      runDate: params.runDate,
      now: params.now,
      dryRun: params.dryRun,
      reason: `No eligible customer SMS/email channel was available for action ${params.decision.action}.`,
      summary: params.summary,
    });
  } else {
    params.summary.remindersScheduled += 1;
    if (params.decision.customerAction === "SEND_INITIAL_CATCH_UP") {
      params.summary.initialCatchUpsScheduled += 1;
    } else if (reminderTouchKey) {
      params.summary.remindersScheduledByTouch[reminderTouchKey] += 1;
    }
    const scheduledChannel = selectedChannelCountsKey(channel.selectedChannel);
    if (scheduledChannel) params.summary.remindersScheduledByChannel[scheduledChannel] += 1;
    if (!params.dryRun) {
      await updateConfirmationAfterCustomerTouch({
        client: params.client,
        candidate,
        eventId: event?.id ?? null,
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
    touchNumber,
    eventId: event?.id ?? null,
    internalEventId: null,
    dedupeKey: params.decision.expectedDedupeKey,
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

async function findNoResponseLifecycleCandidates(params: {
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
    },
    orderBy: [{ deliveryDate: "asc" }, { orderNumber: "asc" }, { id: "asc" }],
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
  salespersonNumber?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  orderType: string;
  orderNumber: string;
  jobName?: string | null;
  jobAddress?: string | null;
  deliveryDate: Date | string;
  confirmationLink: string;
  currentStatus: string;
  reason: string;
  touchHistorySummary?: string | null;
  messageSummaryOverride?: string | null;
}) {
  const salespersonName = cleanNotificationText(params.salespersonName) ?? "there";
  const salespersonNumber = cleanNotificationText(params.salespersonNumber);
  const customerEmail = cleanNotificationText(params.customerEmail);
  const customerPhone = cleanNotificationText(params.customerPhone);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const customerContact = [customerEmail, customerPhone].filter(Boolean).join(" / ") || "not available";
  const jobName = cleanNotificationText(params.jobName) ?? "not available";
  const jobAddress = cleanNotificationText(params.jobAddress) ?? "not available";
  const salespersonLine = salespersonNumber
    ? `${salespersonName} (${salespersonNumber})`
    : salespersonName;
  const messageSummary =
    cleanNotificationText(params.messageSummaryOverride) ??
    "Customer did not respond after 3 total 42-day delivery confirmation touches.";
  const subject = `No response: Delivery confirmation for Order ${params.orderNumber}`;
  const body = [
    `Hello ${salespersonName},`,
    "",
    messageSummary,
    "",
    `Order: ${params.orderType} ${params.orderNumber}`,
    `Delivery date: ${deliveryDate}`,
    `Job: ${jobName}`,
    `Delivery address: ${jobAddress}`,
    `Customer: ${params.customerName}`,
    `Customer contact: ${customerContact}`,
    `Salesperson: ${salespersonLine}`,
    params.touchHistorySummary
      ? `Touch history: ${params.touchHistorySummary}`
      : "Touches sent: initial 6-week confirmation request, first reminder, and final reminder.",
    `Current confirmation status: ${params.currentStatus}`,
    `Reason: ${params.reason}`,
    "",
    "Recommended action: contact the customer manually to confirm delivery or update the delivery date.",
    "No Acumatica writeback, one-week confirmation update, or hold was placed for this no-response escalation.",
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
  touchHistory?: DeliveryConfirmationNoResponseTouchHistory | null;
  incompleteTouchSequence?: boolean;
  summary: DeliveryConfirmationNoResponseRunSummary;
}) {
  const candidate = params.candidate;
  const deliveryGroup = candidate.orderDeliveryGroup;
  const order = deliveryGroup.order;
  const recipient = resolveInternalRecipient(params.salespersonContact);
  const confirmationLink = candidate.linkToken ? buildDeliveryConfirmationLink(candidate.linkToken) : "";
  const rendered = render42DayNoResponseSalespersonEmail({
    salespersonName: params.salespersonContact?.salespersonName,
    salespersonNumber: order.salespersonNumber,
    customerName: contactNameForCandidate(candidate),
    customerEmail: order.contact.email,
    customerPhone: customerPhoneForCandidate(candidate),
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    jobName: formatJobName({
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
    }),
    jobAddress: order.address ? formatJobAddress(order.address) : null,
    deliveryDate: deliveryGroup.deliveryDate,
    confirmationLink,
    currentStatus: candidate.status,
    reason: params.reason,
    touchHistorySummary: params.touchHistory?.summary,
    messageSummaryOverride: params.incompleteTouchSequence
      ? "Customer reached the 39-day checkpoint before the full confirmation touch sequence completed."
      : null,
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
    if (internalEvent?.id) {
      params.summary.internalEscalationEventIdsCreatedThisRun.push(internalEvent.id);
    }
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
        params.incompleteTouchSequence
          ? `39-day checkpoint: incomplete 42-day confirmation touch sequence. ${params.touchHistory?.summary ?? ""}`.trim()
          : "39-day checkpoint: customer did not respond after 3 total 42-day confirmation touches.",
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

async function processStateMachineCandidate(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
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
  const plannedIntervalDay = deliveryIntervalDay(params.runDate, candidate.deliveryDate);
  if (plannedIntervalDay === 39) {
    params.summary.escalationCandidatesChecked += 1;
  } else {
    params.summary.reminderCandidatesChecked += 1;
  }

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
      touchNumber: "salesperson_escalation",
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
  const touchHistory = await resolveDeliveryConfirmationTouchHistory({
    client: params.client,
    candidate,
  });
  const decision = chooseDeliveryConfirmationNoResponseAction({
    runDate: params.runDate,
    candidate,
    touchHistory,
  });

  if (decision.customerAction) {
    if (decision.customerAction === "SEND_REMINDER_1") {
      params.summary.reminderCandidateCounts.touch2 += 1;
    } else if (decision.customerAction === "SEND_REMINDER_2") {
      params.summary.reminderCandidateCounts.touch3 += 1;
    }
    await createOrReuseCustomerTouchEvent({
      client: params.client,
      candidate,
      decision,
      activeOptOutAddresses: params.activeOptOutAddresses,
      salespersonContact: params.salespersonContact,
      runDate: params.runDate,
      now: params.now,
      dryRun: params.dryRun,
      summary: params.summary,
    });
    return;
  }

  if (
    decision.action === "ESCALATE_NO_RESPONSE" ||
    decision.action === "ESCALATE_INCOMPLETE_TOUCH_SEQUENCE"
  ) {
    params.summary.escalationCandidateCount += 1;
    await createOrReuseSalespersonEscalation({
      client: params.client,
      candidate,
      salespersonContact: await loadSalespersonContactForCandidate(candidate, params.client),
      runDate: params.runDate,
      now: params.now,
      dryRun: params.dryRun,
      reason: decision.reason ?? DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.incompleteTouchSequenceDueToCatchup,
      touchHistory,
      incompleteTouchSequence: decision.action === "ESCALATE_INCOMPLETE_TOUCH_SEQUENCE",
      summary: params.summary,
    });
    return;
  }

  const reason =
    decision.reason ??
    DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.noResponseActionMismatch;
  addSkippedReason(params.summary, reason);
  await applyStopSideEffect({
    client: params.client,
    candidate,
    stopReason: reason as DeliveryConfirmationNoResponseSkipReason,
    now: params.now,
    dryRun: params.dryRun,
    summary: params.summary,
  });
  params.summary.eventReports.push({
    confirmationId: candidate.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: dateKey(candidate.deliveryDate),
    touchNumber: reportTouchForCandidate(params.runDate, candidate, decision),
    eventId: null,
    internalEventId: null,
    dedupeKey: decision.expectedDedupeKey,
    status: NotificationEventStatus.SKIPPED,
    selectedChannel: null,
    reasonSkipped: reason,
    subject: null,
    renderedMessagePreview: `${decision.action}: ${touchHistory.summary}`,
    confirmationFollowUpCountAfter: candidate.confirmationFollowUpCount,
    manualReviewRequiredAfter: candidate.manualReviewRequired,
  });
}

// Retained for old dry-run tooling; production run42DayDeliveryConfirmationNoResponse uses processStateMachineCandidate.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function processReminderCandidate(params: {
  client: DeliveryConfirmationNoResponseClient;
  candidate: DeliveryConfirmationNoResponseCandidate;
  schedule: LegacyReminderSchedule;
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
  const touchKey = touchSummaryKey(params.schedule.touchNumber);

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
    touchNumber: params.schedule.touchNumber,
  });
  const emailMessage = render42DayEmailConfirmationReminderMessage({
    orderNumber: order.orderNumber,
    contactName: contactNameForCandidate(candidate),
    deliveryDate: deliveryGroup.deliveryDate,
    link,
    touchNumber: params.schedule.touchNumber,
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
    params.summary.reminderEventsDedupedByTouch[touchKey] += 1;
    event = existingEvent;
  } else if (params.dryRun) {
    params.summary.reminderEventsWouldCreate += 1;
    params.summary.reminderEventsWouldCreateByTouch[touchKey] += 1;
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
    params.summary.reminderEventsCreatedByTouch[touchKey] += 1;
    if (!noChannel && event.id) {
      params.summary.dispatchableReminderEventIdsCreatedThisRun.push(event.id);
    }
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
    params.summary.remindersScheduledByTouch[touchKey] += 1;
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

// Retained for old dry-run tooling; production run42DayDeliveryConfirmationNoResponse uses processStateMachineCandidate.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    orderScope?: DeliveryOrderScope | null;
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
  const allCandidates = await findNoResponseLifecycleCandidates({
    client,
    deliveryDateFrom: addDays(runDate, 39),
    deliveryDateTo: addDays(runDate, 41),
  });
  const scopedCandidates = filterByDeliveryOrderScope(allCandidates, params.orderScope);
  summary.orderScope = deliveryOrderScopeReport({
    scope: params.orderScope,
    unscopedCount: allCandidates.length,
    scopedCount: scopedCandidates.length,
  });
  const salespersonContactsByNumber = await loadSalespersonContactsForCandidates(
    scopedCandidates,
    client
  );

  for (const candidate of scopedCandidates) {
    const salespersonNumber = salespersonNumberForCandidate(candidate);
    await processStateMachineCandidate({
      client,
      candidate,
      activeOptOutAddresses,
      salespersonContact: salespersonNumber ? salespersonContactsByNumber.get(salespersonNumber) ?? null : null,
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
