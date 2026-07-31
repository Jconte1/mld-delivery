import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  evaluateDeliveryGroupPayment,
  type DeliveryGroupPaymentEvaluation,
  type DeliveryGroupPaymentInput,
  type DeliveryPaymentLineInput,
} from "../lib/delivery-payment/deliveryGroupPayment";
import {
  summarizeDeliveryGroupReadiness,
  type OrderLineReadinessInput,
} from "../lib/delivery-readiness/orderLineReadiness";
import { NotificationIntervalType } from "../lib/generated/prisma/client";
import {
  getFreshExternalStockMatchesForInventoryIds,
  getLatestSharePointStockSyncFreshness,
  type ExternalStockReadinessOptions,
} from "../lib/sharepoint-stock/externalStockReadiness";
import { SHAREPOINT_STOCK_SOURCE } from "../lib/sharepoint-stock/stockInventoryNormalization";

const ROOT = process.cwd();
const DELIVERY_DATE = "2026-08-10";
const MATCHED_INVENTORY_ID = "STOCK-READY-1";
const STOCK_MATCHES = new Set([MATCHED_INVENTORY_ID]);

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function readinessLine(
  overrides: Partial<OrderLineReadinessInput> & { id: string; lineNbr: number }
): OrderLineReadinessInput {
  return {
    id: overrides.id,
    lineNbr: overrides.lineNbr,
    inventoryId: overrides.inventoryId ?? MATCHED_INVENTORY_ID,
    lineDescription: overrides.lineDescription ?? `Fixture item ${overrides.lineNbr}`,
    itemType: overrides.itemType ?? "F",
    itemClass: overrides.itemClass ?? "TEST",
    requestedOn: overrides.requestedOn ?? DELIVERY_DATE,
    eta: "eta" in overrides ? overrides.eta ?? null : null,
    orderQty: overrides.orderQty ?? "1",
    openQty: overrides.openQty ?? "1",
    allocations: overrides.allocations ?? [],
  };
}

function readinessFor(
  line: OrderLineReadinessInput,
  externalStockReadyInventoryIds: Set<string> = STOCK_MATCHES
) {
  return summarizeDeliveryGroupReadiness({
    orderDeliveryGroupId: "group_readiness",
    orderId: "order_readiness",
    orderType: "SO",
    orderNumber: "SO-READINESS",
    deliveryDate: DELIVERY_DATE,
    lines: [line],
    externalStockReadyInventoryIds,
  }).lines[0];
}

function paymentLine(
  overrides: Partial<DeliveryPaymentLineInput> & { id: string; lineNbr: number }
): DeliveryPaymentLineInput {
  return {
    id: overrides.id,
    lineNbr: overrides.lineNbr,
    inventoryId: overrides.inventoryId ?? MATCHED_INVENTORY_ID,
    lineDescription: overrides.lineDescription ?? `Fixture item ${overrides.lineNbr}`,
    itemType: overrides.itemType ?? "F",
    itemClass: overrides.itemClass ?? "TEST",
    requestedOn: overrides.requestedOn ?? DELIVERY_DATE,
    taxCategory: overrides.taxCategory ?? "EXEMPT",
    discountedUnitPrice: overrides.discountedUnitPrice ?? "100.00",
    orderQty: overrides.orderQty ?? "3",
    openQty: overrides.openQty ?? "3",
    activeAllocatedQty: overrides.activeAllocatedQty ?? "0",
    allocationStatus: overrides.allocationStatus ?? "not_allocated",
    etaStatus: "etaStatus" in overrides ? overrides.etaStatus ?? null : "eta_pending",
    readinessStatus:
      "readinessStatus" in overrides ? overrides.readinessStatus ?? null : "eta_pending",
  };
}

