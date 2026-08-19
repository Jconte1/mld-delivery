import ExcelJS from "exceljs";
import { mkdir } from "fs/promises";
import path from "path";

import {
  DeliveryConfirmationStatus,
  DeliveryOrderHoldActionReason,
  DeliveryOrderHoldActionStatus,
  InternalOrderLifecycleStatus,
  NotificationActionType,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  getDeliveryGroupPaymentEvaluation,
  isEligibleDeliveryPaymentTerm,
  isMeaningfulDeliveryPaymentAmount,
  normalizeDeliveryPaymentTerms,
  type DeliveryGroupPaymentEvaluation,
} from "../lib/delivery-payment/deliveryGroupPayment";
import { getDeliveryGroupReadiness } from "../lib/delivery-readiness/orderLineReadiness";
import {
  importSalesOrdersForLineRequestedOn,
  type ImportSalesOrdersResult,
} from "../lib/erp/importSalesOrders";
import {
  deliveryItemEtaDisplay,
  deliveryItemStatusDisplay,
  shouldSuppressDeliveryItemCustomerEtaAndStatus,
} from "../app/delivery/components/DeliveryItemsForThisDelivery";
import {
  buildDeliveryConfirmationLink,
  buildShortDeliveryConfirmationLink,
} from "../lib/notifications/deliveryConfirmationLinks";
import { render42DayEmailConfirmationMessage } from "../lib/notifications/deliveryConfirmationEmail";
import {
  render42DaySmsConfirmationMessage,
} from "../lib/notifications/deliveryConfirmationSms";
import { renderDeliveryReminderEmailBody } from "../lib/notifications/deliveryReminderEmail";
import {
  buildNotificationDedupeKey,
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getDeliveryDateCustomerNotificationSkipReason,
  getNotificationTargetDate,
  renderDeliveryReminderEmailSubject,
  renderDeliveryReminderMessage,
  selectNotificationChannel,
  shouldSkipNotificationRunForWeekend,
} from "../lib/notifications/helpers";
import { render30DayDeliveryReminderEmail, render30DayDeliveryReminderSms } from "../lib/notifications/deliveryReminder30Day";
import { render14DayDeliveryReminderEmail, render14DayDeliveryReminderSms } from "../lib/notifications/deliveryReminder14Day";
import {
  DELIVERY_PAYMENT_REQUEST_10_DAY_SKIP_REASONS,
  get10DayPaymentSkipReason,
  requestedOnFor10DayTargetDate,
} from "../lib/notifications/create10DayDeliveryPaymentRequestEvents";
import {
  DELIVERY_PAYMENT_REQUEST_12_DAY_SKIP_REASONS,
  get12DayPaymentSkipReason,
  requestedOnFor12DayTargetDate,
} from "../lib/notifications/create12DayDeliveryPaymentRequestEvents";
import {
  DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS,
  get8DayPaymentEnforcementSkipReason,
  requestedOnFor8DayTargetDate,
} from "../lib/notifications/create8DayPaymentEnforcementEvents";
import {
  DELIVERY_REMINDER_2_DAY_SKIP_REASONS,
  hasRequired2DayOneWeekConfirmation,
  requestedOnFor2DayTargetDate,
} from "../lib/notifications/create2DayDeliveryReminderEvents";
import {
  render2DayDeliveryReminderEmail,
  render2DayDeliveryReminderSms,
} from "../lib/notifications/deliveryReminder2Day";
import {
  DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON,
  requestedOnFor30DayTargetDate,
} from "../lib/notifications/create30DayDeliveryReminderEvents";
import { requestedOnFor14DayTargetDate } from "../lib/notifications/create14DayDeliveryReminderEvents";
import { getRequestedDeliveryDateRouteNote } from "../lib/notifications/deliveryDateEligibility";
import {
  evaluateAndRecordDeliveryTenDayConfirmation,
  type DeliveryTenDayConfirmationEvaluationResult,
} from "../lib/notifications/deliveryTenDayConfirmation";
import {
  render10DayDeliveryPaymentReminderEmail,
  render10DayDeliveryPaymentReminderSms,
} from "../lib/notifications/deliveryPaymentReminder10Day";
import {
  render12DayDeliveryPaymentReminderEmail,
  render12DayDeliveryPaymentReminderSms,
} from "../lib/notifications/deliveryPaymentReminder12Day";
import {
  render8DayPaymentEnforcementCustomerEmail,
  render8DayPaymentEnforcementCustomerSms,
} from "../lib/notifications/deliveryPaymentEnforcement8Day";
import { getPaymentDeadlineDate } from "../lib/notifications/paymentDeadlineBusinessDays";
import { getActiveSalespersonContactMap } from "../lib/notifications/salespersonContactCache";
import {
  loadActiveNotificationOptOutAddresses,
  mergeNotificationOptOutAddresses,
  type ActiveNotificationOptOutAddresses,
} from "../lib/notifications/notificationOptOutLookup";
import {
  normalizeEmailForOptOut,
  normalizeSmsPhoneForOptOut,
} from "../lib/notifications/notificationAddressNormalization";
import { prisma } from "../lib/prisma";

type IntervalKey = "180" | "90" | "60" | "42" | "30" | "14" | "12" | "10" | "8" | "2";
type ChannelKey = "EMAIL" | "SMS";
type Row = Record<string, unknown>;

type CliOptions = {
  testRunId: string;
  preview: boolean;
  applyRuntimeEvents: boolean;
  sendTestRecipients: boolean;
  maxPerIntervalChannel: number;
  output: string;
  runDate: string;
  interval: IntervalKey | null;
  confirmResetPhrase: string | null;
};

type IntervalConfig = {
  key: IntervalKey;
  label: string;
  days: number;
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
  requestedOn: (targetDeliveryDate: string) => string;
  category: "early_reminder" | "confirmation" | "confirmed_reminder" | "payment_request" | "payment_enforcement" | "final_reminder";
};

type RuntimeCounts = Awaited<ReturnType<typeof runtimeCounts>>;
type DeliveryGroupRecord = Awaited<ReturnType<typeof loadDeliveryGroupsForTargetDate>>[number];
type SalespersonMap = Awaited<ReturnType<typeof getActiveSalespersonContactMap>>;
type PaymentReport = {
  evaluation: DeliveryGroupPaymentEvaluation | null;
  error: string | null;
};

type CandidateRows = {
  intervalResultRows: Row[];
  selectedExampleRows: Row[];
  renderRows: Row[];
  deliveryGroupRows: Row[];
  itemRows: Row[];
  paymentRows: Row[];
  contactRows: Row[];
  skipRows: Row[];
  writebackRows: Row[];
};

type ImportRunResult = {
  interval: IntervalConfig;
  targetDeliveryDate: string;
  requestedOn: string;
  skippedReason: string | null;
  result: ImportSalesOrdersResult | null;
  error: string | null;
  activeDeliveryGroupCount: number | null;
};

const REQUESTED_ON_TIME = "09:19:00.000Z";
const PREVIEW_DETAILS_LINK_PREFIX = "preview-dd";
const PREVIEW_CONFIRMATION_LINK_PREFIX = "preview-dc42";

const INTERVALS: IntervalConfig[] = [
  {
    key: "180",
    label: "180-day reminder",
    days: 180,
    intervalType: NotificationIntervalType.DAY_180,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    requestedOn: requestedOnForStandardTargetDate,
    category: "early_reminder",
  },
  {
    key: "90",
    label: "90-day reminder",
    days: 90,
    intervalType: NotificationIntervalType.DAY_90,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    requestedOn: requestedOnForStandardTargetDate,
    category: "early_reminder",
  },
  {
    key: "60",
    label: "60-day reminder",
    days: 60,
    intervalType: NotificationIntervalType.DAY_60,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    requestedOn: requestedOnForStandardTargetDate,
    category: "early_reminder",
  },
  {
    key: "42",
    label: "42-day confirmation request",
    days: 42,
    intervalType: NotificationIntervalType.DAY_42,
    actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    requestedOn: requestedOnForStandardTargetDate,
    category: "confirmation",
  },
  {
    key: "30",
    label: "30-day delivery reminder",
    days: 30,
    intervalType: NotificationIntervalType.DAY_30,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    requestedOn: requestedOnFor30DayTargetDate,
    category: "confirmed_reminder",
  },
  {
    key: "14",
    label: "14-day delivery reminder",
    days: 14,
    intervalType: NotificationIntervalType.DAY_14,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    requestedOn: requestedOnFor14DayTargetDate,
    category: "confirmed_reminder",
  },
  {
    key: "12",
    label: "12-day payment request",
    days: 12,
    intervalType: NotificationIntervalType.DAY_12,
    actionType: NotificationActionType.PAYMENT_REQUEST,
    requestedOn: requestedOnFor12DayTargetDate,
    category: "payment_request",
  },
  {
    key: "10",
    label: "10-day payment request",
    days: 10,
    intervalType: NotificationIntervalType.DAY_10,
    actionType: NotificationActionType.PAYMENT_REQUEST,
    requestedOn: requestedOnFor10DayTargetDate,
    category: "payment_request",
  },
  {
    key: "8",
    label: "8-day payment enforcement",
    days: 8,
    intervalType: NotificationIntervalType.DAY_8,
    actionType: NotificationActionType.PAYMENT_ENFORCEMENT,
    requestedOn: requestedOnFor8DayTargetDate,
    category: "payment_enforcement",
  },
  {
    key: "2",
    label: "2-day final delivery reminder",
    days: 2,
    intervalType: NotificationIntervalType.DAY_2,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    requestedOn: requestedOnFor2DayTargetDate,
    category: "final_reminder",
  },
];

