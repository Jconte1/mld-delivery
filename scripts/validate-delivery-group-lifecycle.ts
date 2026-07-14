import {
  DeliveryConfirmationStatus,
  NotificationActionType,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
  Prisma,
} from "../lib/generated/prisma/client";
import { persistOrderReadiness } from "../lib/delivery-readiness/orderLineReadiness";
import { syncOrderDeliveryGroups } from "../lib/erp/syncOrderDeliveryGroups";
import { prisma } from "../lib/prisma";

type Tx = Prisma.TransactionClient;

type FixtureOrder = {
  id: string;
  orderType: string;
  orderNumber: string;
  status: string | null;
  contactId: string;
};

type LineSeed = {
  lineNbr: number;
  requestedOn: string | null;
  itemType?: string;
  orderQty?: string;
  openQty?: string;
  eta?: string | null;
  allocatedQty?: string;
};

type GroupSnapshot = {
  id: string;
  deliveryDate: string;
  isActive: boolean;
  lineCount: number | null;
  lastSeenAt: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
  notificationEvents: number;
  deliveryConfirmations: number;
  readinessTotals: Record<string, number> | null;
};

type Snapshot = {
  deliveryGroups: GroupSnapshot[];
  activeGroupDates: string[];
  inactiveSupersededGroupDates: string[];
  futureTargetableGroupDates: string[];
  lineReadiness: Array<{
    lineNbr: number;
    requestedOn: string | null;
    activeAllocatedQty: string | null;
    allocationStatus: string | null;
    etaStatus: string | null;
    readinessStatus: string | null;
    displayStatus: string | null;
    readinessCalculatedAt: string | null;
  }>;
};

type ScenarioResult = {
  scenario: string;
  passed: boolean;
  notes: string;
  warnings: string[];
  before: Snapshot;
  middle?: Snapshot;
  after: Snapshot;
};

type LifecycleResult = {
  diagnosticRolledBack: boolean;
  safetyCounts: {
    before: SafetyCounts;
    after: SafetyCounts;
    unchanged: boolean;
    fixtureRowsRemaining: number;
  };
  scenarios: ScenarioResult[];
  summary: Array<{
    scenario: string;
    passed: boolean;
    notes: string;
    warnings: string[];
  }>;
};

type SafetyCounts = {
  notificationEvents: number;
  deliveryConfirmations: number;
  notificationAttempts: number;
};

class RollbackDiagnostic extends Error {
  constructor(readonly lifecycleResult: Omit<LifecycleResult, "diagnosticRolledBack" | "safetyCounts">) {
    super("rollback_delivery_group_lifecycle_validation");
  }
}

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateKey(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function byDate(snapshot: Snapshot, date: string) {
  return snapshot.deliveryGroups.find((group) => group.deliveryDate === date);
}

function sortedDates(values: Iterable<string>) {
  return [...values].sort();
}

function expect(condition: boolean, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function hasSameDates(actual: string[], expected: string[]) {
  return JSON.stringify(sortedDates(actual)) === JSON.stringify(sortedDates(expected));
}

async function safetyCounts(): Promise<SafetyCounts> {
  const [notificationEvents, deliveryConfirmations, notificationAttempts] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.deliveryConfirmation.count(),
    prisma.notificationAttempt.count(),
  ]);

  return { notificationEvents, deliveryConfirmations, notificationAttempts };
}

async function createFixtureOrder(
  tx: Tx,
  params: {
    prefix: string;
    scenarioId: string;
    lines: LineSeed[];
  }
): Promise<FixtureOrder> {
  const contact = await tx.contact.create({
    data: {
      contactId: `${params.prefix}-${params.scenarioId}-CONTACT`,
      displayName: `Lifecycle Diagnostic ${params.scenarioId}`,
      email: `${params.prefix.toLowerCase()}-${params.scenarioId.toLowerCase()}@example.com`,
    },
  });

  const order = await tx.order.create({
    data: {
      orderType: "TS",
      orderNumber: `${params.prefix}-${params.scenarioId}`,
      status: "Open",
      contactId: contact.contactId,
    },
  });

  for (const line of params.lines) {
    await createLine(tx, order, line);
  }

  return order;
}