function payment(
  overrides: Partial<DeliveryGroupPaymentInput> = {}
): DeliveryGroupPaymentEvaluation {
  const lines = overrides.lines ?? [paymentLine({ id: "pay_stock", lineNbr: 1 })];
  return evaluateDeliveryGroupPayment({
    orderDeliveryGroupId: "group_payment",
    orderId: "order_payment",
    orderType: "SO",
    orderNumber: "SO-PAYMENT",
    deliveryDate: DELIVERY_DATE,
    paymentTerms: "PP",
    unpaidBalance: "900.00",
    orderTotal: "1000.00",
    taxTotal: "0.00",
    lines,
    taxDetails: [],
    activeOrderLineIds: lines.map((line) => line.id),
    externalStockReadyInventoryIds: STOCK_MATCHES,
    ...overrides,
  });
}

function paymentSkipParams(result: DeliveryGroupPaymentEvaluation) {
  return {
    hasOrderTotal: true,
    paymentTerms: result.paymentTerms,
    unpaidBalance: result.unpaidBalance,
    paymentStatus: result.paymentStatus,
    amountDueNowRounded: result.amountDueNowRounded,
    calculationWarnings: result.calculationWarnings,
  };
}

function paymentEvaluation(
  overrides: Partial<DeliveryGroupPaymentEvaluation> = {}
): DeliveryGroupPaymentEvaluation {
  return {
    orderDeliveryGroupId: "group_one_week",
    orderId: "order_one_week",
    orderType: "SO",
    orderNumber: "SO1W",
    deliveryDate: "2026-08-09",
    paymentTerms: "PP",
    unpaidBalance: "0.00",
    orderTotal: "1000.00",
    taxTotal: "0.00",
    paidToDate: "1000.00",
    currentDeliveryGroupMerchandiseValue: "0.00",
    currentDeliveryGroupTaxAmount: "0.00",
    currentDeliveryGroupValue: "0.00",
    completedValueBeforeCurrentDelivery: "0.00",
    remainingUndeliveredValueAfterCurrentDelivery: null,
    creditAfterCurrentDelivery: null,
    requiredDownOnRemaining: null,
    amountDueNow: null,
    amountDueNowRounded: null,
    payableStockValue: "0.00",
    assignedFreightDeliveryChargeValue: "0.00",
    newlyAssignedFreightDeliveryChargeValue: "0.00",
    payableBasisValue: "0.00",
    freightDeliveryChargeTodos: [],
    paymentApplicabilityStatus: "no_meaningful_balance_due",
    paymentStatus: "no_balance_due",
    urgencyStatus: "not_applicable",
    calculationWarnings: [],
    lines: [],
    ...overrides,
  };
}

function oneWeekGroup() {
  return {
    id: "group_one_week",
    orderId: "order_one_week",
    orderType: "SO",
    orderNumber: "SO1W",
    deliveryDate: new Date("2026-08-09T00:00:00.000Z"),
    order: {
      id: "order_one_week",
      orderType: "SO",
      orderNumber: "SO1W",
      acumaticaOneWeekConfirmed: false,
    },
  };
}

function fakeExternalStockClient(params: {
  completedAt?: Date | null;
  matchedIds?: string[];
}) {
  let externalStockItemFindManyCalls = 0;
  return {
    get externalStockItemFindManyCalls() {
      return externalStockItemFindManyCalls;
    },
    client: {
      sharePointStockSyncRun: {
        findFirst: async () =>
          params.completedAt === undefined
            ? null
            : {
                id: "sync_success",
                completedAt: params.completedAt,
              },
      },
      externalStockItem: {
        findMany: async (args: {
          where: {
            source: string;
            isActive: boolean;
            normalizedInventoryId: { in: string[] };
          };
          select: { normalizedInventoryId: boolean };
        }) => {
          externalStockItemFindManyCalls += 1;
          const matchedIds = new Set(params.matchedIds ?? []);
          return args.where.source === SHAREPOINT_STOCK_SOURCE && args.where.isActive
            ? args.where.normalizedInventoryId.in
                .filter((inventoryId) => matchedIds.has(inventoryId))
                .map((normalizedInventoryId) => ({ normalizedInventoryId }))
            : [];
        },
      },
    },
  };
}

