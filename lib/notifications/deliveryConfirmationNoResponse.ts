import { DeliveryConfirmationStatus, type NotificationChannel } from "@/lib/generated/prisma/client";
import { DELIVERY_MANUAL_REVIEW_REASONS } from "@/lib/notifications/deliveryConfirmationManualReview";
import {
  addDays,
  dateFromKey,
  dateKey,
  shouldSkipNotificationRunForWeekend,
} from "@/lib/notifications/helpers";
import { prisma } from "@/lib/prisma";

type DeliveryConfirmationNoResponseClient = Pick<typeof prisma, "deliveryConfirmation">;

const NO_CUSTOMER_RESPONSE_STATUSES = [
  DeliveryConfirmationStatus.PENDING,
  DeliveryConfirmationStatus.UNRECOGNIZED,
  DeliveryConfirmationStatus.INCOMPLETE,
] as const;

const AWAITING_NEW_DATE_STATUSES = [
  DeliveryConfirmationStatus.AWAITING_NEW_DATE,
  DeliveryConfirmationStatus.CHANGE_REQUESTED,
] as const;

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

function countSelectedChannels(
  candidates: Array<{ notificationEvent?: { selectedChannel: NotificationChannel | null } | null }>
) {
  const counts = emptySelectedChannelCounts();
  for (const candidate of candidates) {
    counts[selectedChannelBucket(candidate.notificationEvent?.selectedChannel)] += 1;
  }
  return counts;
}

async function findFollowUpCandidates(params: {
  client: DeliveryConfirmationNoResponseClient;
  deliveryDate: Date;
  statuses: readonly DeliveryConfirmationStatus[];
  maxConfirmationFollowUpCountBeforeRun: number;
}) {
  return params.client.deliveryConfirmation.findMany({
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
      reason: "weekend_skip_no_shift",
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

export async function planDeliveryConfirmationNoResponseWork(params: {
  runDate?: Date | string;
  prismaClient?: DeliveryConfirmationNoResponseClient;
} = {}): Promise<DeliveryConfirmationNoResponsePlan> {
  const client = params.prismaClient ?? prisma;
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

export async function mark39DayNoResponseManualReview(params: {
  runDate?: Date | string;
  prismaClient?: DeliveryConfirmationNoResponseClient;
  now?: Date;
}) {
  const client = params.prismaClient ?? prisma;
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
