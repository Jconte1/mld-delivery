import ExcelJS from "exceljs";

export type AuditRecord = Record<string, unknown>;
export type AuditRow = Record<string, string | number>;
export const auditObject = (value: unknown): AuditRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as AuditRecord : {};
const list = (value: unknown): AuditRecord[] => Array.isArray(value) ? value.map(auditObject) : [];
const str = (value: unknown) => value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
const time = (value: unknown) => value ? new Date(str(value)).getTime() : NaN;
const order = (row: AuditRecord) => [row.orderType, row.orderNumber].filter(Boolean).join(" ");
const terminalSuccess = new Set(["written", "already_true", "already_false", "succeeded", "skipped_existing_value"]);
export function writebackState(value: unknown) {
  const status = str(value).toLowerCase();
  if (terminalSuccess.has(status)) return "Succeeded; verify ERP evidence";
  if (["not_cleared", "awaiting_notification", "dry_run", "skipped", "not_queued"].includes(status)) return "Withheld / not attempted";
  if (["pending", "queued", "processing", "running", ""].includes(status)) return "Pending";
  return "Needs attention";
}
export function erpVerification(value: unknown): string {
  const result = auditObject(value);
  const verification = auditObject(result.verification);
  if (verification.verified === false || result.verified === false) return "MISMATCH / verification failed";
  if (verification.verified === true || result.verified === true) return "Read back and matched (worker evidence)";
  if (verification.oneWeekConfirmedAfter === true || verification.holdAfter === true) return "Read back and matched (worker evidence)";
  if (verification.oneWeekConfirmedAfter === false || verification.holdAfter === false) return "MISMATCH / verification failed";
  return "NOT VERIFIED: check ERP";
}
export function denverDayStart(date: string): Date {
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target)) throw new Error("Invalid report date");
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const p = (name: string) => parts.find(part => part.type === name)?.value;
    guess += target - Date.parse(`${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}Z`);
  }
  return new Date(guess);
}
export function nextDate(date: string) { return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); }
export function operationsCoverageStart(reportDate: string, previous: AuditRecord | null) {
  const midnight = denverDayStart(reportDate);
  if (!previous) return { start: midnight, overlap: false };
  const summary = auditObject(previous.resultSummary);
  const candidate = summary.coreCoverageComplete === false ? summary.coverageStart : summary.coverageEnd;
  const parsed = time(candidate);
  if (Number.isFinite(parsed)) return { start: new Date(Math.min(parsed, midnight.getTime())), overlap: summary.coreCoverageComplete === false };
  return { start: denverDayStart(str(previous.runDate).slice(0, 10)), overlap: true };
}
export function lifecycle(row: AuditRecord): string {
  const interval = str(row.intervalType ?? row.sourceInterval).replace("DAY_", "");
  if (interval === "42" && row.actionType === "DELIVERY_CONFIRMATION_REMINDER") {
    if (str(row.dedupeKey).includes("touch_2")) return "41";
    if (str(row.dedupeKey).includes("touch_3")) return "40";
  }
  return interval || "unknown";
}
function mask(value: unknown) {
  const text = str(value);
  if (!text) return "missing";
  if (text.includes("@")) return `${text[0]}***@${text.split("@")[1]}`;
  return `***${text.slice(-4)}`;
}
const expected: Record<string, string> = { "180": "15:00", "90": "15:10", "60": "15:20", "42": "15:30",
  "39": "15:35", "30": "15:40", "14": "15:50", "12": "16:00", "10": "16:10", "8": "16:20", "2": "16:30" };
