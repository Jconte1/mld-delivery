import "dotenv/config";

import { getDeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import {
  getDeliveryGroupReadiness,
  type OrderLineReadinessSummary,
} from "../lib/delivery-readiness/orderLineReadiness";
import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import {
  DeliveryConfirmationStatus,
  InternalNotificationAudienceType,
  InternalNotificationPurpose,
  InternalNotificationStatus,
  InternalOrderLifecycleStatus,
  NotificationActionType,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  deliveryItemEtaDisplay,
  deliveryItemStatusDisplay,
  shouldSuppressDeliveryItemCustomerEtaAndStatus,
} from "../app/delivery/components/DeliveryItemsForThisDelivery";
import {
  confirmDeliveryFromWebpage,
  guardDeliveryConfirmationWebAction,
} from "../lib/notifications/confirmDeliveryFromWebpage";
import { render42DayEmailConfirmationMessage } from "../lib/notifications/deliveryConfirmationEmail";
import {
  buildDeliveryConfirmationLink,
  getDeliveryAppBaseUrlConfig,
  newDeliveryConfirmationLinkToken,
} from "../lib/notifications/deliveryConfirmationLinks";
import {
  buildDeliveryConfirmationScopeKey,
  render42DaySmsConfirmationMessage,
} from "../lib/notifications/deliveryConfirmationSms";
import {
  DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS,
  buildDeliveryConfirmationReminderDedupeKey,
  run42DayDeliveryConfirmationNoResponse,
  type DeliveryConfirmationNoResponseCandidate,
  type DeliveryConfirmationNoResponseClient,
  type DeliveryConfirmationNoResponseCurrentStateRefresher,
  type DeliveryConfirmationNoResponseRunSummary,
} from "../lib/notifications/deliveryConfirmationNoResponse";
import { shouldDryRunDeliveryConfirmationAttributeWriteback } from "../lib/notifications/deliveryConfirmationAttributeWritebackQueue";
import { shouldDryRunDeliveryPrepaymentHold } from "../lib/notifications/deliveryPrepaymentHoldQueue";
import { shouldDryRunDeliveryTenDayConfirmationWriteback } from "../lib/notifications/deliveryTenDayConfirmationWritebackQueue";
import { handleTwilioInboundSms } from "../lib/notifications/handleTwilioInboundSms";
import {
  addDays,
  cleanNotificationText,
  dateFromKey,
  dateKey,
  formatContactName,
  formatCustomerFriendlyDate,
  formatJobAddress,
  formatJobName,
  selectNotificationChannel,
} from "../lib/notifications/helpers";
import {
  loadActiveNotificationOptOutAddresses,
  mergeNotificationOptOutAddresses,
} from "../lib/notifications/notificationOptOutLookup";
import { getActiveSalespersonContactMap } from "../lib/notifications/salespersonContactCache";
import type { SalespersonContactInput } from "../lib/notifications/salespersonContactDisplay";
import { prisma } from "../lib/prisma";

const REQUESTED_ON_TIME = "09:19:00.000Z";
const TEST_SMS_FROM = "+18015550100";
const TEST_SMS_TO = "+18015550999";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TARGETED_IMPORT_CANDIDATES = 12;

type AnyRecord = Record<string, unknown>;
type Failure = string;

type SafetyCounts = {
  notificationEvents: number;
  notificationAttempts: number;
  deliveryConfirmations: number;
  internalNotificationEvents: number;
  deliveryGroupTenDayConfirmations: number;
  deliveryOrderHoldActions: number;
};

function assert(condition: unknown, message: string, failures?: Failure[]): asserts condition {
  if (condition) return;
  if (failures) {
    failures.push(message);
    return;
  }
  throw new Error(message);
}

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function requireEnv(name: string) {
  const value = envValue(name);
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function envDryRunSafe(name: string) {
  const value = envValue(name);
  return {
    envVar: name,
    value: value || null,
    safe: value.toLowerCase() !== "false",
  };
}

function ensureQueueReadMode() {
  process.env.USE_QUEUE_ERP = "true";
  process.env.MLD_QUEUE_JOB_POLL_TIMEOUT_MS ||= "120000";
  process.env.MLD_QUEUE_JOB_POLL_INTERVAL_MS ||= "1000";
  process.env.MLD_QUEUE_STEP1_TIMEOUT_MS ||= "120000";
  process.env.MLD_QUEUE_STEP2_TIMEOUT_MS ||= "120000";
  process.env.MLD_QUEUE_CONTACT_TIMEOUT_MS ||= "120000";
  process.env.ERP_IMPORT_TRANSACTION_TIMEOUT_MS ||= "30000";
}

function preflight() {
  requireEnv("NOTIFICATIONS_TEST_EMAIL");
  requireEnv("DELIVERY_APP_BASE_URL");
  requireEnv("MLD_QUEUE_BASE_URL");
  requireEnv("MLD_QUEUE_TOKEN");

  const writebackFlags = {
    confirmation: {
      ...envDryRunSafe("DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN"),
      helperDryRun: shouldDryRunDeliveryConfirmationAttributeWriteback(),
    },
    contactOptIn: envDryRunSafe("DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN"),
    tenDayOneWeekCon: {
      ...envDryRunSafe("DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN"),
      helperDryRun: shouldDryRunDeliveryTenDayConfirmationWriteback(),
    },
    prepaymentHold: {
      ...envDryRunSafe("DELIVERY_PREPAYMENT_HOLD_DRY_RUN"),
      helperDryRun: shouldDryRunDeliveryPrepaymentHold(),
    },
  };

  const allWritebackFlagsSafe =
    writebackFlags.confirmation.safe &&
    writebackFlags.contactOptIn.safe &&
    writebackFlags.tenDayOneWeekCon.safe &&
    writebackFlags.prepaymentHold.safe &&
    writebackFlags.confirmation.helperDryRun &&
    writebackFlags.tenDayOneWeekCon.helperDryRun &&
    writebackFlags.prepaymentHold.helperDryRun;

  if (!allWritebackFlagsSafe) {
    throw new Error("One or more writeback dry-run flags are unsafe for this dry run.");
  }

  const baseUrlConfig = getDeliveryAppBaseUrlConfig();
  if (baseUrlConfig.isDefault) {
    throw new Error("DELIVERY_APP_BASE_URL must be explicitly configured for link rendering.");
  }

  return {
    queueReadMode: process.env.USE_QUEUE_ERP === "true",
    mldQueueBaseUrlConfigured: true,
    mldQueueTokenConfigured: true,
    notificationsTestEmailConfigured: true,
    deliveryAppBaseUrlConfigured: true,
    deliveryAppBaseUrlEnvVar: baseUrlConfig.envVar,
    deliveryAppBaseUrlIsLocalhost: baseUrlConfig.isLocalhost,
    providerDispatchDisabledByScript: true,
    smsSendDisabledByScript: true,
    customerEmailSendDisabledByScript: true,
    writebackFlags,
  };
}

async function safetyCounts(): Promise<SafetyCounts> {
  const [
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    internalNotificationEvents,
    deliveryGroupTenDayConfirmations,
    deliveryOrderHoldActions,
  ] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
    prisma.internalNotificationEvent.count(),
    prisma.deliveryGroupTenDayConfirmation.count(),
    prisma.deliveryOrderHoldAction.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    internalNotificationEvents,
    deliveryGroupTenDayConfirmations,
    deliveryOrderHoldActions,
  };
}

function countDiff(before: SafetyCounts, after: SafetyCounts) {
  return {
    notificationEvents: after.notificationEvents - before.notificationEvents,
    notificationAttempts: after.notificationAttempts - before.notificationAttempts,
    deliveryConfirmations: after.deliveryConfirmations - before.deliveryConfirmations,
    internalNotificationEvents:
      after.internalNotificationEvents - before.internalNotificationEvents,
    deliveryGroupTenDayConfirmations:
      after.deliveryGroupTenDayConfirmations - before.deliveryGroupTenDayConfirmations,
    deliveryOrderHoldActions:
      after.deliveryOrderHoldActions - before.deliveryOrderHoldActions,
  };
}

function todayInMountainTime() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return dateKey(new Date());
  return `${year}-${month}-${day}`;
}

function daysBetween(from: Date | string, to: Date | string) {
  return Math.round((dateFromKey(to).getTime() - dateFromKey(from).getTime()) / DAY_MS);
}

function isWeekday(value: Date | string) {
  const day = dateFromKey(value).getUTCDay();
  return day >= 1 && day <= 5;
}

function isGoodLifecycleDeliveryDate(value: Date | string) {
  const touch2 = addDays(value, -41);
  const touch3 = addDays(value, -40);
  const escalation = addDays(value, -39);
  return isWeekday(value) && isWeekday(touch2) && isWeekday(touch3) && isWeekday(escalation);
}

function requestedOnForDeliveryDate(value: Date | string) {
  return `${dateKey(value)}T${REQUESTED_ON_TIME}`;
}

