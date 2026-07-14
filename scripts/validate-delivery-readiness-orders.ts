import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import {
  getDeliveryGroupReadiness,
  type DeliveryGroupReadinessResult,
  type EtaStatus,
  type AllocationStatus,
  type ReadinessStatus,
} from "../lib/delivery-readiness/orderLineReadiness";
import { createErpClientFromEnv } from "../lib/erp/erpClient";
import {
  importSalesOrdersForLineRequestedOn,
  type ImportSalesOrderLookup,
  type ImportSalesOrdersResult,
} from "../lib/erp/importSalesOrders";
import { prisma } from "../lib/prisma";

const DEFAULT_ORDER_NUMBERS = ["HW06397", "PG04618", "HW06205", "SO40064", "PL02553", "SO40278"];
const REPORT_DIR = "reports";

type OrderValidationResult = {
  lookup: ImportSalesOrderLookup;
  fullRowsFetched: number;
  matchingFullRows: number;
  detailLineCount: number;
  requestedDates: string[];
  importResults: ImportSalesOrdersResult[];
  deliveryGroups: DeliveryGroupReport[];
  errors: string[];
};

type DeliveryGroupReport = {
  orderDeliveryGroupId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: string;
  buyerGroup: string | null;
  customerDescription: string | null;
  locationDescription: string | null;
  totalLineCount: number;
  includedStockLineCount: number;
  ignoredNonStockLineCount: number;
  readinessTotals: Record<ReadinessStatus, number>;
  allocationTotals: Record<AllocationStatus, number>;
  etaTotals: Record<EtaStatus, number>;
  hasBackorders: boolean;
  hasEtaPending: boolean;
  hasPartialAllocation: boolean;
  allReadyOrComplete: boolean;
  hasActionableIssues: boolean;
  lines: Array<
    DeliveryGroupReadinessResult["lines"][number] & {
      orderType: string;
      orderNumber: string;
      deliveryDate: string;
      buyerGroup: string | null;
      customerDescription: string | null;
      locationDescription: string | null;
    }
  >;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getValue(field: unknown): unknown {
  if (isRecord(field) && "value" in field) return field.value ?? null;
  return field ?? null;
}

function getField(record: unknown, key: string) {
  return isRecord(record) ? record[key] : undefined;
}

function getString(field: unknown) {
  const value = getValue(field);
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function getArray(field: unknown): unknown[] {
  const value = getValue(field);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.value)) return value.value;
  return [];
}

