import { NotificationActionType, NotificationIntervalType, Prisma } from "@/lib/generated/prisma/client";
import { createDeliveryNotificationProvider } from "@/lib/notifications/deliveryNotificationProviders";
import { dateFromKey, dateKey } from "@/lib/notifications/helpers";
import { prisma } from "@/lib/prisma";
import { groupEvidenceSelect } from "./deliveryNotificationGroupEvidence";
import { auditObject, auditTable, buildOperationsAudit, denverDayStart, lifecycle, nextDate, operationsWorkbook, operationsCoverageStart,
  type AuditRecord, type AuditRow, type OperationsAuditInput } from "./deliveryOperationsAudit";

export const REPORT_INTERVAL = "OPS_REPORT";
const LIMIT = 10000;
const str = (value: unknown) => value == null ? "" : String(value);
export function deliveryOperationsIntervalLabel(event: { intervalType: NotificationIntervalType; actionType: NotificationActionType; dedupeKey: string }) { return lifecycle(event); }
export function deliveryWritebackSucceeded(kind: "confirmation" | "requestedDate", status: string | null | undefined) {
  return status === "written" || (kind === "requestedDate" && status === "skipped_existing_value");
}
async function fetchQueueJob(jobId: string): Promise<AuditRecord> {
  const base = process.env.MLD_QUEUE_BASE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MLD_QUEUE_TOKEN?.trim();
  if (!base || !token) throw new Error("Queue reporting credentials unavailable");
  const url = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  const response = await fetch(`${url}/api/erp/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Queue status HTTP ${response.status}`);
  return auditObject(await response.json());
}