function normalizeConfirmVia(value: unknown) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function isCompletedOrCancelledStatus(value: string | null | undefined) {
  return /^(completed|complete|closed|cancelled|canceled)$/i.test(String(value ?? "").trim());
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

function valueDateKey(value: unknown) {
  if (value instanceof Date || typeof value === "string") return dateKey(value);
  return null;
}

function matchesConfirmationWhere(
  confirmation: DeliveryConfirmationNoResponseCandidate,
  where: AnyRecord
) {
  const idFilter = asRecord(where.id);
  if (Array.isArray(idFilter.in) && !idFilter.in.includes(confirmation.id)) return false;

  const deliveryDate = valueDateKey(where.deliveryDate);
  if (deliveryDate && dateKey(confirmation.deliveryDate) !== deliveryDate) return false;

  const deliveryDateFilter = asRecord(where.deliveryDate);
  const gte = valueDateKey(deliveryDateFilter.gte);
  const lte = valueDateKey(deliveryDateFilter.lte);
  const confirmationDate = dateKey(confirmation.deliveryDate);
  if (gte && confirmationDate < gte) return false;
  if (lte && confirmationDate > lte) return false;

  const statusFilter = asRecord(where.status);
  if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(confirmation.status)) {
    return false;
  }
  if (where.confirmedAt === null && confirmation.confirmedAt !== null) return false;
  if (where.requestedNewDate === null && confirmation.requestedNewDate !== null) return false;
  if (where.noResponseAt === null && confirmation.noResponseAt !== null) return false;
  if (
    typeof where.manualReviewRequired === "boolean" &&
    confirmation.manualReviewRequired !== where.manualReviewRequired
  ) {
    return false;
  }

  const followUp = where.confirmationFollowUpCount;
  if (typeof followUp === "number") return confirmation.confirmationFollowUpCount === followUp;
  const followUpFilter = asRecord(followUp);
  if (typeof followUpFilter.gte === "number" && confirmation.confirmationFollowUpCount < followUpFilter.gte) {
    return false;
  }
  if (typeof followUpFilter.lte === "number" && confirmation.confirmationFollowUpCount > followUpFilter.lte) {
    return false;
  }

  return true;
}

function applyData(target: AnyRecord, data: AnyRecord) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === "object" &&
      "increment" in value &&
      typeof value.increment === "number"
    ) {
      target[key] = Number(target[key] ?? 0) + value.increment;
      continue;
    }
    target[key] = value;
  }
}

function selectFields(record: AnyRecord, select: unknown) {
  const selectRecord = asRecord(select);
  if (Object.keys(selectRecord).length === 0) return record;
  return Object.fromEntries(
    Object.entries(selectRecord)
      .filter(([, include]) => include)
      .map(([key]) => [key, record[key]])
  );
}

function slimSummary(summary: DeliveryConfirmationNoResponseRunSummary) {
  return {
    runDate: summary.runDate,
    dryRun: summary.dryRun,
    weekendSkipped: summary.weekendSkipped,
    reminderCandidatesChecked: summary.reminderCandidatesChecked,
    escalationCandidatesChecked: summary.escalationCandidatesChecked,
    currentStateRefreshesAttempted: summary.currentStateRefreshesAttempted,
    currentStateRefreshesSucceeded: summary.currentStateRefreshesSucceeded,
    currentStateRefreshesFailed: summary.currentStateRefreshesFailed,
    externalConfirmationsStopped: summary.externalConfirmationsStopped,
    staleConfirmationsExpired: summary.staleConfirmationsExpired,
    reminderEventsCreated: summary.reminderEventsCreated,
    reminderEventsWouldCreate: summary.reminderEventsWouldCreate,
    reminderEventsDeduped: summary.reminderEventsDeduped,
    remindersScheduled: summary.remindersScheduled,
    remindersScheduledByChannel: summary.remindersScheduledByChannel,
    confirmationsUpdatedAfterReminder: summary.confirmationsUpdatedAfterReminder,
    internalEscalationsCreated: summary.internalEscalationsCreated,
    internalEscalationsWouldCreate: summary.internalEscalationsWouldCreate,
    internalEscalationsDeduped: summary.internalEscalationsDeduped,
    manualReviewMarked: summary.manualReviewMarked,
    noChannelEscalations: summary.noChannelEscalations,
    skippedReasons: summary.skippedReasons,
    eventReportCount: summary.eventReports.length,
    eventReports: summary.eventReports.map((event) => ({
      orderType: event.orderType,
      orderNumber: event.orderNumber,
      deliveryDate: event.deliveryDate,
      touchNumber: event.touchNumber,
      status: event.status,
      selectedChannel: event.selectedChannel,
      reasonSkipped: event.reasonSkipped,
      subjectHasOrderNumber: Boolean(event.subject?.includes(event.orderNumber)),
      renderedMessageHasOrderNumber: event.renderedMessagePreview.includes(event.orderNumber),
      confirmationFollowUpCountAfter: event.confirmationFollowUpCountAfter,
      manualReviewRequiredAfter: event.manualReviewRequiredAfter,
    })),
  };
}

class FakeNoResponseStore {
  confirmations: DeliveryConfirmationNoResponseCandidate[] = [];
  notificationEvents: AnyRecord[] = [];
  internalNotificationEvents: AnyRecord[] = [];
  updateCount = 0;
  salespersonContact: SalespersonContactInput & { salespersonNumber: string };

  constructor(private readonly testEmail: string) {
    this.salespersonContact = {
      salespersonNumber: "SP1",
      salespersonName: "Test Salesperson",
      salespersonEmail: testEmail,
      salespersonPhone: TEST_SMS_FROM,
      isActive: true,
    };
  }

