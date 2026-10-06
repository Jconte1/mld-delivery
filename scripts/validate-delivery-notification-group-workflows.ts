import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type NotificationIntervalType } from "../lib/generated/prisma/client";
import { buildDeliveryConfirmationAttributeWritebackPayload } from "../lib/notifications/deliveryConfirmationAttributeWritebackQueue";
import { buildDeliveryRequestedDateWritebackPayload } from "../lib/notifications/deliveryRequestedDateWritebackQueue";
import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";

async function main() {
  const value = process.env.TEST_DELIVERY_GROUP_DATABASE_URL;
  if (!value) throw new Error("Explicit isolated TEST_DELIVERY_GROUP_DATABASE_URL required");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/delivery_group_validation") || url.search) throw new Error("Only isolated loopback database allowed");
  process.env.DATABASE_URL = value;
  const { prepareFreshDeliveryIntervalImport } = await import("../lib/notifications/freshDeliveryIntervalImport");
  process.env.DELIVERY_APP_BASE_URL = "https://delivery.invalid/delivery";
  globalThis.fetch = async () => { throw new Error("network_forbidden_in_group_validation"); };
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: value }) });
  const { dispatchGroupedDeliveryNotifications } = await import("../lib/notifications/deliveryNotificationDispatcher");
  const { respondToNotificationGroup, loadCustomerNotificationGroup, groupCustomerStateError } = await import("../lib/notifications/deliveryNotificationGroupCustomer");
  const { handleTwilioInboundSms } = await import("../lib/notifications/handleTwilioInboundSms");
  const { hasQualifyingTenDayNotification, evaluateAndRecordDeliveryTenDayConfirmation } = await import("../lib/notifications/deliveryTenDayConfirmation");
  const { getDeliveryGroupPaymentEvaluation } = await import("../lib/delivery-payment/deliveryGroupPayment");
  const { buildNotificationDedupeKey } = await import("../lib/notifications/helpers");
  const { resolveDeliveryConfirmationTouchHistory, chooseDeliveryConfirmationNoResponseAction, buildDeliveryConfirmationReminderDedupeKey } = await import("../lib/notifications/deliveryConfirmationNoResponse");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", USE_QUEUE_ERP: "true", MLD_QUEUE_BASE_URL: "https://queue.invalid", MLD_QUEUE_TOKEN: "test",
    DELIVERY_APP_BASE_URL: "https://delivery.invalid/delivery", TWILIO_ACCOUNT_SID: "test", TWILIO_AUTH_TOKEN: "test", TWILIO_MESSAGING_SERVICE_SID: "test",
    MS_GRAPH_TENANT_ID: "test", MS_GRAPH_CLIENT_ID: "test", MS_GRAPH_CLIENT_SECRET: "test", MS_GRAPH_FROM_EMAIL: "test@example.invalid" };
  let simulatedSends = 0;
  let simulatedJobs = 0;
  const date = new Date("2030-01-07T00:00:00Z");
  const ports = { refresh: async () => {},
    confirm: async (input: Parameters<typeof buildDeliveryConfirmationAttributeWritebackPayload>[0]) => {
      simulatedJobs++; return { jobId: randomUUID(), payload: buildDeliveryConfirmationAttributeWritebackPayload(input) };
    },
    requestDate: async (input: Parameters<typeof buildDeliveryRequestedDateWritebackPayload>[0]) => {
      assert.deepEqual(input.lineNumbers, [1]); simulatedJobs++;
      return { jobId: randomUUID(), payload: buildDeliveryRequestedDateWritebackPayload(input) };
    },
  };
  let sequence = Math.floor(Math.random() * 9000000) + 1000000;
  const fixture = async (interval: NotificationIntervalType = "DAY_42", sms = false, mixedPayment = false) => {
    const runStartedAt = new Date();
    const prefix = randomUUID();
    const phone = `+1202${sequence++}`;
    const contact = await db.contact.create({ data: { contactId: prefix, firstName: "Test", lastName: "Conte",
      email: `${prefix}@example.invalid`, phone1: phone, smsOptIn: sms, emailOptIn: !sms } });
    const primary = interval === "DAY_2" ? await db.contact.create({ data: { contactId: `${prefix}-primary`,
      lastName: "Conte", email: `primary-${prefix}@example.invalid`, emailOptIn: true } }) : contact;
    const events = [];
    for (let n = 0; n < (mixedPayment ? 3 : 2); n++) {
      const order = await db.order.create({ data: { orderType: "TEST", orderNumber: `${prefix}-${n}`, status: "Open", contactId: primary.contactId,
        primaryContactFetchSucceeded: true,
        ...(interval === "DAY_2" ? { deliveryContactId: contact.contactId, deliveryContactSyncStatus: "fetched" } : {}),
        lastSyncedAt: new Date(), address: { create: { addressLine1: "1 Test St", city: "Salt Lake City", state: "UT", postalCode: "84101", country: "US" } },
        total: { create: { orderNumber: `${prefix}-${n}`, paymentTerms: mixedPayment && n > 0 ? "PP" : "N30NODEP",
          orderTotal: 100, unpaidBalance: mixedPayment && n === 1 ? 0 : 100, taxTotal: 0 } } } });
      const delivery = await db.orderDeliveryGroup.create({ data: { orderId: order.id, orderType: order.orderType, orderNumber: order.orderNumber, deliveryDate: date } });
      const line = await db.orderLine.create({ data: { orderId: order.id, orderType: order.orderType, orderNumber: order.orderNumber, lineNbr: 1,
        inventoryId: "TEST", itemType: "F", taxCategory: "EXEMPT", requestedOn: date, orderQty: 1, openQty: 1,
        discountedUnitPrice: 100, activeAllocatedQty: 1, allocationStatus: "allocated", readinessStatus: "ready", displayStatus: "Ready" } });
      await db.orderDeliveryGroupLine.create({ data: { orderDeliveryGroupId: delivery.id, orderLineId: line.id, orderId: order.id,
        orderType: order.orderType, orderNumber: order.orderNumber, lineNbr: 1, deliveryDate: date, lastSeenAt: new Date() } });
      const link = await db.deliveryDetailsLink.create({ data: { token: randomUUID(), orderId: order.id, orderDeliveryGroupId: delivery.id, deliveryDate: date } });
      const event = await db.notificationEvent.create({ data: { orderId: order.id, deliveryGroupId: delivery.id, contactId: contact.contactId,
        recipientContactRole: interval === "DAY_2" ? "DELIVERY" : "PRIMARY",
        orderType: order.orderType, orderNumber: order.orderNumber, deliveryDate: date, intervalType: interval,
        actionType: interval === "DAY_42" ? "DELIVERY_CONFIRMATION_REQUEST" : "DELIVERY_REMINDER", selectedChannel: sms ? "SMS" : "EMAIL",
        status: "SCHEDULED", dedupeKey: buildNotificationDedupeKey({ orderType: order.orderType, orderNumber: order.orderNumber,
          deliveryDate: date, intervalType: interval, actionType: interval === "DAY_42" ? "DELIVERY_CONFIRMATION_REQUEST" : "DELIVERY_REMINDER" }), detailsLinkId: link.id } });
      if (interval === "DAY_42") await db.deliveryConfirmation.create({ data: { orderId: order.id, deliveryGroupId: delivery.id, notificationEventId: event.id,
        orderType: order.orderType, orderNumber: order.orderNumber, deliveryDate: date, contactId: contact.contactId, linkToken: randomUUID(), status: "PENDING" } });
      events.push(event);
    }
    const importResult: ImportSalesOrdersResult = { requestedOn: date.toISOString(), successfullyRefreshedOrders: events,
      qualifyingOrdersFetched: 2, fullOrdersFetched: 2, contactsUpserted: 1, ordersCreated: 2, ordersUpdated: 0, totalsUpserted: 2,
      taxDetailsUpserted: 0, linesUpserted: 2, allocationsUpserted: 0, addressesUpserted: 2, deliveryGroupsUpserted: 2,
      deliveryGroupLinesUpserted: 2, deliveryGroupLinesCreated: 2, deliveryGroupLinesReactivated: 0, deliveryGroupLinesDeactivated: 0,
      deliveryGroupLinesExcludedNonStock: 0, deliveryGroupLinesExcludedService: 0, deliveryGroupLinesExcludedUnknownItemType: 0,
      deliveryGroupLinesExcludedMissingRequestedOn: 0, deliveryGroupLinesExcludedMissingDeliveryGroup: 0, changeEventsDetected: 0,
      changeEventsCreated: 0, changeEventsDeduped: 0, skippedOrders: 0, failedOrders: 0, errors: [] };
    const freshImport = await prepareFreshDeliveryIntervalImport({ targetDeliveryDate: date, dryRun: false, importSalesOrders: async () => importResult });
    const options = { env, prismaClient: db, currentRunEventIds: events.map(e => e.id), freshImport, runStartedAt, testRunId: prefix,
      provider: { sendEmail: async (input: { textBody: string; to: string }) => {
        if (interval === "DAY_2") assert.equal(input.to, contact.email);
        simulatedSends++; assert.ok(input.textBody.includes("/delivery/group/"));
        if (interval === "DAY_42") assert.ok(!/balance|payment|amount due/i.test(input.textBody));
        return { provider: "ms_graph" as const, externalMessageId: randomUUID(), providerCode: "accepted", httpStatus: 202 };
      }, sendSms: async (input: { body: string }) => {
        simulatedSends++; assert.ok(input.body.includes("/delivery/group/"));
        return { provider: "twilio" as const, externalMessageId: randomUUID(), providerCode: "queued", httpStatus: 201 };
      } } };
    const result = await dispatchGroupedDeliveryNotifications({ ...options, send: true });
    assert.equal(result.reports.length, 1); assert.equal(result.reports[0].outcome, "submitted");
    const group = await db.deliveryNotificationGroup.findUniqueOrThrow({ where: { id: result.reports[0].groupId! } });
    return { group, events, options, phone };
  };
  try {
    const twoDay = await fixture("DAY_2");
    const twoDayPage = await loadCustomerNotificationGroup(db, twoDay.group.linkToken);
    assert.equal(groupCustomerStateError(twoDayPage!), null);
    assert.equal(twoDay.group.contactId, twoDay.events[0].contactId);
    await db.order.update({ where: { id: twoDay.events[0].orderId }, data: { deliveryContactId: null } });
    assert.ok(groupCustomerStateError((await loadCustomerNotificationGroup(db, twoDay.group.linkToken))!));
    const callsBeforeStale = simulatedSends;
    const staleEvent = await db.notificationEvent.create({ data: {
      orderId: twoDay.events[0].orderId, deliveryGroupId: twoDay.events[0].deliveryGroupId,
      contactId: twoDay.events[0].contactId, recipientContactRole: "DELIVERY",
      orderType: twoDay.events[0].orderType, orderNumber: twoDay.events[0].orderNumber,
      deliveryDate: date, intervalType: "DAY_2", actionType: "DELIVERY_REMINDER",
      selectedChannel: "EMAIL", status: "SCHEDULED", dedupeKey: randomUUID(), detailsLinkId: twoDay.events[0].detailsLinkId,
    } });
    await assert.rejects(dispatchGroupedDeliveryNotifications({ ...twoDay.options, currentRunEventIds: [staleEvent.id], send: true }), /grouped_contact_changed/);
    assert.equal(simulatedSends, callsBeforeStale);
    const followUp = await fixture();
    const loadCandidate = async (groupId: string) => db.deliveryConfirmation.findUniqueOrThrow({
      where: { deliveryGroupId_deliveryDate: { deliveryGroupId: groupId, deliveryDate: date } },
      include: { orderDeliveryGroup: { include: { deliveryGroupLines: true, order: { include: { address: true, contact: true } } } }, notificationEvent: true },
    });
    const dayBefore = (days: number) => new Date(date.getTime() - days * 86400000);
    for (const touch of [2, 3] as const) {
      const ids = [];
      for (const original of followUp.events) {
        const candidate = await loadCandidate(original.deliveryGroupId);
        const history = await resolveDeliveryConfirmationTouchHistory({ client: db as never, candidate: candidate as never });
        assert.equal(history.completedTouchCount, touch - 1);
        const decision = chooseDeliveryConfirmationNoResponseAction({ runDate: dayBefore(43 - touch).toISOString().slice(0, 10), candidate: candidate as never, touchHistory: history });
        assert.equal(decision.customerAction, touch === 2 ? "SEND_REMINDER_1" : "SEND_REMINDER_2");
        const event = await db.notificationEvent.create({ data: { orderId: original.orderId, deliveryGroupId: original.deliveryGroupId,
          contactId: original.contactId, orderType: original.orderType, orderNumber: original.orderNumber, deliveryDate: date,
          intervalType: "DAY_42", actionType: "DELIVERY_CONFIRMATION_REMINDER", selectedChannel: "EMAIL", status: "SCHEDULED",
          dedupeKey: buildDeliveryConfirmationReminderDedupeKey({ confirmationId: candidate.id, orderType: original.orderType,
            orderNumber: original.orderNumber, deliveryDate: date, touchNumber: touch }) } });
        await db.deliveryConfirmation.update({ where: { id: candidate.id }, data: { notificationEventId: event.id } });
        ids.push(event.id);
      }
      const sent = await dispatchGroupedDeliveryNotifications({ ...followUp.options, currentRunEventIds: ids, send: true, now: dayBefore(43 - touch) });
      assert.equal(sent.reports[0].outcome, "submitted");
    }
    for (const event of followUp.events) {
      const candidate = await loadCandidate(event.deliveryGroupId);
      const history = await resolveDeliveryConfirmationTouchHistory({ client: db as never, candidate: candidate as never });
      assert.equal(history.completedTouchCount, 3);
      const decision = chooseDeliveryConfirmationNoResponseAction({ runDate: dayBefore(39).toISOString().slice(0, 10), candidate: candidate as never, touchHistory: history });
      assert.equal(decision.customerAction, null);
      assert.match(decision.action, /ESCALAT/);
    }

    const confirmed = await fixture();
    const response = await respondToNotificationGroup({ client: db, token: confirmed.group.linkToken, action: "CONFIRM", source: "WEBPAGE", ports });
    assert.equal(response.jobs.length, 2); assert.equal(response.outcome, "recorded");
    assert.equal(await db.deliveryConfirmation.count({ where: { orderId: { in: confirmed.events.map(e => e.orderId) }, status: "CONFIRMED", confirmationWritebackStatus: "queued" } }), 2);
    const jobsBefore = simulatedJobs;
    assert.equal((await respondToNotificationGroup({ client: db, token: confirmed.group.linkToken, action: "CONFIRM", source: "WEBPAGE", ports })).outcome, "already_recorded");
    assert.equal(simulatedJobs, jobsBefore);

    const changed = await fixture();
    await assert.rejects(respondToNotificationGroup({ client: db, token: changed.group.linkToken, action: "REQUEST_DATE", source: "WEBPAGE", requestedDate: "2030-01-07", ports }));
    assert.equal((await respondToNotificationGroup({ client: db, token: changed.group.linkToken, action: "REQUEST_DATE", source: "WEBPAGE", requestedDate: "2030-01-10", ports })).jobs.length, 2);
    const dates = await db.deliveryConfirmation.findMany({ where: { orderId: { in: changed.events.map(e => e.orderId) } } });
    assert.ok(dates.every(c => c.requestedNewDate?.toISOString().startsWith("2030-01-10") && c.requestedDateWritebackJobId));

    const stale = await fixture();
    await db.orderDeliveryGroup.update({ where: { id: stale.events[0].deliveryGroupId }, data: { deliveryDate: new Date("2030-01-08") } });
    await assert.rejects(respondToNotificationGroup({ client: db, token: stale.group.linkToken, action: "CONFIRM", source: "WEBPAGE", ports }), /membership_changed/);
    assert.equal(await db.deliveryConfirmation.count({ where: { orderId: { in: stale.events.map(e => e.orderId) }, status: "PENDING" } }), 2);

    const partial = await fixture(); let calls = 0;
    const partialResponse = await respondToNotificationGroup({ client: db, token: partial.group.linkToken, action: "CONFIRM", source: "WEBPAGE",
      ports: { ...ports, confirm: async input => { if (++calls === 1) throw new Error("simulated_queue_failure"); return ports.confirm(input); } } });
    assert.equal(partialResponse.outcome, "writeback_attention_required"); assert.equal(partialResponse.jobs.filter(j => j.error).length, 1);

    const sms = await fixture("DAY_42", true);
    const inbound = await handleTwilioInboundSms({ prismaClient: db, payload: { MessageSid: randomUUID(), From: sms.phone, To: "+12025550999", Body: "Y" }, groupResponsePorts: ports });
    assert.equal(inbound.matchStatus, "MATCHED"); assert.match(inbound.responseMessage!, /Thank you/);
    assert.equal(await db.deliveryConfirmation.count({ where: { orderId: { in: sms.events.map(e => e.orderId) }, status: "CONFIRMED" } }), 2);

    const smsDate = await fixture("DAY_42", true);
    const inboundPayload = { From: smsDate.phone, To: "+12025550999" };
    const beforeDateJobs = simulatedJobs;
    await handleTwilioInboundSms({ prismaClient: db, payload: { ...inboundPayload, MessageSid: randomUUID(), Body: "N" }, groupResponsePorts: ports });
    assert.equal(simulatedJobs, beforeDateJobs);
    assert.equal(await db.deliveryConfirmation.count({ where: { orderId: { in: smsDate.events.map(e => e.orderId) }, status: "AWAITING_NEW_DATE" } }), 2);
    const dateReply = await handleTwilioInboundSms({ prismaClient: db, payload: { ...inboundPayload, MessageSid: randomUUID(), Body: "01/10/2030" }, groupResponsePorts: ports });
    assert.equal(dateReply.matchStatus, "MATCHED");
    assert.equal(simulatedJobs, beforeDateJobs + 2);
    assert.equal(await db.deliveryConfirmation.count({ where: { orderId: { in: smsDate.events.map(e => e.orderId) }, status: "NEW_DATE_REQUESTED" } }), 2);

    const mixed = await fixture("DAY_14", false, true);
    let paymentWrites = 0;
    for (const [index, event] of mixed.events.entries()) {
      const deliveryGroup = await db.orderDeliveryGroup.findUniqueOrThrow({ where: { id: event.deliveryGroupId }, include: { order: true } });
      const payment = await getDeliveryGroupPaymentEvaluation(deliveryGroup.id, db);
      const evaluated = await evaluateAndRecordDeliveryTenDayConfirmation({ deliveryGroup, payment, sourceInterval: "DAY_14", prismaClient: db,
        enqueueWriteback: async () => { paymentWrites++; throw new Error("isolated_writeback_recorded_without_network"); } });
      assert.equal(evaluated.localCleared, index < 2);
      if (index === 2) assert.equal(payment.amountDueNowRounded, "100.00");
    }
    assert.equal(paymentWrites, 2);

    const pay = await fixture("DAY_14");
    for (const event of pay.events) {
      const group = await db.orderDeliveryGroup.findUniqueOrThrow({ where: { id: event.deliveryGroupId }, include: { order: true } });
      assert.equal(await hasQualifyingTenDayNotification(group, db), true);
    }
    await db.contact.update({ where: { contactId: pay.group.contactId }, data: { emailOptIn: false } });
    const delivery = await db.orderDeliveryGroup.findUniqueOrThrow({ where: { id: pay.events[0].deliveryGroupId }, include: { order: true } });
    assert.equal(await hasQualifyingTenDayNotification(delivery, db), false);
    assert.equal(await db.notificationAttempt.count(), 0);
    const loaded = await loadCustomerNotificationGroup(db, pay.group.linkToken);
    assert.equal(groupCustomerStateError(loaded!), null);
    console.log(JSON.stringify({ ok: true, simulatedSends, simulatedJobs, confirmationFanout: true, requestedDateFanout: true,
      duplicateResponseSafe: true, movedMemberBlocksAll: true, partialWritebackRecorded: true, smsGroupReply: true,
      paymentSendEvidence: true, mixedPaymentClearance: true, smsGroupDateReply: true,
      sharedThreeTouchLifecycle: true, providerCalls: 0, actualQueueJobs: 0, productionDatabaseUsed: false,
      pageFixtureToken: pay.group.linkToken, confirmationPageFixtureToken: followUp.group.linkToken }, null, 2));
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
