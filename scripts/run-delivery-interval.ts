import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  NotificationActionType,
  NotificationAttemptStatus,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import { dateFromKey, dateKey, getNotificationTargetDate } from "../lib/notifications/helpers";
import {
  deliveryOrderMatchesScope,
  describeDeliveryOrderScope,
  normalizeDeliveryOrderScope,
  type DeliveryOrderScope,
} from "../lib/notifications/orderScope";
import { create180DayDeliveryReminderEvents } from "../lib/notifications/create180DayDeliveryReminderEvents";
import { create90DayDeliveryReminderEvents } from "../lib/notifications/create90DayDeliveryReminderEvents";
import { create60DayDeliveryReminderEvents } from "../lib/notifications/create60DayDeliveryReminderEvents";
import {
  create30DayDeliveryReminderEvents,
  type Create30DayDeliveryReminderEventsSummary,
} from "../lib/notifications/create30DayDeliveryReminderEvents";
import { create14DayDeliveryReminderEvents } from "../lib/notifications/create14DayDeliveryReminderEvents";
import type { CreateDeliveryReminderEventsSummary } from "../lib/notifications/createDeliveryReminderEvents";
import {
  create42DayDeliveryConfirmationEvents,
  type Create42DayDeliveryConfirmationEventsSummary,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import {
  create12DayDeliveryPaymentRequestEvents,
  type Create12DayDeliveryPaymentRequestEventsSummary,
} from "../lib/notifications/create12DayDeliveryPaymentRequestEvents";
import {
  create10DayDeliveryPaymentRequestEvents,
  type Create10DayDeliveryPaymentRequestEventsSummary,
} from "../lib/notifications/create10DayDeliveryPaymentRequestEvents";
import {
  create2DayDeliveryReminderEvents,
  type Create2DayDeliveryReminderEventsSummary,
} from "../lib/notifications/create2DayDeliveryReminderEvents";
import {
  create8DayPaymentEnforcementEvents,
  type Create8DayPaymentEnforcementEventsSummary,
} from "../lib/notifications/create8DayPaymentEnforcementEvents";
import {
  dispatchDeliveryNotifications,
  type DispatcherChannelFilter,
} from "../lib/notifications/deliveryNotificationDispatcher";
import {
  createFreshImportFailedOrderLookup,
  getFreshImportFailedOrders,
  getFreshImportSuccessfulOrders,
  requestedOnForDeliveryIntervalTargetDate,
  type DeliveryIntervalFreshImportResult,
} from "../lib/notifications/freshDeliveryIntervalImport";
import { prisma } from "../lib/prisma";

const SUPPORTED_INTERVALS = ["180", "90", "60", "42", "30", "14", "12", "10", "8", "2"] as const;

type SupportedInterval = (typeof SUPPORTED_INTERVALS)[number];
type CreateDeliveryIntervalEventsSummary =
  | CreateDeliveryReminderEventsSummary
  | Create30DayDeliveryReminderEventsSummary
  | Create42DayDeliveryConfirmationEventsSummary
  | Create12DayDeliveryPaymentRequestEventsSummary
  | Create10DayDeliveryPaymentRequestEventsSummary
  | Create8DayPaymentEnforcementEventsSummary
  | Create2DayDeliveryReminderEventsSummary;
type CreateDeliveryIntervalEvents = (options: {
  runDate?: Date | string;
  dryRun?: boolean;
  orderScope?: DeliveryOrderScope | null;
}) => Promise<CreateDeliveryIntervalEventsSummary>;

type IntervalConfig = {
  interval: SupportedInterval;
  days: number;
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
  confirmPhrase: string;
  createEvents: CreateDeliveryIntervalEvents;
  dispatchOnlyCurrentRunCreatedEvents?: boolean;
  abortOnPerOrderImportFailure: boolean;
};

const INTERVAL_CONFIGS: Record<SupportedInterval, IntervalConfig> = {
  "180": {
    interval: "180",
    days: 180,
    intervalType: NotificationIntervalType.DAY_180,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    confirmPhrase: "RUN REAL 180 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create180DayDeliveryReminderEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
  "90": {
    interval: "90",
    days: 90,
    intervalType: NotificationIntervalType.DAY_90,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    confirmPhrase: "RUN REAL 90 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create90DayDeliveryReminderEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
  "60": {
    interval: "60",
    days: 60,
    intervalType: NotificationIntervalType.DAY_60,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    confirmPhrase: "RUN REAL 60 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create60DayDeliveryReminderEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
  "42": {
    interval: "42",
    days: 42,
    intervalType: NotificationIntervalType.DAY_42,
    actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    confirmPhrase: "RUN REAL 42 DAY CUSTOMER CONFIRMATION NOTIFICATIONS",
    createEvents: create42DayDeliveryConfirmationEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: false,
  },
  "30": {
    interval: "30",
    days: 30,
    intervalType: NotificationIntervalType.DAY_30,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    confirmPhrase: "RUN REAL 30 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create30DayDeliveryReminderEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
  "14": {
    interval: "14",
    days: 14,
    intervalType: NotificationIntervalType.DAY_14,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    confirmPhrase: "RUN REAL 14 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create14DayDeliveryReminderEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
  "12": {
    interval: "12",
    days: 12,
    intervalType: NotificationIntervalType.DAY_12,
    actionType: NotificationActionType.PAYMENT_REQUEST,
    confirmPhrase: "RUN REAL 12 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create12DayDeliveryPaymentRequestEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
  "10": {
    interval: "10",
    days: 10,
    intervalType: NotificationIntervalType.DAY_10,
    actionType: NotificationActionType.PAYMENT_REQUEST,
    confirmPhrase: "RUN REAL 10 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create10DayDeliveryPaymentRequestEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
  "8": {
    interval: "8",
    days: 8,
    intervalType: NotificationIntervalType.DAY_8,
    actionType: NotificationActionType.PAYMENT_ENFORCEMENT,
    confirmPhrase: "RUN REAL 8 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create8DayPaymentEnforcementEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
  "2": {
    interval: "2",
    days: 2,
    intervalType: NotificationIntervalType.DAY_2,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    confirmPhrase: "RUN REAL 2 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create2DayDeliveryReminderEvents,
    dispatchOnlyCurrentRunCreatedEvents: true,
    abortOnPerOrderImportFailure: true,
  },
};

export type DeliveryIntervalRunOptions = {
  interval: SupportedInterval | null;
  runDate: string | null;
  send: boolean;
  confirmPhrase: string | null;
  runId: string | null;
  orderType: string | null;
  orderNumber: string | null;
  orderScope: DeliveryOrderScope | null;
  channel: DispatcherChannelFilter;
  verifyPackageAndMigrations: boolean;
  manualPresentationRun: boolean;
};

function isSupportedInterval(value: string): value is SupportedInterval {
  return SUPPORTED_INTERVALS.includes(value as SupportedInterval);
}

function readOption(args: string[], index: number, name: string) {
  const arg = args[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), nextIndex: index };

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function parseArgs(args: string[]): DeliveryIntervalRunOptions {
  const options: DeliveryIntervalRunOptions = {
    interval: null,
    runDate: null,
    send: false,
    confirmPhrase: null,
    runId: null,
    orderType: null,
    orderNumber: null,
    orderScope: null,
    channel: "both",
    verifyPackageAndMigrations: true,
    manualPresentationRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--send") {
      options.send = true;
      continue;
    }
    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const parsed = readOption(args, index, "--interval");
      const normalized = parsed.value.trim();
      if (!isSupportedInterval(normalized)) {
        throw new Error(
          `Unsupported interval ${normalized}. Supported intervals: ${SUPPORTED_INTERVALS.join(", ")}.`
        );
      }
      options.interval = normalized;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--run-date" || arg.startsWith("--run-date=")) {
      const parsed = readOption(args, index, "--run-date");
      options.runDate = dateKey(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      const parsed = readOption(args, index, "--confirm");
      options.confirmPhrase = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const parsed = readOption(args, index, "--run-id");
      options.runId = parsed.value.trim();
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--order-type" || arg.startsWith("--order-type=")) {
      const parsed = readOption(args, index, "--order-type");
      options.orderType = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--order-number" || arg.startsWith("--order-number=")) {
      const parsed = readOption(args, index, "--order-number");
      options.orderNumber = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--channel" || arg.startsWith("--channel=")) {
      const parsed = readOption(args, index, "--channel");
      const channel = parsed.value.trim().toLowerCase();
      if (channel !== "sms" && channel !== "email" && channel !== "both") {
        throw new Error("--channel must be sms, email, or both.");
      }
      options.channel = channel;
      index = parsed.nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.orderScope = normalizeDeliveryOrderScope({
    orderType: options.orderType,
    orderNumber: options.orderNumber,
  });

  return options;
}

function envValue(name: string, env: NodeJS.ProcessEnv = process.env) {
  return env[name]?.trim() ?? "";
}

function flagIsTrue(name: string, env: NodeJS.ProcessEnv = process.env) {
  return envValue(name, env).toLowerCase() === "true";
}

function flagIsExplicitFalse(name: string, env: NodeJS.ProcessEnv = process.env) {
  return envValue(name, env).toLowerCase() === "false";
}

function dryRunOverrideEnabled(name: string, env: NodeJS.ProcessEnv = process.env) {
  return envValue(name, env).toLowerCase() === "true";
}

function flagIsFalseOrUnset(name: string, env: NodeJS.ProcessEnv = process.env) {
  const value = envValue(name, env).toLowerCase();
  return !value || value === "false";
}

function addMissingEnvFailure(
  failures: string[],
  name: string,
  purpose: string,
  env: NodeJS.ProcessEnv = process.env
) {
  if (!envValue(name, env)) failures.push(`${name} is required for ${purpose}.`);
}

function redactEmail(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return "<redacted-email>";
  return `${local.slice(0, 1)}***@${domain}`;
}

function normalizeDigits(value: string | null | undefined) {
  return value?.replace(/\D/g, "") ?? "";
}

function redactPhone(value: string | null | undefined) {
  const digits = normalizeDigits(value);
  if (!digits) return null;
  return `***${digits.slice(-4)}`;
}

function redactRecipient(channel: NotificationChannel | string | null, value: string | null | undefined) {
  if (!channel || !value) return null;
  return channel === NotificationChannel.SMS ? redactPhone(value) : redactEmail(value);
}

function redactProviderId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return "<redacted-provider-id>";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function redactSensitiveText(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "<redacted-phone>")
    .slice(0, 1000);
}

function validateRunId(value: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("--run-id may contain only letters, numbers, underscores, periods, and dashes.");
  }
  if (value.length > 128) {
    throw new Error("--run-id must be 128 characters or fewer.");
  }
}

function defaultRunId(runDate: string, interval: SupportedInterval) {
  return `production_${runDate.replace(/-/g, "")}_${interval}`;
}

function runReadOnlyCommand(name: string, args: string[]) {
  const result = spawnSync(name, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(" ")} failed: ${redactSensitiveText(output)}`);
  }

  return output;
}

function verifyMigrationStatus() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = runReadOnlyCommand(npmCommand, ["exec", "--", "prisma", "migrate", "status"]);
  if (!/Database schema is up to date/i.test(output)) {
    throw new Error("Prisma migration status did not report the database schema is up to date.");
  }
  return "Database schema is up to date";
}

function verifyPackageScript() {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (!pkg.scripts?.["run:delivery-interval"]?.includes("scripts/run-delivery-interval.ts")) {
    throw new Error("package.json script run:delivery-interval must point to scripts/run-delivery-interval.ts.");
  }
}

function preflight(options: DeliveryIntervalRunOptions, env: NodeJS.ProcessEnv = process.env) {
  const failures: string[] = [];
  const config = options.interval ? INTERVAL_CONFIGS[options.interval] : null;

  if (!config) {
    failures.push(`--interval is required and must be one of: ${SUPPORTED_INTERVALS.join(", ")}.`);
  }
  if (!options.runDate) {
    failures.push("--run-date YYYY-MM-DD is required.");
  }
  if (!options.send) {
    failures.push("--send is required; this command is only for real production sends.");
  }
  if (config && options.confirmPhrase !== config.confirmPhrase) {
    failures.push(`--confirm must exactly equal "${config.confirmPhrase}" for interval ${config.interval}.`);
  } else if (!config && !options.confirmPhrase) {
    failures.push("--confirm is required.");
  }
  addMissingEnvFailure(failures, "DATABASE_URL", "database access", env);
  addMissingEnvFailure(failures, "MLD_QUEUE_BASE_URL", "queue-backed ERP import", env);
  addMissingEnvFailure(failures, "MLD_QUEUE_TOKEN", "queue-backed ERP import", env);
  addMissingEnvFailure(failures, "DELIVERY_APP_BASE_URL", "customer links and Twilio callbacks", env);
  addMissingEnvFailure(failures, "TWILIO_ACCOUNT_SID", "SMS sends", env);
  addMissingEnvFailure(failures, "TWILIO_AUTH_TOKEN", "SMS sends", env);
  if (!envValue("TWILIO_MESSAGING_SERVICE_SID", env) && !envValue("TWILIO_FROM_NUMBER", env)) {
    failures.push("TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER is required for SMS sends.");
  }
  for (const name of [
    "MS_GRAPH_TENANT_ID",
    "MS_GRAPH_CLIENT_ID",
    "MS_GRAPH_CLIENT_SECRET",
    "MS_GRAPH_FROM_EMAIL",
  ]) {
    addMissingEnvFailure(failures, name, "email sends", env);
  }

  if (env.NODE_ENV !== "production" && !flagIsTrue("DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION", env)) {
    failures.push(
      "NODE_ENV must be production, or DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION must be exactly true for an approved local shell run."
    );
  }
  if (!flagIsTrue("USE_QUEUE_ERP", env)) {
    failures.push("USE_QUEUE_ERP must be exactly true.");
  }
  if (flagIsExplicitFalse("DELIVERY_REAL_CUSTOMER_SEND_ENABLED", env)) {
    failures.push("DELIVERY_REAL_CUSTOMER_SEND_ENABLED is explicitly false.");
  }
  if (!flagIsFalseOrUnset("DELIVERY_CONTROLLED_RECIPIENT_MODE", env)) {
    failures.push("DELIVERY_CONTROLLED_RECIPIENT_MODE must be false or unset.");
  }
  if (!flagIsFalseOrUnset("DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST", env)) {
    failures.push("DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST must be false or unset.");
  }
  if (!flagIsFalseOrUnset("DEMO_NOTIFICATION_SEND_ENABLED", env)) {
    failures.push("DEMO_NOTIFICATION_SEND_ENABLED must be false or unset.");
  }
  if (flagIsExplicitFalse("TWILIO_WEBHOOK_VALIDATE_SIGNATURES", env)) {
    failures.push("TWILIO_WEBHOOK_VALIDATE_SIGNATURES is explicitly false.");
  }

  const appBaseUrl = envValue("DELIVERY_APP_BASE_URL", env);
  if (/localhost|127\.0\.0\.1|::1/i.test(appBaseUrl)) {
    failures.push("DELIVERY_APP_BASE_URL must not be localhost for a real production send.");
  }

  if (failures.length > 0) {
    throw new Error(`Production delivery interval preflight failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

async function runtimeCounts() {
  const [
    notificationEvents,
    notificationAttempts,
    twilioCallbacks,
    deliveryConfirmations,
    deliveryDetailsLinks,
    holdActions,
  ] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.twilioMessageStatusCallback.count(),
    prisma.deliveryConfirmation.count(),
    prisma.deliveryDetailsLink.count(),
    prisma.deliveryOrderHoldAction.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
    twilioCallbacks,
    deliveryConfirmations,
    deliveryDetailsLinks,
    holdActions,
  };
}

async function scheduledEventsForRun(params: {
  config: IntervalConfig;
  runDate: string;
  targetDate: string;
  currentRunCreatedEventIds?: string[] | null;
  orderScope?: DeliveryOrderScope | null;
}) {
  if (params.currentRunCreatedEventIds && params.currentRunCreatedEventIds.length === 0) {
    return [];
  }

  return prisma.notificationEvent.findMany({
    where: {
      id: params.currentRunCreatedEventIds ? { in: params.currentRunCreatedEventIds } : undefined,
      intervalType: params.config.intervalType,
      actionType: params.config.actionType,
      orderType: params.orderScope?.orderType,
      orderNumber: params.orderScope?.orderNumber,
      deliveryDate: dateFromKey(params.targetDate),
      scheduledAt: dateFromKey(params.runDate),
      status: NotificationEventStatus.SCHEDULED,
    },
    orderBy: [{ orderType: "asc" }, { orderNumber: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      selectedChannel: true,
      recipientEmail: true,
      recipientPhone: true,
      _count: { select: { attempts: true } },
    },
  });
}

function summarizeSkippedReasons(reasons: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(reasons).sort((left, right) => right[1] - left[1])
  );
}

function createdEventIdsForCurrentRun(summary: CreateDeliveryIntervalEventsSummary) {
  if ("createdEventIds" in summary && Array.isArray(summary.createdEventIds)) {
    return summary.createdEventIds;
  }
  return eventReportsForSummary(summary)
    .filter(
      (report) =>
        (report.eventId && report.status === NotificationEventStatus.SCHEDULED) ||
        (report.customerEventId && report.customerEventStatus === NotificationEventStatus.SCHEDULED)
    )
    .map((report) => (report.eventId ?? report.customerEventId) as string);
}

function eventReportsForSummary(summary: CreateDeliveryIntervalEventsSummary) {
  if ("eventReports" in summary && Array.isArray(summary.eventReports)) {
    return summary.eventReports as Array<{
      orderType?: string | null;
      orderNumber?: string | null;
      deliveryGroupId?: string | null;
      deliveryDate?: string | null;
      eventId?: string | null;
      status?: string | null;
      customerEventId?: string | null;
      customerEventStatus?: string | null;
      selectedChannel?: string | null;
      reasonSkipped?: string | null;
      customerEventSkippedReason?: string | null;
    }>;
  }
  return [];
}

function summarizeCreateEventReports(summary: CreateDeliveryIntervalEventsSummary) {
  return eventReportsForSummary(summary).map((report) => ({
    orderType: report.orderType ?? null,
    orderNumber: report.orderNumber ?? null,
    deliveryGroupId: report.deliveryGroupId ?? null,
    deliveryDate: report.deliveryDate ?? null,
    eventId: report.eventId ?? report.customerEventId ?? null,
    status: report.status ?? report.customerEventStatus ?? null,
    selectedChannel: report.selectedChannel ?? null,
    reasonSkipped: report.reasonSkipped ?? report.customerEventSkippedReason ?? null,
  }));
}

function dedupedEventCountForSummary(summary: CreateDeliveryIntervalEventsSummary) {
  if ("eventsDeduped" in summary) return summary.eventsDeduped;
  if ("customerEventsDeduped" in summary) return summary.customerEventsDeduped;
  return 0;
}

function summaryOrderScope(summary: CreateDeliveryIntervalEventsSummary) {
  if ("orderScope" in summary) return summary.orderScope;
  return null;
}

function freshImportForSummary(
  summary: CreateDeliveryIntervalEventsSummary
): DeliveryIntervalFreshImportResult {
  if ("freshImport" in summary) return summary.freshImport;

  const failedOrders = getFreshImportFailedOrders(summary.importResult);
  const successfulOrders = getFreshImportSuccessfulOrders(summary.importResult);
  return {
    required: true,
    performed: Boolean(summary.importResult),
    targetDate: summary.targetDeliveryDate,
    requestedOn:
      summary.importRequestedOn ||
      requestedOnForDeliveryIntervalTargetDate(summary.targetDeliveryDate),
    skippedReason: summary.importResult ? null : "not_reported",
    importResult: summary.importResult,
    failedOrders,
    failedOrderLookup: createFreshImportFailedOrderLookup(failedOrders),
    successfulOrderLookup: createFreshImportFailedOrderLookup(successfulOrders),
    globalFailed: false,
    perOrderFailed: failedOrders.length > 0,
    errorMessage: null,
  };
}

function assertRowsWithinOrderScope(
  scope: DeliveryOrderScope | null,
  rows: Array<{ orderType?: string | null; orderNumber?: string | null }>,
  label: string
) {
  if (!scope) return;
  const mismatches = rows.filter((row) => !deliveryOrderMatchesScope(row, scope));
  if (mismatches.length > 0) {
    throw new Error(
      `${label} included ${mismatches.length} row(s) outside scoped canary order ${describeDeliveryOrderScope(scope)}; refusing to continue.`
    );
  }
}

async function countOtherScheduledEventsForInterval(params: {
  config: IntervalConfig;
  currentRunCreatedEventIds?: string[] | null;
}) {
  return prisma.notificationEvent.count({
    where: {
      intervalType: params.config.intervalType,
      status: NotificationEventStatus.SCHEDULED,
      id:
        params.currentRunCreatedEventIds && params.currentRunCreatedEventIds.length > 0
          ? { notIn: params.currentRunCreatedEventIds }
          : undefined,
    },
  });
}

function assertPreviewSafe(
  previewReports: Awaited<ReturnType<typeof dispatchDeliveryNotifications>>["reports"]
) {
  const failures: string[] = [];
  for (const report of previewReports) {
    if (report.outcome !== "previewed") {
      failures.push(`${report.eventId}: dispatcher preview outcome ${report.outcome}: ${report.reason ?? "no reason"}`);
    }
    if (report.controlledRecipientMode) {
      failures.push(`${report.eventId}: dispatcher preview used controlled-recipient mode`);
    }
    if (report.forcedContactEligibility) {
      failures.push(`${report.eventId}: dispatcher preview used forced contact eligibility`);
    }
    if (report.finalRecipientKind !== "customer") {
      failures.push(`${report.eventId}: dispatcher preview final recipient was not the customer`);
    }
    if (report.realRecipientSuppressed) {
      failures.push(`${report.eventId}: dispatcher preview suppressed a real recipient`);
    }
    if (report.finalRecipientIsTestRecipient) {
      failures.push(`${report.eventId}: dispatcher preview resolved to the configured test recipient`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Dispatcher preview safety check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

async function dispatchPreviewForEvents(
  eventIds: string[],
  runId: string,
  channel: DispatcherChannelFilter
) {
  const attemptsBefore = await prisma.notificationAttempt.count();
  const reports = [];
  for (const eventId of eventIds) {
    const summary = await dispatchDeliveryNotifications({
      preview: true,
      send: false,
      controlledRecipientSend: false,
      testRunId: `${runId}_preview`,
      eventId,
      limit: 1,
      channel,
    });
    reports.push(...summary.reports);
  }
  assertPreviewSafe(reports);
  const attemptsAfter = await prisma.notificationAttempt.count();
  if (attemptsAfter !== attemptsBefore) {
    throw new Error("Dispatcher preview created NotificationAttempt rows; refusing to send.");
  }
  return reports;
}

async function dispatchSendForEvents(
  eventIds: string[],
  runId: string,
  channel: DispatcherChannelFilter
) {
  const summaries = [];
  for (const eventId of eventIds) {
    summaries.push(
      await dispatchDeliveryNotifications({
        preview: false,
        send: true,
        controlledRecipientSend: false,
        testRunId: runId,
        eventId,
        limit: 1,
        channel,
      })
    );
  }
  return summaries;
}

async function attemptsForReports(
  reports: Awaited<ReturnType<typeof dispatchDeliveryNotifications>>["reports"]
) {
  const attemptIds = reports.flatMap((report) =>
    [report.attemptId, report.fallbackAttemptId].filter((id): id is string => Boolean(id))
  );
  if (attemptIds.length === 0) return [];

  return prisma.notificationAttempt.findMany({
    where: { id: { in: attemptIds } },
    orderBy: [{ createdAt: "asc" }, { attemptNumber: "asc" }],
    select: {
      id: true,
      notificationEventId: true,
      channel: true,
      status: true,
      provider: true,
      providerCode: true,
      externalMessageId: true,
      recipient: true,
      suppressedRecipient: true,
      controlledRecipientMode: true,
      forcedContactEligibility: true,
      success: true,
      errorMessage: true,
    },
  });
}

function summarizeAttempts(attempts: Awaited<ReturnType<typeof attemptsForReports>>) {
  return attempts.map((attempt) => ({
    id: attempt.id,
    notificationEventId: attempt.notificationEventId,
    channel: attempt.channel,
    status: attempt.status,
    provider: attempt.provider,
    providerCode: attempt.providerCode,
    externalMessageIdMasked: redactProviderId(attempt.externalMessageId),
    recipientMasked: redactRecipient(attempt.channel, attempt.recipient),
    suppressedRecipientMasked: redactRecipient(attempt.channel, attempt.suppressedRecipient),
    controlledRecipientMode: attempt.controlledRecipientMode,
    forcedContactEligibility: attempt.forcedContactEligibility,
    success: attempt.success,
    errorMessage: redactSensitiveText(attempt.errorMessage),
  }));
}

export async function runDeliveryInterval(options: DeliveryIntervalRunOptions) {
  if (options.runDate) dateFromKey(options.runDate);
  const runDate = options.runDate;
  const config = options.interval ? INTERVAL_CONFIGS[options.interval] : null;
  const runId = options.runId ?? (runDate && config ? defaultRunId(runDate, config.interval) : null);
  if (runId) validateRunId(runId);

  preflight(options);
  if (!runDate || !runId || !config) throw new Error("Internal preflight error: missing run date, run id, or interval.");
  let migrationStatus = "not checked by in-process API runner";
  if (options.verifyPackageAndMigrations) {
    verifyPackageScript();
    migrationStatus = verifyMigrationStatus();
  }

  const targetDate = dateKey(getNotificationTargetDate(runDate, config.days));
  const before = await runtimeCounts();

  const createSummary = await config.createEvents({
    runDate,
    dryRun: false,
    orderScope: options.orderScope,
  });
  const freshImport = freshImportForSummary(createSummary);
  const createEventReports = eventReportsForSummary(createSummary);
  assertRowsWithinOrderScope(options.orderScope, createEventReports, "Create summary event reports");

  if (freshImport.globalFailed || freshImport.errorMessage) {
    throw new Error(
      `Fresh import failed globally; refusing to dispatch: ${redactSensitiveText(freshImport.errorMessage)}`
    );
  }
  if (
    config.abortOnPerOrderImportFailure &&
    freshImport.perOrderFailed
  ) {
    throw new Error(
      `One or more ${config.interval}-day candidates had fresh_import_failed; refusing to dispatch this run.`
    );
  }

  const currentRunCreatedEventIds = config.dispatchOnlyCurrentRunCreatedEvents
    ? createdEventIdsForCurrentRun(createSummary)
    : null;
  const otherScheduledEventsForInterval = await countOtherScheduledEventsForInterval({
    config,
    currentRunCreatedEventIds,
  });
  const scheduledEvents = await scheduledEventsForRun({
    config,
    runDate,
    targetDate,
    currentRunCreatedEventIds,
    orderScope: options.orderScope,
  });
  assertRowsWithinOrderScope(options.orderScope, scheduledEvents, "Scheduled dispatch events");
  const unsafeScheduledEvents = scheduledEvents.filter(
    (event) => !event.selectedChannel || event._count.attempts > 0
  );
  if (unsafeScheduledEvents.length > 0) {
    throw new Error(
      `Scheduled event dedupe safety failed; refusing to dispatch ${unsafeScheduledEvents.length} event(s).`
    );
  }

  if (scheduledEvents.length === 0) {
    const afterNoSend = await runtimeCounts();
    return {
          ok: true,
          phase: "complete_no_dispatchable_events",
          interval: config.interval,
          runDate,
          targetDeliveryDate: targetDate,
          migrationStatus,
          importSummary: freshImport.importResult,
          successfullyRefreshedOrders: freshImport.importResult?.successfullyRefreshedOrders ?? [],
          orderScope: {
            requested: options.orderScope,
            summary: summaryOrderScope(createSummary),
            blastRadiusLimitedOnly: Boolean(options.orderScope),
            productionEligibilityStillRequired: true,
            forcedEligibility: false,
            controlledRecipientMode: false,
          },
          candidateCount: createSummary.targetDeliveryGroups,
          productionQualifiedCount: 0,
          requestedChannel: options.channel,
          skippedCountByReason: summarizeSkippedReasons(createSummary.skippedReasons),
          createEventReports: summarizeCreateEventReports(createSummary),
          failedImportExclusions: createSummary.failedImportExclusions,
          currentRunCreatedEventIds,
          otherScheduledEventsForInterval,
          oldScheduledEventsWarning:
            config.dispatchOnlyCurrentRunCreatedEvents && otherScheduledEventsForInterval > 0
              ? `${otherScheduledEventsForInterval} existing ${config.interval}-day SCHEDULED event(s) were not dispatched and still need targeted cleanup/cancel review before scheduler go-live.`
              : null,
          notificationEventsCreated: afterNoSend.notificationEvents - before.notificationEvents,
          notificationAttemptsCreated: afterNoSend.notificationAttempts - before.notificationAttempts,
          smsAttemptsCreated: 0,
          emailAttemptsCreated: 0,
          providerAcceptedCount: 0,
          providerFailedCount: 0,
          exactNextOperationalAction: `Review skipped reasons; no ${config.interval}-day scheduled events were dispatchable.`,
          sensitiveValuesPrinted: false,
        };
  }

  const previewReports = await dispatchPreviewForEvents(
    scheduledEvents.map((event) => event.id),
    runId,
    options.channel
  );

  const dispatchSummaries = await dispatchSendForEvents(
    scheduledEvents.map((event) => event.id),
    runId,
    options.channel
  );
  const dispatchReports = dispatchSummaries.flatMap((summary) => summary.reports);
  const attempts = await attemptsForReports(dispatchReports);
  const after = await runtimeCounts();
  const smsAttemptsCreated = attempts.filter((attempt) => attempt.channel === NotificationChannel.SMS).length;
  const emailAttemptsCreated = attempts.filter((attempt) => attempt.channel === NotificationChannel.EMAIL).length;
  const providerAcceptedCount = attempts.filter((attempt) => attempt.success === true).length;
  const providerFailedCount = attempts.filter(
    (attempt) => attempt.status === NotificationAttemptStatus.FAILED || attempt.success === false
  ).length;

  return {
        ok: dispatchReports.every((report) => report.outcome === "submitted"),
        phase: "complete",
        interval: config.interval,
        runDate,
        targetDeliveryDate: targetDate,
        migrationStatus,
        controlledRecipientMode: false,
        forcedContactEligibility: false,
        realCustomerSendGateRequired: true,
        realCustomerRecipientsUsed: true,
        confirmationWritebackDryRun: dryRunOverrideEnabled(
          "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN"
        ),
        confirmationWritebackLivePayloadsEnabled: !dryRunOverrideEnabled(
          "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN"
        ),
        tenDayConfirmationWritebackDryRun: dryRunOverrideEnabled(
          "DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN"
        ),
        tenDayConfirmationWritebackLivePayloadsEnabled: !dryRunOverrideEnabled(
          "DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN"
        ),
        requestedChannel: options.channel,
        importSummary: freshImport.importResult,
        successfullyRefreshedOrders: freshImport.importResult?.successfullyRefreshedOrders ?? [],
        orderScope: {
          requested: options.orderScope,
          summary: summaryOrderScope(createSummary),
          blastRadiusLimitedOnly: Boolean(options.orderScope),
          productionEligibilityStillRequired: true,
          forcedEligibility: false,
          controlledRecipientMode: false,
        },
        failedImportExclusions: createSummary.failedImportExclusions,
        currentRunCreatedEventIds,
        otherScheduledEventsForInterval,
        oldScheduledEventsWarning:
          config.dispatchOnlyCurrentRunCreatedEvents && otherScheduledEventsForInterval > 0
            ? `${otherScheduledEventsForInterval} existing ${config.interval}-day SCHEDULED event(s) were not dispatched and still need targeted cleanup/cancel review before scheduler go-live.`
            : null,
        candidateCount: createSummary.targetDeliveryGroups,
        productionQualifiedCount: scheduledEvents.length,
        skippedCountByReason: summarizeSkippedReasons(createSummary.skippedReasons),
        createEventReports: summarizeCreateEventReports(createSummary),
        smsAttemptsCreated,
        emailAttemptsCreated,
        providerAcceptedCount,
        providerFailedCount,
        notificationEventsCreated: after.notificationEvents - before.notificationEvents,
        notificationAttemptsCreated: after.notificationAttempts - before.notificationAttempts,
        twilioMessageSidsMasked: attempts
          .filter((attempt) => attempt.channel === NotificationChannel.SMS)
          .map((attempt) => redactProviderId(attempt.externalMessageId))
          .filter((value): value is string => Boolean(value)),
        graphIdsMasked: attempts
          .filter((attempt) => attempt.channel === NotificationChannel.EMAIL)
          .map((attempt) => redactProviderId(attempt.externalMessageId))
          .filter((value): value is string => Boolean(value)),
        realRecipientsMasked: attempts
          .map((attempt) => redactRecipient(attempt.channel, attempt.recipient))
          .filter((value): value is string => Boolean(value)),
        optOutBlockedCount: dispatchReports.filter(
          (report) =>
            report.outcome === "skipped" &&
            (report.localSmsOptOutActive ||
              report.localEmailOptOutActive ||
              report.globalSmsOptOutActive ||
              report.globalEmailOptOutActive)
        ).length,
        dedupeSkippedCount: dedupedEventCountForSummary(createSummary),
        previewReports: previewReports.map((report) => ({
          eventId: report.eventId,
          orderType: report.orderType,
          orderNumber: report.orderNumber,
          selectedChannel: report.selectedChannel,
          finalRecipientKind: report.finalRecipientKind,
          finalRecipientMasked: report.finalRecipientMasked,
          finalRecipientIsTestRecipient: report.finalRecipientIsTestRecipient,
          realRecipientSuppressed: report.realRecipientSuppressed,
        })),
        dispatchReports: dispatchReports.map((report) => ({
          eventId: report.eventId,
          orderType: report.orderType,
          orderNumber: report.orderNumber,
          outcome: report.outcome,
          reason: redactSensitiveText(report.reason),
          selectedChannel: report.selectedChannel,
          attemptId: report.attemptId,
          fallbackAttemptId: report.fallbackAttemptId,
          finalRecipientKind: report.finalRecipientKind,
          finalRecipientMasked: report.finalRecipientMasked,
          finalRecipientIsTestRecipient: report.finalRecipientIsTestRecipient,
          realRecipientSuppressed: report.realRecipientSuppressed,
          externalMessageIdPresent: report.externalMessageIdPresent,
        })),
        attempts: summarizeAttempts(attempts),
        countDeltas: {
          notificationEvents: after.notificationEvents - before.notificationEvents,
          notificationAttempts: after.notificationAttempts - before.notificationAttempts,
          twilioCallbacks: after.twilioCallbacks - before.twilioCallbacks,
          deliveryConfirmations: after.deliveryConfirmations - before.deliveryConfirmations,
          deliveryDetailsLinks: after.deliveryDetailsLinks - before.deliveryDetailsLinks,
          holdActions: after.holdActions - before.holdActions,
        },
        errors: dispatchReports
          .filter((report) => report.outcome === "failed")
          .map((report) => ({
            eventId: report.eventId,
            reason: redactSensitiveText(report.reason),
          })),
        exactNextOperationalAction:
          "Review NotificationAttempt statuses and provider callbacks before enabling another interval.",
        sensitiveValuesPrinted: false,
      };
}

async function run() {
  const result = await runDeliveryInterval(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (typeof require !== "undefined" && require.main === module) {
  run()
    .catch((error) => {
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            sensitiveValuesPrinted: false,
          },
          null,
          2
        )
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