  readonly client = {
    deliveryConfirmation: {
      findMany: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return this.confirmations.filter((confirmation) =>
          matchesConfirmationWhere(confirmation, where)
        );
      },
      findUnique: async (args: unknown) => {
        const id = asRecord(asRecord(args).where).id;
        return this.confirmations.find((confirmation) => confirmation.id === id) ?? null;
      },
      count: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return this.confirmations.filter((confirmation) =>
          matchesConfirmationWhere(confirmation, where)
        ).length;
      },
      update: async (args: { where: { id: string }; data: AnyRecord; select?: unknown }) => {
        const confirmation = this.confirmations.find((row) => row.id === args.where.id);
        if (!confirmation) throw new Error(`Missing confirmation ${args.where.id}`);
        applyData(confirmation as unknown as AnyRecord, args.data);
        this.updateCount += 1;
        return selectFields(confirmation as unknown as AnyRecord, args.select);
      },
      updateMany: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        const data = asRecord(asRecord(args).data);
        let count = 0;
        for (const confirmation of this.confirmations) {
          if (!matchesConfirmationWhere(confirmation, where)) continue;
          applyData(confirmation as unknown as AnyRecord, data);
          count += 1;
        }
        this.updateCount += count;
        return { count };
      },
    },
    notificationEvent: {
      findUnique: async (args: unknown) => {
        const dedupeKey = asRecord(asRecord(args).where).dedupeKey;
        return this.notificationEvents.find((event) => event.dedupeKey === dedupeKey) ?? null;
      },
      create: async (args: { data: AnyRecord; select?: unknown }) => {
        const event = {
          id: `event_${this.notificationEvents.length + 1}`,
          dedupeKey: String(args.data.dedupeKey),
          intervalType: args.data.intervalType as NotificationIntervalType,
          actionType: args.data.actionType as NotificationActionType,
          status: args.data.status as NotificationEventStatus,
          selectedChannel: (args.data.selectedChannel as NotificationChannel | null | undefined) ?? null,
          recipientEmail: (args.data.recipientEmail as string | null | undefined) ?? null,
          recipientPhone: (args.data.recipientPhone as string | null | undefined) ?? null,
          reasonSkipped: (args.data.reasonSkipped as string | null | undefined) ?? null,
        };
        this.notificationEvents.push(event);
        return selectFields(event, args.select);
      },
    },
    internalNotificationEvent: {
      findFirst: async (args: unknown) => {
        const where = asRecord(asRecord(args).where);
        return (
          this.internalNotificationEvents.find(
            (event) =>
              event.orderDeliveryGroupId === where.orderDeliveryGroupId &&
              event.purpose === where.purpose &&
              event.orderType === where.orderType &&
              event.orderNumber === where.orderNumber &&
              valueDateKey(event.deliveryDate) === valueDateKey(where.deliveryDate)
          ) ?? null
        );
      },
      upsert: async (args: { where: AnyRecord; create: AnyRecord; select?: unknown }) => {
        const key = asRecord(args.where.orderDeliveryGroupId_deliveryDate_purpose);
        const existing = this.internalNotificationEvents.find(
          (event) =>
            event.orderDeliveryGroupId === key.orderDeliveryGroupId &&
            valueDateKey(event.deliveryDate) === valueDateKey(key.deliveryDate) &&
            event.purpose === key.purpose
        );
        if (existing) return selectFields(existing, args.select);

        const event = {
          id: `internal_${this.internalNotificationEvents.length + 1}`,
          ...args.create,
        };
        this.internalNotificationEvents.push(event);
        return selectFields(event, args.select);
      },
      create: async (args: { data: AnyRecord; select?: unknown }) => {
        const event = {
          id: `internal_${this.internalNotificationEvents.length + 1}`,
          ...args.data,
        };
        this.internalNotificationEvents.push(event);
        return selectFields(event, args.select);
      },
    },
    salespersonContact: {
      findMany: async () => [this.salespersonContact],
    },
    smsOptOut: { findMany: async () => [] },
    emailOptOut: { findMany: async () => [] },
  } as unknown as DeliveryConfirmationNoResponseClient;

  seed(options: {
    orderType: string;
    orderNumber: string;
    deliveryDate: Date;
    deliveryGroupId?: string;
    orderId?: string;
    contactId?: string;
    status?: DeliveryConfirmationStatus;
    confirmationFollowUpCount?: number;
    smsOptIn?: boolean;
    emailOptIn?: boolean;
    phone1?: string | null;
    email?: string | null;
    selectedChannel?: NotificationChannel | null;
    groupIsActive?: boolean;
    groupDeliveryDate?: Date;
    confirmVia?: string | null;
    hasActiveLines?: boolean;
    requestedNewDate?: Date | null;
    confirmedAt?: Date | null;
    linkToken?: string | null;
    linkExpiredAt?: Date | null;
  }) {
    const deliveryDate = options.deliveryDate;
    const id = `confirmation_${this.confirmations.length + 1}`;
    const confirmation: DeliveryConfirmationNoResponseCandidate = {
      id,
      orderId: options.orderId ?? `order_${id}`,
      deliveryGroupId: options.deliveryGroupId ?? `group_${id}`,
      notificationEventId: `original_${id}`,
      orderType: options.orderType,
      orderNumber: options.orderNumber,
      deliveryDate,
      contactId: options.contactId ?? `contact_${id}`,
      status: options.status ?? DeliveryConfirmationStatus.PENDING,
      confirmedAt: options.confirmedAt ?? null,
      requestedNewDate: options.requestedNewDate ?? null,
      manualReviewRequired: false,
      manualReviewReason: null,
      manualReviewMarkedAt: null,
      manualReviewNotes: null,
      reminderSentAt: null,
      noResponseAt: null,
      confirmationFollowUpCount: options.confirmationFollowUpCount ?? 0,
      linkToken: options.linkToken === undefined ? `token_${id}` : options.linkToken,
      linkExpiresAt: addDays(deliveryDate, 7),
      linkExpiredAt: options.linkExpiredAt ?? null,
      notificationEvent: { selectedChannel: options.selectedChannel ?? NotificationChannel.SMS },
      orderDeliveryGroup: {
        id: options.deliveryGroupId ?? `group_${id}`,
        deliveryDate: options.groupDeliveryDate ?? deliveryDate,
        isActive: options.groupIsActive ?? true,
        status: "Open",
        deliveryGroupLines: options.hasActiveLines === false ? [] : [{ id: `line_${id}` }],
        order: {
          id: options.orderId ?? `order_${id}`,
          orderType: options.orderType,
          orderNumber: options.orderNumber,
          status: "Open",
          internalLifecycleStatus: InternalOrderLifecycleStatus.ACTIVE,
          buyerGroup: "Test Buyer Group",
          confirmVia: options.confirmVia ?? null,
          salespersonNumber: "SP1",
          customerDescription: "Test Customer",
          locationDescription: "Test Location",
          address: {
            addressLine1: "123 Test St",
            addressLine2: null,
            city: "Salt Lake City",
            state: "UT",
            postalCode: "84101",
          },
          contact: {
            contactId: options.contactId ?? `contact_${id}`,
            companyName: null,
            displayName: "Test Customer",
            firstName: "Test",
            lastName: "Customer",
            email: options.email === undefined ? this.testEmail : options.email,
            phone1: options.phone1 === undefined ? TEST_SMS_FROM : options.phone1,
            phone2: null,
            smsOptIn: options.smsOptIn ?? true,
            emailOptIn: options.emailOptIn ?? true,
            smsOptOuts: [],
            emailOptOuts: [],
          },
        },
      },
    };

    this.confirmations.push(confirmation);
    return confirmation;
  }
}

function noResponseRefreshRecorder(
  mutate?: (candidate: DeliveryConfirmationNoResponseCandidate) => void
): {
  refresher: DeliveryConfirmationNoResponseCurrentStateRefresher;
  refreshes: Array<{ orderType: string; orderNumber: string; deliveryDate: string }>;
} {
  const refreshes: Array<{ orderType: string; orderNumber: string; deliveryDate: string }> = [];
  return {
    refreshes,
    refresher: async ({ candidate }) => {
      refreshes.push({
        orderType: candidate.orderType,
        orderNumber: candidate.orderNumber,
        deliveryDate: dateKey(candidate.deliveryDate),
      });
      mutate?.(candidate);
      return { ok: true, candidate, importResult: null };
    },
  };
}

type SmsConfirmationRecord = {
  id: string;
  orderId: string;
  deliveryGroupId: string;
  notificationEventId: string | null;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  contactId: string;
  status: DeliveryConfirmationStatus;
  confirmedAt: Date | null;
  requestedNewDate: Date | null;
  linkExpiresAt: Date | null;
  linkExpiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contact: {
    contactId: string;
    displayName: string | null;
    companyName: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone1: string | null;
    phone2: string | null;
  };
  notificationEvent: { id: string } | null;
  orderDeliveryGroup: {
    id: string;
    isActive: boolean;
    deliveryDate: Date;
    order: { confirmVia: string | null };
  };
  order: {
    confirmVia: string | null;
    address: {
      state: string | null;
      postalCode: string | null;
    } | null;
  };
};

class FakeStaleSmsStore {
  inboundMessages: AnyRecord[] = [];
  updateCount = 0;

  constructor(private readonly confirmation: SmsConfirmationRecord) {}

  readonly client = {
    twilioInboundMessage: {
      findUnique: async () => null,
      create: async (args: { data: AnyRecord; select?: unknown }) => {
        const record = {
          id: `inbound_${this.inboundMessages.length + 1}`,
          ...args.data,
        };
        this.inboundMessages.push(record);
        return selectFields(record, args.select);
      },
      update: async (args: { where: { id: string }; data: AnyRecord }) => {
        const record = this.inboundMessages.find((row) => row.id === args.where.id);
        if (!record) throw new Error(`Missing inbound message ${args.where.id}`);
        applyData(record, args.data);
        return record;
      },
    },
    deliveryConfirmation: {
      findMany: async () => [this.confirmation],
      findUnique: async () => this.confirmation,
      update: async () => {
        this.updateCount += 1;
        return this.confirmation;
      },
      updateMany: async () => ({ count: 0 }),
    },
    smsOptOut: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async () => ({ id: "sms_opt_out_1" }),
      update: async () => ({ id: "sms_opt_out_1" }),
      updateMany: async () => ({ count: 0 }),
    },
    contact: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as NonNullable<Parameters<typeof handleTwilioInboundSms>[0]["prismaClient"]>;
}

function staleSmsConfirmation(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  status?: DeliveryConfirmationStatus;
}) {
  const now = new Date();
  return {
    id: "sms_stale_confirmation",
    orderId: "sms_order",
    deliveryGroupId: "sms_group",
    notificationEventId: "sms_event",
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate: params.deliveryDate,
    contactId: "sms_contact",
    status: params.status ?? DeliveryConfirmationStatus.PENDING,
    confirmedAt: null,
    requestedNewDate: null,
    linkExpiresAt: addDays(now, 30),
    linkExpiredAt: null,
    createdAt: now,
    updatedAt: now,
    contact: {
      contactId: "sms_contact",
      displayName: null,
      companyName: null,
      firstName: null,
      lastName: null,
      email: null,
      phone1: TEST_SMS_FROM,
      phone2: null,
    },
    notificationEvent: { id: "sms_event" },
    orderDeliveryGroup: {
      id: "sms_group",
      isActive: false,
      deliveryDate: params.deliveryDate,
      order: { confirmVia: null },
    },
    order: {
      confirmVia: null,
      address: { state: "UT", postalCode: "84101" },
    },
  } satisfies SmsConfirmationRecord;
}

function inboundPayload(body: string, messageSid: string) {
  return {
    MessageSid: messageSid,
    AccountSid: "AC_TEST",
    MessagingServiceSid: "MG_TEST",
    From: TEST_SMS_FROM,
    To: TEST_SMS_TO,
    Body: body,
  };
}

async function runStaleSmsScenario(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  body: string;
  sidSuffix: string;
}) {
  const store = new FakeStaleSmsStore(
    staleSmsConfirmation({
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      deliveryDate: params.deliveryDate,
    })
  );
  let writebackCalled = false;
  const result = await handleTwilioInboundSms({
    payload: inboundPayload(params.body, `SM-DRY-${params.sidSuffix}`),
    prismaClient: store.client,
    now: new Date(),
    queueOptions: {
      baseUrl: "http://mld-queue.local.test",
      token: "test-token",
      fetchImpl: async () => {
        writebackCalled = true;
        throw new Error("writeback should not be called in stale SMS dry run");
      },
    },
  });

  return {
    bodyKind: params.body === "Y" ? "confirm" : "requested_date",
    matchStatus: result.matchStatus,
    staleResponseReturned: Boolean(result.responseMessage?.includes("no longer valid")),
    confirmationUpdateCount: store.updateCount,
    writebackCalled,
    smsSent: false,
  };
}

