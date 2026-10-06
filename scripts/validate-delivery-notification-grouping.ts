import assert from "node:assert/strict";
import { planDeliveryNotificationGroups, type GroupingCandidate } from "../lib/notifications/deliveryNotificationGrouping";

const base: GroupingCandidate = {
  eventId: "a", orderType: "SO", orderNumber: "A", contactId: "contact",
  deliveryDate: "2026-10-30", interval: "DAY_14", action: "DELIVERY_REMINDER", stage: "initial",
  channel: "EMAIL", recipient: "test@example.invalid", eligible: true, freshlyImported: true, optedOut: false,
  address: { addressLine1: "1 Test St", addressLine2: "Unit 1", city: "City", state: "UT", postalCode: "84000", country: "US" },
};
function plan(other: Partial<GroupingCandidate> = {}) {
  return planDeliveryNotificationGroups([base, { ...base, eventId: "b", orderNumber: "B", ...other }], new Set(["a", "b"]));
}
assert.equal(plan().groups.length, 1);
assert.equal(plan({ address: { ...base.address, addressLine1: "  1   TEST ST " } }).groups.length, 1);
for (const field of ["contactId", "recipient", "deliveryDate", "interval", "action", "stage"] as const) {
  assert.equal(plan({ [field]: "different" }).groups.length, 2, field);
}
assert.equal(plan({ channel: "SMS" }).groups.length, 2);
assert.equal(plan({ address: { ...base.address, addressLine2: "Unit 2" } }).groups.length, 2);
assert.equal(plan({ address: null }).groups[1].separateReason, "incomplete_delivery_address");
assert.equal(plan({ address: { ...base.address, country: null } }).groups.length, 2);
for (const patch of [{ eligible: false }, { freshlyImported: false }, { optedOut: true }]) {
  assert.equal(plan(patch).excluded.length, 1);
  assert.equal(plan(patch).groups[0].members.length, 1);
}
assert.equal(planDeliveryNotificationGroups([base], new Set()).excluded[0].reason, "outside_current_run");
assert.throws(() => planDeliveryNotificationGroups([base, base], new Set(["a"])));
assert.notEqual(plan().groups[0].membershipKey, planDeliveryNotificationGroups([base], new Set(["a"])).groups[0].membershipKey);
const reversed = planDeliveryNotificationGroups([{ ...base, eventId: "b", orderNumber: "B" }, base], new Set(["b", "a"]));
assert.equal(reversed.groups[0].membershipKey, plan().groups[0].membershipKey);
console.log(JSON.stringify({ ok: true, providerCalls: 0, databaseWrites: 0 }));
