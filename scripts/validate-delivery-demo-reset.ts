import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgresql://validation:validation@localhost:5432/validation";

async function main() {
  const { parseDemoResetArgs, resolveDemoResetOrders, buildDemoResetPlan, demoResetBlockers,
    deleteDemoResetPlan, assertResetJobsFinished } = await import("./reset-delivery-demo");
  const a = { orderType: "SO", orderNumber: "SO38056" };
  const b = { orderType: "PL", orderNumber: "PL02718" };
  assert.equal(parseDemoResetArgs(["SO38056"]).apply, false);
  assert.equal(parseDemoResetArgs(["SO38056", "--apply"]).apply, true);
  assert.deepEqual(parseDemoResetArgs(["SO/SO38056", "PL02718"]).inputs, ["SO/SO38056", "PL02718"]);
  for (const args of [[], ["--apply"], ["*"], ["SO38056", "--all"], ["SO38056", "--preview", "--apply"]]) {
    assert.throws(() => parseDemoResetArgs(args));
  }
  await assert.rejects(resolveDemoResetOrders(["SO38056"], {
    order: { findMany: async () => [a, { orderType: "XX", orderNumber: "SO38056" }] },
  } as never), /ambiguous/);

  const time = new Date("2026-10-29T12:00:00Z");
  const base = {
    orders: [a], events: [{ ...a, id: "event-a", createdAt: time, attempts: [{ testRunId: "demo_example", status: "DELIVERED" }] }],
    groups: [], foreignEvents: [], confirmations: [{ ...a, id: "confirmation", notificationEventId: "event-a" }],
    holds: [], clearances: [], internalEvents: [], links: [],
  };
  assert.deepEqual(demoResetBlockers(base), []);
  assert.ok(demoResetBlockers({ ...base, events: [{ ...base.events[0], attempts: [{ testRunId: "production_42", status: "DELIVERED" }] }] }).length);
  assert.ok(demoResetBlockers({ ...base, events: [{ ...base.events[0], attempts: [{ testRunId: "demo_x", status: "CREATED" }] }] }).length);
  assert.ok(demoResetBlockers({ ...base, foreignEvents: [{ id: "production-event" }] }).length);
  assert.ok(demoResetBlockers({ ...base, confirmations: [{ ...a, id: "c", notificationEventId: "not-demo" }] }).length);
  assert.ok(demoResetBlockers({ ...base, holds: [{ ...a, id: "h", customerNotificationEventId: null, createdAt: time }] }).length);
  assert.ok(demoResetBlockers({ ...base, clearances: [{ ...a, id: "c", updatedAt: new Date("2020-01-01") }] }).length);
  assert.ok(demoResetBlockers({ ...base, internalEvents: [{ ...a, id: "i", createdAt: time, reasonSkipped: "internal_send_claimed", reasonFailed: null }] }).length);
  const group = { id: "group", runId: "demo_x", status: "SENT", members: [{ notificationEventId: "event-a" }, { notificationEventId: "event-b" }], attempts: [] };
  assert.ok(demoResetBlockers({ ...base, groups: [group] }).length, "partial multi-order reset is blocked");
  assert.deepEqual(demoResetBlockers({ ...base, orders: [a, b], groups: [group],
    events: [...base.events, { ...b, id: "event-b", createdAt: time, attempts: [] }] }), []);

  let requests = 0;
  process.env.MLD_QUEUE_BASE_URL = "https://queue.invalid";
  process.env.MLD_QUEUE_TOKEN = "mock-token";
  const request = (status: string) => (async (_url: unknown, options: { method?: string }) => {
    requests++;
    assert.equal(options.method, undefined, "queue verification is GET, never enqueue or delete");
    return Response.json({ status });
  }) as never;
  await assertResetJobsFinished([], request("queued"));
  assert.equal(requests, 0);
  await assert.rejects(assertResetJobsFinished(["job"], request("queued")), /wait before/);
  await assert.rejects(assertResetJobsFinished(["job"], request("processing")), /wait before/);
  await assertResetJobsFinished(["job"], request("succeeded"));
  await assertResetJobsFinished(["job"], request("failed"));

  const queries: Array<{ table: string; args: unknown }> = [];
  const tables = ["notificationEvent", "deliveryNotificationGroup", "deliveryConfirmation", "deliveryOrderHoldAction",
    "deliveryGroupTenDayConfirmation", "internalNotificationEvent", "deliveryDetailsLink"];
  const fake = Object.fromEntries(tables.map(table => [table, { findMany: async (args: unknown) => {
    queries.push({ table, args }); return [];
  } }]));
  const empty = await buildDemoResetPlan([a], fake as never);
  assert.equal(empty.events.length, 0);
  const eventQuery = JSON.stringify(queries[0]);
  assert.ok(eventQuery.includes("SO38056") && eventQuery.includes("demo_"));
  await assert.rejects(buildDemoResetPlan([], fake as never), /Explicit/);

  const calls: string[] = [];
  const deleteTables = [...tables, "deliveryNotificationGroupMember", "deliveryNotificationGroupAttempt"];
  const deletes = Object.fromEntries(deleteTables.map(table => [table, { deleteMany: async (args: unknown) => {
    calls.push(table);
    assert.ok(JSON.stringify(args).includes('"id":{"in":'), "deletes require reviewed explicit IDs");
    return { count: 0 };
  } }]));
  deletes.twilioMessageStatusCallback = { updateMany: async (args: unknown) => {
    calls.push("preserveCallbacks"); assert.ok(JSON.stringify(args).includes('"groupAttemptId":null')); return { count: 0 };
  } } as never;
  await assert.rejects(deleteDemoResetPlan(deletes as never, { ...empty, blockers: ["production data"] }), /production data/);
  assert.equal(calls.length, 0);
  await deleteDemoResetPlan(deletes as never, empty);
  assert.ok(calls.indexOf("deliveryNotificationGroupMember") < calls.indexOf("notificationEvent"));
  assert.ok(calls.indexOf("deliveryConfirmation") < calls.indexOf("notificationEvent"));
  assert.ok(!calls.includes("order") && !calls.includes("contact") && !calls.includes("smsOptOut"));
  const source = readFileSync("scripts/reset-delivery-demo.ts", "utf8");
  assert.ok(source.includes('if (!options.apply || !plan.events.length) return;'));
  assert.ok(source.indexOf("await writeFile(archive") < source.indexOf("await prisma.$transaction"));
  assert.ok(source.includes('isolationLevel: "Serializable"'));
  console.log("Demo reset validation passed: explicit orders, demo-only provenance, production/mixed-group protection, busy-send/writeback protection, preview default, archive-before-delete, ID-only deletes and callback audit preservation. No live DB, ERP or provider calls.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