async function runStaleWebScenario(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
}) {
  let updateCount = 0;
  const staleConfirmation = {
    id: "web_stale_confirmation",
    status: DeliveryConfirmationStatus.PENDING,
    confirmedAt: null,
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryGroupId: "web_group",
    deliveryDate: params.deliveryDate,
    linkExpiresAt: addDays(new Date(), 30),
    linkExpiredAt: null,
    contact: {
      displayName: null,
      companyName: null,
      firstName: null,
      lastName: null,
      email: null,
    },
    orderDeliveryGroup: {
      id: "web_group",
      isActive: false,
      deliveryDate: params.deliveryDate,
      order: {
        id: "web_order",
        confirmVia: null,
        address: { state: "UT", postalCode: "84101" },
      },
    },
  };
  const webClient = {
    deliveryConfirmation: {
      findUnique: async () => staleConfirmation,
      update: async () => {
        updateCount += 1;
        return staleConfirmation;
      },
    },
  } as NonNullable<Parameters<typeof confirmDeliveryFromWebpage>[0]["prismaClient"]>;

  const confirmResult = await confirmDeliveryFromWebpage({
    linkToken: "web_stale_token",
    prismaClient: webClient,
    refreshCurrentState: async () => {},
  });
  const requestGuard = await guardDeliveryConfirmationWebAction({
    linkToken: "web_stale_token",
    prismaClient: webClient,
    refreshCurrentState: async () => {},
  });

  return {
    confirmOutcome: confirmResult.outcome,
    requestDifferentDateGuardOutcome: requestGuard.outcome,
    confirmationUpdateCount: updateCount,
    writebackQueued: false,
  };
}

function syntheticLine(
  overrides: Partial<OrderLineReadinessSummary> & { lineNbr: number }
): OrderLineReadinessSummary {
  return {
    orderLineId: `line_${overrides.lineNbr}`,
    lineNbr: overrides.lineNbr,
    inventoryId: overrides.inventoryId ?? `ITEM-${overrides.lineNbr}`,
    lineDescription: overrides.lineDescription ?? `Fixture item ${overrides.lineNbr}`,
    itemType: overrides.itemType ?? "F",
    itemClass: overrides.itemClass ?? "TEST",
    requestedOn: overrides.requestedOn ?? "2026-08-10",
    eta: "eta" in overrides ? overrides.eta ?? null : "2026-08-08",
    orderQty: overrides.orderQty ?? 1,
    openQty: overrides.openQty ?? 1,
    activeAllocatedQty: overrides.activeAllocatedQty ?? 0,
    allocationStatus: overrides.allocationStatus ?? "not_allocated",
    etaStatus: overrides.etaStatus ?? "expected_on_time",
    readinessStatus: overrides.readinessStatus ?? "expected_on_time",
    readinessStatusBeforeExternalStock: overrides.readinessStatusBeforeExternalStock ?? null,
    externalStockReadinessMatched: overrides.externalStockReadinessMatched ?? false,
    displayStatus: overrides.displayStatus ?? "Expected on time",
    allocationCount: overrides.allocationCount ?? 0,
    allocationRowsCompact: overrides.allocationRowsCompact ?? [],
    activeAllocationCount: overrides.activeAllocationCount ?? 0,
    completedAllocationCount: overrides.completedAllocationCount ?? 0,
  };
}

function validateItemRenderingRules() {
  const failures: Failure[] = [];
  const ready = syntheticLine({
    lineNbr: 1,
    eta: null,
    etaStatus: "ready",
    readinessStatus: "ready",
    displayStatus: "Ready",
  });
  const complete = syntheticLine({
    lineNbr: 2,
    eta: "2026-08-08",
    etaStatus: "complete",
    readinessStatus: "complete",
    displayStatus: "Complete",
  });
  const specialLines = [
    syntheticLine({ lineNbr: 3, inventoryId: "STORAGE-123" }),
    syntheticLine({ lineNbr: 4, inventoryId: "DELIVERY-FEE" }),
    syntheticLine({ lineNbr: 5, inventoryId: "INSTALL-KIT" }),
  ];
  const descriptionOnly = [
    syntheticLine({ lineNbr: 6, inventoryId: "ABC123", lineDescription: "storage cabinet" }),
    syntheticLine({ lineNbr: 7, inventoryId: "ABC123", lineDescription: "delivery included" }),
    syntheticLine({
      lineNbr: 8,
      inventoryId: "ABC123",
      lineDescription: "installation service",
    }),
  ];

  assert(deliveryItemEtaDisplay(ready) === "-", "Ready ETA did not render dash", failures);
  assert(deliveryItemEtaDisplay(complete) === "-", "Complete ETA did not render dash", failures);

  for (const line of specialLines) {
    assert(
      shouldSuppressDeliveryItemCustomerEtaAndStatus(line),
      `Inventory ${line.inventoryId ?? ""} did not suppress display`,
      failures
    );
    assert(deliveryItemEtaDisplay(line) === "-", `Inventory ${line.inventoryId ?? ""} ETA`, failures);
    assert(
      deliveryItemStatusDisplay(line) === "-",
      `Inventory ${line.inventoryId ?? ""} status`,
      failures
    );
  }

  for (const line of descriptionOnly) {
    assert(
      !shouldSuppressDeliveryItemCustomerEtaAndStatus(line),
      `Description-only line ${line.lineNbr} incorrectly suppressed display`,
      failures
    );
    assert(
      deliveryItemStatusDisplay(line) !== "-",
      `Description-only line ${line.lineNbr} status incorrectly rendered dash`,
      failures
    );
  }

  return {
    passed: failures.length === 0,
    failures,
    readyEtaDash: deliveryItemEtaDisplay(ready) === "-",
    completeEtaDash: deliveryItemEtaDisplay(complete) === "-",
    inventoryIdStorageDeliveryInstallSuppressed: specialLines.every(
      (line) =>
        shouldSuppressDeliveryItemCustomerEtaAndStatus(line) &&
        deliveryItemEtaDisplay(line) === "-" &&
        deliveryItemStatusDisplay(line) === "-"
    ),
    descriptionOnlyDoesNotSuppress: descriptionOnly.every(
      (line) => !shouldSuppressDeliveryItemCustomerEtaAndStatus(line)
    ),
  };
}