// Read-only collection: report generation never updates business records or enqueues jobs.
export async function buildDeliveryOperationsReport(reportDate: string, options: { now?: Date; queueLookup?: typeof fetchQueueJob } = {}) {
  const now = options.now ?? new Date();
  const dayEnd = denverDayStart(nextDate(reportDate));
  const end = now < dayEnd ? now : dayEnd;
  if (end <= denverDayStart(reportDate)) throw new Error("Report date is in the future");
  const coverage: AuditRow[] = [];
  const previous = await prisma.deliveryIntervalSchedulerRun.findFirst({
    where: { interval: REPORT_INTERVAL, status: "SUCCESS", runDate: { lt: dateFromKey(reportDate) } },
    orderBy: { runDate: "desc" }, select: { runDate: true, resultSummary: true },
  });
  const { start, overlap } = operationsCoverageStart(reportDate, previous ? auditObject(previous) : null);
  if (overlap) coverage.push({ Section: "Coverage overlap", Status: "Informational", Detail: "Previous report lacks an exact cutoff or had incomplete core data. Activity intentionally overlaps to avoid losing evidence." });
  const window = { gte: start, lt: end };
  const recent = { updatedAt: window };
  const pending = ["enqueue_pending", "queued", "processing", "status_check_failed", "failed", "queue_failed", "refused", "enqueue_failed", "live_write_refused"];
  const sources: Record<string, () => Promise<unknown[]>> = {
    runs: () => prisma.deliveryIntervalSchedulerRun.findMany({
      where: { interval: { not: REPORT_INTERVAL }, runDate: { lte: dateFromKey(reportDate) }, OR: [
        { runDate: { gte: dateFromKey(start.toLocaleDateString("en-CA", { timeZone: "America/Denver" })) } }, { status: { in: ["FAILED", "RUNNING"] } },
      ] }, orderBy: { startedAt: "asc" }, take: LIMIT + 1,
    }),
    events: () => prisma.notificationEvent.findMany({
      where: { createdAt: { lt: end }, OR: [recent, { createdAt: window }, { status: { in: ["FAILED", "SCHEDULED", "PENDING"] } },
        { attempts: { some: { OR: [{ updatedAt: window }, { status: { in: ["FAILED", "CREATED"] } }, { channel: "SMS", status: "SUBMITTED" }] } } },
        { notificationGroupMember: { group: { attempts: { some: { OR: [{ updatedAt: window }, { status: { in: ["FAILED", "SUBMITTING", "RECONCILIATION_REQUIRED", "SUBMITTED"] } }] } } } } },
      ] }, include: { notificationGroupMember: groupEvidenceSelect, attempts: { orderBy: { createdAt: "asc" } }, order: { select: { lastSyncedAt: true } } }, orderBy: { createdAt: "asc" }, take: LIMIT + 1,
    }),
    confirmations: () => prisma.deliveryConfirmation.findMany({
      where: { createdAt: { lt: end }, OR: [recent, { confirmedAt: window }, { requestedNewDateAt: window },
        { confirmationWritebackStatus: { in: pending } }, { requestedDateWritebackStatus: { in: pending } },
      ] }, include: { notificationEvent: true }, orderBy: { updatedAt: "asc" }, take: LIMIT + 1,
    }),
    tenDay: () => prisma.deliveryGroupTenDayConfirmation.findMany({
      where: { createdAt: { lt: end }, OR: [recent, { acumaticaWritebackStatus: { in: ["QUEUED", "FAILED", "REFUSED"] } }] }, orderBy: { updatedAt: "asc" }, take: LIMIT + 1,
    }),
    holds: () => prisma.deliveryOrderHoldAction.findMany({
      where: { createdAt: { lt: end }, OR: [recent, { status: { in: ["PENDING", "QUEUED", "FAILED"] } }] }, orderBy: { updatedAt: "asc" }, take: LIMIT + 1,
    }),
    internal: () => prisma.internalNotificationEvent.findMany({
      where: { createdAt: { lt: end }, OR: [recent, { sentAt: window }, { status: { in: ["PENDING", "FAILED"] } }] }, orderBy: { updatedAt: "asc" }, take: LIMIT + 1,
    }),
    contacts: () => prisma.contactOptInWritebackAction.findMany({
      where: { createdAt: { lt: end }, OR: [recent, { status: { in: ["PENDING", "QUEUED", "FAILED"] } }] }, orderBy: { updatedAt: "asc" }, take: LIMIT + 1,
    }),
    inbound: () => prisma.twilioInboundMessage.findMany({ where: { receivedAt: window }, include: { notificationEvent: true, deliveryConfirmation: true }, orderBy: { receivedAt: "asc" }, take: LIMIT + 1 }),
    thankYou: async () => {
      const [available] = await prisma.$queryRaw<Array<{ available: boolean }>>`
        SELECT to_regclass('public.order_thank_you_events') IS NOT NULL AND to_regclass('public.order_thank_you_attempts') IS NOT NULL AS available`;
      if (!available.available) throw new Error("Thank-you tables unavailable; migration pending");
      return prisma.orderThankYouEvent.findMany({ where: { createdAt: { lt: end }, OR: [recent,
        { acumaticaWritebackStatus: { in: pending } }, { status: { in: ["PENDING", "FAILED"] } }] },
        include: { attempts: true }, orderBy: { updatedAt: "asc" }, take: LIMIT + 1 });
    },
  };
  const collected: Record<string, AuditRecord[]> = {};
  await Promise.all(Object.entries(sources).map(async ([name, query]) => {
    try {
      const rows = await query();
      collected[name] = rows.slice(0, LIMIT).map(auditObject);
      coverage.push({ Section: name, Status: rows.length > LIMIT ? "Truncated" : "Complete", Detail: rows.length > LIMIT ? `${name} exceeds ${LIMIT} rows; review remaining rows separately` : `${rows.length} records loaded` });
    } catch (error) {
      collected[name] = [];
      coverage.push({ Section: name, Status: "Unavailable", Detail: `${name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 800) });
    }
  }));
  const groupIds = [...new Set([...collected.tenDay, ...collected.holds].map(row => str(row.orderDeliveryGroupId)).filter(Boolean))];
  if (groupIds.length) {
    try {
      const history = await prisma.notificationEvent.findMany({ where: { deliveryGroupId: { in: groupIds }, createdAt: { lt: end } },
        include: { notificationGroupMember: groupEvidenceSelect, attempts: true, order: { select: { lastSyncedAt: true } } }, take: LIMIT + 1 });
      const existing = new Map(collected.events.map(row => [row.id, row]));
      for (const row of history.slice(0, LIMIT)) existing.set(row.id, auditObject(row));
      collected.events = [...existing.values()];
      coverage.push({ Section: "Writeback notification evidence", Status: history.length > LIMIT ? "Truncated" : "Complete", Detail: `${Math.min(history.length, LIMIT)} historical events inspected` });
    } catch (error) { coverage.push({ Section: "Writeback notification evidence", Status: "Unavailable", Detail: String(error).slice(0, 500) }); }
  }
  const jobs: Record<string, AuditRecord> = {};
  const jobIds = [...new Set(Object.values(collected).flat().flatMap(row =>
    [row.confirmationWritebackJobId, row.requestedDateWritebackJobId, row.acumaticaWritebackJobId, row.queueJobId].map(str).filter(Boolean)))];
  let index = 0;
  const maxJobs = 500;
  if (jobIds.length > maxJobs) coverage.push({ Section: "Queue lookup", Status: "Truncated", Detail: `Only first ${maxJobs} of ${jobIds.length} jobs checked; remaining writebacks show local status only` });
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < Math.min(jobIds.length, maxJobs)) {
      const id = jobIds[index++];
      try { jobs[id] = await (options.queueLookup ?? fetchQueueJob)(id); }
      catch (error) { jobs[id] = { lookupError: error instanceof Error ? error.message : String(error) }; }
    }
  }));
  const input: OperationsAuditInput = { reportDate, start, end, generatedAt: now, coverage, jobs,
    runs: collected.runs, events: collected.events, confirmations: collected.confirmations, tenDay: collected.tenDay,
    holds: collected.holds, internal: collected.internal, contacts: collected.contacts, thankYou: collected.thankYou, inbound: collected.inbound };
  const report = buildOperationsAudit(input);
  const workbook = await operationsWorkbook(report.sheets);
  if (workbook.length > 2500000) throw new Error("Report workbook exceeds email attachment budget; use --preview export and review locally");
  const subject = `[MLD Delivery] ${reportDate} recap - ${report.summary.attentionItems ? `${report.summary.attentionItems} attention items` : "No detected failures"}`;
  const compactSends = report.sheets.Notifications.map(row => ({ Order: row.Order, Interval: row.Interval, Channel: row.Channel,
    Status: row.Status, "Sent at UTC": row["Sent at UTC"], "Provider accepted": row["Provider accepted"] }));
  const compactIssues = report.sheets.Attention.map(row => ({ Order: row.Order, Interval: row.Interval, Problem: `${row.Category}: ${row.Detail}`, "Next action": row["Next action"] }));
  const compactWrites = report.sheets.Writebacks.map(row => ({ Order: row.Order, Lifecycle: row.Lifecycle, "Intended change": row["Intended value / scope"], Status: row["Business status"], "ERP verification": row["ERP verification"] }));
  const localTime = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", dateStyle: "medium", timeStyle: "short" }).format(date);
  const htmlBody = `<div style="font:14px Arial;color:#18232a;max-width:1100px"><h1>Delivery recap: ${reportDate}</h1>
    <p>Coverage: ${localTime(start)} to ${localTime(end)} (exclusive), America/Denver. Exact UTC timestamps are in the workbook.</p>
    <p>${report.summary.attentionItems} attention items; ${report.summary.notificationsAccepted} sends accepted in coverage; ${report.summary.customerResponses} response records; ${report.summary.writebacks} writeback records.</p>
    <h2>Needs your attention</h2>${auditTable(compactIssues)}
    <h2>Orders and notifications</h2>${auditTable(compactSends)}
    <h2>Customer responses</h2>${auditTable(report.sheets["Customer Responses"])}
    <h2>Writebacks to check in ERP</h2>${auditTable(compactWrites)}
    <h2>Interval execution</h2>${auditTable(report.sheets["Interval Runs"])}
    <h2>Coverage and limitations</h2>${auditTable(report.sheets.Coverage)}
    <p>The Excel attachment includes complete order lists, skipped orders, import results, provider IDs and queue job IDs. Provider acceptance does not establish delivery. Queue success does not establish ERP verification.</p></div>`;
  return { ...report, subject, htmlBody, workbook,
    textBody: `${subject}. ${report.summary.notificationsAccepted} accepted notifications, ${report.summary.customerResponses} responses, ${report.summary.writebacks} writebacks. See attached workbook for all orders and verification evidence.`,
    attachments: [{ name: `delivery-recap-${reportDate}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBytes: workbook.toString("base64") }] };
}

async function acquireReportLock(reportDate: string, retryFailed = false) {
  const lockKey = `delivery_operations_report:${reportDate}`;
  const existing = await prisma.deliveryIntervalSchedulerRun.findUnique({ where: { lockKey } });
  if (existing) {
    if (existing.status === "SUCCESS" || existing.status === "RUNNING") return { acquired: false, row: existing };
    if (!retryFailed && Date.now() - existing.updatedAt.getTime() < 10 * 60 * 1000) return { acquired: false, row: existing };
    const claimed = await prisma.deliveryIntervalSchedulerRun.updateMany({ where: { id: existing.id, status: "FAILED", updatedAt: existing.updatedAt },
      data: { status: "RUNNING", retryCount: { increment: 1 }, startedAt: new Date(), failedAt: null, errorMessage: null } });
    return { acquired: claimed.count === 1, row: existing };
  }
  try {
    return { acquired: true, row: await prisma.deliveryIntervalSchedulerRun.create({ data: {
      lockKey, interval: REPORT_INTERVAL, runDate: dateFromKey(reportDate), timezone: "America/Denver",
      expectedLocalTime: "17:00", actualLocalTime: new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()), delegatedArgs: { reportDate },
    } }) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      return { acquired: false, row: await prisma.deliveryIntervalSchedulerRun.findUniqueOrThrow({ where: { lockKey } }) };
    throw error;
  }
}
export async function runDeliveryOperationsReport(params: { reportDate: string; recipient?: string | null; retryFailed?: boolean }) {
  const reportDate = dateKey(params.reportDate);
  const recipient = params.recipient?.trim() || process.env.DELIVERY_OPERATIONS_REPORT_EMAIL?.trim() || "james@mld.com";
  const lock = await acquireReportLock(reportDate, params.retryFailed);
  if (!lock.acquired) return { ok: true, phase: "skipped_already_reported_or_running", reportDate, recipient, schedulerRunId: lock.row.id };
  let providerAccepted = false;
  try {
    const report = await buildDeliveryOperationsReport(reportDate);
    const result = await createDeliveryNotificationProvider().sendEmail({ to: recipient, subject: report.subject,
      textBody: report.textBody, htmlBody: report.htmlBody, attachments: report.attachments });
    providerAccepted = true;
    await prisma.deliveryIntervalSchedulerRun.update({ where: { id: lock.row.id }, data: { status: "SUCCESS", completedAt: new Date(),
      resultSummary: { ...report.summary, providerRequestIdPresent: Boolean(result.externalMessageId) } } });
    return { ok: true, phase: "sent", recipient, schedulerRunId: lock.row.id, ...report.summary, providerRequestIdPresent: Boolean(result.externalMessageId) };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
    await prisma.deliveryIntervalSchedulerRun.update({ where: { id: lock.row.id }, data: {
      status: providerAccepted ? "RUNNING" : "FAILED", failedAt: providerAccepted ? null : new Date(),
      errorMessage: providerAccepted ? `Email accepted; finalize failed. Inspect before retry: ${message}`.slice(0, 1024) : message,
      resultSummary: { ok: false, providerAccepted, error: message },
    } });
    throw error;
  }
}
