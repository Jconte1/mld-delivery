import type { OrderLineReadinessSummary } from "../lib/delivery-readiness/orderLineReadiness";
import {
  render30DayDeliveryReminderEmail,
  render30DayDeliveryReminderSms,
} from "../lib/notifications/deliveryReminder30Day";

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, text: string, message: string, failures: string[]) {
  assert(source.includes(text), message, failures);
}

function assertNotIncludes(source: string, text: string, message: string, failures: string[]) {
  assert(!source.includes(text), message, failures);
}

const sampleLines: OrderLineReadinessSummary[] = [
  {
    orderLineId: "line_1",
    lineNbr: 1,
    inventoryId: "REF-123",
    lineDescription: "Built-in refrigerator",
    itemType: "S",
    itemClass: "APPLIANCE",
    requestedOn: "2026-08-22",
    eta: "2026-08-10",
    orderQty: 1,
    openQty: 1,
    activeAllocatedQty: 1,
    allocationStatus: "allocated",
    etaStatus: "ready",
    readinessStatus: "ready",
    displayStatus: "Ready",
    allocationCount: 1,
    allocationRowsCompact: ["1"],
    activeAllocationCount: 1,
    completedAllocationCount: 0,
  },
];

function main() {
  const failures: string[] = [];
  const baseParams = {
    orderNumber: "SO30",
    contactName: "James",
    buyerGroup: "Builder",
    jobName: "Smith Residence",
    jobAddress: "123 Main St, Salt Lake City UT",
    deliveryDate: "2026-08-22",
    detailsLink: "https://mld-delivery.example.test/delivery/details/dd_test",
    amountDueNowRounded: "125.50",
    lines: sampleLines,
    salespersonContact: {
      salespersonName: "Sales Person",
      salespersonEmail: "sales@example.test",
      salespersonPhone: "801-555-1212",
      isActive: true,
    },
  };

  const smsNoPayment = render30DayDeliveryReminderSms({
    ...baseParams,
    paymentDue: false,
  });
  const smsPayment = render30DayDeliveryReminderSms({
    ...baseParams,
    paymentDue: true,
  });
  const emailNoPayment = render30DayDeliveryReminderEmail({
    ...baseParams,
    paymentDue: false,
  });
  const emailPayment = render30DayDeliveryReminderEmail({
    ...baseParams,
    paymentDue: true,
  });

  assertIncludes(
    smsNoPayment,
    "MLD: Order SO30:",
    "30-day SMS includes order number",
    failures
  );
  assertIncludes(
    smsPayment,
    "MLD: Order SO30:",
    "30-day payment SMS includes order number",
    failures
  );
  assertIncludes(
    smsNoPayment,
    "Review delivery details here: https://mld-delivery.example.test/delivery/details/dd_test.",
    "SMS includes readonly details link",
    failures
  );
  assertIncludes(
    smsPayment,
    "Payment may be needed before delivery. Please review details here:",
    "SMS includes payment sentence only when due",
    failures
  );
  assertNotIncludes(
    smsNoPayment,
    "Payment may be needed before delivery",
    "SMS omits payment sentence when no payment is due",
    failures
  );

  for (const forbidden of [
    "Confirm",
    "confirmed",
    "Y/N",
    "Reply Y",
    "Sales Person",
    "REF-123",
    "Built-in refrigerator",
    "Items For This Delivery",
  ]) {
    assertNotIncludes(smsNoPayment, forbidden, `SMS should not include ${forbidden}`, failures);
    assertNotIncludes(smsPayment, forbidden, `SMS should not include ${forbidden}`, failures);
  }

  assertIncludes(
    emailNoPayment.subject,
    "Builder delivery reminder: Smith Residence",
    "30-day email subject includes buyer group and job name",
    failures
  );
  assertIncludes(
    emailNoPayment.body,
    "Review delivery details here: https://mld-delivery.example.test/delivery/details/dd_test",
    "30-day email body includes readonly details link",
    failures
  );
  for (const [label, source] of [
    ["email text body", emailNoPayment.body],
    ["email HTML body", emailNoPayment.htmlBody],
    ["payment email text body", emailPayment.body],
    ["payment email HTML body", emailPayment.htmlBody],
  ] as const) {
    for (const forbidden of [
      "Items For This Delivery",
      "Line 1: REF-123",
      "REF-123",
      "Built-in refrigerator",
    ]) {
      assertNotIncludes(
        source,
        forbidden,
        `30-day ${label} should not include item details: ${forbidden}`,
        failures
      );
    }
  }
  assertIncludes(
    emailNoPayment.body,
    "Order: SO30",
    "30-day email body includes order number",
    failures
  );
  assertIncludes(
    emailPayment.body,
    "Order: SO30",
    "30-day payment email body includes order number",
    failures
  );
  assertIncludes(
    emailNoPayment.body,
    "To make a payment, for additional information, or to make changes to this order, please reach out to Sales Person",
    "30-day email includes salesperson footer",
    failures
  );
  assertNotIncludes(
    emailNoPayment.body,
    "Balance owed prior to scheduling Delivery:",
    "30-day email omits payment wording when no payment is due",
    failures
  );
  assertIncludes(
    emailPayment.body,
    "Balance owed prior to scheduling Delivery: $125.50",
    "30-day email includes exact payment wording when due",
    failures
  );

  for (const forbidden of [
    "ACTION REQUIRED",
    "Confirm Delivery",
    "Request Different Date",
    "Reply Y",
    "Reply N",
    "date picker",
  ]) {
    assertNotIncludes(
      emailNoPayment.body,
      forbidden,
      `30-day email should not include confirmation language: ${forbidden}`,
      failures
    );
    assertNotIncludes(
      emailPayment.body,
      forbidden,
      `30-day email should not include confirmation language: ${forbidden}`,
      failures
    );
  }

  if (failures.length > 0) {
    console.error("30-day rendering validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("30-day rendering validation passed.");
}

main();