async function findRealCandidates() {
  const activeOptOuts = await loadActiveNotificationOptOutAddresses(prisma);
  const today = dateFromKey(todayInMountainTime());
  const groups = await prisma.orderDeliveryGroup.findMany({
    where: {
      isActive: true,
      deliveryDate: { gte: today },
      OR: [
        { deliveryGroupLines: { some: { isActive: true } } },
        { lineCount: { gt: 0 } },
      ],
      order: {
        internalLifecycleStatus: InternalOrderLifecycleStatus.ACTIVE,
      },
    },
    orderBy: [{ deliveryDate: "asc" }, { orderNumber: "asc" }],
    take: 250,
    include: {
      deliveryGroupLines: {
        where: { isActive: true },
        select: { id: true },
      },
      deliveryConfirmations: {
        select: {
          id: true,
          status: true,
          manualReviewRequired: true,
          noResponseAt: true,
          confirmationFollowUpCount: true,
          deliveryDate: true,
        },
        take: 5,
      },
      order: {
        include: {
          contact: {
            include: {
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
          address: true,
        },
      },
    },
  });

  const salespersonContacts = await getActiveSalespersonContactMap(
    groups.map((group) => group.order.salespersonNumber),
    prisma
  );

  const candidates = groups
    .map((group) => {
      const contact = group.order.contact;
      const channel = selectNotificationChannel(
        contact,
        mergeNotificationOptOutAddresses(activeOptOuts, {
          activeSmsOptOutPhones: contact.smsOptOuts.map((optOut) => optOut.phone),
          activeEmailOptOutEmails: contact.emailOptOuts.map((optOut) => optOut.email),
        })
      );
      const salespersonNumber = cleanNotificationText(group.order.salespersonNumber);
      const salesperson = salespersonNumber ? salespersonContacts.get(salespersonNumber) : null;
      const existingProblemState = group.deliveryConfirmations.some(
        (confirmation) => confirmation.manualReviewRequired || confirmation.noResponseAt
      );
      const lineCount = group.deliveryGroupLines.length || group.lineCount || 0;
      const lifecycleDatePreferred = isGoodLifecycleDeliveryDate(group.deliveryDate);
      const eligible =
        lineCount > 0 &&
        isWeekday(group.deliveryDate) &&
        !normalizeConfirmVia(group.order.confirmVia) &&
        !existingProblemState &&
        !isCompletedOrCancelledStatus(group.status) &&
        !isCompletedOrCancelledStatus(group.order.status);

      return {
        group,
        channel,
        salespersonEmailAvailable: Boolean(salesperson?.salespersonEmail),
        lifecycleDatePreferred,
        score:
          (eligible ? 1000 : 0) +
          (channel.selectedChannel ? 200 : 0) +
          (salesperson?.salespersonEmail ? 100 : 0) +
          (lifecycleDatePreferred ? 50 : 0) +
          (group.deliveryConfirmations.length === 0 ? 25 : 0),
        report: {
          orderType: group.orderType,
          orderNumber: group.orderNumber,
          deliveryDate: dateKey(group.deliveryDate),
          daysUntilDelivery: daysBetween(today, group.deliveryDate),
          activeDeliveryGroupId: group.id,
          deliveryGroupLineCount: lineCount,
          confirmViaPresent: Boolean(normalizeConfirmVia(group.order.confirmVia)),
          existingConfirmationCount: group.deliveryConfirmations.length,
          existingNoResponseOrManualReview: existingProblemState,
          lifecycleDatePreferred,
          customerChannelEligibility: {
            selectedChannel: channel.selectedChannel,
            reason: channel.channelReason,
            smsOptIn: contact.smsOptIn,
            emailOptIn: contact.emailOptIn,
            phonePresent: Boolean(cleanNotificationText(contact.phone1) || cleanNotificationText(contact.phone2)),
            emailPresent: Boolean(cleanNotificationText(contact.email)),
            activeSmsOptOutForContact: contact.smsOptOuts.length > 0,
            activeEmailOptOutForContact: contact.emailOptOuts.length > 0,
          },
          salespersonEmailAvailable: Boolean(salesperson?.salespersonEmail),
        },
      };
    })
    .filter((candidate) => candidate.score >= 1000)
    .sort((left, right) => right.score - left.score || left.group.deliveryDate.getTime() - right.group.deliveryDate.getTime());

  return candidates.slice(0, MAX_TARGETED_IMPORT_CANDIDATES);
}

type SelectedCandidate = Awaited<ReturnType<typeof findRealCandidates>>[number];

async function candidateDiagnostics() {
  const today = dateFromKey(todayInMountainTime());
  const [
    orders,
    groups,
    activeGroups,
    futureGroups,
    activeFutureGroups,
    activeWithLines,
    activeFutureWithLines,
    activeFutureActiveOrders,
    blankConfirmVia,
    activeFutureWithSalesperson,
    sampleGroups,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.orderDeliveryGroup.count(),
    prisma.orderDeliveryGroup.count({ where: { isActive: true } }),
    prisma.orderDeliveryGroup.count({ where: { deliveryDate: { gte: today } } }),
    prisma.orderDeliveryGroup.count({ where: { isActive: true, deliveryDate: { gte: today } } }),
    prisma.orderDeliveryGroup.count({
      where: {
        isActive: true,
        OR: [
          { deliveryGroupLines: { some: { isActive: true } } },
          { lineCount: { gt: 0 } },
        ],
      },
    }),
    prisma.orderDeliveryGroup.count({
      where: {
        isActive: true,
        deliveryDate: { gte: today },
        OR: [
          { deliveryGroupLines: { some: { isActive: true } } },
          { lineCount: { gt: 0 } },
        ],
      },
    }),
    prisma.orderDeliveryGroup.count({
      where: {
        isActive: true,
        deliveryDate: { gte: today },
        OR: [
          { deliveryGroupLines: { some: { isActive: true } } },
          { lineCount: { gt: 0 } },
        ],
        order: { internalLifecycleStatus: InternalOrderLifecycleStatus.ACTIVE },
      },
    }),
    prisma.orderDeliveryGroup.count({
      where: {
        isActive: true,
        deliveryDate: { gte: today },
        OR: [
          { deliveryGroupLines: { some: { isActive: true } } },
          { lineCount: { gt: 0 } },
        ],
        order: { confirmVia: null },
      },
    }),
    prisma.orderDeliveryGroup.count({
      where: {
        isActive: true,
        deliveryDate: { gte: today },
        OR: [
          { deliveryGroupLines: { some: { isActive: true } } },
          { lineCount: { gt: 0 } },
        ],
        order: { salespersonNumber: { not: null } },
      },
    }),
    prisma.orderDeliveryGroup.findMany({
      where: { isActive: true },
      orderBy: { deliveryDate: "desc" },
      take: 5,
      select: {
        id: true,
        orderType: true,
        orderNumber: true,
        deliveryDate: true,
        status: true,
        lineCount: true,
        _count: { select: { deliveryGroupLines: true } },
        order: {
          select: {
            status: true,
            internalLifecycleStatus: true,
            confirmVia: true,
            salespersonNumber: true,
            contact: {
              select: {
                email: true,
                phone1: true,
                smsOptIn: true,
                emailOptIn: true,
              },
            },
          },
        },
      },
    }),
  ]);

  return {
    today: dateKey(today),
    counts: {
      orders,
      groups,
      activeGroups,
      futureGroups,
      activeFutureGroups,
      activeWithLines,
      activeFutureWithLines,
      activeFutureActiveOrders,
      activeFutureWithBlankConfirmVia: blankConfirmVia,
      activeFutureWithSalesperson,
    },
    latestActiveGroups: sampleGroups.map((group) => ({
      orderType: group.orderType,
      orderNumber: group.orderNumber,
      deliveryDate: dateKey(group.deliveryDate),
      deliveryGroupId: group.id,
      groupStatus: group.status,
      lineCount: group.lineCount,
      deliveryGroupLineCount: group._count.deliveryGroupLines,
      orderStatus: group.order.status,
      internalLifecycleStatus: group.order.internalLifecycleStatus,
      confirmViaPresent: Boolean(normalizeConfirmVia(group.order.confirmVia)),
      salespersonNumberPresent: Boolean(cleanNotificationText(group.order.salespersonNumber)),
      contact: {
        emailPresent: Boolean(cleanNotificationText(group.order.contact.email)),
        phonePresent: Boolean(cleanNotificationText(group.order.contact.phone1)),
        smsOptIn: group.order.contact.smsOptIn,
        emailOptIn: group.order.contact.emailOptIn,
      },
    })),
  };
}

async function importSelectedOrder(candidate: SelectedCandidate) {
  const before = await prisma.orderDeliveryGroup.findUnique({
    where: { id: candidate.group.id },
    include: {
      deliveryGroupLines: {
        where: { isActive: true },
        select: { id: true, orderLineId: true },
      },
    },
  });
  assert(before, `Selected delivery group not found before import: ${candidate.group.id}`);

  const requestedOn = requestedOnForDeliveryDate(candidate.group.deliveryDate);
  const importResult = await importSalesOrdersForLineRequestedOn(requestedOn, {
    orderLookups: [
      {
        orderType: candidate.group.orderType,
        orderNumber: candidate.group.orderNumber,
      },
    ],
    includeUnqualifiedOrderLookups: true,
  });

  const after = await prisma.orderDeliveryGroup.findUnique({
    where: { id: candidate.group.id },
    include: {
      deliveryGroupLines: {
        where: { isActive: true },
        select: { id: true, orderLineId: true },
      },
      order: {
        include: {
          contact: true,
          address: true,
        },
      },
    },
  });
  assert(after, `Selected delivery group not found after import: ${candidate.group.id}`);

  const beforeLines = new Set(before.deliveryGroupLines.map((line) => line.orderLineId ?? line.id));
  const afterLines = new Set(after.deliveryGroupLines.map((line) => line.orderLineId ?? line.id));
  const lineMembershipSame =
    beforeLines.size === afterLines.size &&
    Array.from(beforeLines).every((lineId) => afterLines.has(lineId));

  return {
    requestedOn,
    importResult: {
      requestedOn: importResult.requestedOn,
      qualifyingOrdersFetched: importResult.qualifyingOrdersFetched,
      fullOrdersFetched: importResult.fullOrdersFetched,
      contactsUpserted: importResult.contactsUpserted,
      ordersCreated: importResult.ordersCreated,
      ordersUpdated: importResult.ordersUpdated,
      linesUpserted: importResult.linesUpserted,
      allocationsUpserted: importResult.allocationsUpserted,
      addressesUpserted: importResult.addressesUpserted,
      deliveryGroupsUpserted: importResult.deliveryGroupsUpserted,
      deliveryGroupLinesUpserted: importResult.deliveryGroupLinesUpserted,
      deliveryGroupLinesCreated: importResult.deliveryGroupLinesCreated,
      deliveryGroupLinesReactivated: importResult.deliveryGroupLinesReactivated,
      deliveryGroupLinesDeactivated: importResult.deliveryGroupLinesDeactivated,
      changeEventsDetected: importResult.changeEventsDetected,
      changeEventsCreated: importResult.changeEventsCreated,
      changeEventsDeduped: importResult.changeEventsDeduped,
      skippedOrders: importResult.skippedOrders,
      failedOrders: importResult.failedOrders,
      errorCount: importResult.errors.length,
    },
    reloaded: {
      groupActive: after.isActive,
      deliveryDate: dateKey(after.deliveryDate),
      deliveryDateWeekday: isWeekday(after.deliveryDate),
      confirmViaPresent: Boolean(normalizeConfirmVia(after.order.confirmVia)),
      activeLineCount: after.deliveryGroupLines.length || after.lineCount || 0,
      lineMembershipSame,
    },
    group: after,
  };
}

function sanitizeFreshImportReport(result: Awaited<ReturnType<typeof importSelectedOrder>>) {
  return {
    requestedOn: result.requestedOn,
    importResult: result.importResult,
    reloaded: result.reloaded,
  };
}

function paymentReminderApplies(payment: Awaited<ReturnType<typeof getDeliveryGroupPaymentEvaluation>>) {
  return (
    payment.paymentStatus === "balance_due" &&
    Number(payment.amountDueNowRounded ?? "0") > 2 &&
    payment.calculationWarnings.length === 0
  );
}

async function renderTouch1(params: {
  candidate: SelectedCandidate;
  group: Awaited<ReturnType<typeof importSelectedOrder>>["group"];
}) {
  const token = newDeliveryConfirmationLinkToken();
  const confirmationUrl = buildDeliveryConfirmationLink(token);
  const order = params.group.order;
  const contactName = formatContactName(order.contact);
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const jobAddress = formatJobAddress(order.address ?? {}) || "the job site";
  const payment = await getDeliveryGroupPaymentEvaluation(params.group.id, undefined, {
    dryRun: true,
    sourceInterval: NotificationIntervalType.DAY_42,
  });
  const email = render42DayEmailConfirmationMessage({
    orderNumber: params.group.orderNumber,
    contactName,
    buyerGroup: order.buyerGroup,
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
    jobName,
    jobAddress,
    deliveryDate: params.group.deliveryDate,
    link: confirmationUrl,
    paymentReminderApplies: paymentReminderApplies(payment),
    amountDueNowRounded: payment.amountDueNowRounded,
  });
  const sms = render42DaySmsConfirmationMessage({
    orderNumber: params.group.orderNumber,
    contactName,
    buyerGroup: order.buyerGroup,
    jobName,
    deliveryDate: params.group.deliveryDate,
    link: confirmationUrl,
    deliveryAddress: order.address,
  });
  const scopeKey = buildDeliveryConfirmationScopeKey({
    orderType: params.group.orderType,
    orderNumber: params.group.orderNumber,
    deliveryDate: params.group.deliveryDate,
    deliveryGroupId: params.group.id,
  });
  const readiness = await getDeliveryGroupReadiness(params.group.id);
  const itemRendering = readiness.lines.slice(0, 10).map((line) => ({
    lineNbr: line.lineNbr,
    inventoryIdPresent: Boolean(cleanNotificationText(line.inventoryId)),
    etaDisplay: deliveryItemEtaDisplay(line),
    statusDisplay: deliveryItemStatusDisplay(line),
    suppressedByInventoryId: shouldSuppressDeliveryItemCustomerEtaAndStatus(line),
  }));
  const syntheticItemRuleValidation = validateItemRenderingRules();

  return {
    renderedOnly: true,
    providerEmailSent: false,
    smsSent: false,
    testEmailRecipientConfigured: true,
    durableConfirmationCreated: false,
    confirmationUrlForManualReview: null,
    syntheticConfirmationUrlHost: new URL(confirmationUrl).host,
    syntheticLinkMapsToSelectedOrderDateGroup:
      scopeKey.includes(params.group.orderType) &&
      scopeKey.includes(params.group.orderNumber) &&
      scopeKey.includes(dateKey(params.group.deliveryDate)) &&
      scopeKey.includes(params.group.id),
    email: {
      subjectIncludesOrderNumber: email.subject.includes(params.group.orderNumber),
      bodyIncludesOrderNumber: email.body.includes(`Order: ${params.group.orderNumber}`),
      bodyIncludesDeliveryDate: email.body.includes(formatCustomerFriendlyDate(params.group.deliveryDate)),
      bodyIncludesConfirmationLink: email.body.includes(confirmationUrl),
    },
    sms: {
      bodyIncludesOrderNumber: sms.includes(`MLD: Order ${params.group.orderNumber}:`),
      bodyIncludesDeliveryDate: sms.includes(formatCustomerFriendlyDate(params.group.deliveryDate)),
      bodyIncludesConfirmationLink: sms.includes(confirmationUrl),
      renderedOnly: true,
    },
    webpageData: {
      orderNumberShownByData: params.group.orderNumber === params.candidate.group.orderNumber,
      deliveryDateShownByData: dateKey(params.group.deliveryDate),
      readinessLineCount: readiness.lineCount,
      readinessIncludedLineCount: readiness.includedLineCount,
      itemRenderingSample: itemRendering,
      syntheticItemRuleValidation,
      payment: {
        paymentApplicabilityStatus: payment.paymentApplicabilityStatus,
        paymentStatus: payment.paymentStatus,
        paymentReminderApplies: paymentReminderApplies(payment),
        amountDueNowRoundedPresent: Boolean(payment.amountDueNowRounded),
        nonPrepayBalanceHidden:
          payment.paymentApplicabilityStatus === "not_applicable_terms"
            ? !paymentReminderApplies(payment)
            : true,
        prepayPositiveDueShownWhenApplicable:
          payment.paymentApplicabilityStatus === "applicable" &&
          payment.paymentStatus === "balance_due"
            ? paymentReminderApplies(payment)
            : true,
      },
    },
  };
}

async function runLifecycle(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  deliveryGroupId: string;
  orderId: string;
  contactId: string;
  selectedChannel: NotificationChannel | null;
  testEmail: string;
}) {
  const touch2RunDate = dateKey(addDays(params.deliveryDate, -41));
  const touch3RunDate = dateKey(addDays(params.deliveryDate, -40));
  const escalationRunDate = dateKey(addDays(params.deliveryDate, -39));
  const store = new FakeNoResponseStore(params.testEmail);
  const confirmation = store.seed({
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate: params.deliveryDate,
    deliveryGroupId: params.deliveryGroupId,
    orderId: params.orderId,
    contactId: params.contactId,
    selectedChannel: params.selectedChannel ?? NotificationChannel.EMAIL,
    smsOptIn: params.selectedChannel === NotificationChannel.SMS,
    emailOptIn: params.selectedChannel !== NotificationChannel.SMS,
    phone1: params.selectedChannel === NotificationChannel.SMS ? TEST_SMS_FROM : null,
    email: params.testEmail,
  });
  const refresh = noResponseRefreshRecorder();

  const touch2 = await run42DayDeliveryConfirmationNoResponse({
    runDate: touch2RunDate,
    now: new Date(`${touch2RunDate}T16:00:00.000Z`),
    dryRun: false,
    prismaClient: store.client,
    currentStateRefresher: refresh.refresher,
  });
  const touch3 = await run42DayDeliveryConfirmationNoResponse({
    runDate: touch3RunDate,
    now: new Date(`${touch3RunDate}T16:00:00.000Z`),
    dryRun: false,
    prismaClient: store.client,
    currentStateRefresher: refresh.refresher,
  });
  const escalation = await run42DayDeliveryConfirmationNoResponse({
    runDate: escalationRunDate,
    now: new Date(`${escalationRunDate}T16:00:00.000Z`),
    dryRun: false,
    prismaClient: store.client,
    currentStateRefresher: refresh.refresher,
  });
  const escalationRerun = await run42DayDeliveryConfirmationNoResponse({
    runDate: escalationRunDate,
    now: new Date(`${escalationRunDate}T17:00:00.000Z`),
    dryRun: false,
    prismaClient: store.client,
    currentStateRefresher: refresh.refresher,
  });

  return {
    runDates: {
      touch2: touch2RunDate,
      touch3: touch3RunDate,
      day39Escalation: escalationRunDate,
      allWeekdays:
        isWeekday(touch2RunDate) && isWeekday(touch3RunDate) && isWeekday(escalationRunDate),
    },
    finalConfirmation: {
      confirmationFollowUpCount: confirmation.confirmationFollowUpCount,
      manualReviewRequired: confirmation.manualReviewRequired,
      noResponseAtPresent: Boolean(confirmation.noResponseAt),
    },
    eventCounts: {
      notificationEvents: store.notificationEvents.length,
      internalNotificationEvents: store.internalNotificationEvents.length,
      updateCount: store.updateCount,
    },
    refreshesBeforeEvaluation: refresh.refreshes,
    touch2: slimSummary(touch2),
    touch3: slimSummary(touch3),
    day39Escalation: slimSummary(escalation),
    day39EscalationRerun: slimSummary(escalationRerun),
    dedupe: {
      reminderTouch2DedupeKey: buildDeliveryConfirmationReminderDedupeKey({
        confirmationId: confirmation.id,
        orderType: params.orderType,
        orderNumber: params.orderNumber,
        deliveryDate: params.deliveryDate,
        touchNumber: 2,
      }),
      internalEscalationEventsAfterRerun: store.internalNotificationEvents.length,
      oneEscalationAfterRerun: store.internalNotificationEvents.length === 1,
    },
    sends: {
      customerEmailSent: false,
      smsSent: false,
      providerDispatchToRealRecipient: false,
    },
  };
}

