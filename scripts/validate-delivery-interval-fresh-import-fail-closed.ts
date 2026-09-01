import { readFileSync } from "fs";
import { join } from "path";

import type { ImportSalesOrdersResult } from "../lib/erp/importSalesOrders";
import {
  FRESH_IMPORT_FAILED_SKIP_REASON,
  createFreshImportFailedOrderLookup,
  getFreshImportFailedOrders,
  getFreshImportSuccessfulOrders,
  isFreshImportFailedOrder,
  isFreshImportNotRefreshedOrder,
  prepareFreshDeliveryIntervalImport,
} from "../lib/notifications/freshDeliveryIntervalImport";

const ROOT = process.cwd();

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(source.includes(pattern), message, failures);
}

function assertBefore(
  source: string,
  earlier: string,
  later: string,
  message: string,
  failures: string[]
) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert(
    earlierIndex >= 0 && laterIndex >= 0 && earlierIndex < laterIndex,
    message,
    failures
  );
}

function importResult(errors: ImportSalesOrdersResult["errors"]): ImportSalesOrdersResult {
  return {
    requestedOn: "2026-11-17T09:19:00.000Z",
    qualifyingOrdersFetched: 3,
    fullOrdersFetched: 1,
    successfullyRefreshedOrders: [{ orderType: "SO", orderNumber: "SOGOOD" }],
    contactsUpserted: 0,
    ordersCreated: 0,
    ordersUpdated: 1,
    totalsUpserted: 0,
    taxDetailsUpserted: 0,
    linesUpserted: 0,
    allocationsUpserted: 0,
    addressesUpserted: 0,
    deliveryGroupsUpserted: 0,
    deliveryGroupLinesUpserted: 0,
    deliveryGroupLinesCreated: 0,
    deliveryGroupLinesReactivated: 0,
    deliveryGroupLinesDeactivated: 0,
    deliveryGroupLinesExcludedNonStock: 0,
    deliveryGroupLinesExcludedService: 0,
    deliveryGroupLinesExcludedUnknownItemType: 0,
    deliveryGroupLinesExcludedMissingRequestedOn: 0,
    deliveryGroupLinesExcludedMissingDeliveryGroup: 0,
    changeEventsDetected: 0,
    changeEventsCreated: 0,
    changeEventsDeduped: 0,
    skippedOrders: 0,
    failedOrders: errors.length,
    errors,
  };
}

async function validateSharedHelper(failures: string[]) {
  const result = importResult([
    {
      orderType: "so",
      orderNumber: "SOFAIL",
      reason: "Step 2 full SalesOrder fetch failed: timeout",
    },
    {
      orderNumber: "UNTYPED",
      reason: "Step 2 did not return a matching full SalesOrder",
    },
    {
      orderType: "SO",
      orderNumber: "BENIGN",
      reason: "Delivery group line skipped missing RequestedOn",
    },
  ]);
  const failedOrders = getFreshImportFailedOrders(result);
  const lookup = createFreshImportFailedOrderLookup(failedOrders);

  assert(
    failedOrders.length === 2,
    "shared helper only treats per-order failed full imports as failed-order exclusions",
    failures
  );
  assert(
    lookup.keys.includes("SO:SOFAIL") && lookup.keys.includes(":UNTYPED"),
    "shared helper exposes typed and untyped failed-order lookup keys",
    failures
  );
  assert(
    isFreshImportFailedOrder({ failedOrderLookup: lookup, orderType: "SO", orderNumber: "SOFAIL" }),
    "typed failed import matches the target order",
    failures
  );
  assert(
    isFreshImportFailedOrder({ failedOrderLookup: lookup, orderType: "SO", orderNumber: "UNTYPED" }),
    "untyped failed import matches by order number",
    failures
  );
  assert(
    !isFreshImportFailedOrder({ failedOrderLookup: lookup, orderType: "SO", orderNumber: "BENIGN" }),
    "non-failed import errors do not exclude successful imported orders",
    failures
  );
  const successfulLookup = createFreshImportFailedOrderLookup(getFreshImportSuccessfulOrders(result));
  assert(
    successfulLookup.keys.includes("SO:SOGOOD"),
    "shared helper exposes successfully refreshed orders",
    failures
  );
  assert(
    !isFreshImportNotRefreshedOrder({
      freshImport: {
        required: true,
        performed: true,
        targetDate: "2026-11-17",
        requestedOn: "2026-11-17T09:19:00.000Z",
        skippedReason: null,
        importResult: result,
        failedOrders,
        failedOrderLookup: lookup,
        successfulOrderLookup: successfulLookup,
        globalFailed: false,
        perOrderFailed: false,
        errorMessage: null,
      },
      orderType: "SO",
      orderNumber: "SOGOOD",
    }),
    "successfully refreshed orders are allowed to evaluate",
    failures
  );
  assert(
    isFreshImportNotRefreshedOrder({
      freshImport: {
        required: true,
        performed: true,
        targetDate: "2026-11-17",
        requestedOn: "2026-11-17T09:19:00.000Z",
        skippedReason: null,
        importResult: result,
        failedOrders,
        failedOrderLookup: lookup,
        successfulOrderLookup: successfulLookup,
        globalFailed: false,
        perOrderFailed: false,
        errorMessage: null,
      },
      orderType: "SO",
      orderNumber: "STALE_LOCAL_ONLY",
    }),
    "local target-date orders absent from the current fresh import are excluded",
    failures
  );

  const globalFailure = await prepareFreshDeliveryIntervalImport({
    targetDeliveryDate: "2026-11-17",
    dryRun: false,
    requireQueueBackedImport: false,
    importSalesOrders: async () => {
      throw new Error("queue unavailable");
    },
  });
  assert(globalFailure.globalFailed, "global import exception is captured as globalFailed", failures);
  assert(
    globalFailure.skippedReason === FRESH_IMPORT_FAILED_SKIP_REASON,
    "global import exception reports fresh_import_failed",
    failures
  );
  assert(!globalFailure.performed, "global import exception does not report performed import", failures);
}

