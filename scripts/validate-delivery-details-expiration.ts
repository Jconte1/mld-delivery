import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deliveryDetailsExpired } from "../lib/notifications/deliveryDetailsExpiration";
import { groupCustomerStateError, type CustomerNotificationGroup } from "../lib/notifications/deliveryNotificationGroupCustomer";
import { deliveryAddressGroupingKey } from "../lib/notifications/deliveryNotificationGrouping";

const expired = (date: string, now: string, explicit: string | null = null) =>
  deliveryDetailsExpired(date, explicit ? new Date(explicit) : null, new Date(now));
assert.equal(expired("2026-10-08", "2026-11-07T06:59:59.999Z"), false);
assert.equal(expired("2026-10-08", "2026-11-07T07:00:00Z"), true);
assert.equal(expired("2026-02-08", "2026-03-10T05:59:59.999Z"), false);
assert.equal(expired("2026-02-08", "2026-03-10T06:00:00Z"), true);
assert.equal(expired("2026-12-15", "2027-01-14T07:00:00Z"), true);
assert.equal(expired("2026-10-08", "2026-10-09T12:00:00Z", "2026-10-09T12:00:00Z"), true);
assert.equal(expired("2026-10-08", "2026-11-07T07:00:00Z", "2027-01-01T00:00:00Z"), true);
assert.equal(expired("2026-02-30", "2026-03-01T00:00:00Z"), true);
const single = readFileSync("app/details/[token]/page.tsx", "utf8");
assert.ok(single.indexOf("deliveryDetailsExpired(detailsLink") < single.indexOf("prisma.orderDeliveryGroup.findFirst"));
const grouped = readFileSync("lib/notifications/deliveryNotificationGroupCustomer.ts", "utf8");
assert.ok(grouped.includes('group.intervalType === "DAY_42"'));
assert.ok(grouped.includes("deliveryDetailsExpired(group.deliveryDate, null, now)"));
assert.ok(grouped.includes('return "membership_changed"'));
const address = { addressLine1: "1 Test Rd", city: "Test", state: "UT", postalCode: "84000", country: "US" };
const deliveryDate = new Date("2026-10-08T00:00:00Z");
const group = { intervalType: "DAY_14", deliveryDate, contactId: "contact", addressKey: deliveryAddressGroupingKey(address),
  attempts: [{ status: "SUBMITTED" }], members: [{ notificationEvent: {
    intervalType: "DAY_14", contactId: "contact", order: { contactId: "contact", address,
      internalLifecycleStatus: "ACTIVE", status: "Open" }, orderDeliveryGroup: {
        deliveryDate, isActive: true, deliveryGroupLines: [{ deliveryDate, orderLine: { requestedOn: deliveryDate } }],
      },
  } }],
} as unknown as CustomerNotificationGroup;
assert.equal(groupCustomerStateError(group, new Date("2026-10-09T12:00:00Z")), null);
assert.equal(groupCustomerStateError(group, new Date("2026-11-07T07:00:00Z")), "expired");
assert.equal(groupCustomerStateError({ ...group, intervalType: "DAY_42" }, new Date("2026-10-09T12:00:00Z")), "expired");
group.members[0].notificationEvent.orderDeliveryGroup.isActive = false;
assert.equal(groupCustomerStateError(group, new Date("2026-10-09T12:00:00Z")), "membership_changed");
console.log("Details expiration validation passed: Denver midnight, DST, legacy links, explicit caps, invalid dates, single/group wiring. No network or database calls.");