function dateKeyFromValue(field: unknown) {
  const value = getValue(field);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (match?.[1]) return match[1];
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function inferOrderType(orderNumber: string) {
  return orderNumber.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? null;
}

function parseOrderArgs(argv: string[]): ImportSalesOrderLookup[] {
  const orderNumbers = argv.length > 0 ? argv : DEFAULT_ORDER_NUMBERS;
  return orderNumbers.map((arg) => {
    const [orderType, orderNumber] = arg.includes(":")
      ? (arg.split(":", 2) as [string, string])
      : [inferOrderType(arg), arg];

    if (!orderNumber || !orderType) {
      throw new Error(`Could not infer order type for ${arg}; use ORDER_TYPE:ORDER_NUMBER`);
    }

    return {
      orderType,
      orderNumber,
    };
  });
}

function matchingFullRows(rows: unknown[], lookup: ImportSalesOrderLookup) {
  return rows.filter((row) => {
    const orderNumber = getString(getField(row, "OrderNbr"));
    const orderType = getString(getField(row, "OrderType"));
    return orderNumber === lookup.orderNumber && (!lookup.orderType || orderType === lookup.orderType);
  });
}

function requestedDatesFromFullRows(rows: unknown[]) {
  const requestedDates = new Set<string>();
  let detailLineCount = 0;

  for (const row of rows) {
    const details = getArray(getField(row, "Details"));
    detailLineCount += details.length;
    for (const detail of details) {
      const requestedOn = dateKeyFromValue(getField(detail, "RequestedOn"));
      if (requestedOn) requestedDates.add(requestedOn);
    }
  }

  return {
    detailLineCount,
    requestedDates: [...requestedDates].sort(),
  };
}

function zeroTotals<T extends string>(keys: readonly T[]) {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function countBy<T extends string>(values: T[], keys: readonly T[]) {
  const counts = zeroTotals(keys);
  for (const value of values) {
    counts[value] += 1;
  }
  return counts;
}

function csvValue(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(groups: DeliveryGroupReport[]) {
  const headers = [
    "orderType",
    "orderNumber",
    "deliveryDate",
    "buyerGroup",
    "customerDescription",
    "locationDescription",
    "lineNbr",
    "inventoryId",
    "lineDescription",
    "itemType",
    "itemClass",
    "requestedOn",
    "eta",
    "orderQty",
    "openQty",
    "activeAllocatedQty",
    "allocationStatus",
    "etaStatus",
    "readinessStatus",
    "displayStatus",
    "allocationCount",
    "allocationRowsCompact",
    "manualReviewStatus",
    "manualReviewNotes",
  ];

  const rows = groups.flatMap((group) =>
    group.lines.map((line) => [
      line.orderType,
      line.orderNumber,
      line.deliveryDate,
      line.buyerGroup,
      line.customerDescription,
      line.locationDescription,
      line.lineNbr,
      line.inventoryId,
      line.lineDescription,
      line.itemType,
      line.itemClass,
      line.requestedOn,
      line.eta,
      line.orderQty,
      line.openQty,
      line.activeAllocatedQty,
      line.allocationStatus,
      line.etaStatus,
      line.readinessStatus,
      line.displayStatus,
      line.allocationCount,
      line.allocationRowsCompact.join(", "),
      "",
      "",
    ])
  );

  return [headers, ...rows].map((row) => row.map(csvValue).join(",")).join("\n");
}

function buildMarkdown(results: OrderValidationResult[], groups: DeliveryGroupReport[]) {
  const lines = [
    "# Delivery Readiness Validation",
    "",
    "## Import Summary",
    "",
    "| Order | Full rows | Detail lines | Requested dates | Import errors | Delivery groups |",
    "| --- | ---: | ---: | --- | ---: | ---: |",
  ];

  for (const result of results) {
    const order = `${result.lookup.orderType} ${result.lookup.orderNumber}`;
    const importErrors = result.importResults.reduce(
      (count, importResult) => count + importResult.errors.length,
      result.errors.length
    );
    lines.push(
      `| ${order} | ${result.matchingFullRows}/${result.fullRowsFetched} | ${result.detailLineCount} | ${result.requestedDates.join(
        ", "
      ) || "none"} | ${importErrors} | ${result.deliveryGroups.length} |`
    );
  }

  lines.push("", "## Delivery Groups", "");
  lines.push(
    "| Order | Delivery date | Lines | Stock | Ignored | Ready | Partial | On time | ETA pending | Backordered | Actionable |"
  );
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");

  for (const group of groups) {
    lines.push(
      `| ${group.orderType} ${group.orderNumber} | ${group.deliveryDate} | ${group.totalLineCount} | ${group.includedStockLineCount} | ${group.ignoredNonStockLineCount} | ${group.readinessTotals.ready} | ${group.readinessTotals.partially_allocated} | ${group.readinessTotals.expected_on_time} | ${group.readinessTotals.eta_pending} | ${group.readinessTotals.backordered} | ${group.hasActionableIssues ? "yes" : "no"} |`
    );
  }

  lines.push("", "## Notable Lines", "");
  for (const [title, predicate] of [
    ["Backordered", (line: DeliveryGroupReport["lines"][number]) => line.readinessStatus === "backordered"],
    ["ETA Pending", (line: DeliveryGroupReport["lines"][number]) => line.readinessStatus === "eta_pending"],
    [
      "Partially Allocated",
      (line: DeliveryGroupReport["lines"][number]) => line.readinessStatus === "partially_allocated",
    ],
    ["Complete", (line: DeliveryGroupReport["lines"][number]) => line.readinessStatus === "complete"],
    ["Ignored ItemType=N", (line: DeliveryGroupReport["lines"][number]) => line.readinessStatus === "ignored"],
  ] as const) {
    lines.push(`### ${title}`, "");
    const matches = groups.flatMap((group) => group.lines.filter(predicate));
    if (matches.length === 0) {
      lines.push("None", "");
      continue;
    }
    for (const line of matches) {
      lines.push(
        `- ${line.orderType} ${line.orderNumber} ${line.deliveryDate} line ${line.lineNbr} ${line.inventoryId ?? ""}: ${line.displayStatus}`
      );
    }
    lines.push("");
  }

  const zeroStockGroups = groups.filter((group) => group.includedStockLineCount === 0);
  lines.push("### Zero Included Stock Lines", "");
  if (zeroStockGroups.length === 0) {
    lines.push("None", "");
  } else {
    for (const group of zeroStockGroups) {
      lines.push(`- ${group.orderType} ${group.orderNumber} ${group.deliveryDate}`);
    }
    lines.push("");
  }

  const kdtfLines = groups.flatMap((group) =>
    group.lines.filter((line) => line.orderNumber === "SO40278" && line.inventoryId === "KDTF324PPA")
  );
  lines.push("### SO40278 KDTF324PPA", "");
  if (kdtfLines.length === 0) {
    lines.push("Not present", "");
  } else {
    for (const line of kdtfLines) {
      lines.push(
        `- ${line.orderType} ${line.orderNumber} ${line.deliveryDate} line ${line.lineNbr}: ${line.displayStatus}, eta=${line.eta ?? ""}, requestedOn=${line.requestedOn ?? ""}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function notificationAttemptsCount() {
  return prisma.notificationAttempt.count();
}

async function buildDeliveryGroupReports(lookup: ImportSalesOrderLookup) {
  const order = await prisma.order.findUnique({
    where: {
      orderType_orderNumber: {
        orderType: lookup.orderType ?? "",
        orderNumber: lookup.orderNumber,
      },
    },
    select: {
      buyerGroup: true,
      customerDescription: true,
      locationDescription: true,
      deliveryGroups: {
        where: { isActive: true },
        orderBy: { deliveryDate: "asc" },
        select: { id: true },
      },
    },
  });

  if (!order) return [];

  const reports: DeliveryGroupReport[] = [];
  for (const deliveryGroup of order.deliveryGroups) {
    const readiness = await getDeliveryGroupReadiness(deliveryGroup.id);
    const allocationTotals = countBy(
      readiness.lines.map((line) => line.allocationStatus),
      ["ignored", "complete", "allocated", "partially_allocated", "not_allocated"] as const
    );
    const etaTotals = countBy(
      readiness.lines.map((line) => line.etaStatus),
      ["ignored", "complete", "ready", "eta_pending", "backordered", "expected_on_time"] as const
    );

    reports.push({
      orderDeliveryGroupId: readiness.orderDeliveryGroupId,
      orderType: readiness.orderType,
      orderNumber: readiness.orderNumber,
      deliveryDate: readiness.deliveryDate,
      buyerGroup: order.buyerGroup,
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
      totalLineCount: readiness.lineCount,
      includedStockLineCount: readiness.includedLineCount,
      ignoredNonStockLineCount: readiness.totals.ignored,
      readinessTotals: readiness.totals,
      allocationTotals,
      etaTotals,
      hasBackorders: readiness.hasBackorders,
      hasEtaPending: readiness.hasEtaPending,
      hasPartialAllocation: readiness.hasPartialAllocation,
      allReadyOrComplete: readiness.allReadyOrComplete,
      hasActionableIssues: readiness.hasActionableIssues,
      lines: readiness.lines.map((line) => ({
        ...line,
        orderType: readiness.orderType,
        orderNumber: readiness.orderNumber,
        deliveryDate: readiness.deliveryDate,
        buyerGroup: order.buyerGroup,
        customerDescription: order.customerDescription,
        locationDescription: order.locationDescription,
      })),
    });
  }

  return reports;
}

async function validateOrder(lookup: ImportSalesOrderLookup): Promise<OrderValidationResult> {
  const client = createErpClientFromEnv();
  const errors: string[] = [];
  let fullRows: unknown[] = [];

  try {
    fullRows = await client.fetchDeliverySalesOrderByOrderNumber(lookup.orderNumber, lookup.orderType);
  } catch (error) {
    errors.push(`Full SalesOrder fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const matchingRows = matchingFullRows(fullRows, lookup);
  const { detailLineCount, requestedDates } = requestedDatesFromFullRows(matchingRows);
  const importResults: ImportSalesOrdersResult[] = [];

  for (const requestedDate of requestedDates.slice(0, 1)) {
    importResults.push(
      await importSalesOrdersForLineRequestedOn(requestedDate, {
        orderLookups: [lookup],
        includeUnqualifiedOrderLookups: true,
      })
    );
  }

  const deliveryGroups = await buildDeliveryGroupReports(lookup);

  return {
    lookup,
    fullRowsFetched: fullRows.length,
    matchingFullRows: matchingRows.length,
    detailLineCount,
    requestedDates,
    importResults,
    deliveryGroups,
    errors,
  };
}

async function main() {
  const lookups = parseOrderArgs(process.argv.slice(2));
  const beforeNotificationAttempts = await notificationAttemptsCount();
  const results: OrderValidationResult[] = [];

  for (const lookup of lookups) {
    results.push(await validateOrder(lookup));
  }

  const afterNotificationAttempts = await notificationAttemptsCount();
  const groups = results.flatMap((result) => result.deliveryGroups);
  mkdirSync(REPORT_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = join(REPORT_DIR, `delivery-readiness-validation-${stamp}.csv`);
  const markdownPath = join(REPORT_DIR, `delivery-readiness-validation-${stamp}.md`);
  writeFileSync(csvPath, `${buildCsv(groups)}\n`);
  writeFileSync(markdownPath, `${buildMarkdown(results, groups)}\n`);

  console.log(
    JSON.stringify(
      {
        orders: results.map((result) => ({
          lookup: result.lookup,
          fullRowsFetched: result.fullRowsFetched,
          matchingFullRows: result.matchingFullRows,
          detailLineCount: result.detailLineCount,
          requestedDates: result.requestedDates,
          importResults: result.importResults,
          deliveryGroups: result.deliveryGroups.map((group) => ({
            orderDeliveryGroupId: group.orderDeliveryGroupId,
            orderType: group.orderType,
            orderNumber: group.orderNumber,
            deliveryDate: group.deliveryDate,
            buyerGroup: group.buyerGroup,
            customerDescription: group.customerDescription,
            locationDescription: group.locationDescription,
            totalLineCount: group.totalLineCount,
            includedStockLineCount: group.includedStockLineCount,
            ignoredNonStockLineCount: group.ignoredNonStockLineCount,
            readinessTotals: group.readinessTotals,
            allocationTotals: group.allocationTotals,
            etaTotals: group.etaTotals,
            hasBackorders: group.hasBackorders,
            hasEtaPending: group.hasEtaPending,
            hasPartialAllocation: group.hasPartialAllocation,
            allReadyOrComplete: group.allReadyOrComplete,
            hasActionableIssues: group.hasActionableIssues,
          })),
          errors: result.errors,
        })),
        notableLines: {
          backordered: groups.flatMap((group) =>
            group.lines.filter((line) => line.readinessStatus === "backordered")
          ),
          etaPending: groups.flatMap((group) =>
            group.lines.filter((line) => line.readinessStatus === "eta_pending")
          ),
          partiallyAllocated: groups.flatMap((group) =>
            group.lines.filter((line) => line.readinessStatus === "partially_allocated")
          ),
          complete: groups.flatMap((group) =>
            group.lines.filter((line) => line.readinessStatus === "complete")
          ),
          ignored: groups.flatMap((group) =>
            group.lines.filter((line) => line.readinessStatus === "ignored")
          ),
          zeroIncludedStockGroups: groups.filter((group) => group.includedStockLineCount === 0),
          so40278Kdtf324ppa: groups.flatMap((group) =>
            group.lines.filter(
              (line) => line.orderNumber === "SO40278" && line.inventoryId === "KDTF324PPA"
            )
          ),
        },
        reportFiles: {
          csvPath,
          markdownPath,
        },
        safety: {
          beforeNotificationAttempts,
          afterNotificationAttempts,
          notificationAttemptsUnchanged: beforeNotificationAttempts === afterNotificationAttempts,
        },
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
