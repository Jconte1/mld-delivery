import assert from "node:assert/strict";
import { evaluateDeliveryGroupPayment, type DeliveryPaymentLineInput } from "../lib/delivery-payment/deliveryGroupPayment";
import { planDeliveryNotificationGroups, type GroupingCandidate } from "../lib/notifications/deliveryNotificationGrouping";

const date = "2026-11-12";
function payment(id: string, current: number, completed = 0) {
  const line = (suffix: string, value: number, done: boolean, currentGroup: boolean): DeliveryPaymentLineInput => ({
    id: `${id}-${suffix}`, lineNbr: currentGroup ? 1 : done ? 2 : 3,
    inventoryId: `TEST-${suffix}`, lineDescription: "Isolated fixture", itemType: "F", itemClass: "TEST",
    requestedOn: currentGroup ? date : done ? "2026-10-01" : "2026-12-01",
    taxCategory: "EXEMPT", discountedUnitPrice: String(value), orderQty: "1", openQty: done ? "0" : "1",
    activeAllocatedQty: done ? "0" : "1", allocationStatus: "allocated", etaStatus: "ready", readinessStatus: done ? "complete" : "ready",
  });
  return evaluateDeliveryGroupPayment({ orderDeliveryGroupId: id, orderId: id, orderType: "SO", orderNumber: id,
    deliveryDate: date, paymentTerms: "PP", unpaidBalance: "25000", orderTotal: "50000", taxTotal: "0",
    taxDetails: [], activeOrderLineIds: [`${id}-current`],
    lines: [line("current", current, false, true), line("remaining", 50000 - current - completed, false, false),
      ...(completed ? [line("completed", completed, true, false)] : [])] });
}
const covered = payment("A", 22000);
assert.equal(covered.amountDueNowRounded, "0.00");
assert.equal(covered.depositCoversCurrentDelivery, true);
const overDeposit = payment("B", 26000);
assert.equal(overDeposit.depositCoversCurrentDelivery, false);
assert.equal(overDeposit.amountDueNowRounded, "11800.00");
const completedConsumesDeposit = payment("C", 22000, 10000);
assert.equal(completedConsumesDeposit.depositCoversCurrentDelivery, false);
assert.equal(completedConsumesDeposit.amountDueNowRounded, "15100.00");

const base: GroupingCandidate = { eventId: "a", orderType: "SO", orderNumber: "A", contactId: "test-contact",
  deliveryDate: date, interval: "DAY_14", action: "DELIVERY_REMINDER", stage: "initial", channel: "EMAIL",
  recipient: "test@example.invalid", address: { addressLine1: "1 Test St", city: "Test", state: "UT", country: "US", postalCode: "84000" },
  eligible: true, freshlyImported: true, optedOut: false };
const candidates = [base, { ...base, eventId: "b", orderNumber: "B" }, { ...base, eventId: "c", orderNumber: "C" }];
const ids = new Set(["a", "b", "c"]);
assert.equal(planDeliveryNotificationGroups(candidates, ids).groups.length, 1);
const balances = [payment("A", 22000), payment("B", 22000), payment("C", 26000)];
assert.deepEqual(balances.map(p => p.amountDueNowRounded), ["0.00", "0.00", "11800.00"]);
assert.equal(planDeliveryNotificationGroups([candidates[0], candidates[1], { ...candidates[2], deliveryDate: "2026-11-19" }], ids).groups.length, 2);
const stages = candidates.map((c, i) => ({ ...c, interval: "DAY_42", stage: ["initial", "reminder_1", "final"][i] }));
assert.equal(planDeliveryNotificationGroups(stages, ids).groups.length, 3);
assert.equal(planDeliveryNotificationGroups([base], new Set(["a"])).groups[0].members.length, 1);
console.log(JSON.stringify({ ok: true, scope: "pure grouping plus existing payment evaluator; not grouped writeback integration",
  scenarios: ["deposit covers current delivery", "deposit exceeded activates 45% remainder", "completed items consume deposit",
    "three matching orders group", "two cleared and one unpaid retain independent balances", "moved order separates", "different reminder stages separate", "single order remains valid"],
  sends: 0, writebacks: 0, databaseWrites: 0 }, null, 2));