function requestedOnForStandardTargetDate(targetDeliveryDate: string) {
  return `${targetDeliveryDate}T${REQUESTED_ON_TIME}`;
}

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function envPresent(name: string) {
  return envValue(name).length > 0;
}

function normalizeFlag(value: string) {
  return value.trim().toLowerCase();
}

function flagIsTrue(name: string) {
  return normalizeFlag(envValue(name)) === "true";
}

function queueModeIsExplicitlyEnabled() {
  return ["true", "1", "yes", "y", "on"].includes(normalizeFlag(envValue("USE_QUEUE_ERP")));
}

function requireEnv(name: string, failures: string[]) {
  if (!envPresent(name)) {
    failures.push(`Missing env var: ${name}`);
  }
}

function redactedEmail(value: string) {
  const [local, domain] = value.split("@");
  if (!domain) return "<redacted>";
  return `${local.slice(0, 1)}***@${domain}`;
}

function redactedPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***-***-${digits.slice(-4)}`;
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

function isDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dateKey(dateFromKey(value)) === value;
}

function parseInterval(value: string): IntervalKey {
  const cleaned = value.trim().toUpperCase().replace(/^DAY_/, "") as IntervalKey;
  if (!INTERVALS.some((interval) => interval.key === cleaned)) {
    throw new Error(`Invalid --interval value ${value}. Expected one of ${INTERVALS.map((interval) => interval.key).join(", ")}.`);
  }
  return cleaned;
}

function readFlagValue(args: string[], index: number) {
  const current = args[index];
  const equalsIndex = current.indexOf("=");
  if (equalsIndex !== -1) {
    return { value: current.slice(equalsIndex + 1), nextIndex: index };
  }
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`Missing value for ${current}`);
  }
  return { value: next, nextIndex: index + 1 };
}

function parseArgs(args: string[]): CliOptions {
  const options: Omit<CliOptions, "output"> & { output: string | null } = {
    testRunId: "",
    preview: true,
    applyRuntimeEvents: false,
    sendTestRecipients: false,
    maxPerIntervalChannel: 3,
    output: null,
    runDate: todayInMountainTime(),
    interval: null,
    confirmResetPhrase: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--preview") {
      options.preview = true;
      continue;
    }
    if (arg === "--apply-runtime-events") {
      options.applyRuntimeEvents = true;
      continue;
    }
    if (arg === "--send-test-recipients") {
      options.sendTestRecipients = true;
      continue;
    }
    if (arg === "--no-preview") {
      options.preview = false;
      continue;
    }
    if (arg === "--reset" || arg === "--destructive-reset") {
      throw new Error("Destructive reset is not implemented in Phase 1.");
    }
    if (arg.startsWith("--test-run-id")) {
      const read = readFlagValue(args, index);
      options.testRunId = read.value.trim();
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith("--max-per-interval-channel")) {
      const read = readFlagValue(args, index);
      const value = Number(read.value);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--max-per-interval-channel must be a positive integer.");
      }
      options.maxPerIntervalChannel = value;
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith("--output")) {
      const read = readFlagValue(args, index);
      options.output = read.value.trim();
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith("--run-date")) {
      const read = readFlagValue(args, index);
      options.runDate = dateKey(read.value);
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith("--interval")) {
      const read = readFlagValue(args, index);
      options.interval = parseInterval(read.value);
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith("--confirm-reset-phrase")) {
      const read = readFlagValue(args, index);
      options.confirmResetPhrase = read.value;
      index = read.nextIndex;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.testRunId) {
    throw new Error("Missing required --test-run-id <id>.");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(options.testRunId)) {
    throw new Error("--test-run-id may contain only letters, numbers, underscores, periods, and dashes.");
  }
  if (!isDateKey(options.runDate)) {
    throw new Error(`Invalid --run-date: ${options.runDate}`);
  }
  if (!options.preview && !options.applyRuntimeEvents) {
    throw new Error("--no-preview requires --apply-runtime-events, which is not implemented in Phase 1.");
  }

  return {
    ...options,
    output:
      options.output ??
      path.join("artifacts", `delivery-interval-test-${options.testRunId}.xlsx`),
  };
}

function preflight(options: CliOptions) {
  const failures: string[] = [];
  const required = [
    "DATABASE_URL",
    "USE_QUEUE_ERP",
    "MLD_QUEUE_BASE_URL",
    "MLD_QUEUE_TOKEN",
    "DELIVERY_APP_BASE_URL",
    "NOTIFICATIONS_TEST_EMAIL",
    "NOTIFICATIONS_TEST_PHONE",
  ];
  for (const name of required) requireEnv(name, failures);

  if (!queueModeIsExplicitlyEnabled()) {
    failures.push("USE_QUEUE_ERP must be true/truthy so direct Acumatica fallback cannot be used.");
  }

  const deliveryBaseUrl = envValue("DELIVERY_APP_BASE_URL");
  if (/localhost|127\.0\.0\.1|::1/i.test(deliveryBaseUrl)) {
    failures.push(`DELIVERY_APP_BASE_URL must not be localhost for production-style tests: ${deliveryBaseUrl}`);
  }

  for (const name of [
    "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN",
    "DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN",
    "DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN",
    "DELIVERY_PREPAYMENT_HOLD_DRY_RUN",
  ]) {
    if (!flagIsTrue(name)) {
      failures.push(`${name} must be exactly true for Phase 1.`);
    }
  }

  if (options.applyRuntimeEvents) {
    failures.push("--apply-runtime-events is intentionally refused in Phase 1; preview/export only.");
  }

  if (options.sendTestRecipients) {
    if (!flagIsTrue("DEMO_NOTIFICATION_SEND_ENABLED")) {
      failures.push("DEMO_NOTIFICATION_SEND_ENABLED must be true for controlled test-recipient sends.");
    }
    for (const name of [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "MS_GRAPH_TENANT_ID",
      "MS_GRAPH_CLIENT_ID",
      "MS_GRAPH_CLIENT_SECRET",
      "MS_GRAPH_FROM_EMAIL",
    ]) {
      requireEnv(name, failures);
    }
    if (!envPresent("TWILIO_MESSAGING_SERVICE_SID") && !envPresent("TWILIO_FROM_NUMBER")) {
      failures.push("TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER is required for SMS sends.");
    }
    failures.push("--send-test-recipients is intentionally refused in Phase 1; no providers are called.");
  }

  const rows = [
    envSafetyRow("DATABASE_URL", "present", "required", "DB access"),
    envSafetyRow("USE_QUEUE_ERP", "true", "required", "prevents direct Acumatica fallback"),
    envSafetyRow("MLD_QUEUE_BASE_URL", "present", "required", "queue-backed ERP fetch/import"),
    envSafetyRow("MLD_QUEUE_TOKEN", "present", "required", "queue auth"),
    envSafetyRow("DELIVERY_APP_BASE_URL", "present, non-localhost", "required", "customer-facing links"),
    envSafetyRow("NOTIFICATIONS_TEST_EMAIL", "present", "required", "future email test recipient"),
    envSafetyRow("NOTIFICATIONS_TEST_PHONE", "present", "required", "future SMS test recipient"),
    envSafetyRow("DEMO_NOTIFICATION_SEND_ENABLED", "true only with future send flag", "optional", "provider send gate"),
    envSafetyRow("TWILIO_ACCOUNT_SID", "present only with future send flag", "optional", "Twilio SMS"),
    envSafetyRow("TWILIO_AUTH_TOKEN", "present only with future send flag", "optional", "Twilio SMS"),
    envSafetyRow("TWILIO_MESSAGING_SERVICE_SID", "present or TWILIO_FROM_NUMBER with future send flag", "optional", "Twilio SMS source"),
    envSafetyRow("TWILIO_FROM_NUMBER", "present or TWILIO_MESSAGING_SERVICE_SID with future send flag", "optional", "Twilio SMS source"),
    envSafetyRow("TWILIO_WEBHOOK_VALIDATE_SIGNATURES", "true in production", "advisory", "inbound webhook validation"),
    envSafetyRow("DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN", "true", "required", "CONFIRMVIA/CONFIRMWTH writeback block"),
    envSafetyRow("DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN", "true", "required", "Contact opt-out writeback block"),
    envSafetyRow("DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN", "true", "required", "ONEWEEKCON writeback block"),
    envSafetyRow("DELIVERY_PREPAYMENT_HOLD_DRY_RUN", "true", "required", "prepayment hold write block"),
  ];

  if (failures.length > 0) {
    const error = new Error(`Preflight failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
    Object.assign(error, { preflightRows: rows });
    throw error;
  }

  return {
    passed: true,
    rows,
    testEmailRedacted: redactedEmail(envValue("NOTIFICATIONS_TEST_EMAIL")),
    testPhoneRedacted: redactedPhone(envValue("NOTIFICATIONS_TEST_PHONE")),
  };
}

function envSafetyRow(
  name: string,
  requiredValue: string,
  requirement: string,
  purpose: string
): Row {
  const raw = envValue(name);
  const secret = /TOKEN|SECRET|PASSWORD|AUTH/i.test(name);
  return {
    name,
    requirement,
    requiredValue,
    actualValue: secret && raw ? "<redacted>" : raw || "<missing>",
    present: Boolean(raw),
    purpose,
  };
}

