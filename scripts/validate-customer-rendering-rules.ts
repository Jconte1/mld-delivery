import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { OrderLineReadinessSummary } from "../lib/delivery-readiness/orderLineReadiness";
import {
  isFreightDeliveryChargeLine,
  type DeliveryPaymentLineInput,
} from "../lib/delivery-payment/deliveryGroupPayment";
import { NotificationIntervalType } from "../lib/generated/prisma/client";
import {
  deliveryItemEtaDisplay,
  deliveryItemStatusDisplay,
  shouldSuppressDeliveryItemCustomerEtaAndStatus,
} from "../app/delivery/components/DeliveryItemsForThisDelivery";
import { DeliveryPaymentSummary } from "../app/delivery/components/DeliveryPaymentSummary";
import { render42DayEmailConfirmationMessage } from "../lib/notifications/deliveryConfirmationEmail";
import { render42DaySmsConfirmationMessage } from "../lib/notifications/deliveryConfirmationSms";
import {
  render10DayDeliveryPaymentReminderEmail,
  render10DayDeliveryPaymentReminderSms,
} from "../lib/notifications/deliveryPaymentReminder10Day";
import {
  render12DayDeliveryPaymentReminderEmail,
  render12DayDeliveryPaymentReminderSms,
} from "../lib/notifications/deliveryPaymentReminder12Day";
import {
  render8DayPaymentEnforcementCustomerEmail,
  render8DayPaymentEnforcementCustomerSms,
} from "../lib/notifications/deliveryPaymentEnforcement8Day";
import {
  render14DayDeliveryReminderEmail,
  render14DayDeliveryReminderSms,
} from "../lib/notifications/deliveryReminder14Day";
import {
  render30DayDeliveryReminderEmail,
  render30DayDeliveryReminderSms,
} from "../lib/notifications/deliveryReminder30Day";
import {
  render2DayDeliveryReminderEmail,
  render2DayDeliveryReminderSms,
} from "../lib/notifications/deliveryReminder2Day";
import { renderDeliveryReminderEmailBody } from "../lib/notifications/deliveryReminderEmail";
import { renderDeliveryReminderMessage } from "../lib/notifications/helpers";

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, expected: string, message: string, failures: string[]) {
  assert(source.includes(expected), message, failures);
}

function assertNotIncludes(source: string, unexpected: string, message: string, failures: string[]) {
  assert(!source.includes(unexpected), message, failures);
}

function line(
  overrides: Partial<OrderLineReadinessSummary> & { lineNbr: number }
): OrderLineReadinessSummary {
  return {
    orderLineId: `line_${overrides.lineNbr}`,
    lineNbr: overrides.lineNbr,
    inventoryId: overrides.inventoryId ?? `ITEM-${overrides.lineNbr}`,
    lineDescription: overrides.lineDescription ?? `Fixture item ${overrides.lineNbr}`,
    itemType: overrides.itemType ?? "F",
    itemClass: overrides.itemClass ?? "TEST",
    requestedOn: overrides.requestedOn ?? "2026-08-10",
    eta: "eta" in overrides ? overrides.eta ?? null : "2026-08-08",
    orderQty: overrides.orderQty ?? 1,
    openQty: overrides.openQty ?? 1,
    activeAllocatedQty: overrides.activeAllocatedQty ?? 0,
    allocationStatus: overrides.allocationStatus ?? "not_allocated",
    etaStatus: overrides.etaStatus ?? "expected_on_time",
    readinessStatus: overrides.readinessStatus ?? "expected_on_time",
    readinessStatusBeforeExternalStock: overrides.readinessStatusBeforeExternalStock ?? null,
    externalStockReadinessMatched: overrides.externalStockReadinessMatched ?? false,
    displayStatus: overrides.displayStatus ?? "Expected on time",
    allocationCount: overrides.allocationCount ?? 0,
    allocationRowsCompact: overrides.allocationRowsCompact ?? [],
    activeAllocationCount: overrides.activeAllocationCount ?? 0,
    completedAllocationCount: overrides.completedAllocationCount ?? 0,
  };
}

