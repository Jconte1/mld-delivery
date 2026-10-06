import assert from "node:assert/strict";
import type { PrismaClient } from "../lib/generated/prisma/client";
import { claimDeliveryNotificationGroup, markDeliveryNotificationGroupUncertain, reconcileDeliveryNotificationGroupAttempt } from "../lib/notifications/deliveryNotificationGroupStore";
import { planDeliveryNotificationGroups, type GroupingCandidate } from "../lib/notifications/deliveryNotificationGrouping";

type Attempt = {
  id: string; groupId: string; attemptNumber: number; status: string; provider: string;
  externalMessageId: string | null; providerCode: string | null; submittedAt: Date | null;
  deliveredAt: Date | null; errorMessage: string | null;
};
const candidate: GroupingCandidate = {
  eventId: "a", orderNumber: "TEST-A", orderType: "SO", contactId: "test-contact",
  recipient: "test@example.invalid", channel: "EMAIL", interval: "DAY_14", action: "DELIVERY_REMINDER",
  stage: "initial", deliveryDate: "2026-11-12", eligible: true, freshlyImported: true, optedOut: false,
  address: { addressLine1: "1 Test Road", city: "Test", state: "UT", postalCode: "84000", country: "US" },
};
const candidates = [candidate, { ...candidate, eventId: "b", orderNumber: "TEST-B" }];
const plan = planDeliveryNotificationGroups(candidates, new Set(["a", "b"])).groups[0];

function fixture() {
  let state = {
    group: { id: "g", status: "PREPARED", membershipKey: plan.membershipKey,
      channel: "EMAIL", contactId: candidate.contactId, intervalType: candidate.interval,
      actionType: candidate.action, stage: candidate.stage, deliveryDate: new Date(candidate.deliveryDate),
      members: [{ notificationEventId: "a" }, { notificationEventId: "b" }] },
    events: ["a", "b"].map(id => ({ id, groupId: "g", status: "SCHEDULED", attempted: false })),
    attempts: [] as Attempt[],
  };
  let failCreate = false;
  function update<T extends object>(target: T, data: Partial<T>) {
    Object.assign(target, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
    return target;
  }
  const tx = {
    deliveryNotificationGroup: {
      findUnique: async ({ where }: { where: { id: string } }) => where.id === state.group.id ? structuredClone(state.group) : null,
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<typeof state.group> }) => {
        if (where.id !== state.group.id || where.status !== state.group.status) return { count: 0 };
        update(state.group, data); return { count: 1 };
      },
      update: async ({ data }: { data: Partial<typeof state.group> }) => update(state.group, data),
    },
    notificationEvent: {
      updateMany: async ({ where, data }: { where: { id?: { in: string[] }; status: string | { in: string[] }; attempts?: unknown; notificationGroupMember?: { groupId: string } }; data: { status: string } }) => {
        let count = 0;
        for (const event of state.events) {
          if (where.id && !where.id.in.includes(event.id)) continue;
          if (where.notificationGroupMember && event.groupId !== where.notificationGroupMember.groupId) continue;
          if (typeof where.status === "string" ? event.status !== where.status : !where.status.in.includes(event.status)) continue;
          if (where.attempts && event.attempted) continue;
          update(event, data); count++;
        }
        return { count };
      },
    },
    deliveryNotificationGroupAttempt: {
      create: async ({ data }: { data: Pick<Attempt, "groupId" | "attemptNumber" | "provider"> }) => {
        if (failCreate) throw new Error("simulated_insert_failure");
        const row: Attempt = { ...data, id: "attempt-1", status: "SUBMITTING", externalMessageId: null, providerCode: null,
          submittedAt: null, deliveredAt: null, errorMessage: null };
        state.attempts.push(row); return structuredClone(row);
      },
      findUnique: async ({ where }: { where: { id: string } }) => structuredClone(state.attempts.find(a => a.id === where.id) ?? null),
      findFirst: async ({ where }: { where: { groupId: string } }) => structuredClone(state.attempts.filter(a => a.groupId === where.groupId).sort((a, b) => b.attemptNumber - a.attemptNumber)[0] ?? null),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Attempt> }) => {
        const row = state.attempts.find(a => a.id === where.id);
        assert.ok(row); return update(row, data);
      },
    },
  };
  const client = { $transaction: async (run: (client: typeof tx) => Promise<unknown>, options: { isolationLevel: string }) => {
    assert.equal(options.isolationLevel, "Serializable");
    const before = structuredClone(state);
    try { return await run(tx); } catch (error) { state = before; throw error; }
  } } as unknown as Pick<PrismaClient, "$transaction">;
  return { client, state: () => state, failInsert: () => { failCreate = true; } };
}