async function runtimeCounts() {
  const [
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    deliveryDetailsLinks,
    deliveryOrderHoldActions,
    internalNotificationEvents,
    contactOptInWritebackActions,
    twilioInboundMessages,
    twilioMessageStatusCallbacks,
  ] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
    prisma.deliveryDetailsLink.count(),
    prisma.deliveryOrderHoldAction.count(),
    prisma.internalNotificationEvent.count(),
    prisma.contactOptInWritebackAction.count(),
    prisma.twilioInboundMessage.count(),
    prisma.twilioMessageStatusCallback.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    deliveryDetailsLinks,
    deliveryOrderHoldActions,
    internalNotificationEvents,
    contactOptInWritebackActions,
    twilioInboundMessages,
    twilioMessageStatusCallbacks,
  };
}

function countDeltaRows(before: RuntimeCounts, after: RuntimeCounts): Row[] {
  return Object.keys(before).map((key) => ({
    table: key,
    before: before[key as keyof RuntimeCounts],
    after: after[key as keyof RuntimeCounts],
    delta: after[key as keyof RuntimeCounts] - before[key as keyof RuntimeCounts],
  }));
}

async function loadDeliveryGroupsForTargetDate(targetDeliveryDate: string) {
  return prisma.orderDeliveryGroup.findMany({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      isActive: true,
      deliveryGroupLines: { some: { isActive: true } },
    },
    orderBy: [{ orderNumber: "asc" }, { id: "asc" }],
    include: {
      tenDayConfirmation: {
        select: {
          localConfirmed: true,
          acumaticaWritebackStatus: true,
          mismatchReason: true,
        },
      },
      deliveryOrderHoldActions: {
        where: {
          reason: DeliveryOrderHoldActionReason.PAYMENT_NOT_RECEIVED_BY_DEADLINE,
        },
        select: {
          id: true,
          status: true,
          queueJobId: true,
          errorMessage: true,
          customerNotificationEventId: true,
        },
      },
      order: {
        include: {
          address: true,
          total: true,
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
        },
      },
    },
  });
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