function paymentLine(
  overrides: Partial<DeliveryPaymentLineInput> & { id: string; lineNbr: number }
): DeliveryPaymentLineInput {
  return {
    id: overrides.id,
    lineNbr: overrides.lineNbr,
    inventoryId: overrides.inventoryId ?? `ITEM-${overrides.lineNbr}`,
    lineDescription: overrides.lineDescription ?? `Fixture item ${overrides.lineNbr}`,
    itemType: overrides.itemType ?? "F",
    itemClass: overrides.itemClass ?? "TEST",
    requestedOn: overrides.requestedOn ?? "2026-08-10",
    taxCategory: overrides.taxCategory ?? "EXEMPT",
    discountedUnitPrice: overrides.discountedUnitPrice ?? "100.00",
    orderQty: overrides.orderQty ?? "1",
    openQty: overrides.openQty ?? "1",
  };
}

function validateCustomerMessages(failures: string[]) {
  const common = {
    orderNumber: "SO-CUST",
    contactName: "James",
    buyerGroup: "Appliance",
    jobName: "Smith Residence",
    jobAddress: "123 Main St, Salt Lake City UT",
    deliveryDate: "2026-08-10",
  };
  const detailsLink = "https://delivery.example.test/details/token";
  const confirmLink = "https://delivery.example.test/confirm/token";

  const proactiveMessages = [
    {
      label: "180",
      emailBody: renderDeliveryReminderEmailBody({
        ...common,
        intervalType: NotificationIntervalType.DAY_180,
      }),
      sms: renderDeliveryReminderMessage({
        ...common,
        intervalType: NotificationIntervalType.DAY_180,
      }),
    },
    {
      label: "90",
      emailBody: renderDeliveryReminderEmailBody({
        ...common,
        intervalType: NotificationIntervalType.DAY_90,
      }),
      sms: renderDeliveryReminderMessage({
        ...common,
        intervalType: NotificationIntervalType.DAY_90,
      }),
    },
    {
      label: "60",
      emailBody: renderDeliveryReminderEmailBody({
        ...common,
        intervalType: NotificationIntervalType.DAY_60,
      }),
      sms: renderDeliveryReminderMessage({
        ...common,
        intervalType: NotificationIntervalType.DAY_60,
      }),
    },
    {
      label: "42",
      emailBody: render42DayEmailConfirmationMessage({
        ...common,
        link: confirmLink,
      }).body,
      sms: render42DaySmsConfirmationMessage({
        ...common,
        link: confirmLink,
      }),
    },
    {
      label: "30",
      emailBody: render30DayDeliveryReminderEmail({
        ...common,
        detailsLink,
        paymentDue: false,
      }).body,
      sms: render30DayDeliveryReminderSms({
        ...common,
        detailsLink,
        paymentDue: false,
      }),
    },
    {
      label: "14",
      emailBody: render14DayDeliveryReminderEmail({
        ...common,
        detailsLink,
        paymentDue: false,
      }).body,
      sms: render14DayDeliveryReminderSms({
        ...common,
        detailsLink,
        paymentDue: false,
      }),
    },
    {
      label: "12",
      emailBody: render12DayDeliveryPaymentReminderEmail({
        ...common,
        detailsLink,
        amountDueNowRounded: "125.00",
      }).body,
      sms: render12DayDeliveryPaymentReminderSms({
        ...common,
        detailsLink,
        amountDueNowRounded: "125.00",
      }),
    },
    {
      label: "10",
      emailBody: render10DayDeliveryPaymentReminderEmail({
        ...common,
        detailsLink,
        amountDueNowRounded: "125.00",
      }).body,
      sms: render10DayDeliveryPaymentReminderSms({
        ...common,
        detailsLink,
        amountDueNowRounded: "125.00",
      }),
    },
    {
      label: "8",
      emailBody: render8DayPaymentEnforcementCustomerEmail({
        ...common,
        detailsLink,
        amountDueNowRounded: "125.00",
      }).body,
      sms: render8DayPaymentEnforcementCustomerSms({
        ...common,
        detailsLink,
        amountDueNowRounded: "125.00",
      }),
    },
    {
      label: "2",
      emailBody: render2DayDeliveryReminderEmail({
        ...common,
        detailsLink,
      }).body,
      sms: render2DayDeliveryReminderSms({
        ...common,
        detailsLink,
      }),
    },
  ];

  for (const message of proactiveMessages) {
    assertIncludes(
      message.emailBody,
      "Order: SO-CUST",
      `${message.label}-day customer email includes order number`,
      failures
    );
    assertIncludes(
      message.sms,
      "MLD: Order SO-CUST:",
      `${message.label}-day customer SMS includes order number`,
      failures
    );
  }

  for (const message of proactiveMessages.filter((candidate) => candidate.label !== "180" && candidate.label !== "90" && candidate.label !== "60")) {
    assertIncludes(
      message.sms,
      "Reply STOP to opt out.",
      `${message.label}-day customer SMS keeps STOP language`,
      failures
    );
  }

  const wyomingSms = render42DaySmsConfirmationMessage({
    ...common,
    link: confirmLink,
    deliveryAddress: { state: "WY", postalCode: "82001" },
  });
  const mccallSms = render42DaySmsConfirmationMessage({
    ...common,
    link: confirmLink,
    deliveryAddress: { state: "ID", postalCode: "83638" },
  });
  assertIncludes(
    wyomingSms,
    "Wyoming deliveries are available on Tuesdays only.",
    "42-day Wyoming SMS route note remains",
    failures
  );
  assertIncludes(
    mccallSms,
    "McCall deliveries are available on Mondays only.",
    "42-day McCall SMS route note remains",
    failures
  );
}

