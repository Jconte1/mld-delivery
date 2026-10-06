import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { selectDeliveryRecipient, recipientContactSelect } from "../lib/notifications/deliveryRecipient";

async function main() {
  const primary = { contactId: "1", smsOptIn: false, emailOptIn: true, email: "primary@example.invalid", phone1: "" };
  const delivery = { contactId: "2", smsOptIn: true, emailOptIn: false, phone1: "8015550100", email: "" };
  const order = { contact: primary, deliveryContact: delivery, deliveryContactId: "2",
    deliveryContactSyncStatus: "fetched", primaryContactFetchSucceeded: true };
  assert.equal(selectDeliveryRecipient("DAY_2", order).role, "DELIVERY");
  for (const interval of ["DAY_180", "DAY_90", "DAY_60", "DAY_42", "DAY_30", "DAY_14", "DAY_12", "DAY_10", "DAY_8"]) {
    assert.equal(selectDeliveryRecipient(interval, order).contact.contactId, "1");
  }
  for (const status of ["unavailable", "not_fetched", "not_exposed"]) {
    assert.equal(selectDeliveryRecipient("DAY_2", { ...order, deliveryContactSyncStatus: status }).role, "PRIMARY");
  }
  assert.equal(selectDeliveryRecipient("DAY_2", { ...order, deliveryContactId: null }).fallbackReason, "delivery_contact_missing");
  assert.equal(selectDeliveryRecipient("DAY_2", { ...order, deliveryContact: { ...delivery, smsOptIn: false } }).role, "PRIMARY");
  assert.equal(selectDeliveryRecipient("DAY_2", order, { activeSmsOptOutPhones: ["+18015550100"], activeEmailOptOutEmails: [] }).role, "PRIMARY");
  assert.equal(selectDeliveryRecipient("DAY_2", { ...order, deliveryContactId: null, primaryContactFetchSucceeded: false }).channel.selectedChannel, null);
  assert.equal(selectDeliveryRecipient("DAY_2", order, { activeSmsOptOutPhones: ["+18015550100"], activeEmailOptOutEmails: [primary.email] }).channel.selectedChannel, null);
  assert.equal(selectDeliveryRecipient("DAY_2", { ...order, deliveryContact: primary, deliveryContactId: "1" }).role, "DELIVERY");

  const value = process.env.TEST_DELIVERY_GROUP_DATABASE_URL;
  if (!value) throw new Error("Explicit isolated TEST_DELIVERY_GROUP_DATABASE_URL required");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/delivery_group_validation") || url.search) throw new Error("Only isolated loopback database allowed");
  process.env.DATABASE_URL = value;
  globalThis.fetch = async () => { throw new Error("network_forbidden_in_contact_validation"); };
  const { prisma: db } = await import("../lib/prisma");
  const { importSalesOrdersForLineRequestedOn } = await import("../lib/erp/importSalesOrders");
  const id = randomUUID();
  const p = `primary-${id}`, d = `delivery-${id}`;
  const v = (value: unknown) => ({ value });
  let assigned: unknown = v(d);
  let failDelivery = false;
  let wrongDeliveryId = false;
  const reads: string[] = [];
  const erpClient = {
    fetchQualifyingSalesOrdersByLineRequestedOn: async () => [{ OrderType: v("TEST"), OrderNbr: v(id) }],
    fetchDeliverySalesOrderByOrderNumber: async () => [{ OrderType: v("TEST"), OrderNbr: v(id), Status: v("Open"),
      ContactID: v(p), DeliveryContact: assigned, ShipVia: v("DELIVERY"), Details: [], Totals: {} }],
    fetchDeliveryContactByContactId: async (contactId: string) => {
      reads.push(contactId);
      if (contactId === d && failDelivery) throw new Error("simulated_read_failure");
      return [{ ContactID: v(contactId === d && wrongDeliveryId ? "unexpected-contact" : contactId), FirstName: v("Test"), LastName: v("Conte"), Email: v(`${contactId}@example.invalid`),
        Phone1: v("8015550100"), custom: { Contact: { AttributeCONTEXT: v("Opt-In"), AttributeCONEMAIL: v("Opt-In"), AttributeCONPHONE: v("Opt-In") } } }];
    },
  };
  const run = async () => {
    reads.length = 0;
    const imported = await importSalesOrdersForLineRequestedOn("2030-01-07", { erpClient });
    assert.equal(imported.failedOrders, 0, JSON.stringify(imported.errors));
    return db.order.findUniqueOrThrow({ where: { orderType_orderNumber: { orderType: "TEST", orderNumber: id } },
      include: { contact: { select: recipientContactSelect }, deliveryContact: { select: recipientContactSelect } } });
  };
  try {
    const first = await run();
    assert.equal(first.contactId, p); assert.equal(first.deliveryContactId, d);
    assert.equal(first.deliveryContactSyncStatus, "fetched"); assert.equal(first.deliveryContact?.smsOptIn, true);
    assert.equal(selectDeliveryRecipient("DAY_2", first).contact.contactId, d);
    failDelivery = true;
    const failed = await run();
    assert.equal(failed.deliveryContactSyncStatus, "unavailable");
    assert.equal(selectDeliveryRecipient("DAY_2", failed).contact.contactId, p);
    failDelivery = false; wrongDeliveryId = true;
    assert.equal((await run()).deliveryContactSyncStatus, "unavailable");
    wrongDeliveryId = false;
    assigned = {};
    const removed = await run(); assert.equal(removed.deliveryContactId, null);
    assert.equal(selectDeliveryRecipient("DAY_2", removed).role, "PRIMARY");
    assigned = v(p);
    const same = await run(); assert.equal(same.deliveryContactId, p); assert.deepEqual(reads, [p]);
    console.log(JSON.stringify({ ok: true, pureRouting: true, realLocalImport: true, staleDeliveryContactBlocked: true,
      removalClearsAssignment: true, sharedIdFetchedOnce: true, otherIntervalsUsePrimary: true,
      actualProviderCalls: 0, actualQueueJobs: 0, productionDatabaseUsed: false }, null, 2));
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