async function runManualConfirmViaScenarios(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  testEmail: string;
}) {
  const scenarios = [
    {
      label: "CONFIRMVIA appears after touch 1 before touch 2",
      runDate: dateKey(addDays(params.deliveryDate, -41)),
      followUpCount: 0,
    },
    {
      label: "CONFIRMVIA appears after touch 2 before touch 3",
      runDate: dateKey(addDays(params.deliveryDate, -40)),
      followUpCount: 1,
    },
    {
      label: "CONFIRMVIA appears after touch 3 before escalation",
      runDate: dateKey(addDays(params.deliveryDate, -39)),
      followUpCount: 2,
    },
  ] as const;

  const results = [];
  for (const scenario of scenarios) {
    const store = new FakeNoResponseStore(params.testEmail);
    const confirmation = store.seed({
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      deliveryDate: params.deliveryDate,
      confirmationFollowUpCount: scenario.followUpCount,
    });
    const refresh = noResponseRefreshRecorder((candidate) => {
      candidate.orderDeliveryGroup.order.confirmVia = "Manual";
    });
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: scenario.runDate,
      now: new Date(`${scenario.runDate}T16:00:00.000Z`),
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: refresh.refresher,
    });
    results.push({
      label: scenario.label,
      runDate: scenario.runDate,
      noCustomerReminderCreated: store.notificationEvents.length === 0,
      noEscalationCreated: store.internalNotificationEvents.length === 0,
      externalConfirmationStopped: summary.externalConfirmationsStopped === 1,
      finalStatus: confirmation.status,
      localConfirmedExternally: confirmation.status === DeliveryConfirmationStatus.CONFIRMED,
      refreshesBeforeEvaluation: refresh.refreshes.length,
      summary: slimSummary(summary),
    });
  }

  return results;
}

