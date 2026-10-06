import { readFileSync } from "node:fs";
import { join } from "node:path";
import strictAssert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildOperationsAudit, denverDayStart, nextDate, erpVerification, writebackState, operationsWorkbook, operationsCoverageStart, type OperationsAuditInput } from "../lib/notifications/deliveryOperationsAudit";
import { createDeliveryNotificationProvider } from "../lib/notifications/deliveryNotificationProviders";

import { NotificationActionType, NotificationIntervalType } from "../lib/generated/prisma/client";
import {
  deliveryOperationsIntervalLabel,
  deliveryWritebackSucceeded,
  REPORT_INTERVAL,
} from "../lib/notifications/deliveryOperationsReport";

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function read(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

async function main() {
  const failures: string[] = [];
  assert(
    deliveryOperationsIntervalLabel({
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
      dedupeKey: "delivery_confirmation:order",
    }) === "42",
    "initial confirmation labels as 42",
    failures
  );
  assert(deliveryWritebackSucceeded("confirmation", "written"), "written confirmation is successful", failures);
  assert(!deliveryWritebackSucceeded("confirmation", "dry_run"), "dry-run confirmation is not successful", failures);
  assert(!deliveryWritebackSucceeded("confirmation", "skipped_existing_value"), "unverified existing confirmation is not successful", failures);
  assert(deliveryWritebackSucceeded("requestedDate", "skipped_existing_value"), "already-applied requested date is successful", failures);
  assert(!deliveryWritebackSucceeded("requestedDate", "live_write_refused"), "refused requested date is not successful", failures);
  assert(
    deliveryOperationsIntervalLabel({
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REMINDER,
      dedupeKey: "delivery_confirmation_reminder:order:touch_2",
    }) === "41",
    "first reminder labels as 41",
    failures
  );
  assert(
    deliveryOperationsIntervalLabel({
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REMINDER,
      dedupeKey: "delivery_confirmation_reminder:order:touch_3",
    }) === "40",
    "final reminder labels as 40",
    failures
  );
  assert(
    deliveryOperationsIntervalLabel({
      intervalType: NotificationIntervalType.DAY_14,
      actionType: NotificationActionType.DELIVERY_REMINDER,
      dedupeKey: "delivery:14",
    }) === "14",
    "standard interval labels correctly",
    failures
  );

  const worker = read("scripts/delivery-notification-worker.ts");
  const report = read("lib/notifications/deliveryOperationsReport.ts") + read("lib/notifications/deliveryOperationsAudit.ts");
  const schema = read("prisma/schema.prisma");
  const schedulerModel = schema.match(/model DeliveryIntervalSchedulerRun \{([\s\S]*?)\n\}/)?.[1];
  const intervalLimit = Number(schedulerModel?.match(/interval\s+String\s+@db\.VarChar\((\d+)\)/)?.[1]);
  assert(intervalLimit > 0 && REPORT_INTERVAL.length <= intervalLimit, "report interval fits scheduler database column", failures);
  assert(worker.includes('local.time >= "17:00"'), "worker runs report after 17:00 Denver", failures);
  assert(worker.includes("lastOperationsReportDate"), "worker suppresses repeat report attempts", failures);
  assert(report.includes("delivery_operations_report:${reportDate}"), "report uses date lock", failures);
  assert(report.includes("successfullyRefreshedOrders"), "report includes fresh import evidence", failures);
  assert(report.includes('"39": "15:35"'), "report includes follow-up schedule", failures);
  assert(report.includes("notificationEvent.findMany"), "report includes notification events", failures);
  assert(report.includes("fetchQueueJob"), "report reconciles queue writeback status", failures);
  assert(report.includes("ONEWEEKCON=true"), "report describes ten-day writeback", failures);
  assert(report.includes("Details[].RequestedOn"), "report describes requested-date writeback", failures);
  assert(report.includes("CONFIRMVIA="), "report describes confirmation writeback", failures);
  assert(schema.includes("confirmationWritebackJobId"), "confirmation queue job is persisted", failures);
  assert(schema.includes("requestedDateWritebackJobId"), "requested-date queue job is persisted", failures);

  strictAssert.equal(denverDayStart("2026-03-09").getTime() - denverDayStart("2026-03-08").getTime(), 23 * 3600000);
  strictAssert.equal(denverDayStart("2026-11-02").getTime() - denverDayStart("2026-11-01").getTime(), 25 * 3600000);
  strictAssert.equal(nextDate("2026-12-31"), "2027-01-01");
  strictAssert.equal(operationsCoverageStart("2026-09-29", { runDate: "2026-09-28", resultSummary: { coverageEnd: "2026-09-28T23:00:00Z" } }).start.toISOString(), "2026-09-28T23:00:00.000Z", "next report includes late activity after prior cutoff");
  strictAssert.equal(operationsCoverageStart("2026-09-29", { runDate: "2026-09-28", resultSummary: { coreCoverageComplete: false, coverageStart: "2026-09-28T06:00:00Z", coverageEnd: "2026-09-28T23:00:00Z" } }).start.toISOString(), "2026-09-28T06:00:00.000Z", "incomplete core report must not lose failed section data");
  strictAssert.match(erpVerification({ status: "succeeded" }), /NOT VERIFIED/);
  strictAssert.match(erpVerification({ verification: { verified: false } }), /MISMATCH/);
  strictAssert.match(erpVerification({ verification: { verified: true } }), /matched/);
  strictAssert.match(erpVerification({ verification: { oneWeekConfirmedAfter: true } }), /matched/);
  strictAssert.equal(writebackState("NOT_CLEARED"), "Withheld / not attempted");
  strictAssert.equal(writebackState("AWAITING_NOTIFICATION"), "Withheld / not attempted");
  const start = new Date("2026-09-28T23:00:00Z");
  const end = new Date("2026-09-29T23:00:00Z");
  const event = { id: "event", orderType: "SO", orderNumber: "LATER", intervalType: "DAY_42", actionType: "DELIVERY_CONFIRMATION_REQUEST",
    deliveryDate: "2026-11-10", deliveryGroupId: "g1", createdAt: "2026-09-27T21:30:00Z", updatedAt: "2026-09-29T15:00:00Z", status: "SENT", order: {} };
  const accepted = { id: "accepted", status: "DELIVERED", success: true, channel: "SMS", recipient: "8015551234", createdAt: "2026-09-29T15:00:00Z", sentAt: "2026-09-29T15:00:01Z" };
  const input: OperationsAuditInput = { reportDate: "2026-09-29", start, end, generatedAt: end,
    runs: [{ id: "run", interval: "14", runDate: "2026-09-29", status: "SUCCESS", resultSummary: {
      importSummary: { errors: [{ orderType: "SO", orderNumber: "BADFETCH", reason: "ContactID missing" }], successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "GOODFETCH" }] },
      failedImportExclusions: [] } }],
    events: [{ ...event, attempts: [accepted] }, { ...event, id: "skip", orderNumber: "NOSEND", status: "SKIPPED", reasonSkipped: "no_balance_due", attempts: [] }],
    confirmations: [{ id: "confirmation", orderType: "SO", orderNumber: "LATER", notificationEvent: event,
      deliveryDate: "2026-11-10", requestedNewDate: "2026-11-12", requestedNewDateAt: "2026-09-29T16:00:00Z", responseChannel: "WEB",
      requestedDateWritebackQueuedAt: "2026-09-29T16:00:01Z", requestedDateWritebackStatus: "queued", requestedDateWritebackJobId: "job",
      requestedDateWritebackPayload: { requestedDeliveryDate: "2026-11-12", lineNumbers: [1, 2] } }],
    tenDay: [{ id: "clear", orderType: "SO", orderNumber: "NOSEND", sourceInterval: "DAY_12", acumaticaWritebackStatus: "NOT_CLEARED", updatedAt: "2026-09-29T16:00:00Z" }],
    holds: [], internal: [], contacts: [], thankYou: [], inbound: [], coverage: [],
    jobs: { job: { status: "succeeded", result: { status: "written", verification: { verified: true } } } } };
  const audit = buildOperationsAudit(input);
  strictAssert.equal(audit.summary.notificationsAccepted, 1);
  strictAssert.equal(audit.sheets.Notifications.length, 1, "skipped event is not a send");
  strictAssert.equal(audit.sheets.Notifications[0].Recipient, "***1234");
  strictAssert.ok(audit.sheets["Customer Responses"].some(row => row.Order === "SO LATER"), "later-day response retained");
  strictAssert.ok(audit.sheets.Writebacks.some(row => String(row["Intended value / scope"]).includes("lines=[1,2]")));
  strictAssert.ok(audit.sheets.Attention.some(row => row.Order === "SO BADFETCH"), "empty exclusion list cannot hide import errors");
  strictAssert.ok(audit.sheets.Attention.some(row => row.Category === "Missing interval run"));
  strictAssert.equal(audit.summary.failedWritebacks, 0, "NOT_CLEARED is not failed writeback");
  const backlog = buildOperationsAudit({ ...input, coverage: [{ Section: "test", Status: "Unavailable", Detail: "Section failed" }],
    events: [{ ...event, attempts: [{ ...accepted, id: "failed", status: "FAILED", success: false, createdAt: "2026-09-20T15:00:00Z", sentAt: null }] }] });
  strictAssert.ok(backlog.sheets.Attention.some(row => row.Category === "Notification failed"));
  strictAssert.ok(backlog.sheets.Attention.some(row => row.Category === "Report coverage"));
  const fallback = buildOperationsAudit({ ...input, events: [{ ...event, attempts: [
    { ...accepted, id: "failed", status: "FAILED", success: false, createdAt: "2026-09-29T14:00:00Z" }, accepted] }] });
  strictAssert.ok(!fallback.sheets.Attention.some(row => row.Category === "Notification failed"), "successful fallback resolves failure attention");
  const duplicate = buildOperationsAudit({ ...input, events: [{ ...event, attempts: [accepted, { ...accepted, id: "second" }] }] });
  strictAssert.ok(duplicate.sheets.Attention.some(row => row.Category === "Possible duplicate send"));
  const shared = { ...accepted, id: "one-shared-attempt", groupId: "group", submittedAt: accepted.sentAt, productionEligibilityVerified: true };
  const grouped = buildOperationsAudit({ ...input, events: ["FIRST", "SECOND"].map(orderNumber => ({ ...event,
    id: orderNumber, orderNumber, attempts: [], notificationGroupMember: { group: { id: "group", attempts: [shared] } } })) });
  strictAssert.equal(grouped.summary.notificationsAccepted, 1, "one shared provider send is counted once");
  strictAssert.equal(grouped.sheets.Notifications.length, 2, "both member orders remain visible");
  strictAssert.ok(grouped.sheets.Notifications.every(row => row["Shared attempt"] === "yes"));
  const workbookBytes = await operationsWorkbook(audit.sheets);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  strictAssert.equal(workbook.worksheets.length, 8);
  strictAssert.ok(JSON.stringify(workbook.getWorksheet("Customer Responses")?.getSheetValues()).includes("SO LATER"));
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/oauth2/")) return new Response(JSON.stringify({ access_token: "fake" }), { status: 200 });
    providerCalls++;
    const body = JSON.parse(String(options?.body));
    strictAssert.equal(body.message.attachments[0]["@odata.type"], "#microsoft.graph.fileAttachment");
    strictAssert.equal(body.message.attachments[0].contentBytes, workbookBytes.toString("base64"));
    return new Response(null, { status: 202, headers: { "request-id": "fake-report-request" } });
  };
  try {
    await createDeliveryNotificationProvider({ NODE_ENV: "test", MS_GRAPH_FROM_EMAIL: "fake@example.com", MS_GRAPH_TENANT_ID: "fake", MS_GRAPH_CLIENT_ID: "fake", MS_GRAPH_CLIENT_SECRET: "fake" }).sendEmail({
      to: "fake@example.com", subject: "Validation", textBody: "test", attachments: [{ name: "test.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBytes: workbookBytes.toString("base64") }] });
    strictAssert.equal(providerCalls, 1);
  } finally { globalThis.fetch = originalFetch; }

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    validations: "source checks plus behavioral, DST, workbook and mocked attachment tests",
    emailsSent: 0,
    smsSent: 0,
    providerCalls: 0,
    acumaticaWrites: 0,
    databaseWrites: 0,
  }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