async function createLine(tx: Tx, order: FixtureOrder, seed: LineSeed) {
  const orderLine = await tx.orderLine.create({
    data: {
      orderId: order.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      lineNbr: seed.lineNbr,
      requestedOn: seed.requestedOn ? day(seed.requestedOn) : null,
      inventoryId: `LIFE-${seed.lineNbr}`,
      lineDescription: `Lifecycle diagnostic line ${seed.lineNbr}`,
      itemType: seed.itemType ?? "F",
      itemClass: "LIFECYCLE",
      eta: seed.eta ? day(seed.eta) : null,
      orderQty: seed.orderQty ?? "1",
      openQty: seed.openQty ?? "1",
      warehouseId: "TEST",
    },
  });

  if (seed.allocatedQty) {
    await tx.orderLineAllocation.create({
      data: {
        orderLineId: orderLine.id,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        lineNbr: seed.lineNbr,
        splitLineNbr: 1,
        inventoryId: orderLine.inventoryId,
        allocated: true,
        completed: false,
        qty: seed.allocatedQty,
      },
    });
  }

  return orderLine;
}

async function updateLineRequestedOn(tx: Tx, order: FixtureOrder, lineNbr: number, requestedOn: string | null) {
  await tx.orderLine.update({
    where: { orderId_lineNbr: { orderId: order.id, lineNbr } },
    data: { requestedOn: requestedOn ? day(requestedOn) : null },
  });
}

async function deleteLine(tx: Tx, order: FixtureOrder, lineNbr: number) {
  await tx.orderLine.delete({
    where: { orderId_lineNbr: { orderId: order.id, lineNbr } },
  });
}

async function addAllocation(tx: Tx, order: FixtureOrder, lineNbr: number, qty: string) {
  const line = await tx.orderLine.findUniqueOrThrow({
    where: { orderId_lineNbr: { orderId: order.id, lineNbr } },
    select: { id: true, inventoryId: true },
  });

  await tx.orderLineAllocation.create({
    data: {
      orderLineId: line.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      lineNbr,
      splitLineNbr: 1,
      inventoryId: line.inventoryId,
      allocated: true,
      completed: false,
      qty,
    },
  });
}

async function addHistory(tx: Tx, order: FixtureOrder, deliveryDate: string) {
  const group = await tx.orderDeliveryGroup.findUniqueOrThrow({
    where: {
      orderId_deliveryDate: {
        orderId: order.id,
        deliveryDate: day(deliveryDate),
      },
    },
  });

  const event = await tx.notificationEvent.create({
    data: {
      orderId: order.id,
      deliveryGroupId: group.id,
      contactId: order.contactId,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: group.deliveryDate,
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
      dedupeKey: `${order.orderNumber}-${deliveryDate}-history`,
      selectedChannel: NotificationChannel.EMAIL,
      recipientEmail: `${order.orderNumber.toLowerCase()}@example.com`,
      status: NotificationEventStatus.SCHEDULED,
    },
  });

  await tx.deliveryConfirmation.create({
    data: {
      orderId: order.id,
      deliveryGroupId: group.id,
      notificationEventId: event.id,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: group.deliveryDate,
      contactId: order.contactId,
      status: DeliveryConfirmationStatus.PENDING,
      responseChannel: NotificationChannel.EMAIL,
    },
  });
}

async function syncFromCurrentLines(tx: Tx, order: FixtureOrder, importAt: Date) {
  const lines = await tx.orderLine.findMany({
    where: { orderId: order.id, requestedOn: { not: null } },
    select: { requestedOn: true },
  });

  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    const key = dateKey(line.requestedOn);
    if (key) lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
  }

  await syncOrderDeliveryGroups(tx, {
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    status: order.status,
    importAt,
    currentDeliveryGroups: sortedDates(lineCounts.keys()).map((deliveryDate) => ({
      deliveryDate: day(deliveryDate),
      lineCount: lineCounts.get(deliveryDate) ?? 0,
    })),
  });

  return persistOrderReadiness(order.id, tx);
}