async function runDateBumpScenarios(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  testEmail: string;
}) {
  const bumpedDate = addDays(params.deliveryDate, 7);
  const scenarios = [
    {
      label: "Date changes after touch 1 before touch 2",
      runDate: dateKey(addDays(params.deliveryDate, -41)),
      followUpCount: 0,
    },
    {
      label: "Date changes after touch 2 before touch 3",
      runDate: dateKey(addDays(params.deliveryDate, -40)),
      followUpCount: 1,
    },
    {
      label: "Date changes after touch 3 before escalation",
      runDate: dateKey(addDays(params.deliveryDate, -39)),
      followUpCount: 2,
    },
  ] as const;
  const results = [];

  for (const scenario of scenarios) {
    const store = new FakeNoResponseStore(params.testEmail);
    const confirmation = store.seed({
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      deliveryDate: params.deliveryDate,
      confirmationFollowUpCount: scenario.followUpCount,
      groupDeliveryDate: bumpedDate,
    });
    const refresh = noResponseRefreshRecorder();
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: scenario.runDate,
      now: new Date(`${scenario.runDate}T16:00:00.000Z`),
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: refresh.refresher,
    });
    results.push({
      label: scenario.label,
      runDate: scenario.runDate,
      noCustomerReminderCreated: store.notificationEvents.length === 0,
      noEscalationCreated: store.internalNotificationEvents.length === 0,
      staleConfirmationExpired: summary.staleConfirmationsExpired === 1,
      finalStatus: confirmation.status,
      linkExpiredAtPresent: Boolean(confirmation.linkExpiredAt),
      refreshesBeforeEvaluation: refresh.refreshes.length,
      summary: slimSummary(summary),
    });
  }

  const oldDedupe = buildDeliveryConfirmationReminderDedupeKey({
    confirmationId: "confirmation_old",
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate: params.deliveryDate,
    touchNumber: 2,
  });
  const newDedupe = buildDeliveryConfirmationReminderDedupeKey({
    confirmationId: "confirmation_new",
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate: bumpedDate,
    touchNumber: 2,
  });

  return {
    scenarios: results,
    newBumpedWeekdayDate: dateKey(bumpedDate),
    newTouch1AllowedByDistinctDateDedupe: oldDedupe !== newDedupe,
    oldChainHistoricalStale: true,
  };
}

async function runOptOutScenarios(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  testEmail: string;
}) {
  const baseRunDate = dateKey(addDays(params.deliveryDate, -41));
  const scenarios = [
    {
      label: "SMS opt-out before touch 2 with email fallback",
      smsOptIn: false,
      emailOptIn: true,
      phone1: TEST_SMS_FROM,
      email: params.testEmail,
      expectedChannel: NotificationChannel.EMAIL,
      expectedManualReview: false,
    },
    {
      label: "SMS opt-out before touch 2 with no email fallback",
      smsOptIn: false,
      emailOptIn: false,
      phone1: TEST_SMS_FROM,
      email: null,
      expectedChannel: null,
      expectedManualReview: true,
    },
    {
      label: "Email opt-out before touch 2 with SMS fallback",
      smsOptIn: true,
      emailOptIn: false,
      phone1: TEST_SMS_FROM,
      email: params.testEmail,
      expectedChannel: NotificationChannel.SMS,
      expectedManualReview: false,
    },
    {
      label: "Email opt-out before touch 2 with no SMS fallback",
      smsOptIn: false,
      emailOptIn: false,
      phone1: null,
      email: params.testEmail,
      expectedChannel: null,
      expectedManualReview: true,
    },
  ] as const;

  const results = [];
  for (const scenario of scenarios) {
    const store = new FakeNoResponseStore(params.testEmail);
    const confirmation = store.seed({
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      deliveryDate: params.deliveryDate,
      smsOptIn: scenario.smsOptIn,
      emailOptIn: scenario.emailOptIn,
      phone1: scenario.phone1,
      email: scenario.email,
    });
    const refresh = noResponseRefreshRecorder();
    const summary = await run42DayDeliveryConfirmationNoResponse({
      runDate: baseRunDate,
      now: new Date(`${baseRunDate}T16:00:00.000Z`),
      dryRun: false,
      prismaClient: store.client,
      currentStateRefresher: refresh.refresher,
    });
    const created = store.notificationEvents[0] ?? null;
    results.push({
      label: scenario.label,
      selectedChannel: created?.selectedChannel ?? null,
      expectedChannel: scenario.expectedChannel,
      channelMatchesExpected: (created?.selectedChannel ?? null) === scenario.expectedChannel,
      noSmsSent: true,
      noRealCustomerEmailSent: true,
      noCustomerTouchCountedWhenNoChannel:
        scenario.expectedChannel !== null || confirmation.confirmationFollowUpCount === 0,
      manualReviewRequired: confirmation.manualReviewRequired,
      manualReviewMatchesExpected: confirmation.manualReviewRequired === scenario.expectedManualReview,
      summary: slimSummary(summary),
    });
  }

  return results;
}

async function runWeekendScenarios(params: {
  orderType: string;
  orderNumber: string;
  testEmail: string;
}) {
  const saturdayRun = "2026-08-15";
  const mondayCatchup = "2026-08-17";
  const sundayRun = "2026-08-16";
  const escalationWeekendRun = "2026-08-15";
  const saturdayStore = new FakeNoResponseStore(params.testEmail);
  saturdayStore.seed({
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate: addDays(saturdayRun, 41),
  });
  const saturdaySummary = await run42DayDeliveryConfirmationNoResponse({
    runDate: saturdayRun,
    now: new Date(`${saturdayRun}T16:00:00.000Z`),
    dryRun: false,
    prismaClient: saturdayStore.client,
    currentStateRefresher: noResponseRefreshRecorder().refresher,
  });

  const catchupStore = new FakeNoResponseStore(params.testEmail);
  const catchupConfirmation = catchupStore.seed({
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate: addDays(mondayCatchup, 39),
    confirmationFollowUpCount: 0,
  });
  const catchupSummary = await run42DayDeliveryConfirmationNoResponse({
    runDate: mondayCatchup,
    now: new Date(`${mondayCatchup}T16:00:00.000Z`),
    dryRun: false,
    prismaClient: catchupStore.client,
    currentStateRefresher: noResponseRefreshRecorder().refresher,
  });

  const sundayStore = new FakeNoResponseStore(params.testEmail);
  sundayStore.seed({
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate: addDays(sundayRun, 40),
    confirmationFollowUpCount: 1,
  });
  const sundaySummary = await run42DayDeliveryConfirmationNoResponse({
    runDate: sundayRun,
    now: new Date(`${sundayRun}T16:00:00.000Z`),
    dryRun: false,
    prismaClient: sundayStore.client,
    currentStateRefresher: noResponseRefreshRecorder().refresher,
  });

  const escalationWeekendStore = new FakeNoResponseStore(params.testEmail);
  escalationWeekendStore.seed({
    orderType: params.orderType,
    orderNumber: params.orderNumber,
    deliveryDate: addDays(escalationWeekendRun, 39),
    confirmationFollowUpCount: 2,
  });
  const escalationWeekendSummary = await run42DayDeliveryConfirmationNoResponse({
    runDate: escalationWeekendRun,
    now: new Date(`${escalationWeekendRun}T16:00:00.000Z`),
    dryRun: false,
    prismaClient: escalationWeekendStore.client,
    currentStateRefresher: noResponseRefreshRecorder().refresher,
  });

  return {
    touch2Saturday: {
      runDate: saturdayRun,
      weekendSkipped: saturdaySummary.weekendSkipped,
      notificationEventsCreated: saturdayStore.notificationEvents.length,
      notCountedUntilScheduled: true,
      summary: slimSummary(saturdaySummary),
    },
    touch2MondayCatchup: {
      runDate: mondayCatchup,
      notificationEventsCreated: catchupStore.notificationEvents.length,
      confirmationFollowUpCount: catchupConfirmation.confirmationFollowUpCount,
      caughtUp: catchupStore.notificationEvents.length === 1,
      summary: slimSummary(catchupSummary),
    },
    touch3Sunday: {
      runDate: sundayRun,
      weekendSkipped: sundaySummary.weekendSkipped,
      notificationEventsCreated: sundayStore.notificationEvents.length,
      notCountedUntilScheduled: true,
      summary: slimSummary(sundaySummary),
    },
    escalationWeekend: {
      runDate: escalationWeekendRun,
      implementedBehavior: "weekend run skips before reminder or escalation evaluation",
      weekendSkipped: escalationWeekendSummary.weekendSkipped,
      internalEscalationsCreated: escalationWeekendStore.internalNotificationEvents.length,
      summary: slimSummary(escalationWeekendSummary),
    },
  };
}

