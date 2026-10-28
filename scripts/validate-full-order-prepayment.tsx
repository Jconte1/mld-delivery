import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { evaluateDeliveryGroupPayment, type DeliveryGroupPaymentInput } from "../lib/delivery-payment/deliveryGroupPayment";
import { currentCustomerPaymentAmount, customerPaymentVisible } from "../lib/notifications/customerPaymentPresentation";
import { DeliveryPaymentSummary } from "../app/delivery/components/DeliveryPaymentSummary";
import { refreshDeliveryPaymentOrder } from "../lib/notifications/freshDeliveryPayment";
import type { DeliveryErpClient } from "../lib/erp/erpClient";

const input: DeliveryGroupPaymentInput = {
  orderDeliveryGroupId: "test-group", orderId: "test-order", orderType: "SO", orderNumber: "TEST",
  deliveryDate: "2030-01-15", paymentTerms: "PP", orderTotal: "50000", unpaidBalance: "25000",
  taxTotal: "0", taxDetails: [], activeOrderLineIds: ["current"],
  lines: [{ id: "current", lineNbr: 1, inventoryId: "TEST", lineDescription: "Test", itemType: "F",
    itemClass: "TEST", requestedOn: "2030-01-15", taxCategory: "EXEMPT", discountedUnitPrice: "5000",
    orderQty: "1", openQty: "1", activeAllocatedQty: "1", readinessStatus: "ready" }],
};
const evaluate = (patch: Partial<DeliveryGroupPaymentInput> = {}) => evaluateDeliveryGroupPayment({ ...input, ...patch });

