import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withExplicitDeliveryOrders, explicitDeliveryOrders, explicitDeliveryOrderWhere,
  assertExplicitDeliveryGroup, assertExplicitDeliveryOrders } from "../lib/notifications/explicitDeliveryRun";

process.env.DATABASE_URL ??= "postgresql://validation:validation@localhost:5432/validation";

async function main() {
  const { parseDemoArgs, resolveDemoOrder, runDeliveryDemo, demoEventIds, demoDiscoveryBlockReason } = await import("./run-delivery-demo");
  const { importSalesOrdersForLineRequestedOn } = await import("../lib/erp/importSalesOrders");
  const { deliveryOrderMatchesScope } = await import("../lib/notifications/orderScope");
  const a = { orderType: "SO", orderNumber: "SO12345" };
  const b = { orderType: "PL", orderNumber: "PL02718" };
  const outside = { orderType: "SO", orderNumber: "SO99999" };
  const now = new Date("2026-10-29T01:00:00Z");
  assert.equal(parseDemoArgs(["42", a.orderNumber], now).runDate, "2026-10-28");
  assert.equal(parseDemoArgs(["followup", a.orderNumber], now).action, "followup");
  assert.equal(parseDemoArgs(["noresponse", a.orderNumber], now).action, "followup");
  assert.equal(parseDemoArgs(["39", a.orderNumber], now).action, "followup");
  assert.equal(parseDemoArgs(["hold", a.orderNumber], now).action, "8");
  assert.throws(() => parseDemoArgs(["hold", a.orderNumber, b.orderNumber], now));
  assert.deepEqual(parseDemoArgs(["42", "SO/SO12345", b.orderNumber], now).orders, ["SO/SO12345", b.orderNumber]);
  for (const args of [["42"], ["bad", "SO12345"], ["42", "SO12345", "SO12345"], ["42", "*"],
    ["42", "SO12345", "--send"], ["42", "SO12345", "--run-date", "2026-02-30"], ["8", "SO12345", "PL02718"]]) {
    assert.throws(() => parseDemoArgs(args, now));
  }
  const row = { OrderType: { value: "SO" }, OrderNbr: { value: "SO12345" },
    Status: { value: "Open" }, ShipVia: { value: "DELIVERY SLC" } };
  assert.equal(demoDiscoveryBlockReason(row), null);
  assert.equal(demoDiscoveryBlockReason({ ...row, OrderType: { value: "QT" } }), "excluded_order_type");
  assert.equal(demoDiscoveryBlockReason({ ...row, ShipVia: { value: "WILL CALL" } }), "ship_via_not_delivery_eligible");
  assert.equal(demoDiscoveryBlockReason({ ...row, Status: { value: "Hold" } }), "order_status_not_discovery_eligible");
  await assert.rejects(resolveDemoOrder("SO12345", async () => [{ ...row, ShipVia: { value: "WILL CALL" } }]), /ship_via_not_delivery/);
  assert.deepEqual(await resolveDemoOrder("SO12345", async () => [row]), a);
  await assert.rejects(resolveDemoOrder("SO12345", async () => []), /missing or ambiguous/);
  await assert.rejects(resolveDemoOrder("SO12345", async () => [row, row]), /ambiguous/);
  await assert.rejects(resolveDemoOrder("PL/SO12345", async () => [row]), /missing/);

  let discovery = 0;
  const fullGets: string[] = [];
  const fakeErp = {
    fetchQualifyingSalesOrdersByLineRequestedOn: async () => { discovery++; return []; },
    fetchDeliverySalesOrderByOrderNumber: async (number: string) => { fullGets.push(number); return []; },
    fetchDeliveryContactByContactId: async () => { throw new Error("no contact requested for nonexistent order"); },
  };
  await withExplicitDeliveryOrders([a, b], async () => {
    assert.deepEqual(explicitDeliveryOrderWhere(), { OR: [a, b] });
    assert.equal(deliveryOrderMatchesScope(outside, null), false);
    assert.equal(deliveryOrderMatchesScope(a, null), true);
    assert.throws(() => assertExplicitDeliveryOrders([outside]), /outside/);
    assert.throws(() => assertExplicitDeliveryGroup([{ members: [a] }, { members: [b] }]), /compatible_group/);
    assert.throws(() => assertExplicitDeliveryGroup([{ members: [a] }]), /compatible_group/);
    assert.throws(() => assertExplicitDeliveryGroup([{ members: [a, a] }]), /compatible_group/);
    assertExplicitDeliveryGroup([{ members: [a, b] }]);
    const result = await importSalesOrdersForLineRequestedOn("2026-12-09", { erpClient: fakeErp });
    assert.equal(discovery, 0);
    assert.deepEqual(fullGets, [a.orderNumber, b.orderNumber]);
    assert.equal(result.failedOrders, 2);
    await assert.rejects(importSalesOrdersForLineRequestedOn("2026-12-09", {
      erpClient: fakeErp, orderLookups: [outside],
    }), /outside/);
    await withExplicitDeliveryOrders([a], async () => assert.equal(explicitDeliveryOrders()?.length, 1));
    assert.equal(explicitDeliveryOrders()?.length, 2);
  });
  assert.equal(explicitDeliveryOrders(), undefined);
  assert.deepEqual(explicitDeliveryOrderWhere(), {});
  assert.equal(deliveryOrderMatchesScope(outside, null), true);
  await importSalesOrdersForLineRequestedOn("2026-12-09", { erpClient: fakeErp });
  assert.equal(discovery, 1, "ordinary production imports retain date discovery");
  await assert.rejects(importSalesOrdersForLineRequestedOn("2026-12-09", {
    erpClient: fakeErp, explicitOrdersOnly: true,
  }), /requires_order/);

  // All target selectors receive the actual command-local SQL scope.
  const finders = [
    (await import("../lib/notifications/create42DayDeliveryConfirmationEvents")).find42DayDeliveryConfirmationTargetGroups,
    (await import("../lib/notifications/create30DayDeliveryReminderEvents")).find30DayDeliveryReminderTargetGroups,
    (await import("../lib/notifications/create12DayDeliveryPaymentRequestEvents")).find12DayDeliveryPaymentRequestTargetGroups,
    (await import("../lib/notifications/create10DayDeliveryPaymentRequestEvents")).find10DayDeliveryPaymentRequestTargetGroups,
    (await import("../lib/notifications/create8DayPaymentEnforcementEvents")).find8DayPaymentEnforcementTargetGroups,
    (await import("../lib/notifications/create2DayDeliveryReminderEvents")).find2DayDeliveryReminderTargetGroups,
  ];
  for (const find of finders) {
    let where: unknown;
    const client = { orderDeliveryGroup: { findMany: async (args: { where: unknown }) => { where = args.where; return []; } } };
    await withExplicitDeliveryOrders([a], () => find("2026-12-09", client as never));
    assert.deepEqual((where as { OR: unknown }).OR, [a]);
  }
  assert.deepEqual(demoEventIds({ currentRunCreatedEventIds: ["new-event"] }), ["new-event"]);
  assert.deepEqual(demoEventIds({ currentRunDispatchableReminderEventIds: ["new-reminder"] }), ["new-reminder"]);
  assert.deepEqual(demoEventIds({ oldScheduledDay42Events: ["old-event"] }), []);

  let executions = 0;
  let refreshed = 0;
  const dependencies = {
    now, preflight: () => {}, resolve: async (input: string) => input === b.orderNumber ? b : a,
    refresh: async () => { refreshed++; assert.ok(explicitDeliveryOrders()); return { successfullyRefreshedOrders: [a, b] } as never; },
    checkGroup: async () => {}, snapshot: async () => [],
    links: async () => ({ confirmationLinks: [], groupedLinks: [], detailsLinks: [] }), log: () => {},
    execute: async (options: { orderScope: unknown; runId: unknown }, followup: boolean) => {
      executions++; assert.ok(explicitDeliveryOrders()); assert.ok(options.runId);
      return { ok: true, followup, currentRunCreatedEventIds: [] } as never;
    },
  };
  await runDeliveryDemo(["42", a.orderNumber, b.orderNumber], dependencies);
  await runDeliveryDemo(["followup", a.orderNumber], dependencies);
  assert.equal(executions, 2);
  assert.equal(refreshed, 2);
  for (const [alias, interval, followup] of [["noresponse", "42", true], ["39", "42", true], ["hold", "8", false]] as const) {
    let called = false;
    await runDeliveryDemo([alias, a.orderNumber], {
      ...dependencies,
      execute: async (options, isFollowup) => {
        called = true;
        assert.equal(options.interval, interval);
        assert.equal(isFollowup, followup);
        assert.deepEqual(options.orderScope, a);
        assert.equal(options.send, true);
        assert.equal(explicitDeliveryOrders()?.length, 1);
        return { ok: true, currentRunCreatedEventIds: [] } as never;
      },
    });
    assert.equal(called, true, `${alias} delegates through the existing production execution path`);
  }
  await assert.rejects(runDeliveryDemo(["42", a.orderNumber], {
    ...dependencies, preflight: () => { throw new Error("production_gate_blocked"); },
  }), /production_gate/);
  await assert.rejects(runDeliveryDemo(["42", a.orderNumber], {
    ...dependencies, refresh: async () => { throw new Error("fresh_import_failed"); },
  }), /fresh_import_failed/);
  await assert.rejects(runDeliveryDemo(["42", a.orderNumber, b.orderNumber], {
    ...dependencies, checkGroup: async () => { throw new Error("group_mismatch"); },
  }), /group_mismatch/);
  assert.equal(executions, 2, "blocked runs cannot reach execution");
  assert.equal(explicitDeliveryOrders(), undefined, "scope is removed after errors");
  const dispatcher = readFileSync("lib/notifications/deliveryNotificationDispatcher.ts", "utf8");
  assert.ok(dispatcher.indexOf("assertExplicitDeliveryGroup(planned.groups)") < dispatcher.indexOf("for (const group of planned.groups)"));
  const noResponse = readFileSync("lib/notifications/deliveryConfirmationNoResponse.ts", "utf8");
  assert.match(noResponse, /const rows = await params.client.deliveryConfirmation.findMany\(\{\s*where: \{\s*\.\.\.explicitDeliveryOrderWhere\(\)/);
  console.log("Delivery demo validation passed: parser/Denver date, exact ERP resolution, no broad discovery, scoped selectors/refreshes, unchanged normal import, group refusal before send, production gates and followup routing. Fakes only; no live DB/provider/ERP calls.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