function validateSource(failures: string[]) {
  const sharedReminder = read("lib/notifications/createDeliveryReminderEvents.ts");
  const confirmation42 = read("lib/notifications/create42DayDeliveryConfirmationEvents.ts");
  const reminder30 = read("lib/notifications/create30DayDeliveryReminderEvents.ts");
  const reminder14 = read("lib/notifications/create14DayDeliveryReminderEvents.ts");
  const payment12 = read("lib/notifications/create12DayDeliveryPaymentRequestEvents.ts");
  const payment10 = read("lib/notifications/create10DayDeliveryPaymentRequestEvents.ts");
  const enforcement8 = read("lib/notifications/create8DayPaymentEnforcementEvents.ts");
  const reminder2 = read("lib/notifications/create2DayDeliveryReminderEvents.ts");
  const harness = read("scripts/run-production-style-delivery-full-interval-test.ts");
  const pkg = read("package.json");

  for (const [label, source] of [
    ["180/90/60", sharedReminder],
    ["42", confirmation42],
    ["30/14", reminder30],
    ["12", payment12],
    ["10", payment10],
    ["8", enforcement8],
    ["2", reminder2],
  ] as const) {
    assertIncludes(
      source,
      "FRESH_IMPORT_FAILED_SKIP_REASON",
      `${label} uses the standardized fresh_import_failed skip reason`,
      failures
    );
    assertIncludes(
      source,
      "deliveryGroupsSkippedFailedImport",
      `${label} reports failed fresh-import delivery group count`,
      failures
    );
    assertIncludes(
      source,
      "failedImportExclusions",
      `${label} exposes failed fresh-import order details in the summary/export shape`,
      failures
    );
    assertIncludes(
      source,
      "FRESH_IMPORT_NOT_REFRESHED_SKIP_REASON",
      `${label} uses the standardized fresh_import_not_refreshed skip reason`,
      failures
    );
    assertIncludes(
      source,
      "isFreshImportNotRefreshedOrder({",
      `${label} excludes local target-date orders absent from the current ERP import`,
      failures
    );
  }

  assertBefore(
    sharedReminder,
    "summary.freshImport = await prepareFreshDeliveryIntervalImport",
    "const deliveryGroups = await client.orderDeliveryGroup.findMany",
    "180/90/60 import before target evaluation",
    failures
  );
  assertBefore(
    sharedReminder,
    "isFreshImportFailedOrder({",
    "const dedupeKey = buildNotificationDedupeKey",
    "180/90/60 exclude failed imports before event dedupe/creation",
    failures
  );
  assertBefore(
    sharedReminder,
    "isFreshImportFailedOrder({",
    "summary.eligibleDeliveryGroups += 1",
    "180/90/60 do not evaluate failed-import orders as eligible",
    failures
  );
  assertIncludes(
    sharedReminder,
    "summary.freshImport.globalFailed",
    "180/90/60 stop safely on global import failure",
    failures
  );

  assertBefore(
    confirmation42,
    "summary.freshImport = await prepareFreshDeliveryIntervalImport",
    "const allDeliveryGroups = await find42DayDeliveryConfirmationTargetGroups",
    "42 import before target evaluation",
    failures
  );
  assertBefore(
    confirmation42,
    "isFreshImportFailedOrder({",
    "const dedupeKey = buildNotificationDedupeKey",
    "42 excludes failed imports before event dedupe/creation",
    failures
  );
  assertBefore(
    confirmation42,
    "isFreshImportFailedOrder({",
    "const confirmation = await ensurePendingDeliveryConfirmation",
    "42 excludes failed imports before DeliveryConfirmation creation",
    failures
  );
  assertIncludes(
    confirmation42,
    "summary.freshImport.globalFailed",
    "42 stops safely on global import failure",
    failures
  );

  assertBefore(
    reminder30,
    "summary.importResult = await importSalesOrdersForLineRequestedOn(importRequestedOn)",
    "const unscopedDeliveryGroups = await find30DayDeliveryReminderTargetGroups",
    "30/14 import before target evaluation",
    failures
  );
  assertBefore(
    reminder30,
    "isFreshImportFailedOrder({",
    "const dedupeKey = buildNotificationDedupeKey",
    "30/14 exclude failed imports before event dedupe/creation",
    failures
  );
  assertBefore(
    reminder30,
    "isFreshImportFailedOrder({",
    "const detailsLink = await ensureDeliveryDetailsLink",
    "30/14 exclude failed imports before details link creation",
    failures
  );
  assertIncludes(
    reminder14,
    "createConfirmedDeliveryReminderEvents",
    "14-day uses the protected 30/14 shared creator",
    failures
  );
  assertIncludes(
    reminder14,
    "intervalDays: DELIVERY_REMINDER_14_DAY_INTERVAL_DAYS",
    "14-day keeps its own target interval while sharing the guard",
    failures
  );

  for (const [label, source, matcher, creatorMarker] of [
    ["12", payment12, "isOrderExcludedBy12DayFailedImport({", "const dedupeKey = buildNotificationDedupeKey"],
    ["10", payment10, "isOrderExcludedBy10DayFailedImport({", "const dedupeKey = buildNotificationDedupeKey"],
    ["2", reminder2, "isOrderExcludedBy2DayFailedImport({", "const dedupeKey = buildNotificationDedupeKey"],
    ["8", enforcement8, "isOrderExcludedBy8DayFailedImport({", "const acumaticaConfirmVia = normalize8DayConfirmVia"],
  ] as const) {
    assertIncludes(
      source,
      "getFreshImportFailedOrders(importResult)",
      `${label} reuses the shared failed import parser`,
      failures
    );
    assertBefore(
      source,
      matcher,
      creatorMarker,
      `${label} excludes failed imports before customer/internal notification or writeback work`,
      failures
    );
    assertIncludes(
      source,
      "addSkippedReason(summary, FRESH_IMPORT_FAILED_SKIP_REASON)",
      `${label} reports fresh_import_failed in skippedReasons`,
      failures
    );
  }

  for (const [label, source] of [
    ["12", payment12],
    ["10", payment10],
    ["2", reminder2],
  ] as const) {
    assertIncludes(
      source,
      "reasonSkipped: FRESH_IMPORT_FAILED_SKIP_REASON",
      `${label} event report uses fresh_import_failed`,
      failures
    );
  }
  assertIncludes(
    enforcement8,
    "report.customerEventSkippedReason = FRESH_IMPORT_FAILED_SKIP_REASON",
    "8-day event report uses fresh_import_failed",
    failures
  );

  assertIncludes(
    harness,
    "getFreshImportFailedOrders",
    "production-style workbook harness uses the shared failed import parser",
    failures
  );
  assertIncludes(
    harness,
    "freshImportSuccess: params.failedFreshImport ? false : true",
    "production-style workbook marks failed fresh imports",
    failures
  );
  assertIncludes(
    pkg,
    "validate:delivery-interval-fresh-import-fail-closed",
    "package.json exposes fresh import fail-closed validation",
    failures
  );
}

async function main() {
  const failures: string[] = [];

  await validateSharedHelper(failures);
  validateSource(failures);

  if (failures.length > 0) {
    console.error("Fresh import fail-closed validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "Fresh import fail-closed validation passed for 180/90/60/42/30/14/12/10/8/2."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