function validatePaymentSummary(failures: string[]) {
  const nonPrepayMarkup = renderToStaticMarkup(
    React.createElement(DeliveryPaymentSummary, {
      payment: {
        paymentApplicabilityStatus: "not_applicable_terms",
        paymentStatus: "not_applicable",
        amountDueNowRounded: "500.00",
        unpaidBalance: "500.00",
        calculationWarnings: [],
      },
    })
  );
  for (const forbidden of [
    "Balance owed",
    "Unpaid balance",
    "Balance owed prior to scheduling Delivery",
    "$500.00",
  ]) {
    assertNotIncludes(
      nonPrepayMarkup,
      forbidden,
      `non-prepay webpage payment summary hides ${forbidden}`,
      failures
    );
  }

  const prepayMarkup = renderToStaticMarkup(
    React.createElement(DeliveryPaymentSummary, {
      payment: {
        paymentApplicabilityStatus: "applicable",
        paymentStatus: "balance_due",
        amountDueNowRounded: "100.00",
        unpaidBalance: "500.00",
        calculationWarnings: [],
      },
    })
  );
  assertIncludes(
    prepayMarkup,
    "Balance owed prior to scheduling Delivery",
    "prepay webpage payment summary still shows positive due label",
    failures
  );
  assertIncludes(
    prepayMarkup,
    "$100.00",
    "prepay webpage payment summary still shows positive amount due",
    failures
  );
  assertIncludes(
    prepayMarkup,
    "Unpaid balance",
    "prepay webpage payment summary still shows unpaid balance",
    failures
  );

  const thresholdMarkup = renderToStaticMarkup(
    React.createElement(DeliveryPaymentSummary, {
      payment: {
        paymentApplicabilityStatus: "applicable",
        paymentStatus: "balance_due",
        amountDueNowRounded: "2.00",
        unpaidBalance: "-1.00",
        calculationWarnings: [],
      },
    })
  );
  assertNotIncludes(
    thresholdMarkup,
    "Balance owed prior to scheduling Delivery",
    "threshold-insignificant due amount remains hidden",
    failures
  );
  assertNotIncludes(
    thresholdMarkup,
    "Unpaid balance",
    "negative unpaid balance remains hidden",
    failures
  );
}