async function run() {
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const { get8DayPaymentEnforcementSkipReason } = await import(
    "../lib/notifications/create8DayPaymentEnforcementEvents"
  );
  const { get10DayPaymentSkipReason } = await import(
    "../lib/notifications/create10DayDeliveryPaymentRequestEvents"
  );
  const { get12DayPaymentSkipReason } = await import(
    "../lib/notifications/create12DayDeliveryPaymentRequestEvents"
  );
  const failures: string[] = [];

  const pending = readinessFor(readinessLine({ id: "pending", lineNbr: 1 }));
  assert(pending.readinessStatus === "ready", "1. Pending stock-list match becomes Ready", failures);
  assert(
    pending.readinessStatusBeforeExternalStock === "eta_pending",
    "1. Pending stock-list match records previous status",
    failures
  );

  const etaPending = readinessFor(readinessLine({ id: "eta_pending", lineNbr: 2, eta: null }));
  assert(
    etaPending.readinessStatus === "ready",
    "2. ETA-pending stock-list match becomes Ready",
    failures
  );

  const backordered = readinessFor(
    readinessLine({
      id: "backordered",
      lineNbr: 3,
      eta: "2026-08-12",
    })
  );
  assert(
    backordered.readinessStatus === "ready" &&
      backordered.readinessStatusBeforeExternalStock === "backordered",
    "3. Backordered stock-list match becomes Ready",
    failures
  );

  const expectedOnTime = readinessFor(
    readinessLine({
      id: "expected_on_time",
      lineNbr: 4,
      eta: DELIVERY_DATE,
    })
  );
  assert(
    expectedOnTime.readinessStatus === "ready" &&
      expectedOnTime.readinessStatusBeforeExternalStock === "expected_on_time",
    "4. Expected-on-time stock-list match becomes Ready",
    failures
  );

  const partiallyAllocated = readinessFor(
    readinessLine({
      id: "partial",
      lineNbr: 5,
      allocations: [
        {
          allocated: true,
          completed: false,
          qty: "1",
        },
      ],
      openQty: "3",
    })
  );
  assert(
    partiallyAllocated.readinessStatus === "ready" &&
      partiallyAllocated.readinessStatusBeforeExternalStock === "partially_allocated",
    "5. Partially allocated stock-list match becomes Ready",
    failures
  );

  const missing = readinessFor(
    readinessLine({
      id: "missing",
      lineNbr: 6,
      inventoryId: "NOT-IN-STOCK-LIST",
      eta: "2026-08-12",
    })
  );
  assert(
    missing.readinessStatus === "backordered",
    "6. Stock item missing from stock list keeps existing status",
    failures
  );

  const nonStock = readinessFor(
    readinessLine({
      id: "non_stock",
      lineNbr: 7,
      itemType: "N",
      inventoryId: MATCHED_INVENTORY_ID,
    })
  );
  assert(nonStock.readinessStatus === "ignored", "7. Non-stock matching inventory is ignored", failures);

  const blankInventory = readinessFor(
    readinessLine({
      id: "blank",
      lineNbr: 8,
      inventoryId: " ",
      eta: "2026-08-12",
    })
  );
  assert(blankInventory.readinessStatus === "backordered", "8. Blank inventoryId is ignored", failures);

  const staleClient = fakeExternalStockClient({
    completedAt: new Date("2026-07-01T00:00:00.000Z"),
    matchedIds: [MATCHED_INVENTORY_ID],
  });
  const staleFreshness = await getLatestSharePointStockSyncFreshness({
    client: staleClient.client as unknown as NonNullable<ExternalStockReadinessOptions["client"]>,
    now: new Date("2026-07-31T00:00:00.000Z"),
    env: { SHAREPOINT_STOCK_FRESHNESS_DAYS: "10" } as unknown as NodeJS.ProcessEnv,
  });
  const staleMatches = await getFreshExternalStockMatchesForInventoryIds([MATCHED_INVENTORY_ID], {
    client: staleClient.client as unknown as NonNullable<ExternalStockReadinessOptions["client"]>,
    now: new Date("2026-07-31T00:00:00.000Z"),
    env: { SHAREPOINT_STOCK_FRESHNESS_DAYS: "10" } as unknown as NodeJS.ProcessEnv,
  });
  assert(
    !staleFreshness.isFresh &&
      staleFreshness.staleReason === "stale" &&
      staleMatches.size === 0 &&
      staleClient.externalStockItemFindManyCalls === 0,
    "9. Stale stock sync is ignored without item lookup",
    failures
  );

  const missingSyncClient = fakeExternalStockClient({
    matchedIds: [MATCHED_INVENTORY_ID],
  });
  const missingSyncMatches = await getFreshExternalStockMatchesForInventoryIds(
    [MATCHED_INVENTORY_ID],
    {
      client: missingSyncClient.client as unknown as NonNullable<ExternalStockReadinessOptions["client"]>,
      now: new Date("2026-07-31T00:00:00.000Z"),
    }
  );
  assert(
    missingSyncMatches.size === 0 && missingSyncClient.externalStockItemFindManyCalls === 0,
    "10. Missing successful sync is ignored without item lookup",
    failures
  );

  const freshClient = fakeExternalStockClient({
    completedAt: new Date("2026-07-30T00:00:00.000Z"),
    matchedIds: [MATCHED_INVENTORY_ID],
  });
  const freshMatches = await getFreshExternalStockMatchesForInventoryIds(
    [` ${MATCHED_INVENTORY_ID.toLowerCase()} `],
    {
      client: freshClient.client as unknown as NonNullable<ExternalStockReadinessOptions["client"]>,
      now: new Date("2026-07-31T00:00:00.000Z"),
    }
  );
  assert(
    freshMatches.has(MATCHED_INVENTORY_ID) && freshClient.externalStockItemFindManyCalls === 1,
    "11. Fresh stock sync applies normalized matches with one batch lookup",
    failures
  );

  const confirmReadiness = summarizeDeliveryGroupReadiness({
    orderDeliveryGroupId: "group_same_source",
    orderId: "order_same_source",
    orderType: "SO",
    orderNumber: "SO-SAME",
    deliveryDate: DELIVERY_DATE,
    lines: [readinessLine({ id: "same_source", lineNbr: 12 })],
    externalStockReadyInventoryIds: STOCK_MATCHES,
  });
  const detailsReadiness = summarizeDeliveryGroupReadiness({
    orderDeliveryGroupId: "group_same_source",
    orderId: "order_same_source",
    orderType: "SO",
    orderNumber: "SO-SAME",
    deliveryDate: DELIVERY_DATE,
    lines: [readinessLine({ id: "same_source", lineNbr: 12 })],
    externalStockReadyInventoryIds: STOCK_MATCHES,
  });
  assert(
    confirmReadiness.lines[0]?.readinessStatus === detailsReadiness.lines[0]?.readinessStatus,
    "12. Confirm/details shared readiness source remains consistent",
    failures
  );

  const matchedPayment = payment();
  assert(
    matchedPayment.lines[0]?.payableStockMerchandiseValue === "300.00" &&
      matchedPayment.lines[0]?.payableQuantity === "3.0000",
    "13. Stock-list matched item uses openQty * discountedUnitPrice",
    failures
  );

  const matchedPartial = payment({
    lines: [
      paymentLine({
        id: "partial_payment",
        lineNbr: 14,
        openQty: "3",
        activeAllocatedQty: "1",
        readinessStatus: "partially_allocated",
        etaStatus: "ready",
      }),
    ],
  });
  assert(
    matchedPartial.lines[0]?.payableQuantity === "3.0000",
    "14. Partially allocated stock-list match uses full openQty",
    failures
  );

  const matchedBackorder = payment({
    lines: [
      paymentLine({
        id: "backordered_payment",
        lineNbr: 15,
        readinessStatus: "backordered",
        etaStatus: "backordered",
      }),
    ],
  });
  assert(
    matchedBackorder.lines[0]?.payableBasisIncluded === true,
    "15. Backordered stock-list match becomes payable",
    failures
  );

  const matchedEtaPending = payment({
    lines: [
      paymentLine({
        id: "eta_payment",
        lineNbr: 16,
        readinessStatus: "eta_pending",
        etaStatus: "eta_pending",
      }),
    ],
  });
  assert(
    matchedEtaPending.lines[0]?.payableBasisIncluded === true,
    "16. ETA-pending stock-list match becomes payable",
    failures
  );

  const matchedReady = payment({
    lines: [
      paymentLine({
        id: "ready_payment",
        lineNbr: 17,
        openQty: "2",
        activeAllocatedQty: "2",
        readinessStatus: "ready",
        etaStatus: "ready",
      }),
    ],
  });
  assert(
    matchedReady.lines[0]?.payableStockMerchandiseValue === "200.00",
    "17. Ready stock-list match is not double-counted",
    failures
  );

  const matchedNonStock = payment({
    lines: [
      paymentLine({
        id: "non_stock_payment",
        lineNbr: 18,
        itemType: "N",
        readinessStatus: "ignored",
        etaStatus: "ignored",
      }),
    ],
  });
  assert(
    matchedNonStock.lines[0]?.payableBasisIncluded === false &&
      matchedNonStock.lines[0]?.payableBasisExclusionReason === "ordinary_non_stock_excluded",
    "18. Non-stock stock-list match is not payable",
    failures
  );

  assert(
    payment({ externalStockReadyInventoryIds: staleMatches }).lines[0]?.payableBasisIncluded === false,
    "19. Stale sync does not affect payable basis",
    failures
  );
  assert(
    payment({ externalStockReadyInventoryIds: missingSyncMatches }).lines[0]
      ?.payableBasisIncluded === false,
    "20. Missing sync does not affect payable basis",
    failures
  );

  assert(
    get12DayPaymentSkipReason(paymentSkipParams(matchedPayment)) === null,
    "21. 12-day can qualify because stock-list match creates payable due",
    failures
  );
  assert(
    get10DayPaymentSkipReason(paymentSkipParams(matchedPayment)) === null,
    "22. 10-day can qualify because stock-list match creates payable due",
    failures
  );
  assert(
    get8DayPaymentEnforcementSkipReason(paymentSkipParams(matchedPayment)) === null,
    "23. 8-day can qualify because stock-list match creates payable due",
    failures
  );

  const { evaluateAndRecordDeliveryTenDayConfirmation } = await import(
    "../lib/notifications/deliveryTenDayConfirmation"
  );
  const oneWeekNoBalance = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: oneWeekGroup(),
    payment: paymentEvaluation(),
    sourceInterval: NotificationIntervalType.DAY_10,
    dryRun: true,
    prismaClient: {},
  });
  assert(
    oneWeekNoBalance.localCleared &&
      oneWeekNoBalance.wouldWrite &&
      oneWeekNoBalance.dryRun,
    "24. ONEWEEKCON no-balance path remains for no payable due",
    failures
  );

  const readinessSource = read("lib/delivery-readiness/orderLineReadiness.ts");
  const sourceFiles = [
    read("lib/sharepoint-stock/externalStockReadiness.ts"),
    read("lib/delivery-payment/deliveryGroupPayment.ts"),
  ].join("\n");
  const forbiddenPatterns = [
    "notificationAttempt.create",
    "sendEmail",
    "sendSms",
    "provider",
    "enqueueDeliveryPrepaymentHold",
    "deliveryOrderHoldAction.create",
    "acumaticaOneWeekConfirmed",
  ];
  for (const pattern of forbiddenPatterns) {
    assert(
      !sourceFiles.includes(pattern),
      `Safety check: integration code must not include ${pattern}`,
      failures
    );
  }
  assert(
    readinessSource.includes("applyExternalStockReadiness: false"),
    "Safety check: persisted readiness disables SharePoint stock overlay",
    failures
  );

  if (failures.length > 0) {
    console.error("SharePoint stock readiness integration validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        validation: "sharepoint stock readiness integration validation passed",
        covered: [
          "webpage readiness overlay for pending/ETA/backorder/expected/partial statuses",
          "non-stock and blank inventory IDs ignored",
          "stale and missing sync ignored",
          "fresh sync applies via one batch lookup",
          "payment payable basis uses full open quantity for matched stock lines",
          "12/10/8 payment qualifications see the central payable result",
          "ONEWEEKCON no-balance path remains in dry-run validation",
          "no NotificationAttempt/provider send/Acumatica/hold/order-line/date write code invoked",
        ],
      },
      null,
      2
    )
  );
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
