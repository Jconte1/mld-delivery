import {
  render2DayDeliveryReminderEmail,
  render2DayDeliveryReminderSms,
} from "../lib/notifications/deliveryReminder2Day";

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, text: string, message: string, failures: string[]) {
  assert(source.includes(text), message, failures);
}

function assertNotIncludes(source: string, text: string, message: string, failures: string[]) {
  assert(!source.includes(text), message, failures);
}

function assertNoForbidden(source: string, label: string, failures: string[]) {
  for (const forbidden of [
    "To make a payment",
    "Balance owed prior to scheduling Delivery",
    "Payment may be needed",
    "payment deadline",
    "Your balance must be handled by",
    "Items For This Delivery",
    "ACTION REQUIRED",
    "Confirm Delivery",
    "Request Different Date",
    "Reply Y",
    "Reply N",
    "YES/NO",
    "hold",
    "enforcement",
    "final balance reminder",
    "second balance reminder",
  ]) {
    assertNotIncludes(source, forbidden, `2-day ${label} must not include ${forbidden}`, failures);
  }
}

function main() {
  const failures: string[] = [];
  const params = {
    orderNumber: "SO2",
    contactName: "James",
    buyerGroup: "Builder",
    jobName: "Jones Project",
    jobAddress: "456 State St, Salt Lake City UT",
    deliveryDate: "2026-08-10",
    detailsLink: "https://mld-delivery.example.test/delivery/details/dd_2_test",
    salespersonContact: {
      salespersonName: "Jane Seller",
      salespersonEmail: "jane.seller@example.test",
      salespersonPhone: "8015553434",
      isActive: true,
    },
  };

  const sms = render2DayDeliveryReminderSms(params);
  const email = render2DayDeliveryReminderEmail(params);
  const emailWithoutSalesperson = render2DayDeliveryReminderEmail({
    ...params,
    salespersonContact: null,
  });

  assertIncludes(
    email.subject,
    "Final Delivery Reminder: Builder delivery - Jones Project - Monday, August 10, 2026",
    "2-day subject starts with final delivery reminder and includes delivery date",
    failures
  );
  assertIncludes(
    email.body,
    "Order: SO2",
    "2-day email includes order number",
    failures
  );
  assertIncludes(
    email.body,
    "This is your final reminder",
    "2-day email says this is the final reminder",
    failures
  );
  assertIncludes(
    email.body,
    "Monday, August 10, 2026",
    "2-day email includes scheduled delivery date",
    failures
  );
  assertIncludes(
    email.body,
    "View Delivery Details: https://mld-delivery.example.test/delivery/details/dd_2_test",
    "2-day email includes View Delivery Details link",
    failures
  );
  assertIncludes(
    email.htmlBody,
    ">View Delivery Details</a>",
    "2-day HTML email includes View Delivery Details link",
    failures
  );
  assertIncludes(
    email.body,
    "For additional information or to make changes to this order, please reach out to Jane Seller at 801-555-3434 or jane.seller@example.test.",
    "2-day email includes no-payment salesperson footer",
    failures
  );
  assertNotIncludes(
    emailWithoutSalesperson.body,
    "please reach out to",
    "2-day email gracefully omits salesperson footer when contact is missing",
    failures
  );
  assertIncludes(
    email.body,
    "Thank you,\nMLD",
    "2-day email closes with MLD signature",
    failures
  );

  assertIncludes(sms, "MLD: Order SO2:", "2-day SMS includes order number", failures);
  assertIncludes(sms, "Final reminder -", "2-day SMS says Final reminder", failures);
  assertIncludes(
    sms,
    "https://mld-delivery.example.test/delivery/details/dd_2_test",
    "2-day SMS includes details link",
    failures
  );
  assertIncludes(sms, "Reply STOP to opt out.", "2-day SMS includes STOP language", failures);

  for (const [label, source] of [
    ["email subject", email.subject],
    ["email text body", email.body],
    ["email HTML body", email.htmlBody],
    ["SMS", sms],
  ] as const) {
    assertNoForbidden(source, label, failures);
  }

  for (const salespersonText of ["Jane Seller", "801-555-3434", "jane.seller@example.test"]) {
    assertNotIncludes(sms, salespersonText, `2-day SMS must not include ${salespersonText}`, failures);
  }

  for (const itemText of ["RANGE-456", "Pro range", "Line 2"]) {
    assertNotIncludes(email.body, itemText, `2-day email must not include item ${itemText}`, failures);
    assertNotIncludes(email.htmlBody, itemText, `2-day HTML email must not include item ${itemText}`, failures);
    assertNotIncludes(sms, itemText, `2-day SMS must not include item ${itemText}`, failures);
  }

  if (failures.length > 0) {
    console.error("2-day rendering validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("2-day rendering validation passed.");
}

main();
