import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../lib/generated/prisma/client";
import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";
import { createUnsentEventRecovery } from "../lib/notifications/unsentEventRecovery";

const ORDER_TYPE = "RECOVERY";
const TARGET_DATE = "2030-01-07";
const DELIVERY_DATE = new Date(`${TARGET_DATE}T00:00:00.000Z`);

function isolatedDatabaseUrl() {
  const value = process.env.TEST_DELIVERY_GROUP_DATABASE_URL;
  if (!value) throw new Error("Explicit isolated TEST_DELIVERY_GROUP_DATABASE_URL required");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/delivery_group_validation") || url.search) {
    throw new Error("Only an isolated loopback delivery_group_validation database is allowed");
  }
  return value;
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(db: PrismaClient, runStartedAt: Date, suffix: string) {
  const key = `${suffix}-${randomUUID()}`;
  const contact = await db.contact.create({
    data: { contactId: `contact-${key}`, email: `${key}@example.invalid`, emailOptIn: true },
  });
  const order = await db.order.create({
    data: {
      orderType: ORDER_TYPE,
      orderNumber: key,
      contactId: contact.contactId,
      status: "Open",
      primaryContactFetchSucceeded: true,
      lastSyncedAt: new Date(runStartedAt.getTime() + 1_000),
    },
  });
  const group = await db.orderDeliveryGroup.create({
    data: {
      orderId: order.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: DELIVERY_DATE,
      status: "Open",
      isActive: true,
    },
  });
  const dedupeKey = `unsent-recovery:${key}`;
  const event = await db.notificationEvent.create({
    data: {
      orderId: order.id,
      deliveryGroupId: group.id,
      contactId: contact.contactId,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: DELIVERY_DATE,
      intervalType: "DAY_30",
      actionType: "DELIVERY_REMINDER",
      dedupeKey,
      selectedChannel: "EMAIL",
      recipientEmail: "old-recipient@example.invalid",
      status: "SCHEDULED",
      scheduledAt: new Date("2030-12-01T12:00:00.000Z"),
    },
  });
  return { contact, order, group, event, dedupeKey };
}

function importResult(fixture: Fixture, errors: ImportSalesOrdersResult["errors"] = []) {
  return {
    successfullyRefreshedOrders: [{
      orderType: fixture.order.orderType,
      orderNumber: fixture.order.orderNumber,
    }],
    errors,
  } as unknown as ImportSalesOrdersResult;
}

function replacementData(fixture: Fixture,
  overrides: Partial<Prisma.NotificationEventUncheckedCreateInput> = {}): Prisma.NotificationEventUncheckedCreateInput {
  return {
    orderId: fixture.order.id,
    deliveryGroupId: fixture.group.id,
    contactId: fixture.contact.contactId,
    orderType: fixture.order.orderType,
    orderNumber: fixture.order.orderNumber,
    deliveryDate: DELIVERY_DATE,
    intervalType: "DAY_30",
    actionType: "DELIVERY_REMINDER",
    dedupeKey: fixture.dedupeKey,
    selectedChannel: "EMAIL",
    recipientEmail: "fresh-recipient@example.invalid",
    status: "SCHEDULED",
    scheduledAt: new Date("2030-12-02T12:00:00.000Z"),
    ...overrides,
  };
}

function recovery(db: PrismaClient, fixture: Fixture, runStartedAt: Date,
  result = importResult(fixture)) {
  return createUnsentEventRecovery(db, () => ({
    dryRun: false,
    targetDeliveryDate: TARGET_DATE,
    importResult: result,
  }), runStartedAt);
}

async function discoverCandidate(instance: ReturnType<typeof recovery>, dedupeKey: string) {
  return instance.client.notificationEvent.findUnique({
    where: { dedupeKey },
    select: { id: true, status: true, recipientEmail: true },
  });
}

async function recover(instance: ReturnType<typeof recovery>, fixture: Fixture,
  overrides: Partial<Prisma.NotificationEventUncheckedCreateInput> = {}) {
  return instance.client.notificationEvent.create({
    data: replacementData(fixture, overrides),
    select: { id: true, status: true, recipientEmail: true, createdAt: true },
  });
}

