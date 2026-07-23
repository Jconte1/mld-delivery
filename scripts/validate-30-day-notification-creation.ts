import { readFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(source.includes(pattern), message, failures);
}

function assertNotIncludes(
  source: string,
  pattern: string,
  message: string,
  failures: string[]
) {
  assert(!source.includes(pattern), message, failures);
}

function main() {
  const failures: string[] = [];
  const source = read("lib/notifications/create30DayDeliveryReminderEvents.ts");
  const renderer = read("lib/notifications/deliveryReminder30Day.ts");
  const script = read("scripts/create-30-day-delivery-reminder-events.ts");
  const helper = read("lib/notifications/deliveryDetailsLinks.ts");

  const weekendIndex = source.indexOf("shouldSkipNotificationRunForWeekend(runDate)");
  const importIndex = source.indexOf(
    "summary.importResult = await importSalesOrdersForLineRequestedOn(importRequestedOn)"
  );
  const targetQueryIndex = source.indexOf(
    "const deliveryGroups = await find30DayDeliveryReminderTargetGroups"
  );

  assert(weekendIndex >= 0, "30-day creator checks global weekend skip", failures);
  assert(importIndex >= 0, "30-day creator imports fresh target-date data", failures);
  assert(targetQueryIndex >= 0, "30-day creator queries target delivery groups", failures);
  assert(
    importIndex > weekendIndex && importIndex < targetQueryIndex,
    "fresh Acumatica import occurs before target group query/qualification",
    failures
  );

  assertIncludes(
    source,
    "DELIVERY_REMINDER_30_DAY_INTERVAL_DAYS = 30",
    "30-day target interval is exactly 30 days",
    failures
  );
  assertIncludes(
    source,
    "DELIVERY_REMINDER_30_DAY_REQUESTED_ON_TIME = \"09:19:00.000Z\"",
    "30-day fresh import uses the existing requestedOn timestamp convention",
    failures
  );
  assertIncludes(
    source,
    "intervalType: NotificationIntervalType.DAY_30",
    "30-day events use DAY_30 interval",
    failures
  );
  assertIncludes(
    source,
    "actionType: NotificationActionType.DELIVERY_REMINDER",
    "30-day events use one combined DELIVERY_REMINDER action",
    failures
  );
  assertIncludes(
    source,
    "normalize30DayConfirmVia(order.confirmVia)",
    "30-day creator evaluates imported Acumatica confirmVia",
    failures
  );
  assertIncludes(
    source,
    "const trimmed = String(value).trim();",
    "confirmVia normalization trims whitespace",
    failures
  );
  assertIncludes(
    source,
    "not_confirmed_in_acumatica",
    "blank/missing confirmVia has clear skip reason",
    failures
  );
  assertIncludes(
    source,
    "ensureDeliveryDetailsLink",
    "30-day creator ensures reusable readonly details link",
    failures
  );
  assertIncludes(
    source,
    "detailsLinkId",
    "30-day notification events are associated to details links",
    failures
  );
  assertIncludes(
    source,
    "getDeliveryGroupReadiness(deliveryGroup.id)",
    "30-day creator loads all items for this delivery",
    failures
  );
  assertIncludes(
    source,
    "getDeliveryGroupPaymentEvaluation(deliveryGroup.id)",
    "30-day creator evaluates payment state",
    failures
  );
  assertIncludes(
    source,
    "getActiveSalespersonContactMap",
    "30-day creator resolves salesperson contact for email/page rendering",
    failures
  );

  for (const forbidden of [
    "NotificationActionType.PAYMENT_REQUEST",
    "NotificationActionType.BACKORDER_REPORT",
    "NotificationActionType.PAYMENT_ENFORCEMENT",
    "DeliveryConfirmation",
    "deliveryConfirmation",
    "newDeliveryConfirmationLinkToken",
    "buildDeliveryConfirmationLink",
    "confirmDeliveryFromWebpage",
    "enqueueDeliveryConfirmationAttributeWriteback",
    "notificationAttempt.create",
    "sendMail",
    "sendEmail",
    "sendSms",
    "twilio.messages.create",
    "client.messages.create",
  ]) {
    assertNotIncludes(
      source,
      forbidden,
      `30-day creator must not include ${forbidden}`,
      failures
    );
  }

  assertIncludes(
    renderer,
    "Payment may be needed before delivery. Please review details here:",
    "30-day SMS renderer has required payment sentence",
    failures
  );
  assertIncludes(
    renderer,
    "Balance owed prior to scheduling Delivery:",
    "30-day email renderer has exact payment wording",
    failures
  );
  assertIncludes(
    renderer,
    "Items For This Delivery",
    "30-day email renderer includes item section",
    failures
  );
  assertNotIncludes(
    renderer,
    "Request Different Date",
    "30-day renderer has no request-different-date language",
    failures
  );
  assertNotIncludes(
    renderer,
    "Reply Y",
    "30-day renderer has no SMS confirmation language",
    failures
  );

  assertIncludes(
    script,
    "notificationAttemptsUnchanged",
    "30-day script reports that attempts are unchanged",
    failures
  );
  assertIncludes(
    script,
    "deliveryConfirmationsUnchanged",
    "30-day script reports that confirmations are unchanged",
    failures
  );
  assertNotIncludes(
    helper,
    "/delivery/confirm/",
    "details link helper does not build 42-day confirmation URLs",
    failures
  );

  if (failures.length > 0) {
    console.error("30-day notification creation validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("30-day notification creation validation passed.");
}

main();
