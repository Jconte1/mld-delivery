import {
  classifyOrderLineReadiness,
  type AllocationStatus,
  type EtaStatus,
  type OrderLineReadinessInput,
  type ReadinessStatus,
} from "../lib/delivery-readiness/orderLineReadiness";

type Expected = {
  allocationStatus: AllocationStatus;
  etaStatus: EtaStatus;
  readinessStatus: ReadinessStatus;
  displayStatus: string;
  activeAllocatedQty?: number;
};

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function baseLine(overrides: Partial<OrderLineReadinessInput> = {}): OrderLineReadinessInput {
  return {
    id: "line-test",
    lineNbr: 1,
    inventoryId: "ITEM",
    lineDescription: "Test item",
    itemType: "F",
    itemClass: "106",
    requestedOn: "2027-01-04T23:59:59.000Z",
    eta: "2027-01-04T00:00:01.000Z",
    orderQty: "1.0000",
    openQty: "1.0000",
    allocations: [],
    ...overrides,
  };
}

function runCase(name: string, line: OrderLineReadinessInput, expected: Expected) {
  const result = classifyOrderLineReadiness(line, "2027-01-04");
  assertEqual(result.allocationStatus, expected.allocationStatus, `${name} allocationStatus`);
  assertEqual(result.etaStatus, expected.etaStatus, `${name} etaStatus`);
  assertEqual(result.readinessStatus, expected.readinessStatus, `${name} readinessStatus`);
  assertEqual(result.displayStatus, expected.displayStatus, `${name} displayStatus`);
  if (expected.activeAllocatedQty !== undefined) {
    assertEqual(result.activeAllocatedQty, expected.activeAllocatedQty, `${name} activeAllocatedQty`);
  }
  return {
    name,
    allocationStatus: result.allocationStatus,
    etaStatus: result.etaStatus,
    readinessStatus: result.readinessStatus,
    displayStatus: result.displayStatus,
    activeAllocatedQty: result.activeAllocatedQty,
  };
}

const results = [
  runCase(
    "itemType N ignored",
    baseLine({ itemType: "N", openQty: "1.0000", eta: "2027-02-01" }),
    {
      allocationStatus: "ignored",
      etaStatus: "ignored",
      readinessStatus: "ignored",
      displayStatus: "Ignored",
      activeAllocatedQty: 0,
    }
  ),
  runCase("openQty 0 complete", baseLine({ openQty: "0.0000", eta: "2027-02-01" }), {
    allocationStatus: "complete",
    etaStatus: "complete",
    readinessStatus: "complete",
    displayStatus: "Complete",
    activeAllocatedQty: 0,
  }),
  runCase(
    "active allocation covers openQty",
    baseLine({
      openQty: "2.0000",
      eta: "2027-02-01",
      allocations: [{ allocated: true, completed: false, qty: "2.0000" }],
    }),
    {
      allocationStatus: "allocated",
      etaStatus: "ready",
      readinessStatus: "ready",
      displayStatus: "Ready",
      activeAllocatedQty: 2,
    }
  ),
  runCase(
    "unallocated row lets ETA decide",
    baseLine({
      eta: "2027-01-03",
      allocations: [{ allocated: false, completed: false, qty: "1.0000" }],
    }),
    {
      allocationStatus: "not_allocated",
      etaStatus: "expected_on_time",
      readinessStatus: "expected_on_time",
      displayStatus: "Expected on time",
      activeAllocatedQty: 0,
    }
  ),
  runCase(
    "completed rows ignored and active rows count",
    baseLine({
      openQty: "2.0000",
      allocations: [
        { allocated: true, completed: true, qty: "2.0000" },
        { allocated: true, completed: false, qty: "2.0000" },
      ],
    }),
    {
      allocationStatus: "allocated",
      etaStatus: "ready",
      readinessStatus: "ready",
      displayStatus: "Ready",
      activeAllocatedQty: 2,
    }
  ),
  runCase(
    "partial allocation",
    baseLine({
      openQty: "2.0000",
      allocations: [{ allocated: true, completed: false, qty: "1.0000" }],
    }),
    {
      allocationStatus: "partially_allocated",
      etaStatus: "expected_on_time",
      readinessStatus: "partially_allocated",
      displayStatus: "Partially ready",
      activeAllocatedQty: 1,
    }
  ),
  runCase("eta null pending", baseLine({ eta: null }), {
    allocationStatus: "not_allocated",
    etaStatus: "eta_pending",
    readinessStatus: "eta_pending",
    displayStatus: "ETA pending",
    activeAllocatedQty: 0,
  }),
  runCase("late ETA backordered", baseLine({ eta: "2027-01-05" }), {
    allocationStatus: "not_allocated",
    etaStatus: "backordered",
    readinessStatus: "backordered",
    displayStatus: "Backordered",
    activeAllocatedQty: 0,
  }),
  runCase("ETA on requested date expected on time", baseLine({ eta: "2027-01-04" }), {
    allocationStatus: "not_allocated",
    etaStatus: "expected_on_time",
    readinessStatus: "expected_on_time",
    displayStatus: "Expected on time",
    activeAllocatedQty: 0,
  }),
  runCase(
    "allocated line with late ETA remains ready",
    baseLine({
      eta: "2027-02-01",
      allocations: [{ allocated: true, completed: false, qty: "1.0000" }],
    }),
    {
      allocationStatus: "allocated",
      etaStatus: "ready",
      readinessStatus: "ready",
      displayStatus: "Ready",
      activeAllocatedQty: 1,
    }
  ),
  runCase(
    "date-only comparison ignores time",
    baseLine({
      requestedOn: "2027-01-04T00:00:00.000Z",
      eta: "2027-01-04T23:59:59.000Z",
    }),
    {
      allocationStatus: "not_allocated",
      etaStatus: "expected_on_time",
      readinessStatus: "expected_on_time",
      displayStatus: "Expected on time",
      activeAllocatedQty: 0,
    }
  ),
];

console.log(JSON.stringify({ cases: results.length, results }, null, 2));
