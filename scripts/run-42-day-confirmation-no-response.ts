import {
  InternalNotificationPurpose,
  NotificationAttemptStatus,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  run42DayDeliveryConfirmationNoResponse,
  type DeliveryConfirmationNoResponseRunSummary,
} from "../lib/notifications/deliveryConfirmationNoResponse";
import {
  dispatchDeliveryNotifications,
  type DeliveryDispatchSummary,
} from "../lib/notifications/deliveryNotificationDispatcher";
import { addDays, dateFromKey, dateKey } from "../lib/notifications/helpers";
import {
  deliveryOrderMatchesScope,
  describeDeliveryOrderScope,
  normalizeDeliveryOrderScope,
  type DeliveryOrderScope,
} from "../lib/notifications/orderScope";
import { prisma } from "../lib/prisma";

const REAL_NO_RESPONSE_CONFIRM_PHRASE = "RUN REAL 42 DAY NO RESPONSE FOLLOW UPS";

type CliMode = "dry-run" | "apply" | "send";

export type NoResponseCliOptions = {
  runDate: string | null;
  mode: CliMode;
  confirmPhrase: string | null;
  testRunId: string | null;
  orderType: string | null;
  orderNumber: string | null;
  orderScope: DeliveryOrderScope | null;
};

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

function parseArgs(argv: string[]): NoResponseCliOptions {
  const options: NoResponseCliOptions = {
    runDate: null,
    mode: "dry-run",
    confirmPhrase: null,
    testRunId: null,
    orderType: null,
    orderNumber: null,
    orderScope: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run" || arg === "--preview") {
      options.mode = "dry-run";
      continue;
    }

    if (arg === "--apply" || arg === "--live") {
      options.mode = "apply";
      continue;
    }

    if (arg === "--send") {
      options.mode = "send";
      continue;
    }

    if (arg === "--run-date" || arg.startsWith("--run-date=")) {
      const parsed = readOption(argv, index, "--run-date");
      options.runDate = dateKey(parsed.value);
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      const parsed = readOption(argv, index, "--confirm");
      options.confirmPhrase = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--test-run-id" || arg.startsWith("--test-run-id=")) {
      const parsed = readOption(argv, index, "--test-run-id");
      options.testRunId = parsed.value.trim();
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--order-type" || arg.startsWith("--order-type=")) {
      const parsed = readOption(argv, index, "--order-type");
      options.orderType = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--order-number" || arg.startsWith("--order-number=")) {
      const parsed = readOption(argv, index, "--order-number");
      options.orderNumber = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (!arg.startsWith("-") && !options.runDate) {
      options.runDate = dateKey(arg);
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

function flagIsFalseOrUnset(name: string, env: NodeJS.ProcessEnv = process.env) {
  const value = envValue(name, env).toLowerCase();
  return !value || value === "false";
}

function requireEnv(failures: string[], name: string, purpose: string) {
  if (!envValue(name)) failures.push(`${name} is required for ${purpose}.`);
}

function requireFlagTrue(failures: string[], name: string) {
  if (!flagIsTrue(name)) failures.push(`${name} must be exactly true.`);
}

function requireFlagFalseOrUnset(failures: string[], name: string) {
  if (!flagIsFalseOrUnset(name)) failures.push(`${name} must be false or unset.`);
}

function validateRunId(value: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("--test-run-id may contain only letters, numbers, underscores, periods, and dashes.");
  }
  if (value.length > 128) {
    throw new Error("--test-run-id must be 128 characters or fewer.");
  }
}

function defaultRunId(runDate: string) {
  return `production_${runDate.replace(/-/g, "")}_42_no_response`;
}

function redactEmail(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return "<redacted-email>";
  return `${local.slice(0, 1)}***@${domain}`;
}

function redactPhone(value: string | null | undefined) {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (!digits) return null;
  return `***${digits.slice(-4)}`;
}

function redactRecipient(channel: NotificationChannel | string | null, value: string | null | undefined) {
  if (!channel || !value) return null;
  return channel === NotificationChannel.SMS || channel === "SMS" ? redactPhone(value) : redactEmail(value);
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

function preflight(options: NoResponseCliOptions) {
  const failures: string[] = [];

  if (!options.runDate) {
    failures.push("--run-date YYYY-MM-DD is required.");
  }

  if (options.mode === "send" && options.confirmPhrase !== REAL_NO_RESPONSE_CONFIRM_PHRASE) {
    failures.push(`--confirm must exactly equal "${REAL_NO_RESPONSE_CONFIRM_PHRASE}".`);
  }

  if (options.mode !== "send" && options.confirmPhrase) {
    failures.push("--confirm is only accepted with --send.");
  }

  requireEnv(failures, "DATABASE_URL", "database access");

  if (options.mode === "send") {
    requireEnv(failures, "MLD_QUEUE_BASE_URL", "queue-backed ERP refresh");
    requireEnv(failures, "MLD_QUEUE_TOKEN", "queue-backed ERP refresh");
    requireEnv(failures, "DELIVERY_APP_BASE_URL", "customer delivery confirmation links");
    requireEnv(failures, "TWILIO_ACCOUNT_SID", "SMS sends");
    requireEnv(failures, "TWILIO_AUTH_TOKEN", "SMS sends");
    if (!envValue("TWILIO_MESSAGING_SERVICE_SID") && !envValue("TWILIO_FROM_NUMBER")) {
      failures.push("TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER is required for SMS sends.");
    }
    for (const name of [
      "MS_GRAPH_TENANT_ID",
      "MS_GRAPH_CLIENT_ID",
      "MS_GRAPH_CLIENT_SECRET",
      "MS_GRAPH_FROM_EMAIL",
    ]) {
      requireEnv(failures, name, "email sends");
    }

    if (
      process.env.NODE_ENV !== "production" &&
      !flagIsTrue("DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION")
    ) {
      failures.push(
        "NODE_ENV must be production, or DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION must be exactly true for an approved local shell run."
      );
    }

    requireFlagTrue(failures, "USE_QUEUE_ERP");
    requireFlagTrue(failures, "DELIVERY_REAL_CUSTOMER_SEND_ENABLED");
    requireFlagTrue(failures, "TWILIO_WEBHOOK_VALIDATE_SIGNATURES");
    requireFlagFalseOrUnset(failures, "DELIVERY_CONTROLLED_RECIPIENT_MODE");
    requireFlagFalseOrUnset(failures, "DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST");
    requireFlagFalseOrUnset(failures, "DEMO_NOTIFICATION_SEND_ENABLED");

    for (const name of [
      "DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN",
      "DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN",
      "DELIVERY_PREPAYMENT_HOLD_DRY_RUN",
    ]) {
      requireFlagTrue(failures, name);
    }

    const appBaseUrl = envValue("DELIVERY_APP_BASE_URL");
    if (/localhost|127\.0\.0\.1|::1/i.test(appBaseUrl)) {
      failures.push("DELIVERY_APP_BASE_URL must not be localhost for real customer sends.");
    }
  }

  if (failures.length > 0) {
    throw new Error(`42-day no-response preflight failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

async function runtimeCounts() {
  const [
    notificationEvents,
    notificationAttempts,
    twilioCallbacks,
    deliveryConfirmations,
    internalNotificationEvents,
    deliveryOrderHoldActions,
    contactOptInWritebackActions,
  ] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.twilioMessageStatusCallback.count(),
    prisma.deliveryConfirmation.count(),
    prisma.internalNotificationEvent.count(),
    prisma.deliveryOrderHoldAction.count(),
    prisma.contactOptInWritebackAction.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
    twilioCallbacks,
    deliveryConfirmations,
    internalNotificationEvents,
    deliveryOrderHoldActions,
    contactOptInWritebackActions,
  };
}

function summarizeSkippedReasons(reasons: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(reasons).sort((left, right) => right[1] - left[1])
  );
}

async function oldScheduledDay42Events(currentRunEventIds: string[]) {
  const grouped = await prisma.notificationEvent.groupBy({
    by: ["actionType"],
    where: {
      intervalType: NotificationIntervalType.DAY_42,
      status: NotificationEventStatus.SCHEDULED,
      id: currentRunEventIds.length > 0 ? { notIn: currentRunEventIds } : undefined,
    },
    _count: { _all: true },
  });

  return {
    total: grouped.reduce((sum, row) => sum + row._count._all, 0),
    byActionType: Object.fromEntries(
      grouped.map((row) => [row.actionType, row._count._all])
    ),
  };
}

async function currentRunEvents(eventIds: string[]) {
  if (eventIds.length === 0) return [];

  return prisma.notificationEvent.findMany({
    where: { id: { in: eventIds } },
    orderBy: [{ orderType: "asc" }, { orderNumber: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      intervalType: true,
      actionType: true,
      status: true,
      selectedChannel: true,
      recipientEmail: true,
      recipientPhone: true,
      _count: { select: { attempts: true } },
    },
  });
}

function assertCurrentRunEventsDispatchable(events: Awaited<ReturnType<typeof currentRunEvents>>) {
  const failures: string[] = [];
  for (const event of events) {
    if (event.intervalType !== NotificationIntervalType.DAY_42) {
      failures.push(`${event.id}: interval is ${event.intervalType}`);
    }
    if (
      event.actionType !== "DELIVERY_CONFIRMATION_REMINDER" &&
      event.actionType !== "DELIVERY_CONFIRMATION_REQUEST"
    ) {
      failures.push(`${event.id}: action is ${event.actionType}`);
    }
    if (event.status !== NotificationEventStatus.SCHEDULED) {
      failures.push(`${event.id}: status is ${event.status}`);
    }
    if (!event.selectedChannel) {
      failures.push(`${event.id}: selected channel is missing`);
    }
    if (event._count.attempts > 0) {
      failures.push(`${event.id}: already has ${event._count.attempts} attempt(s)`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Current-run no-response event safety check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
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

function assertDispatcherPreviewSafe(reports: DeliveryDispatchSummary["reports"]) {
  const failures: string[] = [];
  for (const report of reports) {
    if (report.outcome !== "previewed") {
      failures.push(`${report.eventId}: preview outcome ${report.outcome}: ${report.reason ?? "no reason"}`);
    }
    if (report.controlledRecipientMode) {
      failures.push(`${report.eventId}: controlled-recipient mode was enabled`);
    }
    if (report.forcedContactEligibility) {
      failures.push(`${report.eventId}: forced contact eligibility was enabled`);
    }
    if (report.finalRecipientKind !== "customer") {
      failures.push(`${report.eventId}: final recipient was not the customer`);
    }
    if (report.realRecipientSuppressed) {
      failures.push(`${report.eventId}: real recipient was suppressed`);
    }
    if (report.finalRecipientIsTestRecipient) {
      failures.push(`${report.eventId}: dispatcher resolved to the configured test recipient`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Dispatcher preview safety check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

async function dispatchPreviewForEvents(eventIds: string[], testRunId: string) {
  const attemptsBefore = await prisma.notificationAttempt.count();
  const reports: DeliveryDispatchSummary["reports"] = [];

  for (const eventId of eventIds) {
    const summary = await dispatchDeliveryNotifications({
      preview: true,
      send: false,
      controlledRecipientSend: false,
      testRunId: `${testRunId}_preview`,
      eventId,
      limit: 1,
    });
    reports.push(...summary.reports);
  }

  assertDispatcherPreviewSafe(reports);
  const attemptsAfter = await prisma.notificationAttempt.count();
  if (attemptsAfter !== attemptsBefore) {
    throw new Error("Dispatcher preview created NotificationAttempt rows; refusing to send.");
  }

  return reports;
}

async function dispatchSendForEvents(eventIds: string[], testRunId: string) {
  const summaries: DeliveryDispatchSummary[] = [];
  for (const eventId of eventIds) {
    summaries.push(
      await dispatchDeliveryNotifications({
        preview: false,
        send: true,
        controlledRecipientSend: false,
        testRunId,
        eventId,
        limit: 1,
      })
    );
  }
  return summaries;
}

async function attemptsForReports(reports: DeliveryDispatchSummary["reports"]) {
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

async function scopedNoResponseDiagnostic(scope: DeliveryOrderScope | null, runDate: string) {
  if (!scope) return null;

  const deliveryDateFrom = dateFromKey(dateKey(addDays(runDate, 39)));
  const deliveryDateTo = dateFromKey(dateKey(addDays(runDate, 41)));
  const rows = await prisma.deliveryConfirmation.findMany({
    where: {
      orderType: scope.orderType,
      orderNumber: scope.orderNumber,
      deliveryDate: {
        gte: deliveryDateFrom,
        lte: deliveryDateTo,
      },
    },
    orderBy: [{ deliveryDate: "asc" }, { id: "asc" }],
    select: {
      id: true,
      deliveryDate: true,
      status: true,
      confirmedAt: true,
      requestedNewDate: true,
      manualReviewRequired: true,
      noResponseAt: true,
      orderDeliveryGroup: {
        select: {
          id: true,
          isActive: true,
          deliveryDate: true,
          status: true,
          deliveryGroupLines: {
            where: { isActive: true },
            select: { id: true },
          },
          order: {
            select: {
              status: true,
              internalLifecycleStatus: true,
              confirmVia: true,
            },
          },
        },
      },
    },
  });

  return {
    deliveryDateFrom: dateKey(deliveryDateFrom),
    deliveryDateTo: dateKey(deliveryDateTo),
    foundConfirmationRows: rows.length,
    rows: rows.map((row) => ({
      confirmationId: row.id,
      deliveryDate: dateKey(row.deliveryDate),
      status: row.status,
      confirmed: Boolean(row.confirmedAt),
      requestedNewDate: row.requestedNewDate ? dateKey(row.requestedNewDate) : null,
      manualReviewRequired: row.manualReviewRequired,
      noResponseAtPresent: Boolean(row.noResponseAt),
      deliveryGroupId: row.orderDeliveryGroup.id,
      deliveryGroupDate: dateKey(row.orderDeliveryGroup.deliveryDate),
      deliveryGroupActive: row.orderDeliveryGroup.isActive,
      deliveryGroupStatus: row.orderDeliveryGroup.status,
      activeDeliveryLineCount: row.orderDeliveryGroup.deliveryGroupLines.length,
      orderStatus: row.orderDeliveryGroup.order.status,
      internalLifecycleStatus: row.orderDeliveryGroup.order.internalLifecycleStatus,
      acumaticaConfirmViaPresent: Boolean(row.orderDeliveryGroup.order.confirmVia?.trim()),
    })),
    noQualifyingCandidateReason:
      rows.length === 0
        ? "Scoped order has no DeliveryConfirmation in the 39-41 day no-response window for this run date."
        : "Scoped order has DeliveryConfirmation row(s), but current status/state filters kept them out of the no-response state machine.",
  };
}

function plannedReport(summary: DeliveryConfirmationNoResponseRunSummary) {
  return {
    runDate: summary.runDate,
    targetDeliveryDates: summary.targetDeliveryDates,
    weekendSkipped: summary.weekendSkipped,
    reminderCandidatesChecked: summary.reminderCandidatesChecked,
    escalationCandidatesChecked: summary.escalationCandidatesChecked,
    reminderCandidateCounts: summary.reminderCandidateCounts,
    escalationCandidateCount: summary.escalationCandidateCount,
    currentStateRefreshesAttempted: summary.currentStateRefreshesAttempted,
    currentStateRefreshesSucceeded: summary.currentStateRefreshesSucceeded,
    currentStateRefreshesFailed: summary.currentStateRefreshesFailed,
    externalConfirmationsStopped: summary.externalConfirmationsStopped,
    staleConfirmationsExpired: summary.staleConfirmationsExpired,
    reminderEventsCreated: summary.reminderEventsCreated,
    reminderEventsCreatedByTouch: summary.reminderEventsCreatedByTouch,
    reminderEventsWouldCreate: summary.reminderEventsWouldCreate,
    reminderEventsWouldCreateByTouch: summary.reminderEventsWouldCreateByTouch,
    reminderEventsDeduped: summary.reminderEventsDeduped,
    reminderEventsDedupedByTouch: summary.reminderEventsDedupedByTouch,
    reminderEventsSkipped: summary.reminderEventsSkipped,
    initialCatchUpEventsCreated: summary.initialCatchUpEventsCreated,
    initialCatchUpEventsWouldCreate: summary.initialCatchUpEventsWouldCreate,
    initialCatchUpEventsDeduped: summary.initialCatchUpEventsDeduped,
    initialCatchUpsScheduled: summary.initialCatchUpsScheduled,
    remindersScheduled: summary.remindersScheduled,
    remindersScheduledByTouch: summary.remindersScheduledByTouch,
    remindersScheduledByChannel: summary.remindersScheduledByChannel,
    confirmationsUpdatedAfterReminder: summary.confirmationsUpdatedAfterReminder,
    internalEscalationsCreated: summary.internalEscalationsCreated,
    internalEscalationsWouldCreate: summary.internalEscalationsWouldCreate,
    internalEscalationsDeduped: summary.internalEscalationsDeduped,
    internalEscalationsSkipped: summary.internalEscalationsSkipped,
    manualReviewMarked: summary.manualReviewMarked,
    noChannelEscalations: summary.noChannelEscalations,
    skippedReasons: summarizeSkippedReasons(summary.skippedReasons),
    eventReportCount: summary.eventReports.length,
  };
}

export async function run42DayNoResponseCommand(options: NoResponseCliOptions) {
  if (options.runDate) dateFromKey(options.runDate);
  const runDate = options.runDate;
  const testRunId = options.testRunId ?? (runDate ? defaultRunId(runDate) : null);
  if (testRunId) validateRunId(testRunId);

  preflight(options);
  if (!runDate || !testRunId) throw new Error("Internal preflight error: missing run date or test run id.");

  const before = await runtimeCounts();
  const dryRun = options.mode === "dry-run";
  const summary = await run42DayDeliveryConfirmationNoResponse({
    runDate,
    dryRun,
    orderScope: options.orderScope,
  });
  const scopedDiagnostic =
    options.orderScope && summary.orderScope.scopedCount === 0
      ? await scopedNoResponseDiagnostic(options.orderScope, runDate)
      : null;
  const createdEventIds = summary.dispatchableReminderEventIdsCreatedThisRun;
  const events = await currentRunEvents(createdEventIds);
  assertCurrentRunEventsDispatchable(events);
  assertRowsWithinOrderScope(options.orderScope, summary.eventReports, "No-response event reports");
  assertRowsWithinOrderScope(options.orderScope, events, "No-response dispatchable events");

  const oldScheduledDay42 = await oldScheduledDay42Events(createdEventIds);
  let previewReports: DeliveryDispatchSummary["reports"] = [];
  let dispatchReports: DeliveryDispatchSummary["reports"] = [];
  let attempts: Awaited<ReturnType<typeof attemptsForReports>> = [];

  if (options.mode === "send" && createdEventIds.length > 0) {
    previewReports = await dispatchPreviewForEvents(createdEventIds, testRunId);
    const dispatchSummaries = await dispatchSendForEvents(createdEventIds, testRunId);
    dispatchReports = dispatchSummaries.flatMap((dispatchSummary) => dispatchSummary.reports);
    attempts = await attemptsForReports(dispatchReports);
  }

  const after = await runtimeCounts();
  const smsAttemptsCreated = attempts.filter((attempt) => attempt.channel === NotificationChannel.SMS).length;
  const emailAttemptsCreated = attempts.filter((attempt) => attempt.channel === NotificationChannel.EMAIL).length;
  const providerAcceptedCount = attempts.filter((attempt) => attempt.success === true).length;
  const providerFailedCount = attempts.filter(
    (attempt) => attempt.status === NotificationAttemptStatus.FAILED || attempt.success === false
  ).length;

  return {
        ok:
          options.mode !== "send" ||
          dispatchReports.every((report) => report.outcome === "submitted"),
        mode: options.mode,
        sendModeRequiresExactConfirmPhrase: REAL_NO_RESPONSE_CONFIRM_PHRASE,
        runDate,
        dryRun,
        noResponseTouchLifecycle: {
          day41: "state-machine customer touch: initial catch-up when original 42 touch is missing, otherwise first reminder",
          day40: "state-machine customer touch: initial catch-up, first reminder, or final reminder based on completed touch history",
          day39: "state-machine internal escalation: normal no-response only after three completed touches, otherwise incomplete-touch escalation",
          confirmationFollowUpCountSourceOfTruth: false,
          sourceOfTruth: "NotificationEvent/NotificationAttempt touch history plus current confirmation/order state",
        },
        noResponseWritebackPosture: {
          noDirectAcumaticaWriteFromRunner: true,
          noConfirmViaWriteFromRunner: true,
          noConfirmWithWriteFromRunner: true,
          noOneWeekConWriteFromRunner: true,
          noHoldWriteFromRunner: true,
          deliveryConfirmationWritebackDryRunEnv:
            envValue("DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN") || null,
          contactOptInWritebackDryRunRequiredForSend: true,
          tenDayConfirmationWritebackDryRunRequiredForSend: true,
          prepaymentHoldDryRunRequiredForSend: true,
        },
        orderScope: {
          requested: options.orderScope,
          summary: summary.orderScope,
          zeroCandidateDiagnostic: scopedDiagnostic,
          blastRadiusLimitedOnly: Boolean(options.orderScope),
          productionEligibilityStillRequired: true,
          touchHistoryStateMachineStillRequired: true,
          forcedEligibility: false,
          controlledRecipientMode: false,
        },
        productionRouting: {
          controlledRecipientMode: flagIsTrue("DELIVERY_CONTROLLED_RECIPIENT_MODE"),
          forcedContactEligibility: flagIsTrue("DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST"),
          realCustomerSendGateRequired: options.mode === "send",
          realCustomerRecipientsUsed: options.mode === "send",
          configuredTestRecipientsNotUsedForRouting: options.mode === "send",
        },
        summary: plannedReport(summary),
        currentRunDispatchableReminderEventIds: createdEventIds,
        currentRunDispatchableReminderEventCount: createdEventIds.length,
        currentRunDispatchableReminderEvents: events.map((event) => ({
          id: event.id,
          orderType: event.orderType,
          orderNumber: event.orderNumber,
          selectedChannel: event.selectedChannel,
          recipientMasked: redactRecipient(
            event.selectedChannel,
            event.selectedChannel === NotificationChannel.SMS ? event.recipientPhone : event.recipientEmail
          ),
        })),
        internalEscalationReviewPath: {
          senderIntegrated: false,
          reviewQueueCommand: "npm.cmd run review:42-day-no-response-internal-escalations",
          currentRunInternalEscalationEventIds: summary.internalEscalationEventIdsCreatedThisRun,
          currentRunInternalEscalationEventCount: summary.internalEscalationEventIdsCreatedThisRun.length,
          purpose: InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE,
        },
        oldScheduledDay42Events: oldScheduledDay42,
        oldScheduledDay42Protection: {
          dispatchOnlyCurrentRunCreatedReminderEventIds: true,
          oldScheduledRowsTouched: 0,
          oldScheduledRowsDeleted: 0,
        },
        dispatchPreviewReports: previewReports.map((report) => ({
          eventId: report.eventId,
          orderType: report.orderType,
          orderNumber: report.orderNumber,
          intervalType: report.intervalType,
          actionType: report.actionType,
          outcome: report.outcome,
          reason: redactSensitiveText(report.reason),
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
        productionRunReport: {
          smsSendsAttempted: smsAttemptsCreated,
          emailSendsAttempted: emailAttemptsCreated,
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
          optOutBlockedCount: dispatchReports.filter(
            (report) =>
              report.outcome === "skipped" &&
              (report.localSmsOptOutActive ||
                report.localEmailOptOutActive ||
                report.globalSmsOptOutActive ||
                report.globalEmailOptOutActive)
          ).length,
          dedupeSkippedCount: summary.reminderEventsDeduped + summary.internalEscalationsDeduped,
          errors: dispatchReports
            .filter((report) => report.outcome === "failed")
            .map((report) => ({
              eventId: report.eventId,
              reason: redactSensitiveText(report.reason),
            })),
          exactNextOperationalAction:
            options.mode === "send"
              ? "Review provider callbacks and customer replies before running the next no-response pass."
              : "Review this report before running --send.",
        },
        safetyCounts: {
          before,
          after,
          deltas: {
            notificationEvents: after.notificationEvents - before.notificationEvents,
            notificationAttempts: after.notificationAttempts - before.notificationAttempts,
            twilioCallbacks: after.twilioCallbacks - before.twilioCallbacks,
            deliveryConfirmations: after.deliveryConfirmations - before.deliveryConfirmations,
            internalNotificationEvents:
              after.internalNotificationEvents - before.internalNotificationEvents,
            deliveryOrderHoldActions:
              after.deliveryOrderHoldActions - before.deliveryOrderHoldActions,
            contactOptInWritebackActions:
              after.contactOptInWritebackActions - before.contactOptInWritebackActions,
          },
          previewCreatedNoAttempts:
            options.mode !== "send" && before.notificationAttempts === after.notificationAttempts,
          noHoldActionsCreated:
            before.deliveryOrderHoldActions === after.deliveryOrderHoldActions,
          noContactOptInWritebackActionsCreated:
            before.contactOptInWritebackActions === after.contactOptInWritebackActions,
        },
        sensitiveValuesPrinted: false,
      };
}

async function main() {
  const result = await run42DayNoResponseCommand(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (typeof require !== "undefined" && require.main === module) {
  main()
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