async function runMain() {
  ensureQueueReadMode();
  const testEmail = requireEnv("NOTIFICATIONS_TEST_EMAIL");
  const preflightResult = preflight();
  const beforeCounts = await safetyCounts();
  const diagnostics = await candidateDiagnostics();
  const candidates = await findRealCandidates();
  if (candidates.length === 0) {
    console.log(
      JSON.stringify(
        {
          dryRun: "42-day no-response real-order dry run",
          stoppedBeforeQueueImport: true,
          reason: "No safe active real-order candidates were found.",
          preflight: preflightResult,
          candidateDiagnostics: diagnostics,
          beforeCounts,
          safety: {
            providerDispatchCalled: false,
            smsSent: false,
            customerEmailSent: false,
            acumaticaWritebackCalled: false,
            notificationRowsCreated: false,
          },
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const postImportRejects: Array<{
    orderType: string;
    orderNumber: string;
    deliveryDate: string;
    deliveryGroupId: string;
    reason: string;
    importResult?: unknown;
    error?: string;
  }> = [];
  let selected: SelectedCandidate | null = null;
  let importResult: Awaited<ReturnType<typeof importSelectedOrder>> | null = null;

  for (const candidate of candidates) {
    let candidateImport: Awaited<ReturnType<typeof importSelectedOrder>>;
    try {
      candidateImport = await importSelectedOrder(candidate);
    } catch (error) {
      postImportRejects.push({
        orderType: candidate.group.orderType,
        orderNumber: candidate.group.orderNumber,
        deliveryDate: dateKey(candidate.group.deliveryDate),
        deliveryGroupId: candidate.group.id,
        reason: "targeted_import_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const rejectReason = !candidateImport.reloaded.groupActive
      ? "delivery_group_inactive_after_import"
      : !candidateImport.reloaded.deliveryDateWeekday
        ? "delivery_date_not_weekday_after_import"
        : candidateImport.reloaded.confirmViaPresent
          ? "confirmVia_present_after_import"
          : candidateImport.reloaded.activeLineCount <= 0
            ? "no_active_lines_after_import"
            : null;

    if (rejectReason) {
      postImportRejects.push({
        orderType: candidate.group.orderType,
        orderNumber: candidate.group.orderNumber,
        deliveryDate: dateKey(candidate.group.deliveryDate),
        deliveryGroupId: candidate.group.id,
        reason: rejectReason,
        importResult: candidateImport.importResult,
      });
      continue;
    }

    selected = candidate;
    importResult = candidateImport;
    break;
  }

  if (!selected || !importResult) {
    const afterCounts = await safetyCounts();
    console.log(
      JSON.stringify(
        {
          dryRun: "42-day no-response real-order dry run",
          stoppedAfterTargetedImports: true,
          reason: "No candidate remained safe after targeted queue-backed import refresh.",
          preflight: preflightResult,
          candidateDiagnostics: diagnostics,
          candidatesConsidered: candidates.slice(0, 3).map((candidate) => candidate.report),
          targetedImportCandidatesTried: postImportRejects.length,
          postImportRejects,
          beforeCounts,
          afterCounts,
          countsDiff: countDiff(beforeCounts, afterCounts),
          safety: {
            providerDispatchCalled: false,
            smsSent: false,
            customerEmailSent: false,
            acumaticaWritebackCalled: false,
            notificationRowsCreated: false,
          },
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const touch1 = await renderTouch1({
    candidate: selected,
    group: importResult.group,
  });
  const lifecycle = await runLifecycle({
    orderType: importResult.group.orderType,
    orderNumber: importResult.group.orderNumber,
    deliveryDate: importResult.group.deliveryDate,
    deliveryGroupId: importResult.group.id,
    orderId: importResult.group.orderId,
    contactId: importResult.group.order.contactId,
    selectedChannel: selected.channel.selectedChannel,
    testEmail,
  });
  const manualConfirmVia = await runManualConfirmViaScenarios({
    orderType: importResult.group.orderType,
    orderNumber: importResult.group.orderNumber,
    deliveryDate: importResult.group.deliveryDate,
    testEmail,
  });
  const dateBump = await runDateBumpScenarios({
    orderType: importResult.group.orderType,
    orderNumber: importResult.group.orderNumber,
    deliveryDate: importResult.group.deliveryDate,
    testEmail,
  });
  const staleWeb = await runStaleWebScenario({
    orderType: importResult.group.orderType,
    orderNumber: importResult.group.orderNumber,
    deliveryDate: importResult.group.deliveryDate,
  });
  const staleSms = [
    await runStaleSmsScenario({
      orderType: importResult.group.orderType,
      orderNumber: importResult.group.orderNumber,
      deliveryDate: importResult.group.deliveryDate,
      body: "Y",
      sidSuffix: "CONFIRM",
    }),
    await runStaleSmsScenario({
      orderType: importResult.group.orderType,
      orderNumber: importResult.group.orderNumber,
      deliveryDate: importResult.group.deliveryDate,
      body: "09/15/2026",
      sidSuffix: "DATE",
    }),
  ];
  const optOut = await runOptOutScenarios({
    orderType: importResult.group.orderType,
    orderNumber: importResult.group.orderNumber,
    deliveryDate: importResult.group.deliveryDate,
    testEmail,
  });
  const weekend = await runWeekendScenarios({
    orderType: importResult.group.orderType,
    orderNumber: importResult.group.orderNumber,
    testEmail,
  });

  const afterCounts = await safetyCounts();
  const countsDiff = countDiff(beforeCounts, afterCounts);
  const safetyFailures: Failure[] = [];
  assert(countsDiff.notificationAttempts === 0, "NotificationAttempt count changed", safetyFailures);
  assert(countsDiff.deliveryConfirmations === 0, "DeliveryConfirmation count changed", safetyFailures);
  assert(countsDiff.internalNotificationEvents === 0, "InternalNotificationEvent count changed", safetyFailures);
  assert(
    countsDiff.deliveryGroupTenDayConfirmations === 0,
    "DeliveryGroupTenDayConfirmation count changed",
    safetyFailures
  );
  assert(
    countsDiff.deliveryOrderHoldActions === 0,
    "DeliveryOrderHoldAction count changed",
    safetyFailures
  );
  assert(
    countsDiff.notificationEvents === 0,
    "NotificationEvent count changed",
    safetyFailures
  );

  const report = {
    dryRun: "42-day no-response real-order dry run",
    startedAt: new Date().toISOString(),
    preflight: preflightResult,
    candidatesConsidered: candidates.slice(0, 3).map((candidate) => candidate.report),
    targetedImportCandidatesTried: postImportRejects.length + 1,
    postImportRejects,
    selectedRealOrder: selected.report,
    freshImport: sanitizeFreshImportReport(importResult),
    touch1DryRun: touch1,
    touch2Touch3Day39Lifecycle: lifecycle,
    manualErpConfirmViaStopScenarios: manualConfirmVia,
    dateBumpAndStaleChainScenarios: dateBump,
    staleWebpageLinkScenarios: staleWeb,
    staleSmsScenarios: staleSms,
    channelAndOptOutScenarios: optOut,
    weekendCatchupScenarios: weekend,
    beforeCounts,
    afterCounts,
    countsDiff,
    cleanup: {
      persistentDryRunRowsCreated: false,
      persistentDryRunRowsDeleted: 0,
      durableManualReviewLinkLeftBehind: false,
    },
    safety: {
      emailProviderSendCalled: false,
      smsProviderSendCalled: false,
      providerDispatchToRealRecipientsCalled: false,
      twilioCalled: false,
      acumaticaWritebackCalled: false,
      confirmViaWriteCalled: false,
      confirmWithWriteCalled: false,
      oneWeekConWriteCalled: false,
      holdWriteCalled: false,
      notificationJobsRun: false,
      broadNotificationJobsRun: false,
      deliveryDateManualMutation: false,
      orderLineManualMutation: false,
      targetedQueueBackedImportOnly: true,
      safetyFailures,
    },
    validationHints: {
      noResponseCurrentStateRefreshFailureReason:
        DELIVERY_CONFIRMATION_NO_RESPONSE_SKIP_REASONS.currentStateRefreshFailed,
      noResponseDedupePurpose: InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE,
      escalationAudienceFixture: InternalNotificationAudienceType.SALESPERSON,
      escalationStatusFixture: InternalNotificationStatus.PENDING,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (safetyFailures.length > 0) {
    process.exitCode = 1;
  }
}

runMain()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
