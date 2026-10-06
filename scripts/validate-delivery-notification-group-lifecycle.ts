import assert from "node:assert/strict";
import { assertGroupStillEligible, executeClaimedGroupSend, nextGroupAttemptState, type GroupAttemptState } from "../lib/notifications/deliveryNotificationGroupLifecycle";
import { planDeliveryNotificationGroups, type GroupingCandidate } from "../lib/notifications/deliveryNotificationGrouping";

async function main() {
  const cases: string[] = [];
  const base: GroupingCandidate = {
    eventId: "test-a", orderType: "SO", orderNumber: "TEST-A", contactId: "test-contact",
    deliveryDate: "2026-11-12", interval: "DAY_42", action: "DELIVERY_CONFIRMATION_REQUEST",
    stage: "initial", channel: "SMS", recipient: "+12025550123",
    address: { addressLine1: "1 Test Road", city: "Test", state: "UT", country: "US", postalCode: "84000" },
    eligible: true, freshlyImported: true, optedOut: false,
  };
  const candidates = [base, { ...base, eventId: "test-b", orderNumber: "TEST-B" }];
  const ids = new Set(candidates.map(c => c.eventId));
  const group = planDeliveryNotificationGroups(candidates, ids).groups[0];
  const validate = (rows = candidates) => assertGroupStillEligible({ candidates: rows,
    currentRunEventIds: ids, expectedEventIds: [...ids], expectedMembershipKey: group.membershipKey });
  assert.equal(validate().members.length, 2);
  cases.push("two qualifying orders retain one immutable membership");
  for (const patch of [{ deliveryDate: "2026-11-19" }, { optedOut: true }, { freshlyImported: false },
    { eligible: false }, { stage: "final" }, { recipient: "+12025550124" },
    { address: { ...base.address, addressLine2: "UNIT 2" } }]) {
    assert.throws(() => validate([base, { ...candidates[1], ...patch }]));
  }
  assert.throws(() => validate([base]));
  cases.push("date/contact/address/stage/eligibility changes or missing members fail closed");

  let claimed = false;
  let sends = 0;
  let accepted = 0;
  let uncertain = 0;
  const ports = {
    revalidate: async () => { validate(); },
    claim: async () => { if (claimed) return null; claimed = true; return "isolated-attempt"; },
    send: async () => { sends++; return { providerId: "isolated-provider-id" }; },
    recordAccepted: async () => { accepted++; },
    recordUncertain: async () => { uncertain++; },
  };
  const concurrent = await Promise.all([executeClaimedGroupSend(ports), executeClaimedGroupSend(ports)]);
  assert.deepEqual(concurrent.map(r => r.outcome).sort(), ["already_claimed", "submitted"]);
  assert.equal(sends, 1); assert.equal(accepted, 1);
  assert.equal((await executeClaimedGroupSend(ports)).outcome, "already_claimed");
  cases.push("concurrent calls and reruns invoke one simulated provider send");

  claimed = false;
  const failed = await executeClaimedGroupSend({ ...ports, send: async () => { sends++; throw new Error("timeout"); } });
  assert.equal(failed.outcome, "reconciliation_required");
  assert.equal((await executeClaimedGroupSend(ports)).outcome, "already_claimed");
  assert.equal(uncertain, 1);
  cases.push("provider timeout does not automatically resend");

  claimed = false;
  assert.equal((await executeClaimedGroupSend({ ...ports, recordAccepted: async () => { throw new Error("database unavailable"); } })).outcome, "reconciliation_required");
  assert.equal((await executeClaimedGroupSend(ports)).outcome, "already_claimed");
  cases.push("accepted provider response plus DB failure does not resend");

  claimed = false;
  let checks = 0;
  const before = sends;
  const changed = await executeClaimedGroupSend({ ...ports, revalidate: async () => { if (++checks === 2) throw new Error("opted out after claim"); } });
  assert.equal(changed.outcome, "reconciliation_required"); assert.equal(sends, before);
  cases.push("revalidation after claim blocks changed eligibility before send");

  for (const raw of ["queued", "accepted", "sending", "submitted", "sent"]) {
    assert.equal(nextGroupAttemptState("SUBMITTING", raw), "SUBMITTED");
    assert.equal(nextGroupAttemptState("DELIVERED", raw), "DELIVERED");
    assert.equal(nextGroupAttemptState("FAILED", raw), "FAILED");
  }
  for (const state of ["SUBMITTING", "SUBMITTED", "FAILED", "RECONCILIATION_REQUIRED"] as GroupAttemptState[]) {
    assert.equal(nextGroupAttemptState(state, "delivered"), "DELIVERED");
  }
  for (const raw of ["failed", "undelivered"]) {
    assert.equal(nextGroupAttemptState("SUBMITTED", raw), "FAILED");
    assert.equal(nextGroupAttemptState("DELIVERED", raw), "DELIVERED");
  }
  assert.equal(nextGroupAttemptState("SUBMITTED", "unknown"), "SUBMITTED");
  cases.push("provider status promotion, unknown statuses and downgrade protection");
  console.log(JSON.stringify({ ok: true, cases, realProviderCalls: 0, databaseWrites: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
