import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client";
import { claimDeliveryNotificationGroup, reconcileDeliveryNotificationGroupAttempt } from "../lib/notifications/deliveryNotificationGroupStore";
import { deliveryAddressGroupingKey, planDeliveryNotificationGroups, type GroupingCandidate } from "../lib/notifications/deliveryNotificationGrouping";
import type { DeliveryIntervalFreshImportResult } from "../lib/notifications/freshDeliveryIntervalImport";
import type { DeliveryNotificationProvider } from "../lib/notifications/deliveryNotificationProviders";
import { handleTwilioGroupMessageStatus } from "../lib/notifications/handleTwilioGroupMessageStatus";
import twilio from "twilio";
import { validateTwilioWebhookSignature } from "../lib/notifications/twilioWebhook";

async function main() {
  const value = process.env.TEST_DELIVERY_GROUP_DATABASE_URL;
  if (!value) throw new Error("TEST_DELIVERY_GROUP_DATABASE_URL required; DATABASE_URL is never used");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/delivery_group_validation") || url.search) {
    throw new Error("Only a dedicated loopback delivery_group_validation database is allowed");
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: value }) });
  process.env.DATABASE_URL = value;
  process.env.TWILIO_AUTH_TOKEN = "isolated-test-token";
  process.env.TWILIO_WEBHOOK_VALIDATE_SIGNATURES = "true";
  delete process.env.DELIVERY_APP_BASE_URL;
  const signaturePayload = { MessageSid: "SM-test", MessageStatus: "delivered" };
  const signedUrl = "https://delivery.invalid/api/webhooks/twilio/message-status?groupAttemptId=test";
  const signature = twilio.getExpectedTwilioSignature("isolated-test-token", signedUrl, signaturePayload);
  const headers = { "x-forwarded-host": "delivery.invalid", "x-forwarded-proto": "https", "x-twilio-signature": signature };
  assert.equal(validateTwilioWebhookSignature({ request: new Request(signedUrl, { headers }), payload: signaturePayload }).valid, true);
  assert.equal(validateTwilioWebhookSignature({ request: new Request(signedUrl + "-tampered", { headers }), payload: signaturePayload }).valid, false);
  process.env.DELIVERY_APP_BASE_URL = "https://delivery.invalid";
  assert.equal(validateTwilioWebhookSignature({ request: new Request(signedUrl, { headers }), payload: signaturePayload }).valid, true);
  const { dispatchGroupedDeliveryNotifications } = await import("../lib/notifications/deliveryNotificationDispatcher");
  try {
    const identity = await db.$queryRaw<{ name: string; addr: string }[]>`SELECT current_database() AS name, host(inet_server_addr()) AS addr`;
    assert.equal(identity[0].addr, "127.0.0.1");
    assert.ok(identity[0].name.startsWith("delivery_group_validation"));
    const fixture = async () => {
      const runId = `group-test-${randomUUID()}`;
      const contact = await db.contact.create({ data: { contactId: runId, email: "test@example.invalid", emailOptIn: true } });
      const candidates: GroupingCandidate[] = [];
      for (let i = 0; i < 2; i++) {
        const order = await db.order.create({ data: { orderType: "TEST", orderNumber: `${runId}-${i}`, contactId: contact.contactId } });
        const deliveryDate = new Date("2026-11-12T00:00:00Z");
        const delivery = await db.orderDeliveryGroup.create({ data: { orderId: order.id, orderType: order.orderType, orderNumber: order.orderNumber, deliveryDate } });
        const event = await db.notificationEvent.create({ data: { orderId: order.id, deliveryGroupId: delivery.id, contactId: contact.contactId,
          orderType: order.orderType, orderNumber: order.orderNumber, deliveryDate, intervalType: "DAY_14", actionType: "DELIVERY_REMINDER",
          dedupeKey: `${runId}:${i}`, selectedChannel: "EMAIL", status: "SCHEDULED" } });
        candidates.push({ eventId: event.id, orderType: order.orderType, orderNumber: order.orderNumber, contactId: contact.contactId,
          recipient: "test@example.invalid", channel: "EMAIL", deliveryDate: "2026-11-12", interval: "DAY_14", action: "DELIVERY_REMINDER", stage: "initial",
          eligible: true, freshlyImported: true, optedOut: false,
          address: { addressLine1: "1 Test St", city: "Test", state: "UT", country: "US", postalCode: "84000" } });
      }
      const ids = new Set(candidates.map(c => c.eventId));
      const plan = planDeliveryNotificationGroups(candidates, ids).groups[0];
      const group = await db.deliveryNotificationGroup.create({ data: {
        membershipKey: plan.membershipKey, compatibilityKey: plan.key, runId, contactId: contact.contactId,
        deliveryDate: new Date("2026-11-12"), intervalType: "DAY_14", actionType: "DELIVERY_REMINDER", stage: "initial", channel: "EMAIL",
        addressKey: deliveryAddressGroupingKey(candidates[0].address), members: { create: candidates.map(c => ({ notificationEventId: c.eventId })) },
      } });
      return { group, candidates, ids, params: { groupId: group.id, currentRunEventIds: ids, freshCandidates: candidates } };
    };

    const concurrent = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => claimDeliveryNotificationGroup(db, concurrent.params)));
    const winners = results.flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []);
    assert.equal(winners.length, 1);
    for (const result of results) {
      if (result.status === "rejected") assert.equal(result.reason.code, "P2034", "Only serialization conflicts are acceptable losers");
    }
    assert.equal(await db.deliveryNotificationGroupAttempt.count({ where: { groupId: concurrent.group.id } }), 1);
    assert.equal(await db.notificationAttempt.count(), 0, "No per-order provider attempts fabricated");
    assert.equal(await claimDeliveryNotificationGroup(db, concurrent.params), null);

    const partial = await fixture();
    await db.notificationEvent.update({ where: { id: partial.candidates[1].eventId }, data: { status: "SENT" } });
    await assert.rejects(claimDeliveryNotificationGroup(db, partial.params), /group_member_already_claimed_or_attempted/);
    assert.equal((await db.deliveryNotificationGroup.findUniqueOrThrow({ where: { id: partial.group.id } })).status, "PREPARED");
    assert.equal((await db.notificationEvent.findUniqueOrThrow({ where: { id: partial.candidates[0].eventId } })).status, "SCHEDULED");
    assert.equal(await db.deliveryNotificationGroupAttempt.count({ where: { groupId: partial.group.id } }), 0);

    await assert.rejects(db.deliveryNotificationGroupMember.create({ data: { groupId: partial.group.id, notificationEventId: concurrent.candidates[0].eventId } }), { code: "P2002" });
    await assert.rejects(db.deliveryNotificationGroupMember.create({ data: { groupId: partial.group.id, notificationEventId: "missing-event" } }), { code: "P2003" });

    const callback = (rawStatus: string) => reconcileDeliveryNotificationGroupAttempt(db, { attemptId: winners[0], provider: "ms_graph", externalMessageId: `message-${randomUUID()}`, rawStatus });
    await callback("DELIVERED");
    const attempt = await db.deliveryNotificationGroupAttempt.findUniqueOrThrow({ where: { id: winners[0] } });
    await reconcileDeliveryNotificationGroupAttempt(db, { attemptId: attempt.id, provider: "ms_graph", externalMessageId: attempt.externalMessageId, rawStatus: "QUEUED" });
    assert.equal((await db.deliveryNotificationGroupAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status, "DELIVERED");
    assert.equal((await db.deliveryNotificationGroup.findUniqueOrThrow({ where: { id: concurrent.group.id } })).status, "DELIVERED");
    assert.equal(await db.notificationEvent.count({ where: { id: { in: [...concurrent.ids] }, status: "SENT" } }), 2);

    const runStartedAt = new Date();
    const scoped = await fixture();
    const targetDate = "2026-11-12";
    await db.contact.update({ where: { contactId: scoped.group.contactId }, data: { lastName: "Conte", phone1: "+12025550123", smsOptIn: true } });
    await db.deliveryNotificationGroup.update({ where: { id: scoped.group.id }, data: { intervalType: "DAY_90", channel: "SMS" } });
    for (const candidate of scoped.candidates) {
      const event = await db.notificationEvent.update({ where: { id: candidate.eventId }, data: { intervalType: "DAY_90", selectedChannel: "SMS" } });
      await db.order.update({ where: { id: event.orderId }, data: { status: "Open", lastSyncedAt: new Date(),
        address: { create: { addressLine1: "1 Test St", city: "Test", state: "UT", country: "US", postalCode: "84000" } } } });
      const line = await db.orderLine.create({ data: { orderId: event.orderId, orderType: event.orderType, orderNumber: event.orderNumber, lineNbr: 1, requestedOn: new Date(targetDate) } });
      await db.orderDeliveryGroupLine.create({ data: { orderDeliveryGroupId: event.deliveryGroupId, orderId: event.orderId, orderType: event.orderType,
        orderNumber: event.orderNumber, orderLineId: line.id, lineNbr: 1, deliveryDate: new Date(targetDate), lastSeenAt: new Date() } });
    }
    // This fixture has no claimed attempt; remove its planner-only membership before using the real dispatcher planner.
    await db.deliveryNotificationGroupMember.deleteMany({ where: { groupId: scoped.group.id } });
    await db.deliveryNotificationGroup.delete({ where: { id: scoped.group.id } });
    const freshImport: DeliveryIntervalFreshImportResult = { required: true, performed: true, targetDate, requestedOn: targetDate,
      skippedReason: null, importResult: { requestedOn: targetDate, successfullyRefreshedOrders: scoped.candidates,
        qualifyingOrdersFetched: 2, fullOrdersFetched: 2, contactsUpserted: 1, ordersCreated: 2, ordersUpdated: 0,
        totalsUpserted: 0, taxDetailsUpserted: 0, linesUpserted: 2, allocationsUpserted: 0, addressesUpserted: 2,
        deliveryGroupsUpserted: 2, deliveryGroupLinesUpserted: 2, deliveryGroupLinesCreated: 2,
        deliveryGroupLinesReactivated: 0, deliveryGroupLinesDeactivated: 0, deliveryGroupLinesExcludedNonStock: 0,
        deliveryGroupLinesExcludedService: 0, deliveryGroupLinesExcludedUnknownItemType: 0,
        deliveryGroupLinesExcludedMissingRequestedOn: 0, deliveryGroupLinesExcludedMissingDeliveryGroup: 0,
        changeEventsDetected: 0, changeEventsCreated: 0, changeEventsDeduped: 0, skippedOrders: 0, failedOrders: 0, errors: [] },
      failedOrders: [], failedOrderLookup: { keys: [], orderNumbers: [] },
      successfulOrderLookup: { keys: scoped.candidates.map(c => `${c.orderType}:${c.orderNumber}`.toUpperCase()), orderNumbers: [] },
      globalFailed: false, perOrderFailed: false, errorMessage: null };
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", USE_QUEUE_ERP: "true", MLD_QUEUE_BASE_URL: "https://queue.invalid", MLD_QUEUE_TOKEN: "test",
      DELIVERY_APP_BASE_URL: "https://delivery.invalid", TWILIO_ACCOUNT_SID: "test", TWILIO_AUTH_TOKEN: "test", TWILIO_MESSAGING_SERVICE_SID: "test",
      MS_GRAPH_TENANT_ID: "test", MS_GRAPH_CLIENT_ID: "test", MS_GRAPH_CLIENT_SECRET: "test", MS_GRAPH_FROM_EMAIL: "test@example.invalid" };
    let simulatedCalls = 0;
    let callbackAttempt = "";
    const testSid = `SM-${randomUUID()}`;
    const provider: DeliveryNotificationProvider = {
      sendEmail: async () => { throw new Error("unexpected_email"); },
      sendSms: async input => {
        simulatedCalls++;
        assert.equal(input.to, "+12025550123");
        for (const c of scoped.candidates) assert.ok(input.body.includes(c.orderNumber));
        callbackAttempt = new URL(input.statusCallbackUrl).searchParams.get("groupAttemptId")!;
        assert.ok(callbackAttempt);
        await handleTwilioGroupMessageStatus({ client: db, groupAttemptId: callbackAttempt,
          payload: { MessageSid: testSid, MessageStatus: "delivered", To: input.to } });
        return { provider: "twilio", externalMessageId: testSid, providerCode: "queued", httpStatus: 201 };
      },
    };
    const options = { env, prismaClient: db, provider, testRunId: `dispatch-${randomUUID()}`, currentRunEventIds: [...scoped.ids], freshImport, runStartedAt };
    const before = await db.deliveryNotificationGroupAttempt.count();
    const preview = await dispatchGroupedDeliveryNotifications(options);
    assert.equal(preview.reports.length, 1);
    assert.equal(preview.reports[0].memberCount, 2);
    assert.equal(await db.deliveryNotificationGroupAttempt.count(), before);
    assert.equal(simulatedCalls, 0);
    await assert.rejects(dispatchGroupedDeliveryNotifications({ ...options, freshImport: { ...freshImport, globalFailed: true } }), /grouped_fresh_import_required/);
    await db.contact.update({ where: { contactId: scoped.group.contactId }, data: { smsOptIn: false, emailOptIn: false } });
    await assert.rejects(dispatchGroupedDeliveryNotifications(options), /grouped_channel_unavailable/);
    await db.contact.update({ where: { contactId: scoped.group.contactId }, data: { smsOptIn: true } });
    const sent = await dispatchGroupedDeliveryNotifications({ ...options, send: true });
    assert.equal(sent.reports[0].outcome, "submitted");
    assert.equal(simulatedCalls, 1);
    assert.equal(await db.deliveryNotificationGroupAttempt.count(), before + 1);
    assert.equal((await db.deliveryNotificationGroupAttempt.findUniqueOrThrow({ where: { id: callbackAttempt } })).status, "DELIVERED");
    await handleTwilioGroupMessageStatus({ client: db, groupAttemptId: callbackAttempt,
      payload: { MessageSid: testSid, MessageStatus: "queued", To: "+12025550123" } });
    assert.equal((await db.deliveryNotificationGroupAttempt.findUniqueOrThrow({ where: { id: callbackAttempt } })).status, "DELIVERED");
    await assert.rejects(handleTwilioGroupMessageStatus({ client: db, groupAttemptId: callbackAttempt,
      payload: { MessageSid: testSid, MessageStatus: "delivered", To: "+12025550999" } }), /identity_mismatch/);
    await assert.rejects(dispatchGroupedDeliveryNotifications({ ...options, send: true }), /already_claimed_or_attempted/);
    assert.equal(simulatedCalls, 1);
    assert.equal(await db.notificationEvent.count({ where: { id: { in: [...scoped.ids] }, status: "SENT" } }), 2);
    assert.equal(await db.notificationAttempt.count(), 0);

    const duplicate = await handleTwilioGroupMessageStatus({ client: db, groupAttemptId: callbackAttempt,
      payload: { MessageSid: testSid, MessageStatus: "delivered", To: "+12025550123" } });
    assert.equal(duplicate.matchStatus, "DUPLICATE");
    const unmatched = await handleTwilioGroupMessageStatus({ client: db, groupAttemptId: `unknown-${randomUUID()}`,
      payload: { MessageSid: "SM-unknown", MessageStatus: "sent", To: "+12025550123" } });
    assert.equal(unmatched.matchStatus, "UNMATCHED_GROUP_ATTEMPT");
    assert.ok(await db.twilioMessageStatusCallback.findFirst({ where: { messageSid: "SM-unknown", matchStatus: "UNMATCHED_GROUP_ATTEMPT" } }));

    // New current-run events exercise the email branch without resetting sent events.
    const emailIds: string[] = [];
    for (const eventId of scoped.ids) {
      const event = await db.notificationEvent.findUniqueOrThrow({ where: { id: eventId } });
      const emailEvent = await db.notificationEvent.create({ data: { orderId: event.orderId, orderType: event.orderType,
        orderNumber: event.orderNumber, contactId: event.contactId, deliveryGroupId: event.deliveryGroupId,
        deliveryDate: event.deliveryDate, intervalType: "DAY_60", actionType: "DELIVERY_REMINDER", status: "SCHEDULED",
        selectedChannel: "EMAIL", dedupeKey: randomUUID() } });
      emailIds.push(emailEvent.id);
    }
    await db.contact.update({ where: { contactId: scoped.group.contactId }, data: { smsOptIn: false, emailOptIn: true } });
    const emailOptions = { ...options, currentRunEventIds: emailIds, provider: {
      sendSms: async () => { throw new Error("unexpected_sms"); },
      sendEmail: async (input: Parameters<DeliveryNotificationProvider["sendEmail"]>[0]) => {
        simulatedCalls++;
        assert.equal(input.to, "test@example.invalid");
        for (const c of scoped.candidates) assert.ok(input.textBody.includes(c.orderNumber));
        return { provider: "ms_graph" as const, externalMessageId: `mail-${randomUUID()}`, providerCode: "accepted", httpStatus: 202 };
      },
    } };
    await db.notificationEvent.updateMany({ where: { id: { in: emailIds } }, data: { intervalType: "DAY_42" } });
    await assert.rejects(dispatchGroupedDeliveryNotifications(emailOptions), /confirmation.*link.*missing/);
    await db.notificationEvent.updateMany({ where: { id: { in: emailIds } }, data: { intervalType: "DAY_60" } });
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { id: emailIds[0] } });
    await db.orderDeliveryGroup.update({ where: { id: event.deliveryGroupId }, data: { deliveryDate: new Date("2026-11-13") } });
    await assert.rejects(dispatchGroupedDeliveryNotifications(emailOptions), /delivery_group_date_changed/);
    await db.orderDeliveryGroup.update({ where: { id: event.deliveryGroupId }, data: { deliveryDate: new Date(targetDate) } });
    const emailed = await dispatchGroupedDeliveryNotifications({ ...emailOptions, send: true });
    assert.equal(emailed.reports.length, 1);
    assert.equal(emailed.reports[0].outcome, "submitted");
    assert.equal(simulatedCalls, 2);

    console.log(JSON.stringify({ ok: true, groupedDispatcher: true, callbackBeforeProviderResponse: true, simulatedCalls, database: identity[0].name, concurrentClaimants: 5, winningAttempts: winners.length,
      partialClaimRolledBack: true, membershipUniqueConstraint: true, membershipForeignKey: true,
      callbackPromotionAndDowngradeProtection: true, providerCalls: 0, productionDatabaseUsed: false }, null, 2));
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
