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
  const wrapper = read("lib/notifications/create14DayDeliveryReminderEvents.ts");
  const shared = read("lib/notifications/create30DayDeliveryReminderEvents.ts");
  const productionRunner = read("scripts/run-delivery-interval.ts");
  const renderer = read("lib/notifications/deliveryReminder14Day.ts");

  const importIndex = shared.indexOf(
    "summary.importResult = await importSalesOrdersForLineRequestedOn(importRequestedOn)"
  );
  const queryIndex = shared.indexOf(
    "const deliveryGroups = await find30DayDeliveryReminderTargetGroups"
  );

  assertIncludes(
    wrapper,
    "DELIVERY_REMINDER_14_DAY_INTERVAL_DAYS = 14",
    "14-day target interval is exactly 14 days",
    failures
  );
  assertIncludes(
    wrapper,
    "intervalType: NotificationIntervalType.DAY_14",
    "14-day wrapper creates DAY_14 events",
    failures
  );
  assertIncludes(
    wrapper,
    "createConfirmedDeliveryReminderEvents",
    "14-day reuses shared confirmed-delivery reminder engine",
    failures
  );
  assert(
    importIndex >= 0 && queryIndex >= 0 && importIndex < queryIndex,
    "fresh ERP import occurs before active group query/qualification",
    failures
  );
  assertIncludes(
    shared,
    "normalize30DayConfirmVia(order.confirmVia)",
    "qualification uses current imported Order.confirmVia",
    failures
  );
  assertIncludes(
    shared,
    "const trimmed = String(value).trim();",
    "confirmVia normalization trims whitespace",
    failures
  );
  assertIncludes(
    wrapper,
    "normalize14DayConfirmVia = normalize30DayConfirmVia",
    "14-day exposes same trimmed confirmVia rule",
    failures
  );
  assertIncludes(
    shared,
    "not_confirmed_in_acumatica",
    "blank/missing confirmVia skips with not_confirmed_in_acumatica",
    failures
  );
  assertIncludes(
    shared,
    "intervalType: options.intervalType",
    "shared engine applies wrapper-provided interval type",
    failures
  );
  assertIncludes(
    shared,
    "getDeliveryDateCustomerNotificationSkipReason(targetDeliveryDate)",
    "14-day shared engine enforces weekend delivery-date eligibility",
    failures
  );
  assertIncludes(
    shared,
    "deliveryGroupsSkippedWeekendDeliveryDate",
    "14-day shared summary reports weekend delivery-date skips",
    failures
  );
  assertIncludes(
    shared,
    "detailsLinkId: null",
    "14-day weekend delivery-date dedupe branch detaches details links",
    failures
  );
  assertIncludes(
    shared,
    "actionType: NotificationActionType.DELIVERY_REMINDER",
    "14-day uses one combined DELIVERY_REMINDER action",
    failures
  );
  assertIncludes(
    shared,
    "ensureDeliveryDetailsLink",
    "14-day reuses DeliveryDetailsLink",
    failures
  );
  assertIncludes(
    shared,
    "getDeliveryGroupReadiness(deliveryGroup.id)",
    "14-day loads all items for this delivery",
    failures
  );
  assertIncludes(
    shared,
    "getDeliveryGroupPaymentEvaluation(",
    "14-day evaluates payment inside combined reminder",
    failures
  );
  assertIncludes(
    shared,
    "allocateFreightDeliveryCharges: true",
    "14-day payment evaluation can allocate freight/delivery charges",
    failures
  );
  assertIncludes(
    shared,
    "const showPaymentReminder = paymentReminderApplies(payment);",
    "14-day includes payment only when due",
    failures
  );
  assertNotIncludes(
    shared,
    "if (!showPaymentReminder)",
    "14-day normal reminder must not require payment due",
    failures
  );
  assertNotIncludes(
    shared,
    "paymentStatus !== \"balance_due\"",
    "14-day normal reminder must not skip non-payment customers",
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
    "NotificationIntervalType.DAY_12",
    "NotificationIntervalType.DAY_10",
    "NotificationIntervalType.DAY_8",
  ]) {
    assertNotIncludes(
      wrapper,
      forbidden,
      `14-day wrapper must not include ${forbidden}`,
      failures
    );
  }

  assertIncludes(
    renderer,
    "render14DayDeliveryReminderEmail",
    "14-day renderer exposes interval-specific email rendering",
    failures
  );
  assertIncludes(
    renderer,
    "render14DayDeliveryReminderSms",
    "14-day renderer exposes interval-specific SMS rendering",
    failures
  );
  assertIncludes(
    productionRunner,
    '"14"',
    "production runner supports interval 14",
    failures
  );
  assertIncludes(
    productionRunner,
    "RUN REAL 14 DAY CUSTOMER NOTIFICATIONS",
    "production runner requires exact 14-day confirmation phrase",
    failures
  );
  assertIncludes(
    productionRunner,
    "create14DayDeliveryReminderEvents",
    "production runner uses the 14-day creation path",
    failures
  );
  assertIncludes(
    productionRunner,
    "NotificationIntervalType.DAY_14",
    "production runner maps interval 14 to DAY_14",
    failures
  );

  if (failures.length > 0) {
    console.error("14-day notification creation validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("14-day notification creation validation passed.");
}

main();