async function main() {
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const { get12DayPaymentSkipReason } = await import("../lib/notifications/create12DayDeliveryPaymentRequestEvents");
  const { get10DayPaymentSkipReason } = await import("../lib/notifications/create10DayDeliveryPaymentRequestEvents");
  const { get8DayPaymentEnforcementSkipReason } = await import("../lib/notifications/create8DayPaymentEnforcementEvents");
  for (const paymentTerms of ["PIF", "PP", "PPP", "PPT"]) {
    assert.equal(evaluate({ paymentTerms }).amountDueNowRounded, "25000.00");
  }
  for (const unpaidBalance of ["0", "-100", "1.99", "2.00"]) {
    const payment = evaluate({ unpaidBalance });
    assert.equal(payment.paymentStatus, "no_balance_due");
    assert.equal(payment.amountDueNowRounded, "0.00");
  }
  assert.equal(evaluate({ unpaidBalance: "2.01" }).amountDueNowRounded, "2.01");
  assert.equal(evaluate({ unpaidBalance: "10000" }).amountDueNowRounded, "10000.00");
  assert.equal(evaluate({ unpaidBalance: "27000" }).amountDueNowRounded, "27000.00");
  assert.equal(evaluate({ orderTotal: null }).amountDueNowRounded, "25000.00");
  for (const unpaidBalance of [null, "", "invalid"]) {
    const payment = evaluate({ unpaidBalance });
    assert.equal(payment.paymentStatus, "calculation_blocked");
    assert.equal(payment.amountDueNowRounded, null);
  }
  assert.equal(evaluate({ paymentTerms: null }).paymentStatus, "calculation_blocked");
  assert.equal(evaluate({ paymentTerms: "NET30" }).paymentStatus, "not_applicable");
  const completed = { ...input.lines[0], id: "completed", lineNbr: 2, orderQty: "1", openQty: "0",
    readinessStatus: "complete", discountedUnitPrice: "10000" };
  assert.equal(evaluate({ lines: [...input.lines, completed] }).amountDueNowRounded, "25000.00");
  assert.equal(evaluate().depositCoversCurrentDelivery, null);
  assert.equal(evaluate().requiredDownOnRemaining, null);

  const unavailable = evaluate({ lines: [{ ...input.lines[0], readinessStatus: "backordered", activeAllocatedQty: "0" }] });
  assert.equal(unavailable.amountDueNowRounded, "25000.00");
  assert.equal(unavailable.hasDeliverableItems, false);
  assert.throws(() => currentCustomerPaymentAmount(unavailable));
  for (const getReason of [get12DayPaymentSkipReason, get10DayPaymentSkipReason, get8DayPaymentEnforcementSkipReason]) {
    assert.equal(getReason({ hasOrderTotal: true, ...unavailable }), "no_deliverable_items");
    assert.equal(getReason({ hasOrderTotal: true, ...evaluate({ unpaidBalance: null }) }), "missing_unpaid_balance");
    assert.equal(getReason({ hasOrderTotal: true, ...evaluate() }), null);
  }
  const mixed = evaluate({ lines: [...input.lines, { ...completed, openQty: "1", readinessStatus: "backordered" }] });
  assert.equal(mixed.hasDeliverableItems, true);
  assert.equal(currentCustomerPaymentAmount(mixed), "25000.00");
  const taxUnknown = evaluate({ taxTotal: "100", taxDetails: [
    { taxId: "A", taxType: null, customerTaxZone: null, taxRate: "5", taxableAmount: "100", taxAmount: "5" },
    { taxId: "B", taxType: null, customerTaxZone: null, taxRate: "7", taxableAmount: "100", taxAmount: "7" },
  ], lines: [{ ...input.lines[0], taxCategory: "TAXABLE" }] });
  assert.equal(taxUnknown.amountDueNowRounded, "25000.00");
  assert.equal(taxUnknown.calculationWarnings.length, 0);
  assert.ok(taxUnknown.deliveryValueWarnings!.length > 0);
  const paid = evaluate({ unpaidBalance: "0" });
  assert.deepEqual([paid, evaluate({ unpaidBalance: "20" }), evaluate({ unpaidBalance: "75" })]
    .map(payment => payment.amountDueNowRounded), ["0.00", "20.00", "75.00"]);
  const html = renderToStaticMarkup(<DeliveryPaymentSummary payment={evaluate()} />);
  assert.ok(html.includes("$25,000.00"));
  assert.ok(html.includes("including items"));
  assert.ok(!html.includes("will not be asked to pay"));
  assert.ok(!renderToStaticMarkup(<DeliveryPaymentSummary payment={unavailable} />).includes("Balance owed prior"));
  for (const interval of ["DAY_42", "DAY_41", "DAY_40", "DAY_39", "DAY_2"]) assert.equal(customerPaymentVisible(interval), false);

  const scopes: string[] = [];
  const erp: DeliveryErpClient = {
    fetchQualifyingSalesOrdersByLineRequestedOn: async () => { throw Error("broad discovery forbidden"); },
    fetchDeliverySalesOrderByOrderNumber: async (number, type) => { scopes.push(`${type}/${number}`); return []; },
    fetchDeliveryContactByContactId: async () => [],
  };
  const scope = { orderType: "SO", orderNumber: "TEST", deliveryDate: "2030-01-15" };
  await refreshDeliveryPaymentOrder(scope, { erpClient: erp, importOrders: async (_, options) => {
    assert.deepEqual(await options!.erpClient!.fetchQualifyingSalesOrdersByLineRequestedOn(scope.deliveryDate), []);
    assert.deepEqual(options!.orderLookups, [{ orderType: "SO", orderNumber: "TEST" }]);
    await options!.erpClient!.fetchDeliverySalesOrderByOrderNumber("TEST", "SO");
    return { successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "TEST" }], failedOrders: 0, errors: [] } as never;
  } });
  assert.deepEqual(scopes, ["SO/TEST"]);
  for (const result of [{ successfullyRefreshedOrders: [], failedOrders: 1, errors: [] },
    { successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "OTHER" }], failedOrders: 0, errors: [] }]) {
    await assert.rejects(refreshDeliveryPaymentOrder(scope, { erpClient: erp,
      importOrders: async () => result as never }), /fresh_payment_import_failed/);
  }
  await assert.rejects(refreshDeliveryPaymentOrder(scope, { erpClient: erp,
    importOrders: async () => { throw Error("ERP unavailable"); } }), /ERP unavailable/);
  await validateDispatchRefresh();
  console.log("Full-order prepayment passed: balances, readiness separation, mixed orders, payment copy, threshold, fresh dispatch and refresh failures. No live database/provider/ERP calls.");
}

