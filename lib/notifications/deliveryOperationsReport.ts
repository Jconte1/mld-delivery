import {
  InternalNotificationPurpose,
  NotificationActionType,
  NotificationIntervalType,
  Prisma,
} from "@/lib/generated/prisma/client";
import { createDeliveryNotificationProvider } from "@/lib/notifications/deliveryNotificationProviders";
import { deliveryConfirmationReminderTouchNumberFromDedupeKey } from "@/lib/notifications/deliveryConfirmationNoResponse";
import { dateFromKey, dateKey } from "@/lib/notifications/helpers";
import { prisma } from "@/lib/prisma";

const REPORT_TIMEZONE = "America/Denver";
const REPORT_INTERVAL = "OPERATIONS_REPORT";
const DEFAULT_REPORT_RECIPIENT = "james@mld.com";
const REPORT_LIFECYCLE_INTERVALS = ["180", "90", "60", "42", "41", "40", "39", "30", "14", "12", "10", "8", "2"] as const;

type QueueJobStatus = {
  jobId?: string;
  status?: "queued" | "processing" | "succeeded" | "failed";
  result?: unknown;
  error?: string | null;
};

type ReportResult = {
  ok: boolean;
  phase: string;
  reportDate: string;
  recipient: string;
  schedulerRunId?: string;
  qualifyingOrders?: number;
  writebacks?: number;
  failedWritebacks?: number;
  providerRequestIdPresent?: boolean;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function denverDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function recentWindow(reportDate: string) {
  const center = dateFromKey(reportDate).getTime();
  return {
    gte: new Date(center - 36 * 60 * 60 * 1000),
    lt: new Date(center + 48 * 60 * 60 * 1000),
  };
}

function happenedOnDenverDate(value: Date | null | undefined, reportDate: string) {
  return Boolean(value && denverDate(value) === reportDate);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function queueWritebackOutcome(job: QueueJobStatus) {
  if (job.status === "queued" || job.status === "processing") {
    return { status: job.status, error: job.error ?? null };
  }
  if (job.status === "failed") {
    return { status: "queue_failed", error: job.error ?? "Queue worker marked the job failed" };
  }
  const result = objectValue(job.result);
  const businessStatus = typeof result.status === "string" && result.status.trim()
    ? result.status.trim().toLowerCase()
    : "succeeded_unclassified";
  const detail = [result.reason, result.error, result.holdRestoreError]
    .find((value) => typeof value === "string" && value.trim());
  return {
    status: businessStatus,
    error: typeof detail === "string" ? detail : job.error ?? null,
  };
}

export function deliveryWritebackSucceeded(
  kind: "confirmation" | "requestedDate",
  status: string | null | undefined
) {
  if (status === "written") return true;
  return kind === "requestedDate" && status === "skipped_existing_value";
}

function queueConfig() {
  const baseUrl = process.env.MLD_QUEUE_BASE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MLD_QUEUE_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("MLD_QUEUE_BASE_URL and MLD_QUEUE_TOKEN are required for writeback reporting");
  return { baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`, token };
}

async function fetchQueueJob(jobId: string): Promise<QueueJobStatus> {
  const config = queueConfig();
  const response = await fetch(`${config.baseUrl}/api/erp/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${config.token}` },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Queue status failed for ${jobId}: ${response.status} ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as QueueJobStatus) : {};
}

async function refreshConfirmationWritebacks() {
  const confirmations = await prisma.deliveryConfirmation.findMany({
    where: {
      OR: [
        {
          confirmationWritebackJobId: { not: null },
          OR: [
            { confirmationWritebackStatus: null },
            { confirmationWritebackStatus: { in: ["queued", "processing", "status_check_failed"] } },
          ],
        },
        {
          requestedDateWritebackJobId: { not: null },
          OR: [
            { requestedDateWritebackStatus: null },
            { requestedDateWritebackStatus: { in: ["queued", "processing", "status_check_failed"] } },
          ],
        },
      ],
    },
    take: 500,
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      confirmationWritebackJobId: true,
      requestedDateWritebackJobId: true,
    },
  });

  for (const confirmation of confirmations) {
    for (const kind of ["confirmation", "requestedDate"] as const) {
      const jobId = kind === "confirmation"
        ? confirmation.confirmationWritebackJobId
        : confirmation.requestedDateWritebackJobId;
      if (!jobId) continue;
      try {
        const job = await fetchQueueJob(jobId);
        const terminal = job.status === "succeeded" || job.status === "failed";
        const outcome = queueWritebackOutcome(job);
        const prefix = kind === "confirmation" ? "confirmationWriteback" : "requestedDateWriteback";
        await prisma.deliveryConfirmation.update({
          where: { id: confirmation.id },
          data: {
            [`${prefix}Status`]: outcome.status,
            [`${prefix}Result`]: job.result === undefined
              ? undefined
              : job.result === null
                ? Prisma.JsonNull
                : job.result as Prisma.InputJsonValue,
            [`${prefix}Error`]: outcome.error?.slice(0, 2048) ?? null,
            [`${prefix}CheckedAt`]: new Date(),
            [`${prefix}CompletedAt`]: terminal ? new Date() : null,
          },
        });
      } catch (error) {
        const prefix = kind === "confirmation" ? "confirmationWriteback" : "requestedDateWriteback";
        await prisma.deliveryConfirmation.update({
          where: { id: confirmation.id },
          data: {
            [`${prefix}Status`]: "status_check_failed",
            [`${prefix}Error`]: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
            [`${prefix}CheckedAt`]: new Date(),
          },
        });
      }
    }
  }
}

export function deliveryOperationsIntervalLabel(event: {
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
  dedupeKey: string;
}) {
  if (event.intervalType !== NotificationIntervalType.DAY_42) {
    return event.intervalType.replace("DAY_", "");
  }
  if (event.actionType === NotificationActionType.DELIVERY_CONFIRMATION_REQUEST) return "42";
  const touch = deliveryConfirmationReminderTouchNumberFromDedupeKey(event.dedupeKey);
  if (touch === 2) return "41";
  if (touch === 3) return "40";
  return "42 follow-up";
}

function importHealth(summary: unknown) {
  const root = objectValue(summary);
  const importSummary = objectValue(root.importSummary);
  const errors = Array.isArray(importSummary.errors) ? importSummary.errors.length : 0;
  const refreshed = Array.isArray(root.successfullyRefreshedOrders)
    ? root.successfullyRefreshedOrders.length
    : Number(importSummary.importedOrders ?? importSummary.ordersImported ?? 0);
  const failed = Array.isArray(root.failedImportExclusions) ? root.failedImportExclusions.length : errors;
  return { refreshed, failed };
}

function table(headers: string[], rows: Array<Array<unknown>>) {
  const head = headers.map((header) => `<th style="text-align:left;padding:7px;border:1px solid #ccd2d8;background:#eef1f4">${escapeHtml(header)}</th>`).join("");
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => `<td style="padding:7px;border:1px solid #ccd2d8;vertical-align:top">${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}" style="padding:9px;border:1px solid #ccd2d8">None</td></tr>`;
  return `<table style="border-collapse:collapse;width:100%;font:13px Arial,sans-serif"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export async function buildDeliveryOperationsReport(reportDate: string) {
  await refreshConfirmationWritebacks();
  const runDate = dateFromKey(reportDate);
  const window = recentWindow(reportDate);
  const [schedulerRuns, events, internalEscalations, confirmations, tenDay, holds] = await Promise.all([
    prisma.deliveryIntervalSchedulerRun.findMany({
      where: { runDate, interval: { not: REPORT_INTERVAL } },
      orderBy: [{ interval: "asc" }, { startedAt: "asc" }],
    }),
    prisma.notificationEvent.findMany({
      where: { scheduledAt: runDate },
      orderBy: [{ intervalType: "asc" }, { orderType: "asc" }, { orderNumber: "asc" }],
      include: {
        attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
        order: { select: { lastSyncedAt: true } },
      },
    }),
    prisma.internalNotificationEvent.findMany({
      where: {
        purpose: InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE,
        createdAt: window,
      },
      orderBy: [{ orderType: "asc" }, { orderNumber: "asc" }],
    }),
    prisma.deliveryConfirmation.findMany({
      where: {
        OR: [
          { confirmationWritebackQueuedAt: window },
          { confirmationWritebackCheckedAt: window },
          { requestedDateWritebackQueuedAt: window },
          { requestedDateWritebackCheckedAt: window },
        ],
      },
      orderBy: [{ orderType: "asc" }, { orderNumber: "asc" }],
    }),
    prisma.deliveryGroupTenDayConfirmation.findMany({
      where: { updatedAt: window },
      orderBy: [{ orderType: "asc" }, { orderNumber: "asc" }],
    }),
    prisma.deliveryOrderHoldAction.findMany({
      where: { updatedAt: window },
      orderBy: [{ orderType: "asc" }, { orderNumber: "asc" }],
    }),
  ]);

  const eventRows: Array<{
    interval: string;
    order: string;
    deliveryDate: string;
    channel: string;
    eventStatus: string;
    attemptStatus: string;
    providerAccepted: string;
    lastSyncedAt: string;
  }> = events.map((event) => {
    const attempt = event.attempts[0];
    return {
      interval: deliveryOperationsIntervalLabel(event),
      order: `${event.orderType} ${event.orderNumber}`,
      deliveryDate: dateKey(event.deliveryDate),
      channel: event.selectedChannel ?? "none",
      eventStatus: event.status,
      attemptStatus: attempt?.status ?? "none",
      providerAccepted: attempt?.success === true ? "yes" : attempt ? "no" : "n/a",
      lastSyncedAt: event.order.lastSyncedAt?.toISOString() ?? "missing",
    };
  });
  for (const event of internalEscalations.filter((row) => happenedOnDenverDate(row.createdAt, reportDate))) {
    eventRows.push({
      interval: "39",
      order: `${event.orderType} ${event.orderNumber}`,
      deliveryDate: dateKey(event.deliveryDate),
      channel: "internal email",
      eventStatus: event.status,
      attemptStatus: event.status,
      providerAccepted: event.providerMessageId ? "yes" : event.status === "FAILED" ? "no" : "n/a",
      lastSyncedAt: "see 39-day state refresh",
    });
  }
  eventRows.sort((a, b) => Number(b.interval.replace(/\D/g, "")) - Number(a.interval.replace(/\D/g, "")) || a.order.localeCompare(b.order));

  const writebacks: Array<{ order: string; kind: string; target: string; jobId: string; status: string; success: string; error: string }> = [];
  for (const row of confirmations) {
    if (
      happenedOnDenverDate(row.confirmationWritebackQueuedAt, reportDate) ||
      happenedOnDenverDate(row.confirmationWritebackCheckedAt, reportDate)
    ) {
      const payload = objectValue(row.confirmationWritebackPayload);
      writebacks.push({
        order: `${row.orderType} ${row.orderNumber}`,
        kind: "42 confirmation",
        target: `CONFIRMVIA=${payload.confirmedVia ?? "?"}; CONFIRMWTH=${payload.confirmedWith ?? "?"}`,
        jobId: row.confirmationWritebackJobId ?? "none",
        status: row.confirmationWritebackStatus ?? "unknown",
        success: deliveryWritebackSucceeded("confirmation", row.confirmationWritebackStatus) ? "yes" : "no",
        error: row.confirmationWritebackError ?? "",
      });
    }
    if (
      happenedOnDenverDate(row.requestedDateWritebackQueuedAt, reportDate) ||
      happenedOnDenverDate(row.requestedDateWritebackCheckedAt, reportDate)
    ) {
      const payload = objectValue(row.requestedDateWritebackPayload);
      const lineNumbers = Array.isArray(payload.lineNumbers) ? payload.lineNumbers.join(",") : "?";
      const requestedDate = payload.requestedDeliveryDate
        ? String(payload.requestedDeliveryDate)
        : row.requestedNewDate
          ? dateKey(row.requestedNewDate)
          : "?";
      writebacks.push({
        order: `${row.orderType} ${row.orderNumber}`,
        kind: "42 requested date",
        target: `Details[].RequestedOn=${requestedDate}; lines=${lineNumbers}`,
        jobId: row.requestedDateWritebackJobId ?? "none",
        status: row.requestedDateWritebackStatus ?? "unknown",
        success: deliveryWritebackSucceeded("requestedDate", row.requestedDateWritebackStatus) ? "yes" : "no",
        error: row.requestedDateWritebackError ?? "",
      });
    }
  }
  for (const row of tenDay.filter((item) => happenedOnDenverDate(item.updatedAt, reportDate))) {
    if (!row.acumaticaWritebackStatus && !row.acumaticaWritebackJobId) continue;
    writebacks.push({
      order: `${row.orderType} ${row.orderNumber}`,
      kind: `${row.sourceInterval?.replace("DAY_", "") ?? "14/12/10/8"} ten-day confirmation`,
      target: "ONEWEEKCON=true",
      jobId: row.acumaticaWritebackJobId ?? "none",
      status: row.acumaticaWritebackStatus ?? "unknown",
      success: ["WRITTEN", "ALREADY_TRUE"].includes(row.acumaticaWritebackStatus ?? "") ? "yes" : "no",
      error: row.acumaticaWritebackError ?? "",
    });
  }
  for (const row of holds.filter((item) => happenedOnDenverDate(item.updatedAt, reportDate))) {
    writebacks.push({
      order: `${row.orderType} ${row.orderNumber}`,
      kind: "8-day hold",
      target: "Hold=true",
      jobId: row.queueJobId ?? "none",
      status: row.status,
      success: row.status === "SUCCEEDED" ? "yes" : "no",
      error: row.errorMessage ?? "",
    });
  }

  const schedulerRows = schedulerRuns.map((run) => {
    const health = importHealth(run.resultSummary);
    return [run.interval, run.status, health.refreshed, health.failed, run.errorMessage ?? ""];
  });
  const latestSchedulerByInterval = new Map<string, (typeof schedulerRuns)[number]>();
  for (const run of schedulerRuns) latestSchedulerByInterval.set(run.interval, run);
  const qualificationSummaryRows = REPORT_LIFECYCLE_INTERVALS.map((interval) => {
    const schedulerInterval = ["41", "40"].includes(interval) ? "39" : interval;
    const schedulerRun = latestSchedulerByInterval.get(schedulerInterval);
    const health = schedulerRun ? importHealth(schedulerRun.resultSummary) : null;
    const matchingEvents = eventRows.filter((row) => row.interval === interval);
    return [
      interval,
      matchingEvents.length,
      matchingEvents.filter((row) => row.attemptStatus !== "none").length,
      schedulerRun?.status ?? "MISSING",
      health?.refreshed ?? "n/a",
      health?.failed ?? "n/a",
    ];
  });
  const failedWritebacks = writebacks.filter((row) => row.success !== "yes" && !["queued", "processing"].includes(row.status)).length;
  const pendingWritebacks = writebacks.filter((row) => ["queued", "processing"].includes(row.status)).length;
  const subject = `[MLD Delivery] Daily operations report ${reportDate} - ${failedWritebacks ? `${failedWritebacks} writeback failure(s)` : "OK"}`;
  const htmlBody = `
    <div style="font:14px Arial,sans-serif;color:#1f2933;max-width:1200px">
      <h1 style="font-size:20px">Delivery operations report - ${escapeHtml(reportDate)}</h1>
      <p><strong>Qualifying notification rows:</strong> ${eventRows.length} &nbsp; <strong>Writebacks:</strong> ${writebacks.length} &nbsp; <strong>Pending:</strong> ${pendingWritebacks} &nbsp; <strong>Failed:</strong> ${failedWritebacks}</p>
      <h2 style="font-size:16px">Daily interval qualification summary</h2>
      ${table(["Interval", "Qualified", "Attempts", "Scheduler status", "ERP refreshed", "Import failures"], qualificationSummaryRows)}
      <h2 style="font-size:16px">Interval runs and fresh-import health</h2>
      ${table(["Interval", "Run status", "ERP refreshed", "Import failures", "Error"], schedulerRows)}
      <h2 style="font-size:16px">Qualifying orders and notification results</h2>
      ${table(["Interval", "Order", "Delivery date", "Channel", "Event", "Attempt", "Provider accepted", "Order last synced"], eventRows.map((row) => [row.interval, row.order, row.deliveryDate, row.channel, row.eventStatus, row.attemptStatus, row.providerAccepted, row.lastSyncedAt]))}
      <h2 style="font-size:16px">Acumatica writebacks</h2>
      ${table(["Order", "Lifecycle", "Value written", "Queue job", "Status", "Successful", "Error"], writebacks.map((row) => [row.order, row.kind, row.target, row.jobId, row.status, row.success, row.error]))}
    </div>`;

  return {
    subject,
    textBody: `Delivery operations report ${reportDate}: ${eventRows.length} qualifying notification rows, ${writebacks.length} writebacks, ${pendingWritebacks} pending, ${failedWritebacks} failed.`,
    htmlBody,
    summary: {
      reportDate,
      schedulerRuns: schedulerRuns.length,
      qualifyingOrders: eventRows.length,
      writebacks: writebacks.length,
      pendingWritebacks,
      failedWritebacks,
    },
  };
}

async function acquireReportLock(reportDate: string) {
  const lockKey = `delivery_operations_report:${reportDate}`;
  const existing = await prisma.deliveryIntervalSchedulerRun.findUnique({ where: { lockKey } });
  if (existing?.status === "SUCCESS") return { acquired: false, row: existing };
  if (existing?.status === "RUNNING" && Date.now() - existing.updatedAt.getTime() < 10 * 60 * 1000) {
    return { acquired: false, row: existing };
  }
  if (existing?.status === "FAILED" && Date.now() - existing.updatedAt.getTime() < 10 * 60 * 1000) {
    return { acquired: false, row: existing };
  }
  if (existing) {
    return {
      acquired: true,
      row: await prisma.deliveryIntervalSchedulerRun.update({
        where: { id: existing.id },
        data: { status: "RUNNING", retryCount: { increment: 1 }, startedAt: new Date(), failedAt: null, errorMessage: null },
      }),
    };
  }
  return {
    acquired: true,
    row: await prisma.deliveryIntervalSchedulerRun.create({
      data: {
        lockKey,
        interval: REPORT_INTERVAL,
        runDate: dateFromKey(reportDate),
        timezone: REPORT_TIMEZONE,
        expectedLocalTime: "17:00",
        actualLocalTime: new Intl.DateTimeFormat("en-US", { timeZone: REPORT_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
        delegatedArgs: { reportDate },
      },
    }),
  };
}

export async function runDeliveryOperationsReport(params: { reportDate: string; recipient?: string | null }): Promise<ReportResult> {
  const reportDate = dateKey(params.reportDate);
  const recipient = params.recipient?.trim() || process.env.DELIVERY_OPERATIONS_REPORT_EMAIL?.trim() || DEFAULT_REPORT_RECIPIENT;
  const lock = await acquireReportLock(reportDate);
  if (!lock.acquired) return { ok: true, phase: "skipped_already_reported_or_running", reportDate, recipient, schedulerRunId: lock.row.id };

  try {
    const report = await buildDeliveryOperationsReport(reportDate);
    const providerResult = await createDeliveryNotificationProvider().sendEmail({
      to: recipient,
      subject: report.subject,
      textBody: report.textBody,
      htmlBody: report.htmlBody,
    });
    await prisma.deliveryIntervalSchedulerRun.update({
      where: { id: lock.row.id },
      data: {
        status: "SUCCESS",
        completedAt: new Date(),
        resultSummary: { ...report.summary, providerRequestIdPresent: Boolean(providerResult.externalMessageId) },
      },
    });
    return { ok: true, phase: "sent", recipient, schedulerRunId: lock.row.id, ...report.summary, providerRequestIdPresent: Boolean(providerResult.externalMessageId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.deliveryIntervalSchedulerRun.update({
      where: { id: lock.row.id },
      data: { status: "FAILED", failedAt: new Date(), errorMessage: message.slice(0, 1024), resultSummary: { ok: false, error: message.slice(0, 1024) } },
    });
    throw error;
  }
}