function validateItemDisplay(failures: string[]) {
  const ready = line({
    lineNbr: 1,
    eta: null,
    etaStatus: "ready",
    readinessStatus: "ready",
    displayStatus: "Ready",
  });
  const complete = line({
    lineNbr: 2,
    eta: "2026-08-08",
    etaStatus: "complete",
    readinessStatus: "complete",
    displayStatus: "Complete",
  });
  const pending = line({
    lineNbr: 3,
    eta: null,
    etaStatus: "eta_pending",
    readinessStatus: "eta_pending",
    displayStatus: "ETA pending",
  });
  const backordered = line({
    lineNbr: 4,
    eta: "2026-09-01",
    etaStatus: "backordered",
    readinessStatus: "backordered",
    displayStatus: "Backordered",
  });

  assert(deliveryItemEtaDisplay(ready) === "-", "Ready item ETA renders dash", failures);
  assert(deliveryItemStatusDisplay(ready) === "Ready", "Ready item status remains Ready", failures);
  assert(deliveryItemEtaDisplay(complete) === "-", "Complete item ETA renders dash", failures);
  assert(
    deliveryItemStatusDisplay(complete) === "Complete",
    "Complete item status remains Complete",
    failures
  );
  assert(deliveryItemEtaDisplay(pending) === "Pending", "ETA pending item remains Pending", failures);
  assert(deliveryItemEtaDisplay(backordered) === "2026-09-01", "Backordered ETA remains date", failures);

  for (const special of [
    line({ lineNbr: 5, inventoryId: "STORAGE-FEE", displayStatus: "Ready", readinessStatus: "ready" }),
    line({ lineNbr: 6, inventoryId: "Delivery-Charge", displayStatus: "Ready", readinessStatus: "ready" }),
    line({ lineNbr: 7, inventoryId: "INSTALL", displayStatus: "Ready", readinessStatus: "ready" }),
  ]) {
    assert(
      shouldSuppressDeliveryItemCustomerEtaAndStatus(special),
      `special inventory ID line ${special.lineNbr} is detected case-insensitively`,
      failures
    );
    assert(deliveryItemEtaDisplay(special) === "-", `special inventory ID line ${special.lineNbr} ETA renders dash`, failures);
    assert(deliveryItemStatusDisplay(special) === "-", `special inventory ID line ${special.lineNbr} status renders dash`, failures);
  }

  for (const descriptionOnly of [
    line({ lineNbr: 8, inventoryId: "ABC123", lineDescription: "temporary storage" }),
    line({ lineNbr: 9, inventoryId: "ABC123", lineDescription: "white glove delivery" }),
    line({ lineNbr: 10, inventoryId: "ABC123", lineDescription: "final installation labor" }),
  ]) {
    assert(
      !shouldSuppressDeliveryItemCustomerEtaAndStatus(descriptionOnly),
      `description-only line ${descriptionOnly.lineNbr} does not trigger special display suppression`,
      failures
    );
    assert(
      deliveryItemEtaDisplay(descriptionOnly) === "2026-08-08",
      `description-only line ${descriptionOnly.lineNbr} keeps normal ETA display`,
      failures
    );
    assert(
      deliveryItemStatusDisplay(descriptionOnly) === "Expected on time",
      `description-only line ${descriptionOnly.lineNbr} keeps normal status display`,
      failures
    );
  }
}

function validatePaymentLogicSeparation(failures: string[]) {
  assert(
    isFreightDeliveryChargeLine(
      paymentLine({
        id: "delivery_charge",
        lineNbr: 1,
        itemType: "N",
        inventoryId: "DELIVERY-FEE",
      })
    ),
    "existing non-stock delivery payment charge matching remains",
    failures
  );
  assert(
    !isFreightDeliveryChargeLine(
      paymentLine({
        id: "install_charge",
        lineNbr: 2,
        itemType: "N",
        inventoryId: "INSTALL",
        lineDescription: "installation labor",
      })
    ),
    "install is not newly included in payment charge matching",
    failures
  );
  assert(
    !isFreightDeliveryChargeLine(
      paymentLine({
        id: "storage_charge",
        lineNbr: 3,
        itemType: "N",
        inventoryId: "STORAGE",
        lineDescription: "storage fee",
      })
    ),
    "storage is not newly included in payment charge matching",
    failures
  );
}

function main() {
  const failures: string[] = [];

  validateCustomerMessages(failures);
  validatePaymentSummary(failures);
  validateItemDisplay(failures);
  validatePaymentLogicSeparation(failures);

  if (failures.length > 0) {
    console.error("Customer rendering rules validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        validation: "customer rendering rules passed",
        customerEmailsIncludeOrderNumber: true,
        proactiveSmsIncludesOrderNumber: true,
        stopLanguagePreserved: true,
        wyomingMccallRouteNotesPreserved: true,
        nonPrepayBalanceDisplayHidden: true,
        prepayPositiveDueStillShown: true,
        readyCompleteEtaDash: true,
        specialItemWebDisplaySuppressedByInventoryId: ["storage", "delivery", "install"],
        descriptionOnlySpecialWordsDoNotSuppressItemDisplay: true,
        paymentLogicUnchangedForInstallStorage: true,
        noProviderSends: true,
        noAcumaticaWrites: true,
      },
      null,
      2
    )
  );
}

main();