async function snapshot(tx: Tx, order: FixtureOrder, readiness: Awaited<ReturnType<typeof persistOrderReadiness>>): Promise<Snapshot> {
  const readinessByGroup = new Map(
    readiness.deliveryGroups.map((group) => [group.orderDeliveryGroupId, group.totals])
  );
  const groups = await tx.orderDeliveryGroup.findMany({
    where: { orderId: order.id },
    orderBy: { deliveryDate: "asc" },
    include: {
      _count: {
        select: {
          notificationEvents: true,
          deliveryConfirmations: true,
        },
      },
    },
  });
  const futureTargetableGroups = await tx.orderDeliveryGroup.findMany({
    where: { orderId: order.id, isActive: true },
    orderBy: { deliveryDate: "asc" },
    select: { deliveryDate: true },
  });
  const lines = await tx.orderLine.findMany({
    where: { orderId: order.id },
    orderBy: { lineNbr: "asc" },
    select: {
      lineNbr: true,
      requestedOn: true,
      activeAllocatedQty: true,
      allocationStatus: true,
      etaStatus: true,
      readinessStatus: true,
      displayStatus: true,
      readinessCalculatedAt: true,
    },
  });

  const deliveryGroups = groups.map((group) => ({
    id: group.id,
    deliveryDate: dateKey(group.deliveryDate) ?? "",
    isActive: group.isActive,
    lineCount: group.lineCount,
    lastSeenAt: group.lastSeenAt?.toISOString() ?? null,
    supersededAt: group.supersededAt?.toISOString() ?? null,
    supersededReason: group.supersededReason,
    notificationEvents: group._count.notificationEvents,
    deliveryConfirmations: group._count.deliveryConfirmations,
    readinessTotals: readinessByGroup.get(group.id) ?? null,
  }));

  return {
    deliveryGroups,
    activeGroupDates: deliveryGroups.filter((group) => group.isActive).map((group) => group.deliveryDate),
    inactiveSupersededGroupDates: deliveryGroups
      .filter((group) => !group.isActive && group.supersededAt)
      .map((group) => group.deliveryDate),
    futureTargetableGroupDates: futureTargetableGroups.map((group) => dateKey(group.deliveryDate) ?? ""),
    lineReadiness: lines.map((line) => ({
      lineNbr: line.lineNbr,
      requestedOn: dateKey(line.requestedOn),
      activeAllocatedQty: line.activeAllocatedQty?.toString() ?? null,
      allocationStatus: line.allocationStatus,
      etaStatus: line.etaStatus,
      readinessStatus: line.readinessStatus,
      displayStatus: line.displayStatus,
      readinessCalculatedAt: line.readinessCalculatedAt?.toISOString() ?? null,
    })),
  };
}

async function syncAndSnapshot(tx: Tx, order: FixtureOrder, importAt: Date) {
  const readiness = await syncFromCurrentLines(tx, order, importAt);
  return snapshot(tx, order, readiness);
}

function scenarioResult(params: {
  scenario: string;
  before: Snapshot;
  after: Snapshot;
  middle?: Snapshot;
  failures: string[];
  notes: string;
  warnings?: string[];
}): ScenarioResult {
  return {
    scenario: params.scenario,
    passed: params.failures.length === 0,
    notes: params.failures.length > 0 ? params.failures.join("; ") : params.notes,
    warnings: params.warnings ?? [],
    before: params.before,
    middle: params.middle,
    after: params.after,
  };
}

async function runScenario1(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S01",
    lines: [
      { lineNbr: 1, requestedOn: "2027-01-01" },
      { lineNbr: 2, requestedOn: "2027-01-01" },
      { lineNbr: 3, requestedOn: "2027-01-02" },
    ],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  expect(hasSameDates(after.activeGroupDates, ["2027-01-01", "2027-01-02"]), "Date A and Date B should remain active", failures);
  expect(after.inactiveSupersededGroupDates.length === 0, "No groups should be superseded", failures);
  expect(byDate(after, "2027-01-01")?.lineCount === 2, "Date A lineCount should remain 2", failures);
  expect(byDate(after, "2027-01-02")?.lineCount === 1, "Date B lineCount should remain 1", failures);
  expect(byDate(after, "2027-01-01")?.lastSeenAt === day("2026-08-01").toISOString(), "Date A lastSeenAt should update", failures);
  return scenarioResult({
    scenario: "Scenario 1: No group change",
    before,
    after,
    failures,
    notes: "Date A and Date B remained active; line counts and lastSeenAt updated from the second sync.",
  });
}

async function runScenario2(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S02",
    lines: [
      { lineNbr: 1, requestedOn: "2027-01-01" },
      { lineNbr: 2, requestedOn: "2027-01-01" },
    ],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await createLine(tx, order, { lineNbr: 3, requestedOn: "2027-01-01", allocatedQty: "1" });
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  expect(byDate(before, "2027-01-01")?.lineCount === 2, "Date A before lineCount should be 2", failures);
  expect(byDate(after, "2027-01-01")?.lineCount === 3, "Date A after lineCount should be 3", failures);
  expect(after.deliveryGroups.length === 1 && after.activeGroupDates[0] === "2027-01-01", "Date A should remain the only active group", failures);
  expect(Boolean(byDate(after, "2027-01-01")?.readinessTotals), "Date A readiness totals should be recalculated", failures);
  return scenarioResult({
    scenario: "Scenario 2: Item added to existing group",
    before,
    after,
    failures,
    notes: "Date A remained active and lineCount increased from 2 to 3 with recalculated readiness.",
  });
}