async function main() {
  const cases: string[] = [];
  const claim = (f: ReturnType<typeof fixture>) => claimDeliveryNotificationGroup(f.client, { groupId: "g", freshCandidates: candidates, currentRunEventIds: new Set(["a", "b"]) });
  const callback = (f: ReturnType<typeof fixture>, rawStatus: string, attemptId = "attempt-1") => reconcileDeliveryNotificationGroupAttempt(f.client,
    { attemptId, provider: "ms_graph", externalMessageId: "message-test", rawStatus });
  const f = fixture();
  assert.equal(await claim(f), "attempt-1");
  assert.equal(f.state().attempts.length, 1);
  assert.ok(f.state().events.every(e => e.status === "PENDING"));
  assert.equal(await claim(f), null);
  cases.push("two events claimed with one shared attempt; rerun skipped");

  for (const mode of ["claimed", "attempted", "insert_failed"]) {
    const blocked = fixture();
    if (mode === "claimed") blocked.state().events[1].status = "SENT";
    if (mode === "attempted") blocked.state().events[1].attempted = true;
    if (mode === "insert_failed") blocked.failInsert();
    const before = structuredClone(blocked.state());
    await assert.rejects(claim(blocked));
    assert.deepEqual(blocked.state(), before);
  }
  cases.push("partial claim, prior attempt and insert failure roll back all modeled writes");
  await callback(f, "SENT");
  assert.equal(f.state().attempts[0].status, "SUBMITTED");
  await callback(f, "DELIVERED");
  await callback(f, "QUEUED");
  assert.equal(f.state().attempts[0].status, "DELIVERED");
  assert.equal(f.state().group.status, "DELIVERED");
  assert.ok(f.state().events.every(e => e.status === "SENT"));
  cases.push("callbacks promote shared attempt and both members without downgrade");
  const snapshot = structuredClone(f.state());
  await assert.rejects(reconcileDeliveryNotificationGroupAttempt(f.client, { attemptId: "attempt-1", provider: "twilio", externalMessageId: "wrong", rawStatus: "FAILED" }));
  assert.deepEqual(f.state(), snapshot);
  assert.deepEqual(await callback(f, "SENT", "missing"), { matched: false });
  cases.push("provider mismatch rejected and unmatched callback reported without writes");

  const failed = fixture(); await claim(failed); await callback(failed, "FAILED");
  assert.ok(failed.state().events.every(e => e.status === "FAILED"));
  await callback(failed, "QUEUED");
  assert.equal(failed.state().attempts[0].providerCode, "FAILED");
  const beforeUnknown = structuredClone(failed.state());
  await callback(failed, "NOT_A_PROVIDER_STATUS");
  assert.deepEqual(failed.state(), beforeUnknown);
  failed.state().attempts.push({ ...failed.state().attempts[0], id: "newer", attemptNumber: 2, status: "DELIVERED" });
  failed.state().group.status = "DELIVERED";
  failed.state().events.forEach(e => { e.status = "SENT"; });
  await callback(failed, "UNDELIVERED");
  assert.equal(failed.state().group.status, "DELIVERED");
  assert.ok(failed.state().events.every(e => e.status === "SENT"));
  cases.push("failed older attempt cannot fail newer successful group");

  const uncertain = fixture(); await claim(uncertain);
  await markDeliveryNotificationGroupUncertain(uncertain.client, "attempt-1");
  assert.equal(uncertain.state().group.status, "RECONCILIATION_REQUIRED");
  assert.equal(await claim(uncertain), null);
  await callback(uncertain, "DELIVERED");
  assert.equal(uncertain.state().group.status, "DELIVERED");
  cases.push("uncertain send blocks retry and later callback can resolve it");

  const old = fixture(); await claim(old);
  old.state().attempts.push({ ...old.state().attempts[0], id: "newer", attemptNumber: 2, status: "DELIVERED" });
  old.state().group.status = "DELIVERED";
  await markDeliveryNotificationGroupUncertain(old.client, "attempt-1");
  assert.equal(old.state().group.status, "DELIVERED");
  cases.push("uncertain older attempt cannot downgrade newer delivered group");
  console.log(JSON.stringify({ ok: true, cases, storage: "rollback-aware in-memory adapter", realDatabaseConcurrencyTested: false, providerCalls: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