export type OperationsAuditInput = {
  reportDate: string; start: Date; end: Date; generatedAt: Date;
  runs: AuditRecord[]; events: AuditRecord[]; confirmations: AuditRecord[]; tenDay: AuditRecord[];
  holds: AuditRecord[]; internal: AuditRecord[]; contacts: AuditRecord[]; thankYou: AuditRecord[];
  inbound: AuditRecord[]; coverage: AuditRow[];
  jobs: Record<string, AuditRecord>;
};
export function buildOperationsAudit(input: OperationsAuditInput) {
  const within = (value: unknown) => time(value) >= input.start.getTime() && time(value) < input.end.getTime();
  const age = (value: unknown) => Number.isFinite(time(value)) ? Math.max(0, Math.round((input.end.getTime() - time(value)) / 3600000)) : 0;
  const issues: AuditRow[] = [];
  const sends: AuditRow[] = [];
  const skips: AuditRow[] = [];
  const imports: AuditRow[] = [];
  const responses: AuditRow[] = [];
  const writebacks: AuditRow[] = [];
  const runs: AuditRow[] = [];
  const coverage = [...input.coverage];
  const issue = (category: string, orderNumber: string, interval: string, detail: string, next: string, id = "", hours = 0) =>
    issues.push({ Category: category, Order: orderNumber, Interval: interval, Detail: detail, "Next action": next, ID: id, "Age hours": hours });
  for (const row of coverage) if (!["Complete", "Informational"].includes(str(row.Status))) issue("Report coverage", "", "", str(row.Detail), "Resolve missing section; do not interpret it as zero activity");

  for (const run of input.runs) {
    const summary = auditObject(run.resultSummary);
    const importSummary = auditObject(summary.importSummary);
    const date = str(run.runDate).slice(0, 10);
    const interval = str(run.interval);
    const refreshed = list(summary.successfullyRefreshedOrders ?? importSummary.successfullyRefreshedOrders);
    const errors = list(importSummary.errors);
    runs.push({ Date: date, Interval: interval, Status: str(run.status), Started: str(run.startedAt), Completed: str(run.completedAt),
      Candidates: Number(summary.candidateCount ?? 0), Qualified: Number(summary.productionQualifiedCount ?? 0),
      "Full orders fetched": Number(importSummary.fullOrdersFetched ?? 0), "Orders refreshed": refreshed.length,
      "Import errors": errors.length, Retries: Number(run.retryCount ?? 0), Phase: str(summary.phase), Error: str(run.errorMessage), ID: str(run.id) });
    if (run.status === "FAILED" || (run.status === "RUNNING" && age(run.startedAt) >= 1))
      issue("Interval run", "", interval, str(run.errorMessage) || "Run has not completed", "Inspect run before explicitly retrying", str(run.id), age(run.startedAt));
    for (const err of errors) {
      imports.push({ Order: order(err), Interval: interval, Date: date, Outcome: "IMPORT FAILED / EXCLUDED", Reason: str(err.reason ?? err.error), "Run ID": str(run.id) });
      issue("Fresh import / local write", order(err), interval, str(err.reason ?? err.error), "Correct source/import problem; refresh before sending", str(run.id));
    }
    for (const refreshedOrder of refreshed) imports.push({ Order: order(refreshedOrder), Interval: interval, Date: date, Outcome: "Fresh import succeeded", Reason: "", "Run ID": str(run.id) });
    for (const event of list(summary.createEventReports)) if (event.reasonSkipped || event.reasonFailed)
      skips.push({ Order: order(event), Interval: interval, "Delivery date": str(event.deliveryDate), Reason: str(event.reasonSkipped ?? event.reasonFailed), Source: "Run evaluation", ID: str(event.eventId) });
    const noResponse = auditObject(summary.summary);
    if (Number(noResponse.currentStateRefreshesFailed) > 0)
      issue("Fresh import", "See no-response run", interval, `${noResponse.currentStateRefreshesFailed} refreshes failed`, "Inspect no-response run details", str(run.id));
    const identifiedReasons = list(summary.createEventReports);
    for (const [reason, count] of Object.entries(auditObject(summary.skippedCountByReason))) {
      const identified = identifiedReasons.filter(row => row.reasonSkipped === reason || row.reasonFailed === reason).length;
      if (Number(count) > identified) skips.push({ Order: "Order identity not recorded in run summary", Interval: interval,
        Date: date, Reason: reason, Count: Number(count) - identified, Source: "Aggregate only", ID: str(run.id) });
    }
  }
  const endLocal = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(input.end.getTime() - 1));
  for (let date = input.start.toLocaleDateString("en-CA", { timeZone: "America/Denver" }); date <= input.reportDate; date = nextDate(date)) {
    for (const [interval, scheduled] of Object.entries(expected)) {
      if (input.runs.some(row => str(row.interval) === interval && str(row.runDate).slice(0, 10) === date)) continue;
      const due = input.end >= denverDayStart(nextDate(date)) || endLocal >= scheduled;
      runs.push({ Date: date, Interval: interval, Status: due ? "MISSING" : "NOT DUE", "Expected Denver time": scheduled });
      if (due) issue("Missing interval run", "", interval, `No run record for ${date} at ${scheduled} Denver`, "Check worker uptime and scheduler logs");
    }
  }
  const acceptedByGroup = new Set<string>();
  const duplicateGroups = new Map<string, AuditRow[]>();
  for (const event of input.events) {
    const interval = lifecycle(event);
    const shared: AuditRecord[] = list(auditObject(auditObject(event.notificationGroupMember).group).attempts).map(a => ({ ...a,
      success: a.productionEligibilityVerified === true && ["SUBMITTED", "DELIVERED"].includes(str(a.status)),
      sentAt: a.submittedAt, controlledRecipientMode: false, forcedContactEligibility: false,
      sharedGroupAttempt: true, status: ["SUBMITTING", "RECONCILIATION_REQUIRED"].includes(str(a.status)) ? "CREATED" : a.status }));
    const attempts = [...list(event.attempts), ...shared];
    const latestSuccessfulAt = Math.max(0, ...attempts.filter(attempt => attempt.success === true && ["SUBMITTED", "DELIVERED"].includes(str(attempt.status))).map(attempt => time(attempt.createdAt)));
    const refreshed = str(auditObject(event.order).lastSyncedAt);
    for (const attempt of attempts) {
      const accepted = attempt.success === true && ["SUBMITTED", "DELIVERED"].includes(str(attempt.status));
      if (accepted && attempt.controlledRecipientMode !== true && attempt.forcedContactEligibility !== true &&
          ["14", "12", "10", "8"].includes(interval)) acceptedByGroup.add(`${str(event.deliveryGroupId)}|${str(event.deliveryDate).slice(0, 10)}`);
      const unresolved = ["CREATED", "FAILED"].includes(str(attempt.status)) || (attempt.channel === "SMS" && attempt.status === "SUBMITTED");
      if (!within(attempt.createdAt) && !within(attempt.updatedAt) && !within(attempt.sentAt) && !unresolved) continue;
      const row: AuditRow = { Order: order(event), Interval: interval, Action: str(event.actionType), "Delivery date": str(event.deliveryDate).slice(0, 10),
        Channel: str(attempt.channel), Recipient: mask(attempt.recipient), Status: str(attempt.status),
        "Contact ID": str(event.contactId), "Contact role": str(event.recipientContactRole) || "PRIMARY",
        "Contact fallback reason": str(event.recipientFallbackReason),
        "Provider accepted": accepted ? "yes" : "no", "Delivery evidence": attempt.status === "DELIVERED" ? "Delivered callback" : "Not verified",
        "Sent at UTC": str(attempt.sentAt), "Created at UTC": str(attempt.createdAt), "Updated at UTC": str(attempt.updatedAt),
        "Sent in coverage": within(attempt.sentAt) ? "yes" : "no", "Controlled send": attempt.controlledRecipientMode === true ? "yes" : "no",
        "Provider ID": str(attempt.externalMessageId), "Attempt ID": str(attempt.id), "Shared attempt": attempt.sharedGroupAttempt === true ? "yes" : "no",
        "Notification group ID": str(attempt.groupId), "Event ID": str(event.id), "Group ID": str(event.deliveryGroupId),
        "Order last refreshed (current)": refreshed, Error: str(attempt.errorMessage), "Age hours": age(attempt.createdAt) };
      sends.push(row);
      if (attempt.status === "FAILED") {
        row.Resolution = latestSuccessfulAt > time(attempt.createdAt) ? "Later successful attempt exists" : "Unresolved";
        if (row.Resolution === "Unresolved") issue("Notification failed", order(event), interval, str(attempt.errorMessage) || str(attempt.providerCode), "Inspect provider error and eligible fallback", str(attempt.id), age(attempt.createdAt));
      }
      if (unresolved && attempt.status !== "FAILED" && age(attempt.createdAt) >= (attempt.channel === "SMS" ? 24 : 1))
        issue("Notification pending", order(event), interval, `${attempt.status}; delivery not verified`, "Inspect provider and callback records; do not blindly resend", str(attempt.id), age(attempt.createdAt));
      if (accepted) {
        const key = [event.deliveryGroupId, event.deliveryDate, event.intervalType, event.actionType, event.dedupeKey].map(str).join("|");
        duplicateGroups.set(key, [...duplicateGroups.get(key) ?? [], row]);
      }
    }
    if (within(event.createdAt) || within(event.updatedAt)) {
      if (event.reasonSkipped || event.reasonFailed) skips.push({ Order: order(event), Interval: interval, "Delivery date": str(event.deliveryDate).slice(0, 10), Reason: str(event.reasonSkipped ?? event.reasonFailed), Source: "Notification event", ID: str(event.id) });
    }
    if (["SCHEDULED", "PENDING"].includes(str(event.status)) && !attempts.length && age(event.createdAt) >= 1)
      issue("Event without attempt", order(event), interval, str(event.status), "Inspect dispatch result and eligibility", str(event.id), age(event.createdAt));
    if (event.status === "FAILED" && !latestSuccessfulAt)
      issue("Notification event failed", order(event), interval, str(event.reasonFailed) || "Event failed before a successful send", "Inspect renderer, dispatch and provider errors", str(event.id), age(event.createdAt));
  }
  for (const rows of duplicateGroups.values()) if (rows.length > 1)
    issue("Possible duplicate send", str(rows[0].Order), str(rows[0].Interval), `${rows.length} accepted attempts for the same notification purpose`, "Compare attempt IDs and fallback history", rows.map(row => row["Attempt ID"]).join(","));
  for (const row of input.internal) {
    const interval = str(row.purpose).includes("NO_RESPONSE") ? "39" : "8";
    sends.push({ Order: order(row), Interval: interval, Action: str(row.purpose), Channel: "INTERNAL EMAIL", Recipient: mask(row.recipientEmail),
      Status: str(row.status), "Provider accepted": row.providerMessageId ? "yes" : "no", "Delivery evidence": "Not verified",
      "Sent at UTC": str(row.sentAt), "Sent in coverage": within(row.sentAt) ? "yes" : "no", "Provider ID": str(row.providerMessageId), "Event ID": str(row.id), Error: str(row.reasonFailed ?? row.reasonSkipped) });
    if (row.status !== "SENT") issue("Internal escalation", order(row), interval, str(row.reasonFailed ?? row.reasonSkipped ?? row.status), "Check salesperson/internal recipient and dispatch", str(row.id), age(row.createdAt));
  }
  const addWriteback = (row: AuditRecord, kind: string, target: string, jobId: unknown, status: unknown, result: unknown, error: unknown, changed: unknown) => {
    const job = input.jobs[str(jobId)];
    const queueResult = job?.result ?? result;
    const queueState = job?.status;
    const businessStatus = auditObject(queueResult).status;
    const resolvedStatus = queueState === "failed" ? "queue_failed" : ["queued", "processing"].includes(str(queueState)) ? queueState : businessStatus ?? status;
    const state = writebackState(resolvedStatus);
    const verification = erpVerification(queueResult);
    const resultObject = auditObject(queueResult);
    const detail = str([job?.error, error, resultObject.errorMessage, resultObject.error, resultObject.holdRestoreError].find(value => typeof value === "string" && value.trim()));
    const when = changed ?? row.updatedAt;
    const unresolvedLocal = ["Pending", "Needs attention"].includes(writebackState(status));
    if (!within(when) && state !== "Pending" && state !== "Needs attention" && !unresolvedLocal) return;
    writebacks.push({ Order: order(row) || `Contact ${str(row.contactId)}`, Lifecycle: kind, "Intended value / scope": target,
      "Queue job": str(jobId) || "none", "Queue status": str(queueState) || "not checked", "Business status": str(resolvedStatus),
      Outcome: state, "ERP verification": verification, "Changed at UTC": str(when), "Age hours": age(row.createdAt),
      "Reported today": within(when) ? "yes" : "carry-forward", Reason: str(resultObject.reason), Error: detail, "Record ID": str(row.id) });
    if (unresolvedLocal && state.startsWith("Succeeded")) issue("Local writeback status stale", order(row), kind,
      `Queue reports ${str(resolvedStatus)} but local status is ${str(status)}`, "Reconcile local status; inspect ERP verification evidence", str(jobId));
    if (state === "Needs attention" || verification.startsWith("MISMATCH")) issue("Writeback failed / refused", order(row), kind, detail || str(resolvedStatus), "Check job result and ERP field/lines", str(jobId ?? row.id), age(row.createdAt));
    if (state.startsWith("Succeeded") && detail) issue("Writeback warning", order(row), kind, detail, "Inspect ERP state and any hold-restoration error", str(jobId ?? row.id));
    if (state === "Pending" && age(when) >= 1) issue("Writeback pending", order(row), kind, str(resolvedStatus), "Inspect queue status and worker logs", str(jobId ?? row.id), age(when));
    if (job?.lookupError) issue("Queue status unavailable", order(row), kind, str(job.lookupError), "Check queue access; local status may be stale", str(jobId));
    if (state.startsWith("Succeeded") && ["8 hold", "ONEWEEKCON"].some(term => kind.includes(term)) && !acceptedByGroup.has(`${str(row.orderDeliveryGroupId)}|${str(row.deliveryDate).slice(0, 10)}`))
      issue("Writeback without send evidence", order(row), kind, "No accepted customer attempt in loaded group history", "Inspect full notification history and ERP; do not automatically undo", str(row.id));
  };
  for (const row of input.confirmations) {
    const event = auditObject(row.notificationEvent);
    for (const [field, action] of [["confirmedAt", "Confirmed"], ["changeRequestedAt", "Requested date change"], ["requestedNewDateAt", "Requested date"]]) {
      if (within(row[field])) responses.push({ Order: order(row), "Original interval": lifecycle(event), "Original event": str(row.notificationEventId),
        "Original sent at": str(event.sentAt), "Response at": str(row[field]), Channel: str(row.responseChannel), Action: action,
        "Original delivery date": str(row.deliveryDate).slice(0, 10), "Requested date": str(row.requestedNewDate).slice(0, 10), "Confirmation ID": str(row.id) });
    }
    if (row.confirmationWritebackJobId || row.confirmationWritebackStatus) {
      const payload = auditObject(row.confirmationWritebackPayload);
      addWriteback(row, "42/41/40 confirmation", `CONFIRMVIA=${str(payload.confirmedVia)}; CONFIRMWTH=${str(payload.confirmedWith)}`,
        row.confirmationWritebackJobId, row.confirmationWritebackStatus, row.confirmationWritebackResult, row.confirmationWritebackError,
        row.confirmationWritebackCompletedAt ?? row.confirmationWritebackCheckedAt ?? row.confirmationWritebackQueuedAt);
    }
    if (row.requestedDateWritebackJobId || row.requestedDateWritebackStatus) {
      const payload = auditObject(row.requestedDateWritebackPayload);
      addWriteback(row, "42/41/40 requested date", `Details[].RequestedOn: ${str(row.deliveryDate).slice(0, 10)} -> ${str(payload.requestedDeliveryDate ?? row.requestedNewDate).slice(0, 10)}; lines=${JSON.stringify(payload.lineNumbers ?? [])}`,
        row.requestedDateWritebackJobId, row.requestedDateWritebackStatus, row.requestedDateWritebackResult, row.requestedDateWritebackError,
        row.requestedDateWritebackCompletedAt ?? row.requestedDateWritebackCheckedAt ?? row.requestedDateWritebackQueuedAt);
    }
  }
  for (const row of input.inbound) {
    const linked = auditObject(row.notificationEvent);
    const confirmation = auditObject(row.deliveryConfirmation);
    responses.push({ Order: order(linked) || order(confirmation) || "Unmatched", "Original interval": lifecycle(linked),
      "Response at": str(row.receivedAt), Channel: "SMS", Action: str(row.parsedIntent), Match: str(row.matchStatus),
      "App reply returned": row.responseSent ? "yes" : "no", Error: str(row.error), ID: str(row.id) });
    if (row.error || row.matchStatus === "UNPROCESSED") issue("Inbound response", order(linked), lifecycle(linked), str(row.error ?? row.matchStatus), "Inspect inbound processing", str(row.id));
  }
  for (const row of input.tenDay) addWriteback(row, `${str(row.sourceInterval).replace("DAY_", "")} ONEWEEKCON`, "ONEWEEKCON=true",
    row.acumaticaWritebackJobId, row.acumaticaWritebackStatus, null, row.acumaticaWritebackError, row.updatedAt);
  for (const row of input.holds) addWriteback(row, "8 hold", "Hold=true", row.queueJobId, row.status, row.acumaticaResponseSummary, row.errorMessage, row.completedAt ?? row.updatedAt);
  for (const row of input.contacts) addWriteback(row, "Contact opt-out", `${str(row.targetField)}=${str(row.targetValue)} (logical value)`, row.queueJobId, row.status, row.resultSummary, row.errorMessage, row.completedAt ?? row.updatedAt);
  for (const row of input.thankYou) {
    for (const attempt of list(row.attempts)) {
      if (!within(attempt.createdAt) && !within(attempt.updatedAt) && !within(attempt.sentAt) && !["CREATED", "FAILED", "SUBMITTED"].includes(str(attempt.status))) continue;
      sends.push({ Order: order(row), Interval: "THANKYOU", Action: str(row.classification), Channel: str(attempt.channel),
      Status: str(attempt.status), Recipient: mask(attempt.recipient), "Provider accepted": attempt.success ? "yes" : "no", "Sent in coverage": within(attempt.sentAt ?? attempt.createdAt) ? "yes" : "no",
      "Sent at UTC": str(attempt.sentAt), "Provider ID": str(attempt.externalMessageId), "Attempt ID": str(attempt.id), Error: str(attempt.errorMessage) });
      if (attempt.status === "FAILED") issue("Thank-you send failed", order(row), "THANKYOU", str(attempt.errorMessage), "Inspect provider result and fallback history", str(attempt.id), age(attempt.createdAt));
    }
    if (row.acumaticaWritebackJobId || row.acumaticaWritebackStatus) addWriteback(row, "Thank you", "THANKYOU=true", row.acumaticaWritebackJobId, row.acumaticaWritebackStatus, row.acumaticaWritebackResult, row.acumaticaWritebackError, row.updatedAt);
    if (row.status === "FAILED") issue("Thank-you notification", order(row), "THANKYOU", str(row.reasonFailed), "Inspect provider/error and contact eligibility", str(row.id));
  }
  for (const row of skips) if (/fresh_import|no_automated_channel|no_internal_notification|missing.*contact/i.test(str(row.Reason)))
    issue("Blocked order", str(row.Order), str(row.Interval), str(row.Reason), "Review source data and contact eligibility", str(row.ID));
  coverage.push({ Section: "Report window", Status: "Complete", Detail: `${input.start.toISOString()} inclusive to ${input.end.toISOString()} exclusive; America/Denver reporting date ${input.reportDate}` });
  coverage.push({ Section: "Evidence limits", Status: "Informational", Detail: "Current DB and queue snapshot, not historical ERP replay. Email acceptance is not inbox delivery. Unverified writes require manual ERP review. Local import timestamps may be newer than send time. Response fields may be overwritten by later actions." });
  const unique = (rows: AuditRow[]) => Array.from(new Map(rows.map(row => [JSON.stringify(row), row])).values());
  sends.sort((a, b) => str(b.Interval).localeCompare(str(a.Interval), undefined, { numeric: true }) || str(a.Order).localeCompare(str(b.Order)));
  return { sheets: { "Attention": unique(issues), "Interval Runs": runs, "Notifications": sends, "Customer Responses": responses,
    "Writebacks": writebacks, "Skipped Orders": unique(skips), "Import Results": imports, "Coverage": coverage },
    summary: { reportDate: input.reportDate, coverageStart: input.start.toISOString(), coverageEnd: input.end.toISOString(),
      coreCoverageComplete: !coverage.some(row => row.Section !== "thankYou" && ["Unavailable", "Truncated"].includes(str(row.Status))),
      generatedAt: input.generatedAt.toISOString(), schedulerRuns: input.runs.length,
      missingRuns: runs.filter(row => row.Status === "MISSING").length,
      failedRuns: runs.filter(row => row.Status === "FAILED").length, attentionItems: unique(issues).length,
      notificationsAccepted: new Set(sends.filter(row => row["Provider accepted"] === "yes" && row["Sent in coverage"] === "yes").map(row => row["Attempt ID"] || row["Event ID"])).size,
      customerResponses: responses.length, writebacks: writebacks.length,
      failedWritebacks: writebacks.filter(row => row.Outcome === "Needs attention").length,
      pendingWritebacks: writebacks.filter(row => row.Outcome === "Pending").length } };
}
export async function operationsWorkbook(sheets: Record<string, AuditRow[]>) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "MLD Delivery";
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    const keys = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
    sheet.columns = (keys.length ? keys : ["Result"]).map(key => ({ header: key, key, width: Math.min(55, Math.max(18, key.length + 3)) }));
    for (const row of rows) sheet.addRow(row);
    if (!rows.length) sheet.addRow({ Result: "None" });
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
    sheet.eachRow(row => { row.alignment = { vertical: "top", wrapText: true }; });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
export function auditTable(rows: AuditRow[], limit = 40) {
  const escape = (value: unknown) => str(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (!rows.length) return "<p>None</p>";
  const keys = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font:12px Arial"><tr>${keys.map(key => `<th>${escape(key)}</th>`).join("")}</tr>${rows.slice(0, limit).map(row => `<tr>${keys.map(key => `<td>${escape(str(row[key]).length > 300 ? `${str(row[key]).slice(0, 300)}... (see workbook)` : row[key])}</td>`).join("")}</tr>`).join("")}</table>${rows.length > limit ? `<p>Showing ${limit} of ${rows.length}; complete detail is in the workbook.</p>` : ""}`;
}
