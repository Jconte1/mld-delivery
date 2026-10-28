import assert from "node:assert/strict";
import { paymentLifecycleBlockReason, clearanceSourceAllowed, paymentIsCleared } from "../lib/notifications/paymentLifecycleEligibility";
import { checkPaymentWriteEligibility, paymentWriteAuthorized } from "../lib/notifications/paymentWriteEligibility";
import { evaluateDeliveryGroupPayment, type DeliveryGroupPaymentInput } from "../lib/delivery-payment/deliveryGroupPayment";

process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";

const paymentInput: DeliveryGroupPaymentInput = { orderDeliveryGroupId: "group", orderId: "order", orderType: "SO", orderNumber: "TEST",
  deliveryDate: "2030-01-15", paymentTerms: "PP", orderTotal: "500", unpaidBalance: "250", taxTotal: "0", taxDetails: [],
  activeOrderLineIds: ["line"], lines: [{ id: "line", lineNbr: 1, inventoryId: "TEST", lineDescription: "Test", itemType: "F",
    itemClass: "TEST", requestedOn: "2030-01-15", taxCategory: "EXEMPT", discountedUnitPrice: "500", orderQty: "1", openQty: "1",
    activeAllocatedQty: "1", readinessStatus: "ready" }] };

function fixture() {
  const contact = { contactId: "contact", firstName: "Test", lastName: "Customer", phone1: "8015550123", phone2: null,
    email: "test@example.invalid", smsOptIn: true, emailOptIn: true, smsOptOuts: [], emailOptOuts: [] };
  const order = { id: "order", orderType: "SO", orderNumber: "TEST", contactId: "contact", contact,
    confirmVia: "WEB", confirmWith: "Customer", acumaticaOneWeekConfirmed: false, primaryContactFetchSucceeded: true,
    status: "Open", internalLifecycleStatus: "ACTIVE", salespersonNumber: null, buyerGroup: "Appliances",
    customerDescription: "Test Customer", locationDescription: "Test Site", address: null,
    total: { paymentTerms: "PP", unpaidBalance: "250", orderTotal: "500" } };
  const group = { id: "group", orderId: "order", orderType: "SO", orderNumber: "TEST", isActive: true, status: "active",
    deliveryDate: new Date("2030-01-15T00:00:00Z"), order, deliveryGroupLines: [{ isActive: true }] };
  let optedOut = false;
  let evidence = false;
  const client = {
    order: { findUnique: async () => ({ ...order, deliveryGroups: [group] }) },
    orderDeliveryGroup: { findMany: async () => [group] },
    notificationEvent: { findUnique: async () => null, create: async () => { throw Error("Unexpected live event write"); } },
    notificationAttempt: { findMany: async () => evidence ? [{ channel: "SMS", realSmsOptIn: true, recipient: contact.phone1 }] : [] },
    smsOptOut: { findMany: async () => optedOut ? [{ phone: contact.phone1 }] : [] },
    emailOptOut: { findMany: async () => optedOut ? [{ email: contact.email }] : [] },
  };
  return { order, group, client, setOptOut: (v: boolean) => { optedOut = v; }, setEvidence: (v: boolean) => { evidence = v; } };
}