async function runScenario3(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S03",
    lines: [
      { lineNbr: 1, requestedOn: "2027-01-01" },
      { lineNbr: 2, requestedOn: "2027-01-01" },
      { lineNbr: 3, requestedOn: "2027-01-01" },
    ],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await deleteLine(tx, order, 3);
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  expect(byDate(before, "2027-01-01")?.lineCount === 3, "Date A before lineCount should be 3", failures);
  expect(byDate(after, "2027-01-01")?.lineCount === 2, "Date A after lineCount should be 2", failures);
  expect(after.lineReadiness.every((line) => line.lineNbr !== 3), "Removed line should not appear in current readiness", failures);
  return scenarioResult({
    scenario: "Scenario 3: Item removed from existing group",
    before,
    after,
    failures,
    notes: "Date A remained active, lineCount decreased, and the removed line no longer contributed to readiness.",
  });
}

async function runScenario4(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S04",
    lines: [{ lineNbr: 1, requestedOn: "2027-01-01" }],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await createLine(tx, order, { lineNbr: 2, requestedOn: "2027-01-02" });
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  expect(hasSameDates(after.activeGroupDates, ["2027-01-01", "2027-01-02"]), "Date A and new Date B should be active", failures);
  expect(hasSameDates(after.futureTargetableGroupDates, ["2027-01-01", "2027-01-02"]), "Future targeting should see Date A and Date B", failures);
  return scenarioResult({
    scenario: "Scenario 4: New delivery group forms",
    before,
    after,
    failures,
    notes: "Date B was created active while Date A remained active.",
  });
}

async function runScenario5(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S05",
    lines: [
      { lineNbr: 1, requestedOn: "2027-01-01" },
      { lineNbr: 2, requestedOn: "2027-01-02" },
    ],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await deleteLine(tx, order, 2);
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  const dateB = byDate(after, "2027-01-02");
  expect(byDate(after, "2027-01-01")?.isActive === true, "Date A should remain active", failures);
  expect(Boolean(dateB), "Date B should not be hard-deleted", failures);
  expect(dateB?.isActive === false, "Date B should be inactive", failures);
  expect(Boolean(dateB?.supersededAt), "Date B supersededAt should be set", failures);
  expect(dateB?.supersededReason === "not_present_in_latest_erp_payload", "Date B supersededReason should be set", failures);
  expect(!after.futureTargetableGroupDates.includes("2027-01-02"), "Date B should be excluded from future targeting", failures);
  return scenarioResult({
    scenario: "Scenario 5: Delivery group disappears",
    before,
    after,
    failures,
    notes: "Date B was preserved as inactive/superseded and excluded from future targeting.",
  });
}

async function runScenario6(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S06",
    lines: [{ lineNbr: 1, requestedOn: "2027-01-01" }],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await updateLineRequestedOn(tx, order, 1, "2027-01-02");
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  expect(byDate(after, "2027-01-01")?.isActive === false, "Date A should be inactive after its only line moved", failures);
  expect(byDate(after, "2027-01-02")?.isActive === true, "Date B should be active after the line moved", failures);
  expect(byDate(after, "2027-01-02")?.lineCount === 1, "Date B lineCount should be 1", failures);
  expect(after.lineReadiness[0]?.requestedOn === "2027-01-02", "Line 1 should be evaluated under Date B", failures);
  return scenarioResult({
    scenario: "Scenario 6: Line moves from one group to another",
    before,
    after,
    failures,
    notes: "Line 1 moved to Date B; Date A was superseded and Date B became active.",
  });
}

