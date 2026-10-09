import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  InternalNotificationPurpose,
  PrismaClient,
} from "../lib/generated/prisma/client";
import { DeliveryNotificationProviderError } from "../lib/notifications/deliveryNotificationProviders";
import { dispatchInternalNotifications } from "../lib/notifications/internalNotificationDispatcher";

const ORDER_TYPE = "INTERNALTEST";
const deliveryDate = new Date("2030-01-07T00:00:00.000Z");

function isolatedDatabaseUrl() {
  const value = process.env.TEST_DELIVERY_GROUP_DATABASE_URL;
  if (!value) throw new Error("Explicit isolated TEST_DELIVERY_GROUP_DATABASE_URL required");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/delivery_group_validation") || url.search) {
    throw new Error("Only an isolated loopback delivery_group_validation database is allowed");
  }
  return value;
}

async function eventFixture(db: PrismaClient, suffix: string, recipientEmail = "salesperson@example.invalid") {
  const key = `${suffix}-${randomUUID()}`;
  const contact = await db.contact.create({ data: { contactId: `internal-${key}` } });
  const order = await db.order.create({ data: {
    orderType: ORDER_TYPE,
    orderNumber: key,
    contactId: contact.contactId,
  } });
  const group = await db.orderDeliveryGroup.create({ data: {
    orderId: order.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate,
  } });
  return db.internalNotificationEvent.create({ data: {
    orderId: order.id,
    orderDeliveryGroupId: group.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate,
    purpose: InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE,
    audienceType: "SALESPERSON",
    recipientEmail,
    subject: "Delivery confirmation follow-up required",
    bodyPreview: "Please follow up with this customer.",
    messageSummary: "No response after completed customer touch sequence.",
  } });
}

async function main() {
  const databaseUrl = isolatedDatabaseUrl();
  process.env.DATABASE_URL = databaseUrl;
  globalThis.fetch = async () => { throw new Error("Network forbidden in internal dispatch validation"); };
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const identity = await db.$queryRaw<{ name: string; address: string }[]>`
      SELECT current_database() AS name, host(inet_server_addr()) AS address
    `;
    assert.equal(identity[0].address, "127.0.0.1");
    assert.ok(identity[0].name.startsWith("delivery_group_validation"));

    const event = await eventFixture(db, "concurrent");
    const unrelated = await eventFixture(db, "unrelated");
    let sends = 0;
    const provider = { async sendEmail() {
      sends += 1;
      return { provider: "ms_graph" as const, externalMessageId: "graph-concurrent-request",
        providerCode: "accepted", httpStatus: 202 };
    } };
    const request = () => dispatchInternalNotifications({
      eventIds: [event.id],
      purposes: [InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE],
      client: db,
      provider,
      now: () => new Date("2030-01-01T12:00:00.000Z"),
    });
    const concurrent = await Promise.all(Array.from({ length: 8 }, request));
    assert.equal(sends, 1, "Concurrent dispatchers submit one provider request");
    assert.equal(concurrent.reduce((count, result) => count + result.providerAcceptedCount, 0), 1);
    const sent = await db.internalNotificationEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(sent.status, "SENT");
    assert.equal(sent.providerMessageId, "graph-concurrent-request");
    assert.equal((await db.internalNotificationEvent.findUniqueOrThrow({ where: { id: unrelated.id } })).status,
      "PENDING", "An unrelated pending backlog event is untouched");
    await request();
    assert.equal(sends, 1, "A successful event is never resent");

    const invalid = await eventFixture(db, "invalid", "not-an-email");
    const invalidResult = await dispatchInternalNotifications({
      eventIds: [invalid.id],
      purposes: [InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE],
      client: db,
      provider,
    });
    assert.equal(invalidResult.reports[0].outcome, "skipped");
    assert.equal((await db.internalNotificationEvent.findUniqueOrThrow({ where: { id: invalid.id } })).status,
      "SKIPPED");
    assert.equal(sends, 1);

    const preSendFailure = await eventFixture(db, "pre-send-failure");
    let failedCalls = 0;
    const failedProvider = { async sendEmail(): Promise<never> {
      failedCalls += 1;
      throw new DeliveryNotificationProviderError({
        provider: "ms_graph",
        providerCode: "INTERNAL_TOKEN_FAILED_BEFORE_SEND",
        message: "Simulated token failure",
      });
    } };
    const failedRequest = () => dispatchInternalNotifications({
      eventIds: [preSendFailure.id],
      purposes: [InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE],
      client: db,
      provider: failedProvider,
    });
    assert.equal((await failedRequest()).providerFailedCount, 1);
    await failedRequest();
    assert.equal(failedCalls, 1, "Failed events require reconciliation and are not automatically resent");

    console.log(JSON.stringify({
      ok: true,
      isolatedDatabase: identity[0].name,
      concurrentClaimants: 8,
      winningProviderCalls: sends,
      unrelatedBacklogUntouched: true,
      invalidRecipientSkipped: true,
      successfulEventNotResent: true,
      failedEventNotAutomaticallyRetried: true,
      realProviderCalls: 0,
      productionDatabaseUsed: false,
    }, null, 2));
  } finally {
    await db.order.deleteMany({ where: { orderType: ORDER_TYPE } });
    await db.contact.deleteMany({ where: { contactId: { startsWith: "internal-" } } });
    await db.$disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