async function main() {
  const databaseUrl = isolatedDatabaseUrl();
  process.env.DATABASE_URL = databaseUrl;
  globalThis.fetch = async () => { throw new Error("Network forbidden in recovery validation"); };
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const runStartedAt = new Date();
  try {
    const identity = await db.$queryRaw<{ name: string; address: string }[]>`
      SELECT current_database() AS name, host(inet_server_addr()) AS address
    `;
    assert.equal(identity[0].address, "127.0.0.1");
    assert.ok(identity[0].name.startsWith("delivery_group_validation"));

    const normal = await createFixture(db, runStartedAt, "normal");
    const normalRecovery = recovery(db, normal, runStartedAt);
    assert.equal(await discoverCandidate(normalRecovery, normal.dedupeKey), null);
    const recovered = await recover(normalRecovery, normal);
    assert.equal(recovered.id, normal.event.id, "Recovery keeps the original event identity");
    assert.equal(recovered.recipientEmail, "fresh-recipient@example.invalid");
    assert.deepEqual(normalRecovery.recoveredEventIds, [normal.event.id]);
    assert.deepEqual(normalRecovery.currentRunEligibleEventIds, [normal.event.id]);
    assert.equal(await db.notificationEvent.count({ where: { dedupeKey: normal.dedupeKey } }), 1);
    assert.equal(await db.notificationAttempt.count({ where: { notificationEventId: normal.event.id } }), 0);

    const changedContact = await createFixture(db, runStartedAt, "changed-contact");
    const replacementContact = await db.contact.create({ data: {
      contactId: `replacement-${randomUUID()}`,
      email: "replacement@example.invalid",
      emailOptIn: true,
    } });
    await db.order.update({ where: { id: changedContact.order.id }, data: {
      contactId: replacementContact.contactId,
      primaryContactFetchSucceeded: true,
      lastSyncedAt: new Date(runStartedAt.getTime() + 2_000),
    } });
    const changedContactRecovery = recovery(db, changedContact, runStartedAt);
    assert.equal(await discoverCandidate(changedContactRecovery, changedContact.dedupeKey), null);
    await recover(changedContactRecovery, changedContact, {
      contactId: replacementContact.contactId,
      recipientEmail: replacementContact.email,
    });
    assert.equal((await db.notificationEvent.findUniqueOrThrow({ where: { id: changedContact.event.id } })).contactId,
      replacementContact.contactId, "Recovery uses the newly imported contact assignment");

    const responded = await createFixture(db, runStartedAt, "responded");
    const respondedRecovery = recovery(db, responded, runStartedAt);
    assert.equal(await discoverCandidate(respondedRecovery, responded.dedupeKey), null);
    await recover(respondedRecovery, responded, {
      selectedChannel: null,
      recipientEmail: null,
      status: "SKIPPED",
      scheduledAt: null,
      reasonSkipped: "customer_responded_before_dispatch",
    });
    assert.equal((await db.notificationEvent.findUniqueOrThrow({ where: { id: responded.event.id } })).status,
      "SKIPPED");
    assert.deepEqual(respondedRecovery.currentRunEligibleEventIds, [],
      "A response observed during current eligibility cannot be recovered for dispatch");

    const priorAttempt = await createFixture(db, runStartedAt, "attempted");
    await db.notificationAttempt.create({ data: {
      notificationEventId: priorAttempt.event.id,
      attemptNumber: 1,
      channel: "EMAIL",
      recipient: priorAttempt.event.recipientEmail,
    } });
    const attemptedRecovery = recovery(db, priorAttempt, runStartedAt);
    assert.equal((await discoverCandidate(attemptedRecovery, priorAttempt.dedupeKey))?.id, priorAttempt.event.id);
    assert.deepEqual(attemptedRecovery.currentRunEligibleEventIds, []);

    const failedStatus = await createFixture(db, runStartedAt, "failed-status");
    await db.notificationEvent.update({ where: { id: failedStatus.event.id }, data: { status: "FAILED" } });
    assert.equal((await discoverCandidate(recovery(db, failedStatus, runStartedAt), failedStatus.dedupeKey))?.id,
      failedStatus.event.id);

    const stale = await createFixture(db, runStartedAt, "stale-contact");
    await db.order.update({ where: { id: stale.order.id }, data: {
      lastSyncedAt: new Date(runStartedAt.getTime() - 1_000),
      primaryContactFetchSucceeded: false,
    } });
    assert.equal((await discoverCandidate(recovery(db, stale, runStartedAt), stale.dedupeKey))?.id, stale.event.id);

    const failedImport = await createFixture(db, runStartedAt, "failed-import");
    const failedImportRecovery = recovery(db, failedImport, runStartedAt, importResult(failedImport, [{
      orderType: failedImport.order.orderType,
      orderNumber: failedImport.order.orderNumber,
      reason: "fresh_import_failed",
    }]));
    assert.equal((await discoverCandidate(failedImportRecovery, failedImport.dedupeKey))?.id, failedImport.event.id);

    const wrongDate = await createFixture(db, runStartedAt, "wrong-date");
    await db.notificationEvent.update({ where: { id: wrongDate.event.id }, data: {
      deliveryDate: new Date("2030-01-08T00:00:00.000Z"),
    } });
    assert.equal((await discoverCandidate(recovery(db, wrongDate, runStartedAt), wrongDate.dedupeKey))?.id,
      wrongDate.event.id);

    const identityMismatch = await createFixture(db, runStartedAt, "identity");
    const identityRecovery = recovery(db, identityMismatch, runStartedAt);
    assert.equal(await discoverCandidate(identityRecovery, identityMismatch.dedupeKey), null);
    await assert.rejects(identityRecovery.client.notificationEvent.create({
      data: { ...replacementData(identityMismatch), orderNumber: "DIFFERENT" },
    }), /identity_mismatch/);

    const concurrent = await createFixture(db, runStartedAt, "concurrent");
    const contenders = [recovery(db, concurrent, runStartedAt), recovery(db, concurrent, runStartedAt)];
    assert.deepEqual(await Promise.all(contenders.map(item => discoverCandidate(item, concurrent.dedupeKey))), [null, null]);
    const outcomes = await Promise.allSettled(contenders.map(item => recover(item, concurrent)));
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    assert.equal(await db.notificationEvent.count({ where: { dedupeKey: concurrent.dedupeKey } }), 1);
    assert.equal(contenders.flatMap(item => item.currentRunEligibleEventIds).length, 1);

    console.log(JSON.stringify({
      ok: true,
      isolatedDatabase: identity[0].name,
      recoveredUntouchedEvent: true,
      originalIdentityPreserved: true,
      priorAttemptBlocked: true,
      failedStatusBlocked: true,
      staleContactBlocked: true,
      failedImportBlocked: true,
      changedDateBlocked: true,
      changedContactRefreshed: true,
      customerResponseBeforeDispatchBlocked: true,
      identityMismatchBlocked: true,
      concurrentWinners: 1,
      providerCalls: 0,
      productionDatabaseUsed: false,
    }, null, 2));
  } finally {
    await db.order.deleteMany({ where: { orderType: ORDER_TYPE } });
    await db.contact.deleteMany({ where: { OR: [
      { contactId: { startsWith: "contact-" } },
      { contactId: { startsWith: "replacement-" } },
    ] } });
    await db.$disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
