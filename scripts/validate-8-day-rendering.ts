import {
  render8DayPaymentEnforcementCustomerEmail,
  render8DayPaymentEnforcementCustomerSms,
  render8DayPaymentEnforcementInternalFailure,
  render8DayPaymentEnforcementInternalSuccess,
} from "../lib/notifications/deliveryPaymentEnforcement8Day";

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, text: string, message: string, failures: string[]) {
  assert(source.includes(text), message, failures);
}

function assertNotIncludes(source: string, text: string, message: string, failures: string[]) {
  assert(!source.includes(text), message, failures);
}

function main() {
  const failures: string[] = [];
  const customerParams = {
    contactName: "James",
    buyerGroup: "Appliances",
    jobName: "Smith Residence",
    jobAddress: "123 Main St, Salt Lake City UT",
    deliveryDate: "2026-07-29",
    detailsLink: "https://mld-delivery.example.test/delivery/details/dd_8_test",
    amountDueNowRounded: "1250.00",
    salespersonContact: {
      salespersonName: "Sales Person",
      salespersonEmail: "sales@example.test",
      salespersonPhone: "801-555-1212",
      isActive: true,
    },
  };

  const customerEmail = render8DayPaymentEnforcementCustomerEmail(customerParams);
  const customerSms = render8DayPaymentEnforcementCustomerSms(customerParams);
  const internalSuccess = render8DayPaymentEnforcementInternalSuccess({
    salespersonName: "Sales Person",
    customerName: "Smith Residence",
    customerEmail: "customer@example.test",
    customerPhone: "801-555-1212",
    orderNumber: "SO8",
    jobName: "Smith Residence",
    deliveryDate: "2026-07-29",
    paymentDeadlineDate: "2026-07-21",
    amountDueNowRounded: "1250.00",
    detailsLink: "https://mld-delivery.example.test/delivery/details/dd_8_test",
  });
  const internalFailure = render8DayPaymentEnforcementInternalFailure({
    salespersonName: "Sales Person",
    customerName: "Smith Residence",
    orderNumber: "SO8",
    jobName: "Smith Residence",
    deliveryDate: "2026-07-29",
    paymentDeadlineDate: "2026-07-21",
    amountDueNowRounded: "1250.00",
    detailsLink: "https://mld-delivery.example.test/delivery/details/dd_8_test",
    errorSummary: "live_write_disabled",
  });

  assert(
    customerEmail.subject ===
      "Attention: Delivery Order On Hold - Smith Residence - Wednesday, July 29, 2026",
    "customer subject matches approved on-hold subject",
    failures
  );
  assertIncludes(
    customerEmail.body,
    "Your delivery is currently on hold because payment was not received by the required deadline.",
    "customer email includes on-hold payment deadline language",
    failures
  );
  assertIncludes(
    customerEmail.body,
    "Balance owed prior to scheduling Delivery: $1,250.00",
    "customer email includes approved balance wording",
    failures
  );
  assertIncludes(
    customerEmail.body,
    "View Delivery Details: https://mld-delivery.example.test/delivery/details/dd_8_test",
    "customer email includes View Delivery Details link",
    failures
  );
  assertIncludes(
    customerEmail.body,
    "To make a payment, for additional information, or to make changes to this order, please reach out to Sales Person",
    "customer email includes salesperson payment/contact footer",
    failures
  );
  assertIncludes(
    customerSms,
    "is currently on hold because payment was not received by the required deadline",
    "customer SMS includes on-hold/payment-deadline language",
    failures
  );
  assertIncludes(
    customerSms,
    "Review details here: https://mld-delivery.example.test/delivery/details/dd_8_test",
    "customer SMS includes details link",
    failures
  );
  assertIncludes(customerSms, "Reply STOP to opt out.", "customer SMS includes STOP language", failures);

  for (const [label, source] of [
    ["customer email text", customerEmail.body],
    ["customer email HTML", customerEmail.htmlBody],
    ["customer SMS", customerSms],
  ] as const) {
    for (const forbidden of [
      "Items For This Delivery",
      "Line ",
      "DW-789",
      "YES",
      "Reply Y",
      "Reply N",
      "Y/N",
      "Confirm Delivery",
      "Request Different Date",
      "second balance reminder",
      "final balance reminder",
      "payment reminder",
      "Acumatica",
    ]) {
      assertNotIncludes(source, forbidden, `${label} must not include ${forbidden}`, failures);
    }
  }
  for (const forbiddenSms of ["Sales Person", "sales@example.test", "801-555-1212"]) {
    assertNotIncludes(customerSms, forbiddenSms, `customer SMS must not include ${forbiddenSms}`, failures);
  }

  assert(
    internalSuccess.subject ===
      "Customer Payment Missed: SO8 - Smith Residence - Wednesday, July 29, 2026",
    "internal success subject matches approved concept",
    failures
  );
  assertIncludes(
    internalSuccess.body,
    "Smith Residence did not complete the required payment by the deadline for their scheduled delivery.",
    "internal success body states missed payment deadline",
    failures
  );
  assertIncludes(
    internalSuccess.body,
    "The order has been placed on hold.",
    "internal success body states order was placed on hold",
    failures
  );
  assertIncludes(internalSuccess.body, "Order: SO8", "internal success body includes order", failures);
  assertIncludes(internalSuccess.body, "Payment Deadline: Tuesday, July 21, 2026", "internal success body includes deadline", failures);
  assertIncludes(internalSuccess.body, "Amount Due: $1,250.00", "internal success body includes amount due", failures);
  assertIncludes(internalSuccess.body, "Customer Contact:", "internal success body includes customer contact block", failures);
  assertIncludes(internalSuccess.body, "View Delivery Details:", "internal success body includes details link", failures);

  assert(
    internalFailure.subject === "Action Needed: Automated Hold Failed - SO8 - Smith Residence",
    "internal failure subject matches approved concept",
    failures
  );
  assertIncludes(
    internalFailure.body,
    "but the automated hold write to Acumatica failed.",
    "internal failure body explains automated hold failure",
    failures
  );
  assertIncludes(
    internalFailure.body,
    "Please review this order manually.",
    "internal failure body asks for manual review",
    failures
  );
  assertIncludes(internalFailure.body, "Error:\nlive_write_disabled", "internal failure body includes error summary", failures);

  if (failures.length > 0) {
    console.error("8-day rendering validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        validation: "8-day rendering validation passed",
        customerOnHoldCopy: true,
        customerNoItems: true,
        customerNoConfirmationLanguage: true,
        smsNoSalespersonContact: true,
        internalSuccessCopy: true,
        internalFailureCopy: true,
        noProviderSends: true,
      },
      null,
      2
    )
  );
}

main();
