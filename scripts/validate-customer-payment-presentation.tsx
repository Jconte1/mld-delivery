import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { customerPaymentVisible, currentCustomerPaymentAmount } from "../lib/notifications/customerPaymentPresentation";
import type { DeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import { DeliveryPaymentSummary } from "../app/delivery/components/DeliveryPaymentSummary";
import { render8DayPaymentEnforcementCustomerEmail, render8DayPaymentEnforcementCustomerSms } from "../lib/notifications/deliveryPaymentEnforcement8Day";

for (const interval of ["DAY_2", "DAY_42", "DAY_41", "DAY_40", "DAY_39", "DAY_180", null, undefined]) {
  assert.equal(customerPaymentVisible(interval), false);
}
for (const interval of ["DAY_30", "DAY_14", "DAY_12", "DAY_10", "DAY_8"]) {
  assert.equal(customerPaymentVisible(interval), true);
}
const payment = { paymentStatus: "balance_due", paymentApplicabilityStatus: "applicable",
  amountDueNowRounded: "125.00", calculationWarnings: [],
} as unknown as DeliveryGroupPaymentEvaluation;
const historicalHold = { amountDueAtTrigger: "950.00" };
const input = { orderNumber: "TEST", contactName: "Test", jobName: "Test Job", jobAddress: "Test Address",
  deliveryDate: "2030-01-01", detailsLink: "https://example.invalid/details/test", amountDueNowRounded: currentCustomerPaymentAmount(payment) };
assert.equal(historicalHold.amountDueAtTrigger, "950.00");
const email = render8DayPaymentEnforcementCustomerEmail(input);
for (const output of [render8DayPaymentEnforcementCustomerSms(input), email.body, email.htmlBody,
  renderToStaticMarkup(<DeliveryPaymentSummary payment={payment} />)]) {
  assert.ok(output.includes("$125.00"));
  assert.ok(!output.includes("$950.00"));
}
const blockedPayments: Partial<DeliveryGroupPaymentEvaluation>[] = [{ amountDueNowRounded: "0.00" }, { paymentStatus: "no_balance_due" },
  { amountDueNowRounded: null }, { calculationWarnings: ["Missing tax"] }, { paymentStatus: "calculation_blocked" }];
for (const patch of blockedPayments) {
  assert.throws(() => currentCustomerPaymentAmount({ ...payment, ...patch }), /not_due_or_calculation_blocked/);
}
const page = readFileSync("app/details/[token]/page.tsx", "utf8");
assert.ok(page.includes("showPayment ? await getFreshDeliveryGroupPaymentEvaluation(group.id) : null"));
assert.ok(page.includes("{payment ? <DeliveryPaymentSummary"));
for (const field of ["detailsLinkId: loaded.detailsLink.id", "orderId: order.id", "deliveryGroupId: group.id", "deliveryDate: loaded.detailsLink.deliveryDate"]) assert.ok(page.includes(field));
const dispatcher = readFileSync("lib/notifications/deliveryNotificationDispatcher.ts", "utf8");
const eight = dispatcher.slice(dispatcher.indexOf('if (event.intervalType === NotificationIntervalType.DAY_8)'), dispatcher.indexOf('if (event.intervalType === NotificationIntervalType.DAY_2)'));
assert.ok(eight.includes("await paymentEvaluationForEvent(event, client)"));
assert.ok(eight.includes("currentCustomerPaymentAmount(payment)"));
assert.ok(!eight.includes("amountDueAtTrigger"));
assert.ok(dispatcher.includes("buildDeliveryDetailsLink(event.detailsLink.token, event.id)"));
console.log("Customer payment presentation passed: interval visibility, current 8-day SMS/email/web amount, paid/blocked rejection, scoped link wiring. No database/provider calls.");
