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
import { create180DayDeliveryReminderEvents } from "../lib/notifications/create180DayDeliveryReminderEvents";
import { create90DayDeliveryReminderEvents } from "../lib/notifications/create90DayDeliveryReminderEvents";
import { create60DayDeliveryReminderEvents } from "../lib/notifications/create60DayDeliveryReminderEvents";
import type { CreateDeliveryReminderEventsSummary } from "../lib/notifications/createDeliveryReminderEvents";
import {
  create42DayDeliveryConfirmationEvents,
  type Create42DayDeliveryConfirmationEventsSummary,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import { dispatchDeliveryNotifications } from "../lib/notifications/deliveryNotificationDispatcher";
import { prisma } from "../lib/prisma";

const SUPPORTED_INTERVALS = ["180", "90", "60", "42"] as const;

type SupportedInterval = (typeof SUPPORTED_INTERVALS)[number];
type CreateDeliveryIntervalEventsSummary =
  | CreateDeliveryReminderEventsSummary
  | Create42DayDeliveryConfirmationEventsSummary;
type CreateDeliveryIntervalEvents = (options: {
  runDate?: Date | string;
  dryRun?: boolean;
}) => Promise<CreateDeliveryIntervalEventsSummary>;

type IntervalConfig = {
  interval: SupportedInterval;
  days: number;
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
  confirmPhrase: string;
  createEvents: CreateDeliveryIntervalEvents;
  dispatchOnlyCurrentRunCreatedEvents?: boolean;
  confirmationWritebackDryRunRequired: boolean;
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
    confirmationWritebackDryRunRequired: true,
    abortOnPerOrderImportFailure: true,
  },
  "90": {
    interval: "90",
    days: 90,
    intervalType: NotificationIntervalType.DAY_90,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    confirmPhrase: "RUN REAL 90 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create90DayDeliveryReminderEvents,
    confirmationWritebackDryRunRequired: true,
    abortOnPerOrderImportFailure: true,
  },
  "60": {
    interval: "60",
    days: 60,
    intervalType: NotificationIntervalType.DAY_60,
    actionType: NotificationActionType.DELIVERY_REMINDER,
    confirmPhrase: "RUN REAL 60 DAY CUSTOMER NOTIFICATIONS",
    createEvents: create60DayDeliveryReminderEvents,
    confirmationWritebackDryRunRequired: true,
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
    confirmationWritebackDryRunRequired: false,
    abortOnPerOrderImportFailure: false,
  },
};

type CliOptions = {
  interval: SupportedInterval | null;
  runDate: string | null;
  send: boolean;
  confirmPhrase: string | null;
  runId: string | null;
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    interval: null,
    runDate: null,
    send: false,
    confirmPhrase: null,
    runId: null,
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function envValue(name: string, env: NodeJS.ProcessEnv = process.env) {
  return env[name]?.trim() ?? "";
}

function flagIsTrue(name: string, env: NodeJS.ProcessEnv = process.env) {
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

function requireFlagValue(
  failures: string[],
  name: string,
  expected: boolean,
  env: NodeJS.ProcessEnv = process.env
) {
  const expectedText = expected ? "true" : "false";
  if (envValue(name, env).toLowerCase() !== expectedText) {
    failures.push(`${name} must be exactly ${expectedText}.`);
  }
}

function preflight(options: CliOptions, env: NodeJS.ProcessEnv = process.env) {
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
  if (!flagIsTrue("DELIVERY_REAL_CUSTOMER_SEND_ENABLED", env)) {
    failures.push("DELIVERY_REAL_CUSTOMER_SEND_ENABLED must be exactly true.");
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
  if (!flagIsTrue("TWILIO_WEBHOOK_VALIDATE_SIGNATURES", env)) {
    failures.push("TWILIO_WEBHOOK_VALIDATE_SIGNATURES must be exactly true.");
  }

  if (config) {
    requireFlagValue(
      failures,
      "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN",
      config.confirmationWritebackDryRunRequired,
      env
    );
  } else {
    addMissingEnvFailure(failures, "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN", "confirmation writeback posture", env);
  }

  for (const name of [
    "DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN",
    "DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN",
    "DELIVERY_PREPAYMENT_HOLD_DRY_RUN",
  ]) {
    requireFlagValue(failures, name, true, env);
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
}) {
  if (params.currentRunCreatedEventIds && params.currentRunCreatedEventIds.length === 0) {
    return [];
  }

  return prisma.notificationEvent.findMany({
    where: {
      id: params.currentRunCreatedEventIds ? { in: params.currentRunCreatedEventIds } : undefined,
      intervalType: params.config.intervalType,
      actionType: params.config.actionType,
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
  return null;
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

async function dispatchPreviewForEvents(eventIds: string[], runId: string) {
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

async function dispatchSendForEvents(eventIds: string[], runId: string) {
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

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.runDate) dateFromKey(options.runDate);
  const runDate = options.runDate;
  const config = options.interval ? INTERVAL_CONFIGS[options.interval] : null;
  const runId = options.runId ?? (runDate && config ? defaultRunId(runDate, config.interval) : null);
  if (runId) validateRunId(runId);

  preflight(options);
  if (!runDate || !runId || !config) throw new Error("Internal preflight error: missing run date, run id, or interval.");
  verifyPackageScript();
  const migrationStatus = verifyMigrationStatus();

  const targetDate = dateKey(getNotificationTargetDate(runDate, config.days));
  const before = await runtimeCounts();

  const createSummary = await config.createEvents({
    runDate,
    dryRun: false,
  });

  if (createSummary.freshImport.globalFailed || createSummary.freshImport.errorMessage) {
    throw new Error(
      `Fresh import failed globally; refusing to dispatch: ${redactSensitiveText(createSummary.freshImport.errorMessage)}`
    );
  }
  if (
    config.abortOnPerOrderImportFailure &&
    (createSummary.freshImport.perOrderFailed ||
      createSummary.deliveryGroupsSkippedFailedImport > 0)
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
  });
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
    console.log(
      JSON.stringify(
        {
          ok: true,
          phase: "complete_no_dispatchable_events",
          interval: config.interval,
          runDate,
          targetDeliveryDate: targetDate,
          migrationStatus,
          importSummary: createSummary.freshImport.importResult,
          candidateCount: createSummary.targetDeliveryGroups,
          productionQualifiedCount: 0,
          skippedCountByReason: summarizeSkippedReasons(createSummary.skippedReasons),
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
        },
        null,
        2
      )
    );
    return;
  }

  const previewReports = await dispatchPreviewForEvents(
    scheduledEvents.map((event) => event.id),
    runId
  );

  const dispatchSummaries = await dispatchSendForEvents(
    scheduledEvents.map((event) => event.id),
    runId
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

  console.log(
    JSON.stringify(
      {
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
        confirmationWritebackDryRunRequired: config.confirmationWritebackDryRunRequired,
        confirmationWritebackLivePayloadsEnabled: !config.confirmationWritebackDryRunRequired,
        importSummary: createSummary.freshImport.importResult,
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
        dedupeSkippedCount: createSummary.eventsDeduped,
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
      },
      null,
      2
    )
  );
}

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
