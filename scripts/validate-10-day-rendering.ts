import type { OrderLineReadinessSummary } from "../lib/delivery-readiness/orderLineReadiness";
import {
  render10DayDeliveryPaymentReminderEmail,
  render10DayDeliveryPaymentReminderSms,
} from "../lib/notifications/deliveryPaymentReminder10Day";

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
    orderLineId: "line_10",
    lineNbr: 3,
    inventoryId: "DW-789",
    lineDescription: "Panel ready dishwasher",
    itemType: "S",
    itemClass: "APPLIANCE",
    requestedOn: "2026-07-30",
    eta: "2026-07-15",
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
  const params = {
    contactName: "James",
    buyerGroup: "Appliances",
    jobName: "Smith Residence",
    jobAddress: "123 Main St, Salt Lake City UT",
    deliveryDate: "2026-07-30",
    detailsLink: "https://mld-delivery.example.test/delivery/details/dd_10_test",
    amountDueNowRounded: "1250.00",
    paymentDeadlineDate: "2026-07-22",
    lines: sampleLines,
    salespersonContact: {
      salespersonName: "Sales Person",
      salespersonEmail: "sales@example.test",
      salespersonPhone: "801-555-1212",
      isActive: true,
    },
  };

  const email = render10DayDeliveryPaymentReminderEmail(params);
  const sms = render10DayDeliveryPaymentReminderSms(params);

  assert(
    email.subject ===
      "Balance Reminder: Appliances delivery reminder: Smith Residence - Thursday, July 30, 2026",
    "10-day email subject prefixes existing reminder subject",
    failures
  );
  assertIncludes(
    email.body,
    "This is your final balance reminder.",
    "email includes required final balance reminder wording",
    failures
  );
  assertIncludes(
    email.body,
    "Balance owed prior to scheduling Delivery: $1,250.00",
    "email includes dynamic balance wording",
    failures
  );
  assertIncludes(
    email.body,
    "Your balance must be handled by Wednesday, July 22, 2026.",
    "email includes dynamic adjusted payment deadline",
    failures
  );
  for (const [label, source] of [
    ["email text body", email.body],
    ["email HTML body", email.htmlBody],
  ] as const) {
    for (const forbidden of [
      "Items For This Delivery",
      "Line 3: DW-789",
      "DW-789",
      "Panel ready dishwasher",
    ]) {
      assertNotIncludes(
        source,
        forbidden,
        `10-day ${label} should not include item details: ${forbidden}`,
        failures
      );
    }
  }
  assertIncludes(
    email.body,
    "Review delivery details here: https://mld-delivery.example.test/delivery/details/dd_10_test",
    "email includes readonly delivery details link",
    failures
  );
  assertIncludes(
    email.body,
    "To make a payment, for additional information, or to make changes to this order, please reach out to Sales Person",
    "email includes salesperson footer",
    failures
  );

  assertIncludes(
    sms,
    "Balance may be due before delivery. Please review details here: https://mld-delivery.example.test/delivery/details/dd_10_test.",
    "SMS includes short balance and details-link wording",
    failures
  );

  for (const forbidden of [
    "ACTION REQUIRED",
    "Confirm Delivery",
    "Request Different Date",
    "Reply Y",
    "Reply N",
    "Y/N",
    "Items For This Delivery",
    "second balance reminder",
    "final notice",
    "first notice",
    "Acumatica writeback",
  ]) {
    assertNotIncludes(email.body, forbidden, `email must not include ${forbidden}`, failures);
    assertNotIncludes(sms, forbidden, `SMS must not include ${forbidden}`, failures);
  }

  for (const forbiddenSms of ["Sales Person", "DW-789", "Panel ready dishwasher"]) {
    assertNotIncludes(sms, forbiddenSms, `SMS must not include ${forbiddenSms}`, failures);
  }

  if (failures.length > 0) {
    console.error("10-day rendering validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("10-day rendering validation passed.");
}

main();