function isGroupProductionActive(group: DeliveryGroupRecord) {
  return !(
    isCompletedOrCancelledStatus(group.order.status) ||
    isCompletedOrCancelledStatus(group.status) ||
    isBlockedLifecycleStatus(group.order.internalLifecycleStatus)
  );
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function safeJobAddress(address: DeliveryGroupRecord["order"]["address"]) {
  return formatJobAddress(address ?? {}) || "the job site";
}

function confirmationPreviewToken(options: CliOptions, group: DeliveryGroupRecord) {
  return `${PREVIEW_CONFIRMATION_LINK_PREFIX}-${options.testRunId}-${group.id}`.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function detailsPreviewToken(options: CliOptions, group: DeliveryGroupRecord) {
  return `${PREVIEW_DETAILS_LINK_PREFIX}-${options.testRunId}-${group.id}`.replace(/[^A-Za-z0-9_.-]/g, "-");
}

async function readExistingDetailsLink(group: DeliveryGroupRecord, options: CliOptions) {
  const existing = await prisma.deliveryDetailsLink.findUnique({
    where: {
      orderDeliveryGroupId_deliveryDate: {
        orderDeliveryGroupId: group.id,
        deliveryDate: dateFromKey(group.deliveryDate),
      },
    },
    select: { id: true, token: true },
  });

  return {
    id: existing?.id ?? null,
    url: existing
      ? `${envValue("DELIVERY_APP_BASE_URL").replace(/\/+$/, "")}/delivery/details/${encodeURIComponent(existing.token)}`
      : `${envValue("DELIVERY_APP_BASE_URL").replace(/\/+$/, "")}/delivery/details/${encodeURIComponent(detailsPreviewToken(options, group))}`,
    exists: Boolean(existing),
  };
}

async function readExisting42Confirmation(group: DeliveryGroupRecord) {
  return prisma.deliveryConfirmation.findUnique({
    where: {
      deliveryGroupId_deliveryDate: {
        deliveryGroupId: group.id,
        deliveryDate: dateFromKey(group.deliveryDate),
      },
    },
    select: {
      id: true,
      status: true,
      linkToken: true,
    },
  });
}

async function readExistingEvent(config: IntervalConfig, group: DeliveryGroupRecord, dedupeKey: string) {
  return prisma.notificationEvent.findUnique({
    where: { dedupeKey },
    select: {
      id: true,
      status: true,
      selectedChannel: true,
      reasonSkipped: true,
      detailsLinkId: true,
    },
  });
}

function failedImportOrderKeys(importResult: ImportSalesOrdersResult | null) {
  const keys = new Set<string>();
  for (const error of importResult?.errors ?? []) {
    if (!error.orderNumber || !/failed|did not return/i.test(error.reason)) continue;
    keys.add(`${error.orderType ?? ""}:${error.orderNumber}`);
  }
  return keys;
}

function orderFailedFreshImport(group: DeliveryGroupRecord, failedKeys: Set<string>) {
  return (
    failedKeys.has(`${group.orderType}:${group.orderNumber}`) ||
    failedKeys.has(`:${group.orderNumber}`)
  );
}

function weekdayName(value: Date | string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    dateFromKey(value)
  );
}

function contactOptOutState(
  contact: DeliveryGroupRecord["order"]["contact"],
  globalOptOuts: ActiveNotificationOptOutAddresses
) {
  const merged = mergeNotificationOptOutAddresses(globalOptOuts, {
    activeSmsOptOutPhones: contact.smsOptOuts.map((optOut) => optOut.phone),
    activeEmailOptOutEmails: contact.emailOptOuts.map((optOut) => optOut.email),
  });
  const optedOutPhones = new Set(
    merged.activeSmsOptOutPhones.map(normalizeSmsPhoneForOptOut).filter(Boolean)
  );
  const optedOutEmails = new Set(
    merged.activeEmailOptOutEmails.map(normalizeEmailForOptOut).filter(Boolean)
  );
  const contactPhones = [contact.phone1, contact.phone2]
    .map(normalizeSmsPhoneForOptOut)
    .filter((value): value is string => Boolean(value));
  const contactEmail = normalizeEmailForOptOut(contact.email);

  return {
    merged,
    activeSmsOptOut: contactPhones.some((phone) => optedOutPhones.has(phone)),
    activeEmailOptOut: Boolean(contactEmail && optedOutEmails.has(contactEmail)),
  };
}

function contactChannelPreview(
  contact: DeliveryGroupRecord["order"]["contact"],
  optOutState: ReturnType<typeof contactOptOutState>
) {
  const production = selectNotificationChannel(contact, optOutState.merged);
  const smsIfOptedIn = selectNotificationChannel(
    { ...contact, smsOptIn: true, emailOptIn: false },
    optOutState.merged
  );
  const emailIfOptedIn = selectNotificationChannel(
    { ...contact, smsOptIn: false, emailOptIn: true },
    optOutState.merged
  );

  return {
    production,
    wouldHaveSelectedSmsIfOptedIn: smsIfOptedIn.selectedChannel === "SMS",
    wouldHaveSelectedEmailIfOptedIn: emailIfOptedIn.selectedChannel === "EMAIL",
  };
}

async function paymentReportForInterval(config: IntervalConfig, group: DeliveryGroupRecord): Promise<PaymentReport> {
  if (
    config.intervalType === NotificationIntervalType.DAY_14 ||
    config.intervalType === NotificationIntervalType.DAY_12 ||
    config.intervalType === NotificationIntervalType.DAY_10 ||
    config.intervalType === NotificationIntervalType.DAY_8
  ) {
    try {
      return {
        evaluation: await getDeliveryGroupPaymentEvaluation(group.id, prisma, {
          sourceInterval: config.intervalType,
          allocateFreightDeliveryCharges: true,
          dryRun: true,
        }),
        error: null,
      };
    } catch (error) {
      return {
        evaluation: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (
    config.intervalType === NotificationIntervalType.DAY_42 ||
    config.intervalType === NotificationIntervalType.DAY_30
  ) {
    try {
      return {
        evaluation: await getDeliveryGroupPaymentEvaluation(group.id, prisma),
        error: null,
      };
    } catch (error) {
      return {
        evaluation: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { evaluation: null, error: null };
}

function amountIsMeaningful(value: string | null | undefined) {
  return isMeaningfulDeliveryPaymentAmount(value);
}

function paymentReminderApplies(payment: DeliveryGroupPaymentEvaluation | null) {
  return (
    payment?.paymentStatus === "balance_due" &&
    amountIsMeaningful(payment.amountDueNowRounded) &&
    payment.calculationWarnings.length === 0
  );
}

function paymentDue(payment: DeliveryGroupPaymentEvaluation | null) {
  return paymentReminderApplies(payment);
}

function paymentSkipReason(config: IntervalConfig, group: DeliveryGroupRecord, payment: DeliveryGroupPaymentEvaluation | null) {
  const total = group.order.total;
  if (!payment) return "payment_calculation_failed";

  if (config.intervalType === NotificationIntervalType.DAY_12) {
    return get12DayPaymentSkipReason({
      hasOrderTotal: Boolean(total),
      paymentTerms: total?.paymentTerms ?? null,
      unpaidBalance: total?.unpaidBalance,
      paymentStatus: payment.paymentStatus,
      amountDueNowRounded: payment.amountDueNowRounded,
      calculationWarnings: payment.calculationWarnings,
    });
  }

  if (config.intervalType === NotificationIntervalType.DAY_10) {
    return get10DayPaymentSkipReason({
      hasOrderTotal: Boolean(total),
      paymentTerms: total?.paymentTerms ?? null,
      unpaidBalance: total?.unpaidBalance,
      paymentStatus: payment.paymentStatus,
      amountDueNowRounded: payment.amountDueNowRounded,
      calculationWarnings: payment.calculationWarnings,
    });
  }

  if (config.intervalType === NotificationIntervalType.DAY_8) {
    return get8DayPaymentEnforcementSkipReason({
      hasOrderTotal: Boolean(total),
      paymentTerms: total?.paymentTerms ?? null,
      unpaidBalance: total?.unpaidBalance,
      paymentStatus: payment.paymentStatus,
      amountDueNowRounded: payment.amountDueNowRounded,
      calculationWarnings: payment.calculationWarnings,
    });
  }

  return null;
}

async function oneWeekDryRunPreview(params: {
  config: IntervalConfig;
  group: DeliveryGroupRecord;
  payment: DeliveryGroupPaymentEvaluation;
}) {
  if (
    params.config.intervalType !== NotificationIntervalType.DAY_14 &&
    params.config.intervalType !== NotificationIntervalType.DAY_12 &&
    params.config.intervalType !== NotificationIntervalType.DAY_10 &&
    params.config.intervalType !== NotificationIntervalType.DAY_8
  ) {
    return null;
  }

  return evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: params.group,
    payment: params.payment,
    sourceInterval: params.config.intervalType,
    dryRun: true,
    prismaClient: prisma,
  });
}

function oneWeekGateValue(group: DeliveryGroupRecord) {
  if (!group.tenDayConfirmation) {
    return group.order.acumaticaOneWeekConfirmed === true ? "acumatica_true_without_local_record" : "missing";
  }
  if (hasRequired2DayOneWeekConfirmation(group)) return "passed";
  return "failed";
}

function existingHoldStatus(group: DeliveryGroupRecord) {
  return group.deliveryOrderHoldActions[0] ?? null;
}

function scenarioTags(params: {
  group: DeliveryGroupRecord;
  payment: DeliveryGroupPaymentEvaluation | null;
  readinessLines: Awaited<ReturnType<typeof getDeliveryGroupReadiness>>["lines"];
}) {
  const tags = new Set<string>();
  const address = params.group.order.address;
  if (address?.state?.trim().toUpperCase() === "WY" || address?.state?.trim().toUpperCase() === "WYOMING") {
    tags.add("wyoming");
  }
  if (["83638", "83635"].includes(address?.postalCode?.trim() ?? "")) {
    tags.add("mccall");
  }
  if (params.payment?.paymentStatus === "balance_due") tags.add("payment_due");
  if (params.payment?.paymentStatus === "no_balance_due") tags.add("no_balance_due");
  if (params.payment && isEligibleDeliveryPaymentTerm(params.payment.paymentTerms)) tags.add("prepay");
  if (params.payment && !isEligibleDeliveryPaymentTerm(params.payment.paymentTerms)) tags.add("non_prepay");
  if (params.readinessLines.some((line) => line.readinessStatus === "backordered")) tags.add("backordered");
  if (params.readinessLines.some((line) => line.readinessStatus === "eta_pending")) tags.add("eta_pending");
  if (params.readinessLines.some((line) => line.readinessStatus === "ready")) tags.add("ready");
  if (params.readinessLines.some((line) => line.readinessStatus === "complete")) tags.add("complete");
  if (params.readinessLines.some((line) => line.readinessStatus === "partially_allocated")) {
    tags.add("partial_allocation");
  }
  return [...tags].sort();
}

function eventStatusFromPreview(params: {
  businessSkipReason: string | null;
  productionChannel: ReturnType<typeof selectNotificationChannel>;
}) {
  if (params.businessSkipReason) return NotificationEventStatus.SKIPPED;
  if (params.productionChannel.selectedChannel === null) return NotificationEventStatus.SKIPPED;
  return NotificationEventStatus.SCHEDULED;
}

function channelSkipReason(params: {
  businessSkipReason: string | null;
  productionChannel: ReturnType<typeof selectNotificationChannel>;
}) {
  if (params.businessSkipReason) return params.businessSkipReason;
  return params.productionChannel.selectedChannel === null
    ? params.productionChannel.channelReason
    : null;
}

async function evaluateGroup(params: {
  config: IntervalConfig;
  group: DeliveryGroupRecord;
  options: CliOptions;
  failedFreshImport: boolean;
  globalOptOuts: ActiveNotificationOptOutAddresses;
  salespersonMap: SalespersonMap;
}): Promise<CandidateRows & { selectable: Array<{ channel: ChannelKey; rowIndex: number; tags: string[] }> }> {
  const { config, group, options } = params;
  const order = group.order;
  const contact = order.contact;
  const deliveryDate = dateKey(group.deliveryDate);
  const ineligible = !isGroupProductionActive(group);
  const deliveryDateSkipReason = getDeliveryDateCustomerNotificationSkipReason(group.deliveryDate);
  const dedupeKey = buildNotificationDedupeKey({
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: group.deliveryDate,
    intervalType: config.intervalType,
    actionType: config.actionType,
  });
  const existingEvent = await readExistingEvent(config, group, dedupeKey);
  const optOutState = contactOptOutState(contact, params.globalOptOuts);
  const channelPreview = contactChannelPreview(contact, optOutState);
  const payment = await paymentReportForInterval(config, group);
  const readiness = await getDeliveryGroupReadiness(group.id);
  const salesperson = order.salespersonNumber
    ? params.salespersonMap.get(order.salespersonNumber) ?? null
    : null;
  const detailsLink = await readExistingDetailsLink(group, options);
  const confirmation = config.intervalType === NotificationIntervalType.DAY_42
    ? await readExisting42Confirmation(group)
    : null;

  let businessSkipReason: string | null = null;
  let failureReason: string | null = payment.error;
  let tenDayPreview: DeliveryTenDayConfirmationEvaluationResult | null = null;
  let writebackPlanned = false;
  let writebackDryRun = false;

  if (params.failedFreshImport) {
    businessSkipReason = "fresh_import_failed";
  } else if (ineligible) {
    businessSkipReason = "ineligible_order_or_delivery_group_status";
  } else if (deliveryDateSkipReason) {
    businessSkipReason = deliveryDateSkipReason;
  } else if (config.intervalType === NotificationIntervalType.DAY_42) {
    if (clean(order.confirmVia)) {
      businessSkipReason = "already_confirmed_in_acumatica";
    } else if (confirmation?.status === DeliveryConfirmationStatus.CONFIRMED) {
      businessSkipReason = "already_confirmed_for_delivery_date";
    }
  } else if (
    config.intervalType === NotificationIntervalType.DAY_30 ||
    config.intervalType === NotificationIntervalType.DAY_14
  ) {
    if (!clean(order.confirmVia)) {
      businessSkipReason = DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON;
    }
  } else if (
    config.intervalType === NotificationIntervalType.DAY_12 ||
    config.intervalType === NotificationIntervalType.DAY_10 ||
    config.intervalType === NotificationIntervalType.DAY_8
  ) {
    if (!clean(order.confirmVia)) {
      businessSkipReason =
        config.intervalType === NotificationIntervalType.DAY_8
          ? DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.notConfirmedInAcumatica
          : config.intervalType === NotificationIntervalType.DAY_12
            ? DELIVERY_PAYMENT_REQUEST_12_DAY_SKIP_REASONS.notConfirmedInAcumatica
            : DELIVERY_PAYMENT_REQUEST_10_DAY_SKIP_REASONS.notConfirmedInAcumatica;
    } else {
      const skip = paymentSkipReason(config, group, payment.evaluation) as string | null;
      if (skip) businessSkipReason = skip;
      if (payment.evaluation && skip === "no_balance_due") {
        tenDayPreview = await oneWeekDryRunPreview({
          config,
          group,
          payment: payment.evaluation,
        });
        writebackPlanned = Boolean(tenDayPreview?.wouldWrite);
        writebackDryRun = Boolean(tenDayPreview);
      }
    }
  } else if (config.intervalType === NotificationIntervalType.DAY_2) {
    if (!clean(order.confirmVia)) {
      businessSkipReason = DELIVERY_REMINDER_2_DAY_SKIP_REASONS.notConfirmedInAcumatica;
    } else if (!hasRequired2DayOneWeekConfirmation(group)) {
      businessSkipReason = DELIVERY_REMINDER_2_DAY_SKIP_REASONS.oneWeekConfirmationMissing;
    }
  }

  if (
    !businessSkipReason &&
    config.intervalType === NotificationIntervalType.DAY_14 &&
    payment.evaluation
  ) {
    tenDayPreview = await oneWeekDryRunPreview({ config, group, payment: payment.evaluation });
    writebackPlanned = Boolean(tenDayPreview?.wouldWrite);
    writebackDryRun = Boolean(tenDayPreview);
  }

  if (!businessSkipReason && config.intervalType === NotificationIntervalType.DAY_8) {
    const hold = existingHoldStatus(group);
    if (hold?.status === DeliveryOrderHoldActionStatus.SUCCEEDED) {
      businessSkipReason = DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.alreadyEnforced;
    } else if (
      hold?.status === DeliveryOrderHoldActionStatus.PENDING ||
      hold?.status === DeliveryOrderHoldActionStatus.QUEUED
    ) {
      businessSkipReason = `existing_hold_action_${hold.status.toLowerCase()}`;
    } else if (hold?.status === DeliveryOrderHoldActionStatus.FAILED) {
      businessSkipReason = DELIVERY_PAYMENT_ENFORCEMENT_8_DAY_SKIP_REASONS.holdActionFailed;
      failureReason = hold.errorMessage ?? failureReason;
    } else {
      writebackPlanned = true;
      writebackDryRun = true;
    }
  }

  const productionStatus = eventStatusFromPreview({
    businessSkipReason,
    productionChannel: channelPreview.production,
  });
  const skipReason = channelSkipReason({
    businessSkipReason,
    productionChannel: channelPreview.production,
  });
  const businessQualified = !businessSkipReason;
  const qualified = businessQualified && channelPreview.production.selectedChannel !== null;
  const contactName = formatContactName(contact);
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const jobAddress = safeJobAddress(order.address);
  const paymentIsDue = paymentDue(payment.evaluation);
  const paymentDeadlineDate =
    config.intervalType === NotificationIntervalType.DAY_12 ||
    config.intervalType === NotificationIntervalType.DAY_10 ||
    config.intervalType === NotificationIntervalType.DAY_8
      ? dateKey(getPaymentDeadlineDate(group.deliveryDate))
      : null;
  const render = businessQualified
    ? renderMessages({
        config,
        group,
        options,
        contactName,
        jobName,
        jobAddress,
        detailsLinkUrl: detailsLink.url,
        confirmation,
        payment: payment.evaluation,
        paymentIsDue,
        paymentDeadlineDate,
        readinessLines: readiness.lines,
        salesperson,
      })
    : { emailSubject: null, emailBody: null, smsBody: null, confirmationUrl: null, shortConfirmationUrl: null, detailsUrl: null };
  const routeNote = config.intervalType === NotificationIntervalType.DAY_42
    ? getRequestedDeliveryDateRouteNote(order.address, "sms")
    : null;
  const tags = scenarioTags({ group, payment: payment.evaluation, readinessLines: readiness.lines });
  const emailCandidate = Boolean(
    businessQualified &&
      render.emailBody &&
      channelPreview.wouldHaveSelectedEmailIfOptedIn &&
      !optOutState.activeEmailOptOut
  );
  const smsCandidate = Boolean(
    businessQualified &&
      render.smsBody &&
      channelPreview.wouldHaveSelectedSmsIfOptedIn &&
      !optOutState.activeSmsOptOut
  );
  const eventWouldCreate = !existingEvent && !ineligible && !params.failedFreshImport;

  const base = {
    testRunId: options.testRunId,
    interval: config.key,
    intervalLabel: config.label,
    actionType: config.actionType,
    evaluationDate: options.runDate,
    targetDate: deliveryDate,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    orderDeliveryGroupId: group.id,
    deliveryGroupId: group.id,
    deliveryDate,
    qualified,
    businessQualified,
    skipReason,
    failureReason,
    dedupeKey,
    existingEventFound: Boolean(existingEvent),
    existingEventId: existingEvent?.id ?? null,
    existingEventStatus: existingEvent?.status ?? null,
    wouldCreateEvent: eventWouldCreate,
    previewStatus: productionStatus,
    freshImportSuccess: params.failedFreshImport ? false : true,
    orderActive: !isCompletedOrCancelledStatus(order.status) && !isBlockedLifecycleStatus(order.internalLifecycleStatus),
    deliveryGroupActive: group.isActive,
    deliveryDateWeekday: weekdayName(group.deliveryDate),
    sendDateWeekday: weekdayName(options.runDate),
    confirmedInAcumatica: Boolean(clean(order.confirmVia)),
    acumaticaConfirmVia: clean(order.confirmVia),
    localConfirmation: confirmation?.status ?? null,
    oneWeekConfirmationGate:
      config.intervalType === NotificationIntervalType.DAY_2 ? oneWeekGateValue(group) : null,
    paymentTermsEligible: payment.evaluation
      ? isEligibleDeliveryPaymentTerm(payment.evaluation.paymentTerms)
      : null,
    paymentDue: paymentIsDue,
    contactChannelEligible: channelPreview.production.selectedChannel !== null,
    selectedProductionChannel: channelPreview.production.selectedChannel,
    productionChannelReason: channelPreview.production.channelReason,
    wouldHaveSelectedSmsIfOptedIn: channelPreview.wouldHaveSelectedSmsIfOptedIn,
    wouldHaveSelectedEmailIfOptedIn: channelPreview.wouldHaveSelectedEmailIfOptedIn,
    activeSmsOptOut: optOutState.activeSmsOptOut,
    activeEmailOptOut: optOutState.activeEmailOptOut,
    testOverridePossible: emailCandidate || smsCandidate,
    testOverrideUsed: false,
    emailSubject: render.emailSubject,
    emailBody: render.emailBody,
    smsBody: render.smsBody,
    confirmationUrl: render.confirmationUrl,
    shortConfirmationUrl: render.shortConfirmationUrl,
    detailsUrl: render.detailsUrl,
    writebackPlanned,
    writebackDryRun,
    scenarioTags: tags.join(", "),
    routeNote,
  };

  const intervalResultRows = [base];
  const renderRows: Row[] = [];
  if (render.emailBody) {
    renderRows.push({
      ...base,
      channel: "EMAIL",
      subject: render.emailSubject,
      body: render.emailBody,
      actualTestRecipient: null,
      realCustomerRecipientSuppressed: true,
    });
  }
  if (render.smsBody) {
    renderRows.push({
      ...base,
      channel: "SMS",
      subject: null,
      body: render.smsBody,
      actualTestRecipient: null,
      realCustomerRecipientSuppressed: true,
    });
  }

  const paymentRows = [
    paymentRow({
      config,
      group,
      options,
      payment: payment.evaluation,
      error: payment.error,
      skipReason,
    }),
  ];

  const paymentLines = new Map(
    (payment.evaluation?.lines ?? []).map((line) => [line.lineNbr, line])
  );
  const itemRows = readiness.lines.map((line) => {
    const paymentLine = paymentLines.get(line.lineNbr);
    return {
      testRunId: options.testRunId,
      interval: config.key,
      actionType: config.actionType,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      orderDeliveryGroupId: group.id,
      deliveryDate,
      orderLineId: line.orderLineId,
      lineNbr: line.lineNbr,
      inventoryId: line.inventoryId,
      description: line.lineDescription,
      itemType: line.itemType,
      itemClass: line.itemClass,
      requestedOn: line.requestedOn,
      eta: line.eta,
      etaStatus: line.etaStatus,
      allocationStatus: line.allocationStatus,
      readinessStatus: line.readinessStatus,
      displayStatus: line.displayStatus,
      orderQty: line.orderQty,
      openQty: line.openQty,
      activeAllocatedQty: line.activeAllocatedQty,
      discountedUnitPrice: paymentLine?.discountedUnitPrice ?? null,
      extendedAmount: extendedAmount(paymentLine?.discountedUnitPrice, line.orderQty),
      belongsToSelectedDeliveryGroup: true,
      shownOnCustomerWebpage: true,
      webpageEtaDisplay: deliveryItemEtaDisplay(line),
      webpageStatusDisplay: deliveryItemStatusDisplay(line),
      inventoryIdStorageDeliveryInstallSuppressed:
        shouldSuppressDeliveryItemCustomerEtaAndStatus(line),
      stockListMatchReady: Boolean(line.externalStockReadinessMatched),
      paymentInclusionStatus: paymentLine?.payableBasisIncluded
        ? "included"
        : paymentLine
          ? "excluded"
          : null,
      paymentIncludedQuantity: paymentLine?.payableQuantity ?? null,
      paymentIncludedAmount: paymentLine?.payableStockMerchandiseValue ?? null,
      paymentExclusionReason: paymentLine?.payableBasisExclusionReason ?? null,
    };
  });

  const salespersonRow = {
    salespersonNumber: order.salespersonNumber,
    salespersonName: salesperson?.salespersonName ?? null,
    salespersonPhone: salesperson?.salespersonPhone ?? null,
    salespersonEmail: salesperson?.salespersonEmail ?? null,
  };
  const contactRows = [
    {
      testRunId: options.testRunId,
      interval: config.key,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryGroupId: group.id,
      contactId: contact.contactId,
      displayName: contact.displayName,
      firstName: contact.firstName,
      lastName: contact.lastName,
      companyName: contact.companyName,
      email: contact.email,
      phone1: contact.phone1,
      phone2: contact.phone2,
      smsOptIn: contact.smsOptIn,
      emailOptIn: contact.emailOptIn,
      phoneCallOptIn: contact.phoneCallOptIn,
      activeSmsOptOut: optOutState.activeSmsOptOut,
      activeEmailOptOut: optOutState.activeEmailOptOut,
      selectedProductionChannel: channelPreview.production.selectedChannel,
      wouldHaveSelectedSmsIfOptedIn: channelPreview.wouldHaveSelectedSmsIfOptedIn,
      wouldHaveSelectedEmailIfOptedIn: channelPreview.wouldHaveSelectedEmailIfOptedIn,
      actualTestEmailRecipient: null,
      actualTestSmsRecipient: null,
      realCustomerRecipientSuppressed: true,
      ...salespersonRow,
    },
  ];

  const deliveryGroupRows = [
    {
      testRunId: options.testRunId,
      interval: config.key,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      orderDeliveryGroupId: group.id,
      orderId: group.orderId,
      deliveryDate,
      status: group.status,
      isActive: group.isActive,
      lineCount: group.lineCount,
      lastSeenAt: group.lastSeenAt,
      orderStatus: order.status,
      internalLifecycleStatus: order.internalLifecycleStatus,
      buyerGroup: order.buyerGroup,
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
      addressLine1: order.address?.addressLine1 ?? null,
      addressLine2: order.address?.addressLine2 ?? null,
      city: order.address?.city ?? null,
      state: order.address?.state ?? null,
      postalCode: order.address?.postalCode ?? null,
      scenarioTags: tags.join(", "),
    },
  ];

  const skipRows = skipReason
    ? [
        {
          ...base,
          reason: skipReason,
        },
      ]
    : [];

  const writebackRows: Row[] = [];
  if (tenDayPreview) {
    writebackRows.push({
      testRunId: options.testRunId,
      interval: config.key,
      path: "ONEWEEKCON",
      queueJob: "ERP_SET_DELIVERY_TEN_DAY_CONFIRMATION",
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryGroupId: group.id,
      deliveryDate,
      planned: tenDayPreview.wouldWrite,
      dryRun: true,
      status: tenDayPreview.acumaticaWritebackStatus,
      reason: tenDayPreview.reason,
      localCleared: tenDayPreview.localCleared,
      localConfirmed: tenDayPreview.localConfirmed,
      acumaticaOneWeekConfirmed: tenDayPreview.acumaticaOneWeekConfirmed,
    });
  }
  if (config.intervalType === NotificationIntervalType.DAY_8 && writebackPlanned) {
    writebackRows.push({
      testRunId: options.testRunId,
      interval: config.key,
      path: "PREPAYMENT_HOLD",
      queueJob: "ERP_SET_DELIVERY_PREPAYMENT_HOLD",
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryGroupId: group.id,
      deliveryDate,
      planned: true,
      dryRun: true,
      status: "DRY_RUN",
      reason: "payment_not_received_by_deadline",
      amountDueNow: payment.evaluation?.amountDueNowRounded ?? null,
      paymentDeadlineDate,
    });
  }
  if (config.intervalType === NotificationIntervalType.DAY_42) {
    writebackRows.push({
      testRunId: options.testRunId,
      interval: config.key,
      path: "CONFIRMVIA_CONFIRMWTH",
      queueJob: "ERP_SET_DELIVERY_CONFIRMATION_ATTRIBUTES",
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryGroupId: group.id,
      deliveryDate,
      planned: false,
      dryRun: true,
      status: "NOT_TRIGGERED_BY_OUTBOUND_PREVIEW",
      reason: "would_only_run_after_confirmation_response",
    });
  }

  const selectable = [
    ...(emailCandidate ? [{ channel: "EMAIL" as const, rowIndex: 0, tags }] : []),
    ...(smsCandidate ? [{ channel: "SMS" as const, rowIndex: 0, tags }] : []),
  ];

  return {
    intervalResultRows,
    selectedExampleRows: [],
    renderRows,
    deliveryGroupRows,
    itemRows,
    paymentRows,
    contactRows,
    skipRows,
    writebackRows,
    selectable,
  };
}

function renderMessages(params: {
  config: IntervalConfig;
  group: DeliveryGroupRecord;
  options: CliOptions;
  contactName: string;
  jobName: string;
  jobAddress: string;
  detailsLinkUrl: string;
  confirmation: Awaited<ReturnType<typeof readExisting42Confirmation>>;
  payment: DeliveryGroupPaymentEvaluation | null;
  paymentIsDue: boolean;
  paymentDeadlineDate: string | null;
  readinessLines: Awaited<ReturnType<typeof getDeliveryGroupReadiness>>["lines"];
  salesperson: SalespersonMap extends Map<string, infer V> ? V | null : never;
}) {
  const { config, group, options, contactName, jobName, jobAddress, payment, salesperson } = params;
  const order = group.order;

  if (config.category === "early_reminder") {
    const smsBody = renderDeliveryReminderMessage({
      intervalType: config.intervalType,
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: group.deliveryDate,
    });
    return {
      emailSubject: renderDeliveryReminderEmailSubject({
        buyerGroup: order.buyerGroup,
        jobName,
        deliveryDate: group.deliveryDate,
      }),
      emailBody: renderDeliveryReminderEmailBody({
        intervalType: config.intervalType,
        orderNumber: order.orderNumber,
        contactName,
        buyerGroup: order.buyerGroup,
        jobName,
        jobAddress,
        deliveryDate: group.deliveryDate,
        salespersonContact: salesperson,
      }),
      smsBody,
      confirmationUrl: null,
      shortConfirmationUrl: null,
      detailsUrl: null,
    };
  }

  if (config.category === "confirmation") {
    const token = params.confirmation?.linkToken ?? confirmationPreviewToken(options, group);
    const confirmationUrl = buildDeliveryConfirmationLink(token);
    const shortConfirmationUrl = buildShortDeliveryConfirmationLink(token);
    const smsBody = render42DaySmsConfirmationMessage({
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      deliveryDate: group.deliveryDate,
      link: confirmationUrl,
      deliveryAddress: order.address,
    });
    const email = render42DayEmailConfirmationMessage({
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
      jobName,
      jobAddress,
      deliveryDate: group.deliveryDate,
      link: confirmationUrl,
      paymentReminderApplies: paymentReminderApplies(payment),
      amountDueNowRounded: payment?.amountDueNowRounded ?? null,
      salespersonContact: salesperson,
    });

    return {
      emailSubject: email.subject,
      emailBody: email.body,
      smsBody,
      confirmationUrl,
      shortConfirmationUrl,
      detailsUrl: confirmationUrl,
    };
  }

  if (config.category === "confirmed_reminder") {
    const common = {
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: group.deliveryDate,
      detailsLink: params.detailsLinkUrl,
      paymentDue: params.paymentIsDue,
      amountDueNowRounded: payment?.amountDueNowRounded,
      lines: params.readinessLines,
      salespersonContact: salesperson,
    };
    const smsBody =
      config.intervalType === NotificationIntervalType.DAY_14
        ? render14DayDeliveryReminderSms(common)
        : render30DayDeliveryReminderSms(common);
    const email =
      config.intervalType === NotificationIntervalType.DAY_14
        ? render14DayDeliveryReminderEmail(common)
        : render30DayDeliveryReminderEmail(common);
    return {
      emailSubject: email.subject,
      emailBody: email.body,
      smsBody,
      confirmationUrl: null,
      shortConfirmationUrl: null,
      detailsUrl: params.detailsLinkUrl,
    };
  }

  if (config.category === "payment_request") {
    if (!payment?.amountDueNowRounded) {
      return { emailSubject: null, emailBody: null, smsBody: null, confirmationUrl: null, shortConfirmationUrl: null, detailsUrl: params.detailsLinkUrl };
    }
    const common = {
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: group.deliveryDate,
      detailsLink: params.detailsLinkUrl,
      amountDueNowRounded: payment.amountDueNowRounded,
      paymentDeadlineDate: params.paymentDeadlineDate ?? undefined,
      lines: params.readinessLines,
      salespersonContact: salesperson,
    };
    const smsBody =
      config.intervalType === NotificationIntervalType.DAY_12
        ? render12DayDeliveryPaymentReminderSms(common)
        : render10DayDeliveryPaymentReminderSms(common);
    const email =
      config.intervalType === NotificationIntervalType.DAY_12
        ? render12DayDeliveryPaymentReminderEmail(common)
        : render10DayDeliveryPaymentReminderEmail(common);
    return {
      emailSubject: email.subject,
      emailBody: email.body,
      smsBody,
      confirmationUrl: null,
      shortConfirmationUrl: null,
      detailsUrl: params.detailsLinkUrl,
    };
  }

  if (config.category === "payment_enforcement") {
    if (!payment?.amountDueNowRounded) {
      return { emailSubject: null, emailBody: null, smsBody: null, confirmationUrl: null, shortConfirmationUrl: null, detailsUrl: params.detailsLinkUrl };
    }
    const common = {
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: group.deliveryDate,
      detailsLink: params.detailsLinkUrl,
      amountDueNowRounded: payment.amountDueNowRounded,
      salespersonContact: salesperson,
    };
    const email = render8DayPaymentEnforcementCustomerEmail(common);
    return {
      emailSubject: email.subject,
      emailBody: email.body,
      smsBody: render8DayPaymentEnforcementCustomerSms(common),
      confirmationUrl: null,
      shortConfirmationUrl: null,
      detailsUrl: params.detailsLinkUrl,
    };
  }

  const common = {
    orderNumber: order.orderNumber,
    contactName,
    buyerGroup: order.buyerGroup,
    jobName,
    jobAddress,
    deliveryDate: group.deliveryDate,
    detailsLink: params.detailsLinkUrl,
    salespersonContact: salesperson,
  };
  const smsBody = render2DayDeliveryReminderSms(common);
  const email = render2DayDeliveryReminderEmail(common);
  return {
    emailSubject: email.subject,
    emailBody: email.body,
    smsBody,
    confirmationUrl: null,
    shortConfirmationUrl: null,
    detailsUrl: params.detailsLinkUrl,
  };
}

function numeric(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function sum(values: unknown[]) {
  return values.reduce<number>((total, value) => total + (numeric(value) ?? 0), 0);
}

function money(value: number) {
  return value.toFixed(2);
}

function extendedAmount(unitPrice: unknown, quantity: unknown) {
  const price = numeric(unitPrice);
  const qty = numeric(quantity);
  if (price === null || qty === null) return null;
  return money(price * qty);
}

function paymentRow(params: {
  config: IntervalConfig;
  group: DeliveryGroupRecord;
  options: CliOptions;
  payment: DeliveryGroupPaymentEvaluation | null;
  error: string | null;
  skipReason: string | null;
}): Row {
  const payment = params.payment;
  const lineRows = payment?.lines ?? [];
  const backorderedExcluded = lineRows.filter(
    (line) => !line.payableBasisIncluded && /backordered/i.test(line.payableBasisExclusionReason ?? "")
  );
  const etaPendingExcluded = lineRows.filter(
    (line) => !line.payableBasisIncluded && /eta_pending/i.test(line.payableBasisExclusionReason ?? "")
  );
  const partialLines = lineRows.filter((line) => line.readinessStatus === "partially_allocated");
  const readyLines = lineRows.filter((line) => line.readinessStatus === "ready");
  const expectedOnTimeLines = lineRows.filter((line) => line.readinessStatus === "expected_on_time");

  return {
    testRunId: params.options.testRunId,
    interval: params.config.key,
    orderType: params.group.orderType,
    orderNumber: params.group.orderNumber,
    deliveryGroupId: params.group.id,
    deliveryDate: dateKey(params.group.deliveryDate),
    orderTotal: payment?.orderTotal ?? params.group.order.total?.orderTotal ?? null,
    unpaidBalance: payment?.unpaidBalance ?? params.group.order.total?.unpaidBalance ?? null,
    paymentTerms: payment?.paymentTerms ?? normalizeDeliveryPaymentTerms(params.group.order.total?.paymentTerms ?? null),
    paymentApplicabilityStatus: payment?.paymentApplicabilityStatus ?? null,
    payableBasisValue: payment?.payableBasisValue ?? null,
    amountDueNow: payment?.amountDueNowRounded ?? payment?.amountDueNow ?? null,
    deliveryGroupPaymentAmount: payment?.currentDeliveryGroupValue ?? null,
    freightDeliveryChargeAllocationAmount: payment?.assignedFreightDeliveryChargeValue ?? null,
    backorderedExcludedAmount: money(sum(backorderedExcluded.map((line) => line.lineOpenMerchandiseValue))),
    etaPendingExcludedAmount: money(sum(etaPendingExcluded.map((line) => line.lineOpenMerchandiseValue))),
    partiallyAllocatedPayableQuantity: sum(partialLines.map((line) => line.payableQuantity)),
    readyPayableQuantity: sum(readyLines.map((line) => line.payableQuantity)),
    expectedOnTimePayableQuantity: sum(expectedOnTimeLines.map((line) => line.payableQuantity)),
    skippedReason: params.skipReason,
    calculationBlockedReason: params.error ?? payment?.calculationWarnings.join("; ") ?? null,
  };
}

function addRows(target: CandidateRows, source: CandidateRows) {
  target.intervalResultRows.push(...source.intervalResultRows);
  target.selectedExampleRows.push(...source.selectedExampleRows);
  target.renderRows.push(...source.renderRows);
  target.deliveryGroupRows.push(...source.deliveryGroupRows);
  target.itemRows.push(...source.itemRows);
  target.paymentRows.push(...source.paymentRows);
  target.contactRows.push(...source.contactRows);
  target.skipRows.push(...source.skipRows);
  target.writebackRows.push(...source.writebackRows);
}

function emptyCandidateRows(): CandidateRows {
  return {
    intervalResultRows: [],
    selectedExampleRows: [],
    renderRows: [],
    deliveryGroupRows: [],
    itemRows: [],
    paymentRows: [],
    contactRows: [],
    skipRows: [],
    writebackRows: [],
  };
}

function selectExamplesForInterval(rows: CandidateRows, options: CliOptions) {
  for (const channel of ["EMAIL", "SMS"] as const) {
    const candidates = rows.intervalResultRows
      .map((row, index) => ({ row, index, tags: String(row.scenarioTags ?? "").split(", ").filter(Boolean) }))
      .filter(({ row }) =>
        channel === "EMAIL"
          ? row.wouldHaveSelectedEmailIfOptedIn === true && !row.activeEmailOptOut && Boolean(row.emailBody)
          : row.wouldHaveSelectedSmsIfOptedIn === true && !row.activeSmsOptOut && Boolean(row.smsBody)
      );
    const selectedIndexes = pickDiverseCandidates(candidates, options.maxPerIntervalChannel);
    for (const index of selectedIndexes) {
      const row = rows.intervalResultRows[index];
      const selectedColumn = channel === "EMAIL" ? "selectedPreviewEmailExample" : "selectedPreviewSmsExample";
      row[selectedColumn] = true;
      row.testOverrideUsed = true;

      rows.selectedExampleRows.push({
        testRunId: options.testRunId,
        interval: row.interval,
        channel,
        orderType: row.orderType,
        orderNumber: row.orderNumber,
        orderDeliveryGroupId: row.orderDeliveryGroupId,
        deliveryDate: row.deliveryDate,
        selectedProductionChannel: row.selectedProductionChannel,
        productionChannelReason: row.productionChannelReason,
        realOptInStateSms: row.wouldHaveSelectedSmsIfOptedIn,
        realOptInStateEmail: row.wouldHaveSelectedEmailIfOptedIn,
        actualTestEmailRecipient:
          channel === "EMAIL" ? envValue("NOTIFICATIONS_TEST_EMAIL") : null,
        actualTestSmsRecipient:
          channel === "SMS" ? envValue("NOTIFICATIONS_TEST_PHONE") : null,
        realCustomerRecipientSuppressed: true,
        emailSubject: channel === "EMAIL" ? row.emailSubject : null,
        body: channel === "EMAIL" ? row.emailBody : row.smsBody,
        confirmationUrl: row.confirmationUrl,
        detailsUrl: row.detailsUrl,
        scenarioTags: row.scenarioTags,
      });

      for (const renderRow of rows.renderRows) {
        if (
          renderRow.interval === row.interval &&
          renderRow.orderDeliveryGroupId === row.orderDeliveryGroupId &&
          renderRow.channel === channel
        ) {
          renderRow.actualTestRecipient =
            channel === "EMAIL" ? envValue("NOTIFICATIONS_TEST_EMAIL") : envValue("NOTIFICATIONS_TEST_PHONE");
          renderRow.selectedPreviewExample = true;
        }
      }

      for (const contactRow of rows.contactRows) {
        if (
          contactRow.interval === row.interval &&
          contactRow.deliveryGroupId === row.orderDeliveryGroupId
        ) {
          if (channel === "EMAIL") contactRow.actualTestEmailRecipient = envValue("NOTIFICATIONS_TEST_EMAIL");
          if (channel === "SMS") contactRow.actualTestSmsRecipient = envValue("NOTIFICATIONS_TEST_PHONE");
        }
      }
    }
  }
}

function pickDiverseCandidates(
  candidates: Array<{ index: number; tags: string[] }>,
  max: number
) {
  const selected: number[] = [];
  const coveredTags = new Set<string>();
  const remaining = [...candidates];
  while (selected.length < max && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftNew = left.tags.filter((tag) => !coveredTags.has(tag)).length;
      const rightNew = right.tags.filter((tag) => !coveredTags.has(tag)).length;
      return rightNew - leftNew;
    });
    const next = remaining.shift();
    if (!next) break;
    selected.push(next.index);
    next.tags.forEach((tag) => coveredTags.add(tag));
  }
  return selected;
}

async function importForInterval(config: IntervalConfig, options: CliOptions): Promise<ImportRunResult> {
  const targetDeliveryDate = dateKey(getNotificationTargetDate(options.runDate, config.days));
  const requestedOn = config.requestedOn(targetDeliveryDate);
  const runSkipped = shouldSkipNotificationRunForWeekend(options.runDate);
  const deliveryDateSkipReason = getDeliveryDateCustomerNotificationSkipReason(targetDeliveryDate);

  if (runSkipped || deliveryDateSkipReason) {
    return {
      interval: config,
      targetDeliveryDate,
      requestedOn,
      skippedReason: runSkipped ? "weekend_run_date" : deliveryDateSkipReason,
      result: null,
      error: null,
      activeDeliveryGroupCount: await activeDeliveryGroupCount(targetDeliveryDate),
    };
  }

  try {
    const result = await importSalesOrdersForLineRequestedOn(requestedOn);
    return {
      interval: config,
      targetDeliveryDate,
      requestedOn,
      skippedReason: null,
      result,
      error: null,
      activeDeliveryGroupCount: await activeDeliveryGroupCount(targetDeliveryDate),
    };
  } catch (error) {
    return {
      interval: config,
      targetDeliveryDate,
      requestedOn,
      skippedReason: null,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      activeDeliveryGroupCount: await activeDeliveryGroupCount(targetDeliveryDate),
    };
  }
}

async function activeDeliveryGroupCount(targetDeliveryDate: string) {
  return prisma.orderDeliveryGroup.count({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      isActive: true,
    },
  });
}

async function evaluateInterval(
  importRun: ImportRunResult,
  options: CliOptions,
  globalOptOuts: ActiveNotificationOptOutAddresses
) {
  const rows = emptyCandidateRows();

  if (importRun.error) {
    rows.skipRows.push({
      testRunId: options.testRunId,
      interval: importRun.interval.key,
      targetDate: importRun.targetDeliveryDate,
      reason: "interval_import_failed",
      failureReason: importRun.error,
      freshImportSuccess: false,
    });
    return rows;
  }

  const groups = await loadDeliveryGroupsForTargetDate(importRun.targetDeliveryDate);
  const salespersonMap = await getActiveSalespersonContactMap(
    groups.map((group) => group.order.salespersonNumber),
    prisma
  );
  const failedKeys = failedImportOrderKeys(importRun.result);

  for (const group of groups) {
    const groupRows = await evaluateGroup({
      config: importRun.interval,
      group,
      options,
      failedFreshImport: orderFailedFreshImport(group, failedKeys),
      globalOptOuts,
      salespersonMap,
    });
    addRows(rows, groupRows);
  }

  selectExamplesForInterval(rows, options);
  return rows;
}

function importRows(imports: ImportRunResult[]): Row[] {
  return imports.map((item) => ({
    interval: item.interval.key,
    intervalLabel: item.interval.label,
    targetDate: item.targetDeliveryDate,
    requestedOn: item.requestedOn,
    skippedReason: item.skippedReason,
    importError: item.error,
    qualifyingOrdersFetched: item.result?.qualifyingOrdersFetched ?? null,
    fullOrdersFetched: item.result?.fullOrdersFetched ?? null,
    failedOrders: item.result?.failedOrders ?? null,
    errorCount: item.result?.errors.length ?? (item.error ? 1 : 0),
    importedOrderCount:
      item.result ? item.result.ordersCreated + item.result.ordersUpdated : null,
    contactsUpserted: item.result?.contactsUpserted ?? null,
    linesUpserted: item.result?.linesUpserted ?? null,
    allocationsUpserted: item.result?.allocationsUpserted ?? null,
    deliveryGroupsUpserted: item.result?.deliveryGroupsUpserted ?? null,
    deliveryGroupLinesUpserted: item.result?.deliveryGroupLinesUpserted ?? null,
    changeEventsCreated: item.result?.changeEventsCreated ?? null,
    activeDeliveryGroupCountAfterImport: item.activeDeliveryGroupCount,
  }));
}

function intervalSummaryRows(imports: ImportRunResult[], rows: Row[]): Row[] {
  return imports.map((item) => {
    const intervalRows = rows.filter((row) => row.interval === item.interval.key);
    return {
      testRunId: intervalRows[0]?.testRunId ?? null,
      interval: item.interval.key,
      intervalLabel: item.interval.label,
      targetDate: item.targetDeliveryDate,
      importSkippedReason: item.skippedReason,
      importError: item.error,
      activeDeliveryGroupCount: item.activeDeliveryGroupCount,
      candidateRows: intervalRows.length,
      businessQualified: intervalRows.filter((row) => row.businessQualified).length,
      productionQualified: intervalRows.filter((row) => row.qualified).length,
      wouldCreateEvents: intervalRows.filter((row) => row.wouldCreateEvent).length,
      existingEvents: intervalRows.filter((row) => row.existingEventFound).length,
      productionSms: intervalRows.filter((row) => row.selectedProductionChannel === "SMS").length,
      productionEmail: intervalRows.filter((row) => row.selectedProductionChannel === "EMAIL").length,
      noProductionChannel: intervalRows.filter((row) => row.contactChannelEligible === false).length,
      wouldHaveSelectedSmsIfOptedIn: intervalRows.filter((row) => row.wouldHaveSelectedSmsIfOptedIn).length,
      wouldHaveSelectedEmailIfOptedIn: intervalRows.filter((row) => row.wouldHaveSelectedEmailIfOptedIn).length,
      selectedEmailExamples: intervalRows.filter((row) => row.selectedPreviewEmailExample).length,
      selectedSmsExamples: intervalRows.filter((row) => row.selectedPreviewSmsExample).length,
      writebacksPlannedDryRun: intervalRows.filter((row) => row.writebackPlanned && row.writebackDryRun).length,
    };
  });
}

function resetCountRows(before: RuntimeCounts, after: RuntimeCounts): Row[] {
  return countDeltaRows(before, after).map((row) => ({
    ...row,
    resetPerformed: false,
    cleanupInstruction: "No reset/delete/truncate is implemented in Phase 1.",
  }));
}

function manifestRows(options: CliOptions, outputPath: string): Row[] {
  return [
    {
      testRunId: options.testRunId,
      mode: "preview_export_only",
      applyRuntimeEvents: false,
      sendTestRecipients: false,
      createdNotificationEventIds: "[]",
      createdNotificationAttemptIds: "[]",
      sentEmailMessageIds: "[]",
      sentSmsMessageSids: "[]",
      createdFiles: JSON.stringify([outputPath]),
      cleanupInstructions:
        "Delete the generated workbook only. No runtime event, attempt, hold, confirmation, writeback, or provider-send rows are created by Phase 1.",
    },
  ];
}

function serializeCell(value: unknown) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") {
    if ("toString" in value && value.constructor?.name !== "Object") return String(value);
    return JSON.stringify(value);
  }
  return value;
}

function addSheet(workbook: ExcelJS.Workbook, name: string, rows: Row[]) {
  const worksheet = workbook.addWorksheet(name.slice(0, 31));
  if (rows.length === 0) {
    worksheet.addRow(["No rows"]);
    return;
  }

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  worksheet.columns = headers.map((header) => ({
    header,
    key: header,
    width: Math.min(Math.max(header.length + 2, 14), 42),
  }));
  for (const row of rows) {
    const serialized: Row = {};
    for (const header of headers) {
      serialized[header] = serializeCell(row[header]);
    }
    worksheet.addRow(serialized);
  }
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };
}

