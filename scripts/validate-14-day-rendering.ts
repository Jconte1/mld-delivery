import type { OrderLineReadinessSummary } from "../lib/delivery-readiness/orderLineReadiness";
import {
  render14DayDeliveryReminderEmail,
  render14DayDeliveryReminderSms,
} from "../lib/notifications/deliveryReminder14Day";

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
    orderLineId: "line_14",
    lineNbr: 2,
    inventoryId: "RANGE-456",
    lineDescription: "Pro range",
    itemType: "S",
    itemClass: "APPLIANCE",
    requestedOn: "2026-08-10",
    eta: "2026-08-01",
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
    contactName: "James",
    buyerGroup: "Builder",
    jobName: "Jones Project",
    jobAddress: "456 State St, Salt Lake City UT",
    deliveryDate: "2026-08-10",
    detailsLink: "https://mld-delivery.example.test/delivery/details/dd_14_test",
    amountDueNowRounded: "225.75",
    lines: sampleLines,
    salespersonContact: {
      salespersonName: "Jane Seller",
      salespersonEmail: "jane.seller@example.test",
      salespersonPhone: "801-555-3434",
      isActive: true,
    },
  };

  const smsNoPayment = render14DayDeliveryReminderSms({
    ...baseParams,
    paymentDue: false,
  });
  const smsPayment = render14DayDeliveryReminderSms({
    ...baseParams,
    paymentDue: true,
  });
  const emailNoPayment = render14DayDeliveryReminderEmail({
    ...baseParams,
    paymentDue: false,
  });
  const emailPayment = render14DayDeliveryReminderEmail({
    ...baseParams,
    paymentDue: true,
  });

  assertIncludes(
    smsNoPayment,
    "Review delivery details here: https://mld-delivery.example.test/delivery/details/dd_14_test.",
    "14-day SMS includes readonly details link",
    failures
  );
  assertIncludes(
    smsPayment,
    "Payment may be needed before delivery. Please review details here:",
    "14-day SMS includes payment sentence only when due",
    failures
  );
  assertNotIncludes(
    smsNoPayment,
    "Payment may be needed before delivery",
    "14-day SMS omits payment sentence when no payment is due",
    failures
  );

  for (const forbidden of [
    "Confirm",
    "confirmed",
    "Y/N",
    "Reply Y",
    "Jane Seller",
    "RANGE-456",
    "Pro range",
    "Items For This Delivery",
    "payment request #1",
    "ACTION REQUIRED",
  ]) {
    assertNotIncludes(smsNoPayment, forbidden, `14-day SMS should not include ${forbidden}`, failures);
    assertNotIncludes(smsPayment, forbidden, `14-day SMS should not include ${forbidden}`, failures);
  }

  assertIncludes(
    emailNoPayment.subject,
    "Builder delivery reminder: Jones Project",
    "14-day email subject follows reminder pattern",
    failures
  );
  assertIncludes(
    emailNoPayment.body,
    "Review delivery details here: https://mld-delivery.example.test/delivery/details/dd_14_test",
    "14-day email body includes readonly details link",
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
      "Line 2: RANGE-456",
      "RANGE-456",
      "Pro range",
    ]) {
      assertNotIncludes(
        source,
        forbidden,
        `14-day ${label} should not include item details: ${forbidden}`,
        failures
      );
    }
  }
  assertIncludes(
    emailNoPayment.body,
    "To make a payment, for additional information, or to make changes to this order, please reach out to Jane Seller",
    "14-day email includes salesperson footer",
    failures
  );
  assertNotIncludes(
    emailNoPayment.body,
    "Balance owed prior to scheduling Delivery:",
    "14-day email omits payment wording when no payment is due",
    failures
  );
  assertIncludes(
    emailPayment.body,
    "Balance owed prior to scheduling Delivery: $225.75",
    "14-day email includes exact payment wording when due",
    failures
  );

  for (const forbidden of [
    "ACTION REQUIRED",
    "Confirm Delivery",
    "Request Different Date",
    "Reply Y",
    "Reply N",
    "payment request #1",
    "final notice",
    "first notice",
    "Acumatica writeback",
  ]) {
    assertNotIncludes(
      emailNoPayment.body,
      forbidden,
      `14-day email should not include ${forbidden}`,
      failures
    );
    assertNotIncludes(
      emailPayment.body,
      forbidden,
      `14-day email should not include ${forbidden}`,
      failures
    );
  }

  if (failures.length > 0) {
    console.error("14-day rendering validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("14-day rendering validation passed.");
}

main();
