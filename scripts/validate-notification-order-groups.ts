import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatOrderGroup, formatDeliveryDescription, getSalesOrderBuyerGroup, renderDeliveryReminderMessage, renderDeliveryReminderEmailSubject } from "../lib/notifications/helpers";
import { renderDeliveryReminderEmailBody } from "../lib/notifications/deliveryReminderEmail";
import { render42DaySmsConfirmationMessage, render42DaySmsConfirmationReminderMessage } from "../lib/notifications/deliveryConfirmationSms";
import { render42DayEmailConfirmationMessage, render42DayEmailConfirmationReminderMessage } from "../lib/notifications/deliveryConfirmationEmail";
import { render42DayNoResponseSalespersonEmail } from "../lib/notifications/deliveryConfirmationNoResponse";
import { render30DayDeliveryReminderSms, render30DayDeliveryReminderEmail } from "../lib/notifications/deliveryReminder30Day";
import { render14DayDeliveryReminderSms, render14DayDeliveryReminderEmail } from "../lib/notifications/deliveryReminder14Day";
import { render12DayDeliveryPaymentReminderSms, render12DayDeliveryPaymentReminderEmail } from "../lib/notifications/deliveryPaymentReminder12Day";
import { render10DayDeliveryPaymentReminderSms, render10DayDeliveryPaymentReminderEmail } from "../lib/notifications/deliveryPaymentReminder10Day";
import { render8DayPaymentEnforcementCustomerSms, render8DayPaymentEnforcementCustomerEmail,
  render8DayPaymentEnforcementInternalSuccess, render8DayPaymentEnforcementInternalFailure } from "../lib/notifications/deliveryPaymentEnforcement8Day";
import { render2DayDeliveryReminderSms, render2DayDeliveryReminderEmail } from "../lib/notifications/deliveryReminder2Day";
import { renderDeliveryThankYou, renderWillCallThankYou } from "../lib/notifications/orderThankYouTemplates";
import { renderOrderComplete } from "../lib/notifications/orderCompleteTemplates";

let checked = 0;
for (const group of ["Appliance", "Plumbing", "Hardware", "Fireplace"]) {
  assert.equal(formatOrderGroup(group.toUpperCase(), "SO"), group);
  const p = { orderType: "SO", orderNumber: "SO123456", contactName: "James", buyerGroup: group.toUpperCase(),
    customerName: "Jackson", locationName: "John Smith", jobName: "Jackson / John Smith",
    jobAddress: "2345 S Main Street, Salt Lake City, UT 84109", deliveryDate: "2026-12-15",
    requestedDeliveryDate: new Date("2026-12-15T00:00:00Z"), detailsLink: "https://www.mld.com/delivery/details/example",
    link: "https://www.mld.com/delivery/confirm/example", paymentDue: true, amountDueNowRounded: "26000",
    paymentDeadlineDate: "2026-12-07" };
  const verify = (text: string) => { assert(text.includes(group), `Missing ${group}: ${text}`); checked++; };
  for (const thankYou of [renderDeliveryThankYou(p), renderWillCallThankYou(p)]) {
    verify(thankYou.subject); verify(thankYou.textBody); verify(thankYou.emailTextBody); verify(thankYou.htmlBody);
  }
  for (const intervalType of ["DAY_180", "DAY_90", "DAY_60"] as const) {
    verify(renderDeliveryReminderMessage({ ...p, intervalType }));
    verify(renderDeliveryReminderEmailSubject(p));
    verify(renderDeliveryReminderEmailBody({ ...p, intervalType }));
  }
  verify(render42DaySmsConfirmationMessage(p));
  const confirmation = render42DayEmailConfirmationMessage(p);
  verify(confirmation.subject); verify(confirmation.body); verify(confirmation.htmlBody);
  for (const touchNumber of [2, 3] as const) {
    verify(render42DaySmsConfirmationReminderMessage({ ...p, touchNumber }));
    const reminder = render42DayEmailConfirmationReminderMessage({ ...p, touchNumber });
    verify(reminder.subject); verify(reminder.body); verify(reminder.htmlBody);
  }
  for (const sms of [render30DayDeliveryReminderSms, render14DayDeliveryReminderSms,
    render12DayDeliveryPaymentReminderSms, render10DayDeliveryPaymentReminderSms,
    render8DayPaymentEnforcementCustomerSms, render2DayDeliveryReminderSms]) verify(sms(p));
  for (const email of [render30DayDeliveryReminderEmail, render14DayDeliveryReminderEmail,
    render12DayDeliveryPaymentReminderEmail, render10DayDeliveryPaymentReminderEmail,
    render8DayPaymentEnforcementCustomerEmail, render2DayDeliveryReminderEmail]) {
    const message = email(p); verify(message.subject); verify(message.body); verify(message.htmlBody);
  }
  const escalation = render42DayNoResponseSalespersonEmail({ ...p, confirmationLink: p.link,
    currentStatus: "NO_RESPONSE", reason: "no_response" });
  verify(escalation.body);
  verify(render8DayPaymentEnforcementInternalSuccess(p).body);
  verify(render8DayPaymentEnforcementInternalFailure(p).body);
  for (const channel of ["SMS", "EMAIL"] as const) {
    const complete = renderOrderComplete({ ...p, completedAt: "2026-12-15T18:00:00Z" }, channel);
    verify(complete.subject); verify(complete.textBody);
  }
}
assert.equal(formatOrderGroup("FIREPLACES"), "Fireplace");
assert.equal(formatOrderGroup("APPLIANCES"), "Appliance");
assert.equal(formatOrderGroup("Fireplace", "PL"), "Fireplace");
assert.equal(formatOrderGroup(null, "PG"), "Plumbing");
assert.equal(formatOrderGroup(null, "HW"), "Hardware");
assert.equal(formatOrderGroup(null, "UNKNOWN"), null);
assert.equal(formatDeliveryDescription("Appliance / Plumbing"), "Appliance / Plumbing delivery");
assert.equal(getSalesOrderBuyerGroup({ custom: { Document: { AttributeBUYERGROUP: { value: "Fireplace" } } }, BuyerGroup: "Appliance" }), "Fireplace");
assert.equal(getSalesOrderBuyerGroup({ BuyerGroup: { value: "Hardware" } }), "Hardware");
assert.equal(getSalesOrderBuyerGroup(null), null);
const escaped = render42DayEmailConfirmationReminderMessage({ orderNumber: "TEST", contactName: "James",
  buyerGroup: "Fireplace <Group>", deliveryDate: "2026-12-15", link: "https://example.test" });
assert.match(escaped.htmlBody, /Fireplace &lt;Group&gt;/);
const dispatcher = readFileSync(new URL("../lib/notifications/deliveryNotificationDispatcher.ts", import.meta.url), "utf8");
assert.match(dispatcher, /order: \{ \.\.\.event.order, buyerGroup \}/);
assert.match(dispatcher, /buyerGroup: common.buyerGroup/);
console.log(JSON.stringify({ ok: true, groups: 4, copyAssertions: checked, providerCalls: 0, erpCalls: 0, databaseWrites: 0 }));
