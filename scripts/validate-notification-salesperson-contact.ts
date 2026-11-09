import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendSalespersonSmsContact, renderSalespersonContactText, renderGroupedSalespersonContactText } from "../lib/notifications/salespersonContactDisplay";
import { renderDeliveryReminderMessage } from "../lib/notifications/helpers";
import { render42DaySmsConfirmationMessage, render42DaySmsConfirmationReminderMessage } from "../lib/notifications/deliveryConfirmationSms";
import { render42DayEmailConfirmationReminderMessage } from "../lib/notifications/deliveryConfirmationEmail";
import { render30DayDeliveryReminderSms } from "../lib/notifications/deliveryReminder30Day";
import { render14DayDeliveryReminderSms } from "../lib/notifications/deliveryReminder14Day";
import { render12DayDeliveryPaymentReminderSms } from "../lib/notifications/deliveryPaymentReminder12Day";
import { render10DayDeliveryPaymentReminderSms } from "../lib/notifications/deliveryPaymentReminder10Day";
import { render8DayPaymentEnforcementCustomerSms } from "../lib/notifications/deliveryPaymentEnforcement8Day";
import { render2DayDeliveryReminderSms } from "../lib/notifications/deliveryReminder2Day";
import { renderDeliveryThankYou, renderWillCallThankYou } from "../lib/notifications/orderThankYouTemplates";

const contact = { salespersonName: "alex morgan", salespersonPhone: "8015550142", salespersonEmail: "Alex@Example.test", isActive: true };
const footer = "Questions? Contact Alex Morgan at 801-555-0142 or alex@example.test.";
assert.equal(renderSalespersonContactText(contact), footer);
assert.equal(renderSalespersonContactText(null), "Questions? Contact your MLD salesperson.");
assert.equal(renderSalespersonContactText({ ...contact, isActive: false }), "Questions? Contact your MLD salesperson.");
assert.equal(renderSalespersonContactText({ ...contact, salespersonPhone: null }), "Questions? Contact Alex Morgan at alex@example.test.");
assert.equal(renderSalespersonContactText({ ...contact, salespersonEmail: null }), "Questions? Contact Alex Morgan at 801-555-0142.");

const sample = { orderNumber: "SO123456", contactName: "James", buyerGroup: "Appliance", jobName: "Jackson / John Smith",
  jobAddress: "2345 S Main Street, Salt Lake City, UT 84109", deliveryDate: "2026-12-15", paymentDue: true,
  amountDueNowRounded: "26000", detailsLink: "https://www.mld.com/delivery/details/example",
  link: "https://www.mld.com/delivery/confirm/example", salespersonContact: contact };
const sms = [
  ...(["DAY_180", "DAY_90", "DAY_60"] as const).map(intervalType => renderDeliveryReminderMessage({ ...sample, intervalType })),
  render42DaySmsConfirmationMessage(sample),
  render42DaySmsConfirmationReminderMessage({ ...sample, touchNumber: 2 }),
  render42DaySmsConfirmationReminderMessage({ ...sample, touchNumber: 3 }),
  render30DayDeliveryReminderSms(sample), render30DayDeliveryReminderSms({ ...sample, paymentDue: false }),
  render14DayDeliveryReminderSms(sample), render14DayDeliveryReminderSms({ ...sample, paymentDue: false }),
  render12DayDeliveryPaymentReminderSms(sample), render10DayDeliveryPaymentReminderSms(sample),
  render8DayPaymentEnforcementCustomerSms(sample), render2DayDeliveryReminderSms(sample),
];
for (const body of sms) {
  const rendered = appendSalespersonSmsContact(body, footer);
  assert.match(rendered, /Questions\? Contact Alex Morgan at 801-555-0142 or alex@example.test\./);
  assert(rendered.endsWith(`${footer}\n\nReply STOP to opt out.`));
  assert.equal(rendered.split("Reply STOP to opt out.").length - 1, 1);
}
for (const touchNumber of [2, 3] as const) {
  const email = render42DayEmailConfirmationReminderMessage({ ...sample, touchNumber });
  for (const body of [email.body, email.htmlBody]) {
    assert(body.includes(footer));
    assert.doesNotMatch(body, /make a payment|balance owed/i);
  }
  const escaped = render42DayEmailConfirmationReminderMessage({ ...sample, touchNumber,
    salespersonContact: { ...contact, salespersonName: "Alex <Morgan>" } });
  assert.match(escaped.htmlBody, /Alex &lt;Morgan&gt;/);
}
for (const message of [renderDeliveryThankYou({ orderNumber: sample.orderNumber, requestedDeliveryDate: null, salespersonContact: contact }),
  renderWillCallThankYou({ orderNumber: sample.orderNumber, salespersonContact: contact })]) {
  assert(message.textBody.endsWith(`${footer}\n\nReply STOP to opt out.`));
  for (const body of [message.emailTextBody, message.htmlBody]) {
    assert.match(body, /Alex Morgan/);
    assert.match(body, /801-555-0142/);
    assert.match(body, /alex@example.test/);
    assert.doesNotMatch(body, /Reply STOP/);
  }
}
assert.equal(renderGroupedSalespersonContactText([{ orderNumber: "SO1", contact }, { orderNumber: "SO2", contact }]), footer);
const grouped = renderGroupedSalespersonContactText([{ orderNumber: "SO1", contact },
  { orderNumber: "PL2", contact: { ...contact, salespersonName: "Sam Green", salespersonEmail: "sam@example.test" } },
  { orderNumber: "HW3", contact: null }]);
assert.match(grouped, /Order SO1: Questions\? Contact Alex Morgan/);
assert.match(grouped, /Order PL2: Questions\? Contact Sam Green/);
assert.match(grouped, /Order HW3: Questions\? Contact your MLD salesperson\./);

const dispatcher = readFileSync(new URL("../lib/notifications/deliveryNotificationDispatcher.ts", import.meta.url), "utf8");
assert.match(dispatcher, /const rendered = await renderForChannelContent/);
assert.match(dispatcher, /textBody: appendSalespersonSmsContact\(rendered.textBody/);
assert.match(dispatcher, /groupedContactText = renderGroupedSalespersonContactText/);
const thankYou = readFileSync(new URL("../lib/notifications/orderThankYou.ts", import.meta.url), "utf8");
assert.doesNotMatch(thankYou, /salespersonContact: selected.selectedChannel === "EMAIL"/);
console.log(JSON.stringify({ ok: true, smsScenarios: sms.length, reminderEmailScenarios: 2,
  groupedContacts: "same, different, missing", providerCalls: 0, databaseWrites: 0, erpCalls: 0 }));
