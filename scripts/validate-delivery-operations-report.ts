import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function main() {
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
  const report = read("lib/notifications/deliveryOperationsReport.ts");
  const schema = read("prisma/schema.prisma");
  const schedulerModel = schema.match(/model DeliveryIntervalSchedulerRun \{([\s\S]*?)\n\}/)?.[1];
  const intervalLimit = Number(schedulerModel?.match(/interval\s+String\s+@db\.VarChar\((\d+)\)/)?.[1]);
  assert(intervalLimit > 0 && REPORT_INTERVAL.length <= intervalLimit, "report interval fits scheduler database column", failures);
  assert(worker.includes('local.time >= "17:00"'), "worker runs report after 17:00 Denver", failures);
  assert(worker.includes("lastOperationsReportDate"), "worker suppresses repeat report attempts", failures);
  assert(report.includes("delivery_operations_report:${reportDate}"), "report uses date lock", failures);
  assert(report.includes("successfullyRefreshedOrders"), "report includes fresh import evidence", failures);
  assert(report.includes("REPORT_LIFECYCLE_INTERVALS"), "report includes every lifecycle interval even when empty", failures);
  assert(report.includes("notificationEvent.findMany"), "report includes notification events", failures);
  assert(report.includes("fetchQueueJob"), "report reconciles queue writeback status", failures);
  assert(report.includes("ONEWEEKCON=true"), "report describes ten-day writeback", failures);
  assert(report.includes("Details[].RequestedOn"), "report describes requested-date writeback", failures);
  assert(report.includes("CONFIRMVIA="), "report describes confirmation writeback", failures);
  assert(schema.includes("confirmationWritebackJobId"), "confirmation queue job is persisted", failures);
  assert(schema.includes("requestedDateWritebackJobId"), "requested-date queue job is persisted", failures);

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    validations: 22,
    emailsSent: 0,
    smsSent: 0,
    providerCalls: 0,
    acumaticaWrites: 0,
    databaseWrites: 0,
  }, null, 2));
}

main();