async function validateDispatchRefresh() {
  const { dispatchDeliveryNotifications } = await import("../lib/notifications/deliveryNotificationDispatcher");
  process.env.DELIVERY_APP_BASE_URL = "https://delivery.example.invalid";
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", USE_QUEUE_ERP: "true", MLD_QUEUE_BASE_URL: "https://queue.invalid",
    MLD_QUEUE_TOKEN: "mock", DELIVERY_REAL_CUSTOMER_SEND_ENABLED: "true", DELIVERY_APP_BASE_URL: "https://delivery.example.invalid",
    TWILIO_ACCOUNT_SID: "mock", TWILIO_AUTH_TOKEN: "mock", TWILIO_MESSAGING_SERVICE_SID: "mock",
    MS_GRAPH_TENANT_ID: "mock", MS_GRAPH_CLIENT_ID: "mock", MS_GRAPH_CLIENT_SECRET: "mock", MS_GRAPH_FROM_EMAIL: "mock@example.invalid" };
  for (const scenario of ["paid", "changed", "unavailable", "refresh_failed", "moved", "fallback_paid", "paid_catchup", "due_catchup", "paid_enforcement"] as const) {
    let balance = "25000";
    let status = "SCHEDULED";
    let readinessStatus = "ready";
    let groupDate = new Date("2030-01-15T00:00:00Z");
    let attempts = 0;
    const messages: string[] = [];
    const contact = { contactId: "contact", firstName: "Test", lastName: "Customer", email: "customer@example.invalid",
      phone1: scenario === "fallback_paid" ? "+18015551234" : null, phone2: null,
      smsOptIn: scenario === "fallback_paid", emailOptIn: true, smsOptOuts: [], emailOptOuts: [] };
    const order = { id: "test-order", orderType: "SO", orderNumber: "TEST", contactId: "contact", contact,
      status: "Open", internalLifecycleStatus: "ACTIVE", primaryContactFetchSucceeded: true,
      confirmVia: "WEBPAGE", confirmWith: "Customer",
      acumaticaOneWeekConfirmed: false, buyerGroup: "Appliances", customerDescription: "Test", locationDescription: "Test Site",
      salespersonNumber: null, address: { addressLine1: "1 Test St", city: "Test", state: "UT", country: "US", postalCode: "84000" } };
    const group = () => ({ id: "test-group", orderId: order.id, orderType: "SO", orderNumber: "TEST", isActive: true,
      deliveryDate: groupDate, status: "active", deliveryGroupLines: [{ orderLineId: "current", deliveryDate: groupDate,
        orderLine: { requestedOn: groupDate } }], order: { ...order, total: { orderTotal: "50000", unpaidBalance: balance,
        taxTotal: "0", paymentTerms: "PP" }, lines: [{ ...input.lines[0], readinessStatus }], taxDetails: [], deliveryGroupPaymentChargeAllocations: [] } });
    const event = () => ({ id: "event", status, orderId: order.id, orderType: "SO", orderNumber: "TEST", deliveryGroupId: "test-group",
      deliveryDate: new Date("2030-01-15T00:00:00Z"), intervalType: scenario === "paid_enforcement" ? "DAY_8" : "DAY_12",
      actionType: scenario === "paid_enforcement" ? "PAYMENT_ENFORCEMENT" : scenario.endsWith("catchup") ? "DELIVERY_REMINDER" : "PAYMENT_REQUEST", selectedChannel: "EMAIL",
      contactId: "contact", contact, order, orderDeliveryGroup: group(), detailsLink: { token: "mock-token" },
      deliveryConfirmations: [], attempts: [], paymentEnforcementHoldActions: [] });
    const client = {
      notificationEvent: {
        findMany: async () => [event()], findUnique: async () => event(),
        updateMany: async () => { status = "PENDING"; return { count: 1 }; },
        update: async ({ data }: { data: { status: string } }) => { status = data.status; return event(); },
      },
      orderDeliveryGroup: { findUnique: async () => group() },
      notificationAttempt: { findFirst: async () => null, create: async () => { attempts++; return { id: "attempt", attemptNumber: 1 }; },
        update: async () => ({}) },
      deliveryGroupTenDayConfirmation: { findUnique: async () => null, upsert: async () => ({}) },
      salespersonContact: { findMany: async () => [] },
      smsOptOut: { findMany: async () => [] }, emailOptOut: { findMany: async () => [] },
    };
    let refreshed = 0;
    const result = await dispatchDeliveryNotifications({ send: true, testRunId: "payment-unit-test", eventId: "event", env,
      prismaClient: client as never, refreshPaymentOrder: async () => {
        refreshed++;
        if (scenario === "paid" || scenario === "paid_catchup" || scenario === "paid_enforcement") balance = "0";
        if (scenario === "fallback_paid" && refreshed === 2) balance = "0";
        if (scenario === "changed") balance = "10000";
        if (scenario === "unavailable") readinessStatus = "backordered";
        if (scenario === "moved") groupDate = new Date("2030-01-16T00:00:00Z");
        if (scenario === "refresh_failed") throw Error("mock ERP unavailable");
      },
      provider: { sendSms: async () => { throw Error("mock SMS rejected"); }, sendEmail: async (message: { textBody: string }) => {
        messages.push(message.textBody); return { provider: "ms_graph", externalMessageId: "mock-mail", providerCode: "ACCEPTED", httpStatus: 202 };
      } } as never,
    });
    assert.equal(refreshed, scenario === "fallback_paid" ? 2 : 1);
    if (scenario === "paid_catchup") {
      assert.equal(result.submitted, 1, JSON.stringify(result.reports));
      assert.equal(attempts, 1);
      assert.doesNotMatch(messages[0], /Balance owed|balance reminder|Payment may be needed/);
    } else if (scenario === "changed") {
      assert.equal(result.submitted, 1, JSON.stringify(result.reports));
      assert.equal(attempts, 1);
      assert.ok(messages[0].includes("$10,000.00"));
      assert.ok(!messages[0].includes("$25,000.00"));
    } else {
      assert.equal(result.skipped, 1, JSON.stringify(result.reports));
      assert.equal(attempts, scenario === "fallback_paid" ? 1 : 0);
      assert.equal(messages.length, 0);
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