async function runScenario7(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S07",
    lines: [1, 2, 3, 4, 5].map((lineNbr) => ({ lineNbr, requestedOn: "2027-01-01" })),
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await updateLineRequestedOn(tx, order, 3, "2027-01-02");
  await updateLineRequestedOn(tx, order, 4, "2027-01-02");
  await updateLineRequestedOn(tx, order, 5, "2027-01-03");
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  expect(hasSameDates(after.activeGroupDates, ["2027-01-01", "2027-01-02", "2027-01-03"]), "Dates A, B, and C should be active", failures);
  expect(byDate(after, "2027-01-01")?.lineCount === 2, "Date A lineCount should be 2", failures);
  expect(byDate(after, "2027-01-02")?.lineCount === 2, "Date B lineCount should be 2", failures);
  expect(byDate(after, "2027-01-03")?.lineCount === 1, "Date C lineCount should be 1", failures);
  return scenarioResult({
    scenario: "Scenario 7: One group splits into multiple groups",
    before,
    after,
    failures,
    notes: "Date A stayed active with fewer lines; Date B and Date C became active with separate readiness totals.",
  });
}

async function runScenario8(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S08",
    lines: [
      { lineNbr: 1, requestedOn: "2027-01-01" },
      { lineNbr: 2, requestedOn: "2027-01-02" },
      { lineNbr: 3, requestedOn: "2027-01-03" },
    ],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await updateLineRequestedOn(tx, order, 1, "2027-01-04");
  await updateLineRequestedOn(tx, order, 2, "2027-01-04");
  await updateLineRequestedOn(tx, order, 3, "2027-01-04");
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  expect(hasSameDates(after.activeGroupDates, ["2027-01-04"]), "Only Date D should be active", failures);
  expect(hasSameDates(after.inactiveSupersededGroupDates, ["2027-01-01", "2027-01-02", "2027-01-03"]), "Dates A, B, and C should be superseded", failures);
  expect(byDate(after, "2027-01-04")?.lineCount === 3, "Date D lineCount should be 3", failures);
  return scenarioResult({
    scenario: "Scenario 8: Multiple groups merge into one group",
    before,
    after,
    failures,
    notes: "Date D became the only active group; old groups were preserved inactive.",
  });
}

async function runScenario9(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S09",
    lines: [{ lineNbr: 1, requestedOn: "2027-01-01" }],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await addHistory(tx, order, "2027-01-01");
  await deleteLine(tx, order, 1);
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  const dateA = byDate(after, "2027-01-01");
  expect(Boolean(dateA), "Date A should not be deleted", failures);
  expect(dateA?.isActive === false, "Date A should be inactive", failures);
  expect(dateA?.notificationEvents === 1, "NotificationEvent history should remain", failures);
  expect(dateA?.deliveryConfirmations === 1, "DeliveryConfirmation history should remain", failures);
  expect(!after.futureTargetableGroupDates.includes("2027-01-01"), "Date A should be excluded from future targeting", failures);
  return scenarioResult({
    scenario: "Scenario 9: Group disappears with notification/confirmation history",
    before,
    after,
    failures,
    notes: "Historical notification and confirmation records remained while Date A became inactive.",
  });
}

async function runScenario10(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S10",
    lines: [{ lineNbr: 1, requestedOn: "2027-01-01" }],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await deleteLine(tx, order, 1);
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  const dateA = byDate(after, "2027-01-01");
  expect(Boolean(dateA), "Date A should be preserved even without history", failures);
  expect(dateA?.isActive === false, "Date A should be inactive", failures);
  expect(dateA?.notificationEvents === 0, "Date A should have no notification history", failures);
  expect(dateA?.deliveryConfirmations === 0, "Date A should have no confirmation history", failures);
  return scenarioResult({
    scenario: "Scenario 10: Group disappears with no history",
    before,
    after,
    failures,
    notes: "Date A was preserved as inactive/superseded for consistency.",
  });
}

async function runScenario11(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S11",
    lines: [{ lineNbr: 1, requestedOn: "2027-01-01" }],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await updateLineRequestedOn(tx, order, 1, null);
  const middle = await syncAndSnapshot(tx, order, day("2026-08-01"));
  await updateLineRequestedOn(tx, order, 1, "2027-01-01");
  const after = await syncAndSnapshot(tx, order, day("2026-09-01"));
  const failures: string[] = [];
  const beforeDateA = byDate(before, "2027-01-01");
  const middleDateA = byDate(middle, "2027-01-01");
  const afterDateA = byDate(after, "2027-01-01");
  expect(middleDateA?.isActive === false, "Date A should be inactive after disappearing", failures);
  expect(afterDateA?.isActive === true, "Date A should reactivate when the date reappears", failures);
  expect(beforeDateA?.id === afterDateA?.id, "Current code should reactivate the same Date A group id", failures);
  expect(afterDateA?.supersededAt === null, "Reactivated Date A should clear supersededAt", failures);
  return scenarioResult({
    scenario: "Scenario 11: Group disappears and later reappears",
    before,
    middle,
    after,
    failures,
    notes: "Current behavior is Option A: the same orderId+deliveryDate group is reactivated.",
    warnings: [
      "Business decision: reusing the same group id is mechanically safe for preserving history, but may affect notification dedupe/confirmation semantics if a previously superseded date with history becomes current again.",
    ],
  });
}