async function main() {
  assert.equal(paymentLifecycleBlockReason({ confirmVia: "WEB", confirmWith: "Name" }), null);
  for (const order of [{}, { confirmVia: "WEB" }, { confirmWith: "Name" }]) assert.equal(paymentLifecycleBlockReason(order), "six_week_confirmation_incomplete");
  assert.equal(paymentLifecycleBlockReason({ confirmVia: "WEB", confirmWith: "Name", acumaticaOneWeekConfirmed: true }), "one_week_confirmation_already_true");
  assert.equal(clearanceSourceAllowed("DAY_8"), false);
  assert.equal(paymentWriteAuthorized(null, "secret"), false);
  assert.equal(paymentWriteAuthorized("Bearer secret", undefined), false);
  assert.equal(paymentWriteAuthorized("Bearer wrong", "secret"), false);
  assert.equal(paymentWriteAuthorized("Bearer secret", "secret"), true);
  const request = { operation: "hold" as const, orderType: "SO", orderNumber: "TEST", contactId: "contact", deliveryDate: "2030-01-15",
    contact: { smsOptIn: true, emailOptIn: true, phone1: "8015550123", phone2: "", email: "test@example.invalid" } };
  const f = fixture();
  assert.equal((await checkPaymentWriteEligibility(request, f.client as never)).eligible, true);
  assert.equal((await checkPaymentWriteEligibility({ ...request, contact: { ...request.contact,
    smsOptIn: false, emailOptIn: false, phoneCallOptIn: true } }, f.client as never)).eligible, false);
  f.setOptOut(true);
  assert.equal((await checkPaymentWriteEligibility(request, f.client as never)).reason, "no_automated_channel_available");
  f.setOptOut(false);
  assert.equal((await checkPaymentWriteEligibility({ ...request, contactId: "old-contact" }, f.client as never)).eligible, false);
  assert.equal((await checkPaymentWriteEligibility({ ...request, operation: "clearance", sourceInterval: "DAY_8" }, f.client as never)).eligible, false);
  assert.equal((await checkPaymentWriteEligibility({ ...request, operation: "clearance", sourceInterval: "DAY_10" }, f.client as never)).eligible, false);
  f.setEvidence(true);
  assert.equal((await checkPaymentWriteEligibility({ ...request, operation: "clearance", sourceInterval: "DAY_10" }, f.client as never)).eligible, true);
  assert.equal((await checkPaymentWriteEligibility({ ...request, operation: "clearance", sourceInterval: "DAY_10",
    contact: { ...request.contact, phone1: "8015559999", email: "changed@example.invalid" } }, f.client as never)).eligible, false);
  f.order.acumaticaOneWeekConfirmed = true;
  assert.equal((await checkPaymentWriteEligibility(request, f.client as never)).reason, "one_week_confirmation_already_true");

  const twelve = await import("../lib/notifications/create12DayDeliveryPaymentRequestEvents");
  const ten = await import("../lib/notifications/create10DayDeliveryPaymentRequestEvents");
  const { create14DayDeliveryReminderEvents } = await import("../lib/notifications/create14DayDeliveryReminderEvents");
  for (const [terms, balance] of [["PP", "250"], ["PP", "0"], ["NET30", "250"]]) {
    const state = fixture();
    const payment = evaluateDeliveryGroupPayment({ ...paymentInput, paymentTerms: terms, unpaidBalance: balance });
    const options = { runDate: "2030-01-01", dryRun: true, prismaClient: state.client as never,
      importSalesOrders: async () => ({ requestedOn: "2030-01-15", failedOrders: 0, errors: [],
        successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "TEST" }] }) as never,
      getPaymentEvaluation: async () => payment, getReadiness: async () => ({ lines: [] }) as never,
      getSalespersonContactMap: async () => new Map() };
    const result = await create14DayDeliveryReminderEvents(options);
    assert.equal(result.eventsWouldCreate, 1, JSON.stringify(result));
    assert.equal(result.eventReports[0].paymentReminderApplies, terms === "PP" && balance === "250");
    state.order.acumaticaOneWeekConfirmed = true;
    assert.equal((await create14DayDeliveryReminderEvents(options)).skippedReasons.one_week_confirmation_already_true, 1);
    state.order.acumaticaOneWeekConfirmed = false; state.order.confirmWith = "";
    assert.equal((await create14DayDeliveryReminderEvents(options)).skippedReasons.six_week_confirmation_incomplete, 1);
  }
  const { scheduledEventsForRun } = await import("./run-delivery-interval");
  for (const interval of ["12", "10"]) {
    let query: unknown;
    await scheduledEventsForRun({ config: { interval, intervalType: `DAY_${interval}`, actionType: "PAYMENT_REQUEST" } as never,
      runDate: "2030-01-03", targetDate: "2030-01-15", currentRunCreatedEventIds: ["new-catchup-event"] },
      { notificationEvent: { findMany: async (args: unknown) => { query = args; return []; } } } as never);
    const where = (query as { where: { id: unknown; actionType: unknown; status: unknown } }).where;
    assert.deepEqual(where.id, { in: ["new-catchup-event"] });
    assert.deepEqual(where.actionType, { in: ["PAYMENT_REQUEST", "DELIVERY_REMINDER"] });
    assert.equal(where.status, "SCHEDULED");
  }
  const { POST } = await import("../app/api/internal/delivery-payment-eligibility/route");
  const previousSecret = process.env.MLD_QUEUE_TOKEN;
  try {
    process.env.MLD_QUEUE_TOKEN = "isolated-secret";
    assert.equal((await POST(new Request("http://localhost/api/internal/delivery-payment-eligibility", { method: "POST" }))).status, 401);
    assert.equal((await POST(new Request("http://localhost/api/internal/delivery-payment-eligibility", {
      method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" }))).status, 401);
    assert.equal((await POST(new Request("http://localhost/api/internal/delivery-payment-eligibility", {
      method: "POST", headers: { Authorization: "Bearer isolated-secret" }, body: "{}" }))).status, 400);
  } finally { if (previousSecret === undefined) delete process.env.MLD_QUEUE_TOKEN; else process.env.MLD_QUEUE_TOKEN = previousSecret; }
  for (const [days, run] of [[12, twelve.create12DayDeliveryPaymentRequestEvents], [10, ten.create10DayDeliveryPaymentRequestEvents]] as const) {
    for (const [terms, balance, paid] of [["PP", "250", false], ["PP", "0", true], ["PP", "2", true], ["NET30", "250", true]] as const) {
      const state = fixture();
      const payment = evaluateDeliveryGroupPayment({ ...paymentInput, paymentTerms: terms, unpaidBalance: balance });
      assert.equal(paymentIsCleared(payment), paid);
      const options = { runDate: days === 12 ? "2030-01-03" : "2030-01-05", dryRun: true, prismaClient: state.client as never,
        importSalesOrders: async () => ({ requestedOn: "2030-01-15", failedOrders: 0, errors: [],
          successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "TEST" }] }) as never,
        getPaymentEvaluation: async () => payment, getReadiness: async () => ({ lines: [] }) as never,
        getSalespersonContactMap: async () => new Map() };
      const result = await run(options);
      assert.equal(result.eventsWouldCreate, 1, JSON.stringify(result));
      assert.equal(result.paymentDueCount, paid ? 0 : 1);
      const body = result.eventReports[0].renderedMessagePreview;
      if (paid) assert.doesNotMatch(body ?? "", /balance reminder|Balance owed|Payment may be needed/);
      else assert.match(body ?? "", /\$250\.00/);
      state.order.confirmWith = "";
      assert.equal((await run(options)).eventsWouldCreate, 1); // A skipped audit preview, not a scheduled send.
      assert.equal((await run(options)).eventReports[0].reasonSkipped, "six_week_confirmation_incomplete");
    }
  }
  console.log("Payment lifecycle passed: 14-day decisions, 12/10 paid and terms catch-up, unpaid requests, consent/opt-outs, both confirmations, source restrictions, current-run action filters and evidence. In-memory clients only; zero live DB/provider/ERP calls.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