async function writeWorkbook(params: {
  outputPath: string;
  summaryRows: Row[];
  environmentRows: Row[];
  importRows: Row[];
  intervalResultRows: Row[];
  selectedExampleRows: Row[];
  renderRows: Row[];
  deliveryGroupRows: Row[];
  itemRows: Row[];
  paymentRows: Row[];
  contactRows: Row[];
  skipRows: Row[];
  writebackRows: Row[];
  resetRows: Row[];
  manifestRows: Row[];
}) {
  await mkdir(path.dirname(params.outputPath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "delivery production-style harness";
  workbook.created = new Date();
  addSheet(workbook, "Summary", params.summaryRows);
  addSheet(workbook, "Environment Safety", params.environmentRows);
  addSheet(workbook, "Import Results", params.importRows);
  addSheet(workbook, "Interval Results", params.intervalResultRows);
  addSheet(workbook, "Selected Examples", params.selectedExampleRows);
  addSheet(workbook, "Notification Renders", params.renderRows);
  addSheet(workbook, "Delivery Groups", params.deliveryGroupRows);
  addSheet(workbook, "Items", params.itemRows);
  addSheet(workbook, "Payments", params.paymentRows);
  addSheet(workbook, "Contacts", params.contactRows);
  addSheet(workbook, "Skips", params.skipRows);
  addSheet(workbook, "Writebacks DryRuns", params.writebackRows);
  addSheet(workbook, "Reset Counts", params.resetRows);
  addSheet(workbook, "Manifest", params.manifestRows);
  await workbook.xlsx.writeFile(params.outputPath);
}

function assertNoRuntimeRowsCreated(before: RuntimeCounts, after: RuntimeCounts) {
  const tracked = [
    "notificationEvents",
    "notificationAttempts",
    "deliveryConfirmations",
    "deliveryDetailsLinks",
    "deliveryOrderHoldActions",
    "internalNotificationEvents",
    "contactOptInWritebackActions",
  ] as const;
  const changed = tracked.filter((key) => before[key] !== after[key]);
  if (changed.length > 0) {
    throw new Error(
      `Phase 1 safety assertion failed; runtime row counts changed: ${changed
        .map((key) => `${key} ${before[key]} -> ${after[key]}`)
        .join(", ")}`
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const preflightResult = preflight(options);
  const intervals = options.interval
    ? INTERVALS.filter((interval) => interval.key === options.interval)
    : INTERVALS;
  const before = await runtimeCounts();
  const globalOptOuts = await loadActiveNotificationOptOutAddresses(prisma);
  const imports: ImportRunResult[] = [];
  const allRows = emptyCandidateRows();

  for (const interval of intervals) {
    console.log(`Previewing ${interval.label}...`);
    const importRun = await importForInterval(interval, options);
    imports.push(importRun);
    const evaluated = await evaluateInterval(importRun, options, globalOptOuts);
    addRows(allRows, evaluated);
  }

  const after = await runtimeCounts();
  const outputPath = path.resolve(options.output);
  const importResultRows = importRows(imports);
  const summaryRows = intervalSummaryRows(imports, allRows.intervalResultRows);
  const resetRows = resetCountRows(before, after);
  await writeWorkbook({
    outputPath,
    summaryRows,
    environmentRows: preflightResult.rows,
    importRows: importResultRows,
    intervalResultRows: allRows.intervalResultRows,
    selectedExampleRows: allRows.selectedExampleRows,
    renderRows: allRows.renderRows,
    deliveryGroupRows: allRows.deliveryGroupRows,
    itemRows: allRows.itemRows,
    paymentRows: allRows.paymentRows,
    contactRows: allRows.contactRows,
    skipRows: allRows.skipRows,
    writebackRows: allRows.writebackRows,
    resetRows,
    manifestRows: manifestRows(options, outputPath),
  });
  assertNoRuntimeRowsCreated(before, after);

  const consoleSummary = {
    testRunId: options.testRunId,
    mode: "preview_export_only",
    runDate: options.runDate,
    outputPath,
    preflight: "passed",
    testEmail: preflightResult.testEmailRedacted,
    testPhone: preflightResult.testPhoneRedacted,
    imports: importResultRows.map((row) => ({
      interval: row.interval,
      targetDate: row.targetDate,
      qualifyingOrdersFetched: row.qualifyingOrdersFetched,
      fullOrdersFetched: row.fullOrdersFetched,
      failedOrders: row.failedOrders,
      errorCount: row.errorCount,
      importedOrderCount: row.importedOrderCount,
      activeDeliveryGroupCountAfterImport: row.activeDeliveryGroupCountAfterImport,
      importError: row.importError,
      skippedReason: row.skippedReason,
    })),
    intervals: summaryRows.map((row) => ({
      interval: row.interval,
      targetDate: row.targetDate,
      candidateRows: row.candidateRows,
      businessQualified: row.businessQualified,
      productionQualified: row.productionQualified,
      selectedEmailExamples: row.selectedEmailExamples,
      selectedSmsExamples: row.selectedSmsExamples,
      writebacksPlannedDryRun: row.writebacksPlannedDryRun,
    })),
    safety: {
      notificationEventsCreated: after.notificationEvents - before.notificationEvents,
      notificationAttemptsCreated: after.notificationAttempts - before.notificationAttempts,
      providerSends: 0,
      acumaticaWrites: 0,
      resetDeleteTruncate: false,
    },
  };
  console.log(JSON.stringify(consoleSummary, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