async function runScenario12(tx: Tx, prefix: string): Promise<ScenarioResult> {
  const order = await createFixtureOrder(tx, {
    prefix,
    scenarioId: "S12",
    lines: [{ lineNbr: 1, requestedOn: "2027-01-01", eta: null, openQty: "1" }],
  });
  const before = await syncAndSnapshot(tx, order, day("2026-07-01"));
  await addAllocation(tx, order, 1, "1");
  const after = await syncAndSnapshot(tx, order, day("2026-08-01"));
  const failures: string[] = [];
  const beforeTotals = JSON.stringify(byDate(before, "2027-01-01")?.readinessTotals);
  const afterTotals = JSON.stringify(byDate(after, "2027-01-01")?.readinessTotals);
  expect(byDate(after, "2027-01-01")?.isActive === true, "Date A should remain active", failures);
  expect(beforeTotals !== afterTotals, "Readiness totals should change after source allocation changes", failures);
  expect(Boolean(after.lineReadiness[0]?.readinessCalculatedAt), "Readiness fields should be persisted after recalculation", failures);
  return scenarioResult({
    scenario: "Scenario 12: Readiness changes while group remains",
    before,
    after,
    failures,
    notes: "Date A stayed active and persisted readiness fields refreshed from the existing readiness helper.",
  });
}

async function main() {
  const prefix = `DGLIFE${Date.now()}`;
  const beforeCounts = await safetyCounts();
  let rolledBackResult: Omit<LifecycleResult, "diagnosticRolledBack" | "safetyCounts"> | null = null;

  try {
    await prisma.$transaction(
      async (tx) => {
        const scenarios = [
          await runScenario1(tx, prefix),
          await runScenario2(tx, prefix),
          await runScenario3(tx, prefix),
          await runScenario4(tx, prefix),
          await runScenario5(tx, prefix),
          await runScenario6(tx, prefix),
          await runScenario7(tx, prefix),
          await runScenario8(tx, prefix),
          await runScenario9(tx, prefix),
          await runScenario10(tx, prefix),
          await runScenario11(tx, prefix),
          await runScenario12(tx, prefix),
        ];

        rolledBackResult = {
          scenarios,
          summary: scenarios.map((scenario) => ({
            scenario: scenario.scenario,
            passed: scenario.passed,
            notes: scenario.notes,
            warnings: scenario.warnings,
          })),
        };

        throw new RollbackDiagnostic(rolledBackResult);
      },
      { timeout: 60_000 }
    );
  } catch (error) {
    if (error instanceof RollbackDiagnostic) {
      rolledBackResult = error.lifecycleResult;
    } else {
      throw error;
    }
  }

  const afterCounts = await safetyCounts();
  const fixtureRowsRemaining = await prisma.order.count({
    where: { orderNumber: { startsWith: prefix } },
  });
  const result: LifecycleResult = {
    diagnosticRolledBack: true,
    safetyCounts: {
      before: beforeCounts,
      after: afterCounts,
      unchanged:
        beforeCounts.notificationEvents === afterCounts.notificationEvents &&
        beforeCounts.deliveryConfirmations === afterCounts.deliveryConfirmations &&
        beforeCounts.notificationAttempts === afterCounts.notificationAttempts,
      fixtureRowsRemaining,
    },
    scenarios: rolledBackResult?.scenarios ?? [],
    summary: rolledBackResult?.summary ?? [],
  };

  console.log(JSON.stringify(result, null, 2));

  const failed = result.summary.filter((scenario) => !scenario.passed);
  if (failed.length > 0) {
    throw new Error(`Delivery group lifecycle validation failed: ${failed.map((scenario) => scenario.scenario).join(", ")}`);
  }

  if (!result.safetyCounts.unchanged || result.safetyCounts.fixtureRowsRemaining !== 0) {
    throw new Error("Lifecycle diagnostic left persistent data or changed safety counts.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
