import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Prisma } from "../lib/generated/prisma/client";
import {
  getDeliveryGroupPaymentEvaluationByOrderDate,
  type DeliveryGroupPaymentEvaluation,
} from "../lib/delivery-payment/deliveryGroupPayment";
import { persistOrderReadiness } from "../lib/delivery-readiness/orderLineReadiness";
import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import { syncOrderDeliveryGroups } from "../lib/erp/syncOrderDeliveryGroups";
import { prisma } from "../lib/prisma";

const ORDER_TYPE = "CB";
const ORDER_NUMBER = "CB00528";
const DEFAULT_REQUESTED_ON = "1900-01-01T00:00:00.000Z";
const REPORTS_DIR = "reports";
const HOLDING_DATE = "2030-12-31";
const PRODUCT_LINE_NBRS = [4, 7, 11, 14, 17, 20, 24, 26, 29, 33, 35] as const;

type ImportMode = "auto" | "queue" | "direct";
type Tx = Prisma.TransactionClient;

type SafetyCounts = {
  notificationEvents: number;
  notificationAttempts: number;
  smsOptOuts: number;
  emailOptOuts: number;
};

type ScenarioGroup = {
  label: string;
  deliveryDate: string;
  lineNbrs: number[];
};

type LineOverride = {
  orderQty?: string;
  openQty?: string;
  discountedUnitPrice?: string | null;
  taxCategory?: string | null;
};

type ScenarioDefinition = {
  id: string;
  name: string;
  purpose: string;
  groups: ScenarioGroup[];
  lineOverrides?: Record<number, LineOverride>;
  paymentTerms?: string;
  unpaidBalance?: string;
  orderTotal?: string;
  taxTotal?: string;
  deleteTaxDetails?: boolean;
  businessReviewFinalBalance?: boolean;
};

type ScenarioEvaluationReport = {
  scenarioId: string;
  scenarioName: string;
  purpose: string;
  groupLabel: string;
  expectedLineNbrs: number[];
  actualLineNbrs: number[];
  deterministicPass: boolean;
  deterministicFailures: string[];
  businessReviewNeeded: boolean;
  businessReviewReason: string | null;
  paymentTerms: string | null;
  unpaidBalance: string | null;
  orderTotal: string | null;
  taxTotal: string | null;
  paidToDate: string | null;
  deliveryDate: string;
  currentDeliveryGroupMerchandiseValue: string;
  currentDeliveryGroupTaxAmount: string | null;
  currentDeliveryGroupValue: string | null;
  completedValueBeforeCurrentDelivery: string | null;
  remainingUndeliveredValueAfterCurrentDelivery: string | null;
  creditAfterCurrentDelivery: string | null;
  requiredDownOnRemaining: string | null;
  amountDueNow: string | null;
  amountDueNowRounded: string | null;
  paymentApplicabilityStatus: string;
  paymentStatus: string;
  calculationWarnings: string[];
  lines: ScenarioLineReport[];
};

type ScenarioLineReport = {
  scenarioId: string;
  scenarioName: string;
  groupLabel: string;
  deliveryDate: string;
  lineNbr: number;
  inventoryId: string | null;
  lineDescription: string | null;
  itemType: string | null;
  itemClass: string | null;
  requestedOn: string | null;
  scenarioRequestedOn: string | null;
  taxCategory: string | null;
  discountedUnitPrice: string;
  orderQty: string;
  openQty: string;
  completedQtyDerived: string;
  lineOpenMerchandiseValue: string;
  lineOpenTaxAmount: string | null;
  lineOpenTotalValue: string | null;
  lineCompletedMerchandiseValue: string;
  lineCompletedTaxAmount: string | null;
  lineCompletedTotalValue: string | null;
  includedInCurrentDeliveryGroup: boolean;
};

type BaselineOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

class RollbackScenario extends Error {
  constructor() {
    super("Rollback CB00528 payment scenario mutations");
    this.name = "RollbackScenario";
  }
}

function parseArgs(argv: string[]) {
  const args: { mode: ImportMode; requestedOn: string; skipImport: boolean } = {
    mode: "auto",
    requestedOn: DEFAULT_REQUESTED_ON,
    skipImport: false,
  };

  for (const arg of argv) {
    if (arg === "--skip-import") {
      args.skipImport = true;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      const mode = arg.slice("--mode=".length);
      if (mode !== "auto" && mode !== "queue" && mode !== "direct") {
        throw new Error("--mode must be auto, queue, or direct");
      }
      args.mode = mode;
      continue;
    }

    if (arg.startsWith("--requested-on=")) {
      args.requestedOn = arg.slice("--requested-on=".length);
      continue;
    }

    if (!arg.startsWith("-")) {
      args.requestedOn = arg;
    }
  }

  return args;
}

function dateFromKey(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : dateKey(parsed);
}

function toDisplay(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) return dateKey(value) ?? value.toISOString();
  if (Array.isArray(value)) return value.join("; ");
  return String(value);
}

function csvEscape(value: unknown) {
  const stringValue = toDisplay(value);
  return /[",\r\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
}

function csv(headers: string[], rows: Array<Record<string, unknown>>) {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function normalizeMode(value: ImportMode): "queue" | "direct" {
  if (value === "queue" || value === "direct") return value;

  const useQueue = process.env.USE_QUEUE_ERP?.trim().toLowerCase() === "true";
  const hasQueueConfig = Boolean(
    process.env.MLD_QUEUE_BASE_URL?.trim() && process.env.MLD_QUEUE_TOKEN?.trim()
  );
  return useQueue && hasQueueConfig ? "queue" : "direct";
}

function queueUnavailableReason(errorMessage: string) {
  return /Queue ERP|MLD_QUEUE|ECONNREFUSED|ENOTFOUND|fetch failed|401|403|404|500|502|503|504/i.test(
    errorMessage
  );
}

async function getSafetyCounts(): Promise<SafetyCounts> {
  return {
    notificationEvents: await prisma.notificationEvent.count(),
    notificationAttempts: await prisma.notificationAttempt.count(),
    smsOptOuts: await prisma.smsOptOut.count(),
    emailOptOuts: await prisma.emailOptOut.count(),
  };
}

async function runImport(mode: "queue" | "direct", requestedOn: string) {
  process.env.USE_QUEUE_ERP = mode === "queue" ? "true" : "false";
  const importResult = await importSalesOrdersForLineRequestedOn(requestedOn, {
    orderLookups: [{ orderType: ORDER_TYPE, orderNumber: ORDER_NUMBER }],
    includeUnqualifiedOrderLookups: true,
  });
  return { mode, importResult };
}

async function runImportWithFallback(mode: ImportMode, requestedOn: string) {
  const resolvedMode = normalizeMode(mode);

  try {
    return await runImport(resolvedMode, requestedOn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (resolvedMode === "queue" && mode === "auto" && queueUnavailableReason(message)) {
      const fallback = await runImport("direct", requestedOn);
      return {
        ...fallback,
        fallbackReason: `Queue import failed closed; retried direct mode: ${message}`,
      };
    }
    throw error;
  }
}

function importFailed(result: Awaited<ReturnType<typeof runImportWithFallback>>) {
  const orderErrors = result.importResult.errors.filter(
    (error) => !error.orderNumber || error.orderNumber === ORDER_NUMBER
  );
  return result.importResult.failedOrders > 0 || orderErrors.length > 0;
}

async function loadOrder() {
  return prisma.order.findUnique({
    where: {
      orderType_orderNumber: {
        orderType: ORDER_TYPE,
        orderNumber: ORDER_NUMBER,
      },
    },
    include: {
      contact: true,
      total: true,
      taxDetails: {
        orderBy: [{ rowNumber: "asc" }, { lineNbr: "asc" }, { taxId: "asc" }],
      },
      lines: {
        orderBy: { lineNbr: "asc" },
        include: {
          allocations: { orderBy: { splitLineNbr: "asc" } },
        },
      },
      deliveryGroups: {
        orderBy: { deliveryDate: "asc" },
      },
    },
  });
}

function requireCompleteOrder(order: BaselineOrder | null): asserts order is BaselineOrder {
  if (!order) throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} was not found`);
  if (!order.contact) throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} is missing contact`);
  if (!order.total) throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} is missing totals`);
  if (order.taxDetails.length === 0) {
    throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} has no tax detail rows`);
  }
  if (order.lines.length === 0) throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} has no lines`);
  if (order.deliveryGroups.length === 0) {
    throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} has no delivery groups`);
  }

  const missingProductLines = PRODUCT_LINE_NBRS.filter(
    (lineNbr) => !order.lines.some((line) => line.lineNbr === lineNbr)
  );
  if (missingProductLines.length > 0) {
    throw new Error(
      `${ORDER_TYPE} ${ORDER_NUMBER} is missing expected product lines: ${missingProductLines.join(
        ", "
      )}`
    );
  }

  const linesMissingReadiness = order.lines.filter(
    (line) =>
      line.requestedOn !== null &&
      (line.activeAllocatedQty === null ||
        line.allocationStatus === null ||
        line.etaStatus === null ||
        line.readinessStatus === null ||
        line.displayStatus === null ||
        line.readinessCalculatedAt === null)
  );
  if (linesMissingReadiness.length > 0) {
    throw new Error(
      `${ORDER_TYPE} ${ORDER_NUMBER} has lines missing persisted readiness: ${linesMissingReadiness
        .map((line) => line.lineNbr)
        .join(", ")}`
    );
  }
}

function snapshotOrder(order: BaselineOrder) {
  return JSON.stringify({
    order: {
      status: order.status,
      paymentTerms: order.total?.paymentTerms ?? null,
      unpaidBalance: order.total?.unpaidBalance?.toString() ?? null,
      orderTotal: order.total?.orderTotal?.toString() ?? null,
      taxTotal: order.total?.taxTotal?.toString() ?? null,
      lineTotalAmount: order.total?.lineTotalAmount?.toString() ?? null,
    },
    taxDetails: order.taxDetails.map((taxDetail) => ({
      rowNumber: taxDetail.rowNumber,
      lineNbr: taxDetail.lineNbr,
      recordId: taxDetail.recordId,
      taxId: taxDetail.taxId,
      taxCategory: taxDetail.taxCategory,
      taxType: taxDetail.taxType,
      customerTaxZone: taxDetail.customerTaxZone,
      taxRate: taxDetail.taxRate?.toString() ?? null,
      taxableAmount: taxDetail.taxableAmount?.toString() ?? null,
      taxAmount: taxDetail.taxAmount?.toString() ?? null,
    })),
    lines: order.lines.map((line) => ({
      lineNbr: line.lineNbr,
      requestedOn: dateKey(line.requestedOn),
      taxCategory: line.taxCategory,
      discountedUnitPrice: line.discountedUnitPrice?.toString() ?? null,
      orderQty: line.orderQty?.toString() ?? null,
      openQty: line.openQty?.toString() ?? null,
      activeAllocatedQty: line.activeAllocatedQty?.toString() ?? null,
      allocationStatus: line.allocationStatus,
      etaStatus: line.etaStatus,
      readinessStatus: line.readinessStatus,
      displayStatus: line.displayStatus,
    })),
    deliveryGroups: order.deliveryGroups.map((group) => ({
      deliveryDate: dateKey(group.deliveryDate),
      isActive: group.isActive,
      lineCount: group.lineCount,
      supersededReason: group.supersededReason,
    })),
  });
}

const scenarios: ScenarioDefinition[] = [
  {
    id: "01",
    name: "Single product delivery",
    purpose: "Prove a single-line delivery group calculates from real CB00528 values.",
    groups: [{ label: "A", deliveryDate: "2030-01-01", lineNbrs: [4] }],
  },
  {
    id: "02",
    name: "Two product delivery",
    purpose: "Use lines 4 and 7 as a simple two-line current delivery group.",
    groups: [{ label: "A", deliveryDate: "2030-01-01", lineNbrs: [4, 7] }],
  },
  {
    id: "03",
    name: "Medium product delivery",
    purpose: "Prove multiple current product lines sum correctly.",
    groups: [{ label: "A", deliveryDate: "2030-01-01", lineNbrs: [4, 7, 11, 14] }],
  },
  {
    id: "04",
    name: "Full product delivery / final candidate",
    purpose: "Evaluate all known product lines as the current delivery group.",
    groups: [{ label: "A", deliveryDate: "2030-01-01", lineNbrs: [...PRODUCT_LINE_NBRS] }],
    businessReviewFinalBalance: true,
  },
  {
    id: "05",
    name: "Two delivery groups split 5/6",
    purpose: "Prove split groups calculate independently from requestedOn group membership.",
    groups: [
      { label: "A", deliveryDate: "2030-01-01", lineNbrs: [4, 7, 11, 14, 17] },
      { label: "B", deliveryDate: "2030-02-01", lineNbrs: [20, 24, 26, 29, 33, 35] },
    ],
  },
  {
    id: "06",
    name: "Three delivery groups split 3/4/4",
    purpose: "Prove amount due changes by the delivery group being evaluated.",
    groups: [
      { label: "A", deliveryDate: "2030-01-01", lineNbrs: [4, 7, 11] },
      { label: "B", deliveryDate: "2030-02-01", lineNbrs: [14, 17, 20, 24] },
      { label: "C", deliveryDate: "2030-03-01", lineNbrs: [26, 29, 33, 35] },
    ],
  },
  {
    id: "07",
    name: "Partial quantity line",
    purpose: "Use line 4 with orderQty 2 and openQty 1 to prove completedQtyDerived.",
    groups: [{ label: "A", deliveryDate: "2030-01-01", lineNbrs: [4] }],
    lineOverrides: {
      4: { orderQty: "2", openQty: "1" },
    },
  },
  {
    id: "08",
    name: "Mixed taxable/exempt delivery group",
    purpose: "Line 4 remains TAXABLE and line 7 is made EXEMPT inside rollback.",
    groups: [{ label: "A", deliveryDate: "2030-01-01", lineNbrs: [4, 7] }],
    lineOverrides: {
      7: { taxCategory: "EXEMPT" },
    },
  },
  {
    id: "09",
    name: "No tax details / taxable lines zero tax",
    purpose: "Taxable lines with taxTotal 0 and no tax details must not invent tax.",
    groups: [{ label: "A", deliveryDate: "2030-01-01", lineNbrs: [4, 7] }],
    taxTotal: "0",
    deleteTaxDetails: true,
  },
  {
    id: "10",
    name: "Final delivery with unpaid balance remaining",
    purpose: "Explicit final-delivery unpaid-balance behavior check.",
    groups: [{ label: "A", deliveryDate: "2030-01-01", lineNbrs: [...PRODUCT_LINE_NBRS] }],
    businessReviewFinalBalance: true,
  },
];

async function updateScenarioTotals(tx: Tx, order: BaselineOrder, scenario: ScenarioDefinition) {
  const totalData: Prisma.OrderTotalUpdateInput = {};
  if (scenario.paymentTerms !== undefined) totalData.paymentTerms = scenario.paymentTerms;
  if (scenario.unpaidBalance !== undefined) totalData.unpaidBalance = scenario.unpaidBalance;
  if (scenario.orderTotal !== undefined) totalData.orderTotal = scenario.orderTotal;
  if (scenario.taxTotal !== undefined) totalData.taxTotal = scenario.taxTotal;

  if (Object.keys(totalData).length > 0) {
    await tx.orderTotal.update({
      where: { orderId: order.id },
      data: totalData,
    });
  }

  if (scenario.deleteTaxDetails) {
    await tx.orderTaxDetail.deleteMany({ where: { orderId: order.id } });
  }
}

function scenarioDateByLine(scenario: ScenarioDefinition) {
  const byLineNbr = new Map<number, string>();
  for (const group of scenario.groups) {
    for (const lineNbr of group.lineNbrs) {
      byLineNbr.set(lineNbr, group.deliveryDate);
    }
  }
  return byLineNbr;
}

async function updateScenarioLines(tx: Tx, order: BaselineOrder, scenario: ScenarioDefinition) {
  const dateByLine = scenarioDateByLine(scenario);

  for (const lineNbr of PRODUCT_LINE_NBRS) {
    const override = scenario.lineOverrides?.[lineNbr] ?? {};
    await tx.orderLine.update({
      where: {
        orderId_lineNbr: {
          orderId: order.id,
          lineNbr,
        },
      },
      data: {
        requestedOn: dateFromKey(dateByLine.get(lineNbr) ?? HOLDING_DATE),
        ...(override.orderQty !== undefined ? { orderQty: override.orderQty } : {}),
        ...(override.openQty !== undefined ? { openQty: override.openQty } : {}),
        ...(override.discountedUnitPrice !== undefined
          ? { discountedUnitPrice: override.discountedUnitPrice }
          : {}),
        ...(override.taxCategory !== undefined ? { taxCategory: override.taxCategory } : {}),
      },
    });
  }
}

async function syncGroupsAndReadiness(tx: Tx, order: BaselineOrder) {
  const lines = await tx.orderLine.findMany({
    where: { orderId: order.id, requestedOn: { not: null } },
    select: { requestedOn: true },
  });
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = dateKey(line.requestedOn);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  await syncOrderDeliveryGroups(tx, {
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    status: order.status,
    importAt: new Date(),
    currentDeliveryGroups: [...counts.entries()].map(([deliveryDate, lineCount]) => ({
      deliveryDate: dateFromKey(deliveryDate),
      lineCount,
    })),
  });

  await persistOrderReadiness(order.id, tx);
}

function lineReports(
  scenario: ScenarioDefinition,
  group: ScenarioGroup,
  evaluation: DeliveryGroupPaymentEvaluation,
  baselineByLineNbr: Map<number, BaselineOrder["lines"][number]>
): ScenarioLineReport[] {
  return evaluation.lines.map((line) => {
    const baselineLine = baselineByLineNbr.get(line.lineNbr);
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      groupLabel: group.label,
      deliveryDate: evaluation.deliveryDate,
      lineNbr: line.lineNbr,
      inventoryId: line.inventoryId,
      lineDescription: line.lineDescription,
      itemType: line.itemType,
      itemClass: line.itemClass,
      requestedOn: dateKey(baselineLine?.requestedOn),
      scenarioRequestedOn: line.requestedOn,
      taxCategory: line.taxCategory,
      discountedUnitPrice: line.discountedUnitPrice,
      orderQty: line.orderQty,
      openQty: line.openQty,
      completedQtyDerived: line.completedQtyDerived,
      lineOpenMerchandiseValue: line.lineOpenMerchandiseValue,
      lineOpenTaxAmount: line.lineOpenTaxAmount,
      lineOpenTotalValue: line.lineOpenTotalValue,
      lineCompletedMerchandiseValue: line.lineCompletedMerchandiseValue,
      lineCompletedTaxAmount: line.lineCompletedTaxAmount,
      lineCompletedTotalValue: line.lineCompletedTotalValue,
      includedInCurrentDeliveryGroup: line.includedInCurrentDeliveryGroup,
    };
  });
}

function deterministicChecks(params: {
  scenario: ScenarioDefinition;
  group: ScenarioGroup;
  evaluation: DeliveryGroupPaymentEvaluation;
  lines: ScenarioLineReport[];
  baselineOrder: BaselineOrder;
}) {
  const failures: string[] = [];
  const actualLineNbrs = params.lines
    .filter((line) => line.includedInCurrentDeliveryGroup)
    .map((line) => line.lineNbr)
    .sort((left, right) => left - right);
  const expectedLineNbrs = [...params.group.lineNbrs].sort((left, right) => left - right);

  if (actualLineNbrs.join(",") !== expectedLineNbrs.join(",")) {
    failures.push(
      `Current group line membership mismatch expected=${expectedLineNbrs.join(
        ","
      )} actual=${actualLineNbrs.join(",")}`
    );
  }

  if (params.evaluation.paymentApplicabilityStatus !== "applicable") {
    failures.push(
      `Expected paymentApplicabilityStatus=applicable, got ${params.evaluation.paymentApplicabilityStatus}`
    );
  }

  if (params.evaluation.paymentStatus === "calculation_blocked") {
    failures.push("Payment calculation unexpectedly blocked.");
  }

  if (params.scenario.id === "07") {
    const line4 = params.lines.find((line) => line.lineNbr === 4);
    if (line4?.completedQtyDerived !== "1.0000") {
      failures.push(`Scenario 7 expected line 4 completedQtyDerived=1.0000, got ${line4?.completedQtyDerived}`);
    }
  }

  if (params.scenario.id === "08") {
    const line4 = params.lines.find((line) => line.lineNbr === 4);
    const line7 = params.lines.find((line) => line.lineNbr === 7);
    if (line4?.lineOpenTaxAmount === "0.00") {
      failures.push("Scenario 8 expected taxable line 4 to have nonzero open tax.");
    }
    if (line7?.lineOpenTaxAmount !== "0.00") {
      failures.push(`Scenario 8 expected exempt line 7 open tax 0.00, got ${line7?.lineOpenTaxAmount}`);
    }
  }

  if (params.scenario.id === "09") {
    if (params.evaluation.currentDeliveryGroupTaxAmount !== "0.00") {
      failures.push(
        `Scenario 9 expected currentDeliveryGroupTaxAmount=0.00, got ${params.evaluation.currentDeliveryGroupTaxAmount}`
      );
    }
    if (params.evaluation.calculationWarnings.length > 0) {
      failures.push(
        `Scenario 9 expected no tax warnings, got ${params.evaluation.calculationWarnings.join("; ")}`
      );
    }
  }

  const businessReviewNeeded =
    Boolean(params.scenario.businessReviewFinalBalance) &&
    params.evaluation.amountDueNowRounded !==
      (params.baselineOrder.total?.unpaidBalance?.toString() ?? null);
  const businessReviewReason = businessReviewNeeded
    ? "Final delivery did not calculate full unpaidBalance; review whether a final-delivery-full-balance rule is needed."
    : null;

  return {
    actualLineNbrs,
    expectedLineNbrs,
    deterministicPass: failures.length === 0,
    failures,
    businessReviewNeeded,
    businessReviewReason,
  };
}

async function evaluateScenarioInTransaction(
  scenario: ScenarioDefinition,
  baselineOrder: BaselineOrder
): Promise<ScenarioEvaluationReport[]> {
  let reports: ScenarioEvaluationReport[] | null = null;
  const baselineByLineNbr = new Map(baselineOrder.lines.map((line) => [line.lineNbr, line]));

  try {
    await prisma.$transaction(
      async (tx) => {
        await updateScenarioTotals(tx, baselineOrder, scenario);
        await updateScenarioLines(tx, baselineOrder, scenario);
        await syncGroupsAndReadiness(tx, baselineOrder);

        const scenarioReports: ScenarioEvaluationReport[] = [];
        for (const group of scenario.groups) {
          const evaluation = await getDeliveryGroupPaymentEvaluationByOrderDate(
            {
              orderType: baselineOrder.orderType,
              orderNumber: baselineOrder.orderNumber,
              deliveryDate: group.deliveryDate,
            },
            tx
          );
          const lines = lineReports(scenario, group, evaluation, baselineByLineNbr);
          const checks = deterministicChecks({
            scenario,
            group,
            evaluation,
            lines,
            baselineOrder,
          });

          scenarioReports.push({
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            purpose: scenario.purpose,
            groupLabel: group.label,
            expectedLineNbrs: checks.expectedLineNbrs,
            actualLineNbrs: checks.actualLineNbrs,
            deterministicPass: checks.deterministicPass,
            deterministicFailures: checks.failures,
            businessReviewNeeded: checks.businessReviewNeeded,
            businessReviewReason: checks.businessReviewReason,
            paymentTerms: evaluation.paymentTerms,
            unpaidBalance: evaluation.unpaidBalance,
            orderTotal: evaluation.orderTotal,
            taxTotal: evaluation.taxTotal,
            paidToDate: evaluation.paidToDate,
            deliveryDate: evaluation.deliveryDate,
            currentDeliveryGroupMerchandiseValue: evaluation.currentDeliveryGroupMerchandiseValue,
            currentDeliveryGroupTaxAmount: evaluation.currentDeliveryGroupTaxAmount,
            currentDeliveryGroupValue: evaluation.currentDeliveryGroupValue,
            completedValueBeforeCurrentDelivery: evaluation.completedValueBeforeCurrentDelivery,
            remainingUndeliveredValueAfterCurrentDelivery:
              evaluation.remainingUndeliveredValueAfterCurrentDelivery,
            creditAfterCurrentDelivery: evaluation.creditAfterCurrentDelivery,
            requiredDownOnRemaining: evaluation.requiredDownOnRemaining,
            amountDueNow: evaluation.amountDueNow,
            amountDueNowRounded: evaluation.amountDueNowRounded,
            paymentApplicabilityStatus: evaluation.paymentApplicabilityStatus,
            paymentStatus: evaluation.paymentStatus,
            calculationWarnings: evaluation.calculationWarnings,
            lines,
          });
        }

        reports = scenarioReports;
        throw new RollbackScenario();
      },
      { timeout: 30_000 }
    );
  } catch (error) {
    if (!(error instanceof RollbackScenario)) {
      throw error;
    }
  }

  if (!reports) {
    throw new Error(`Scenario ${scenario.id} did not produce reports`);
  }

  return reports;
}

function baselineSummary(order: BaselineOrder) {
  return {
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentTerms: order.total?.paymentTerms ?? null,
    unpaidBalance: order.total?.unpaidBalance?.toString() ?? null,
    orderTotal: order.total?.orderTotal?.toString() ?? null,
    taxTotal: order.total?.taxTotal?.toString() ?? null,
    lineTotalAmount: order.total?.lineTotalAmount?.toString() ?? null,
    paidToDate:
      order.total?.orderTotal && order.total.unpaidBalance
        ? (
            Number(order.total.orderTotal.toString()) -
            Number(order.total.unpaidBalance.toString())
          ).toFixed(2)
        : null,
    buyerGroup: order.buyerGroup,
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
    taxDetailRows: order.taxDetails.map((taxDetail) => ({
      taxId: taxDetail.taxId,
      customerTaxZone: taxDetail.customerTaxZone,
      taxRate: taxDetail.taxRate?.toString() ?? null,
      taxableAmount: taxDetail.taxableAmount?.toString() ?? null,
      taxAmount: taxDetail.taxAmount?.toString() ?? null,
      taxType: taxDetail.taxType,
      lineNbr: taxDetail.lineNbr,
      recordId: taxDetail.recordId,
    })),
    activeDeliveryGroups: order.deliveryGroups
      .filter((group) => group.isActive)
      .map((group) => ({
        id: group.id,
        deliveryDate: dateKey(group.deliveryDate),
        lineCount: group.lineCount,
        status: group.status,
      })),
    productLines: order.lines
      .filter((line) => PRODUCT_LINE_NBRS.includes(line.lineNbr as (typeof PRODUCT_LINE_NBRS)[number]))
      .map((line) => ({
        lineNbr: line.lineNbr,
        inventoryId: line.inventoryId,
        lineDescription: line.lineDescription,
        itemType: line.itemType,
        itemClass: line.itemClass,
        requestedOn: dateKey(line.requestedOn),
        eta: dateKey(line.eta),
        taxCategory: line.taxCategory,
        discountedUnitPrice: line.discountedUnitPrice?.toString() ?? null,
        orderQty: line.orderQty?.toString() ?? null,
        openQty: line.openQty?.toString() ?? null,
        activeAllocatedQty: line.activeAllocatedQty?.toString() ?? null,
        allocationStatus: line.allocationStatus,
        etaStatus: line.etaStatus,
        readinessStatus: line.readinessStatus,
        displayStatus: line.displayStatus,
      })),
  };
}

async function writeReports(params: {
  baseline: ReturnType<typeof baselineSummary>;
  importRun: Awaited<ReturnType<typeof runImportWithFallback>> | null;
  scenarioReports: ScenarioEvaluationReport[];
  safetyBefore: SafetyCounts;
  safetyAfter: SafetyCounts;
  persistentStateUnchanged: boolean;
}) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(
    REPORTS_DIR,
    `cb00528-payment-scenario-summary-${timestamp}.csv`
  );
  const detailPath = path.join(
    REPORTS_DIR,
    `cb00528-payment-scenario-details-${timestamp}.csv`
  );
  const jsonPath = path.join(REPORTS_DIR, `cb00528-payment-scenario-results-${timestamp}.json`);

  const summaryHeaders = [
    "scenarioId",
    "scenarioName",
    "groupLabel",
    "deliveryDate",
    "expectedLineNbrs",
    "actualLineNbrs",
    "paymentTerms",
    "unpaidBalance",
    "orderTotal",
    "taxTotal",
    "paidToDate",
    "currentDeliveryGroupMerchandiseValue",
    "currentDeliveryGroupTaxAmount",
    "currentDeliveryGroupValue",
    "completedValueBeforeCurrentDelivery",
    "remainingUndeliveredValueAfterCurrentDelivery",
    "creditAfterCurrentDelivery",
    "requiredDownOnRemaining",
    "amountDueNow",
    "amountDueNowRounded",
    "paymentApplicabilityStatus",
    "paymentStatus",
    "calculationWarnings",
    "deterministicPass",
    "deterministicFailures",
    "businessReviewNeeded",
    "businessReviewReason",
  ];
  const summaryRows = params.scenarioReports.map((report) => ({
    ...report,
    expectedLineNbrs: report.expectedLineNbrs.join(";"),
    actualLineNbrs: report.actualLineNbrs.join(";"),
    calculationWarnings: report.calculationWarnings.join("; "),
    deterministicFailures: report.deterministicFailures.join("; "),
  }));

  const detailHeaders = [
    "scenarioId",
    "scenarioName",
    "groupLabel",
    "deliveryDate",
    "lineNbr",
    "inventoryId",
    "lineDescription",
    "itemType",
    "itemClass",
    "requestedOn",
    "scenarioRequestedOn",
    "taxCategory",
    "discountedUnitPrice",
    "orderQty",
    "openQty",
    "completedQtyDerived",
    "lineOpenMerchandiseValue",
    "lineOpenTaxAmount",
    "lineOpenTotalValue",
    "lineCompletedMerchandiseValue",
    "lineCompletedTaxAmount",
    "lineCompletedTotalValue",
    "includedInCurrentDeliveryGroup",
  ];
  const detailRows = params.scenarioReports.flatMap((report) => report.lines);

  await writeFile(summaryPath, csv(summaryHeaders, summaryRows), "utf8");
  await writeFile(detailPath, csv(detailHeaders, detailRows), "utf8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        importRun: params.importRun,
        baseline: params.baseline,
        scenarioReports: params.scenarioReports,
        safety: {
          before: params.safetyBefore,
          after: params.safetyAfter,
          notificationAttemptsUnchanged:
            params.safetyBefore.notificationAttempts === params.safetyAfter.notificationAttempts,
          notificationEventsUnchanged:
            params.safetyBefore.notificationEvents === params.safetyAfter.notificationEvents,
          persistentScenarioStateUnchanged: params.persistentStateUnchanged,
        },
      },
      null,
      2
    ),
    "utf8"
  );

  return { summaryPath, detailPath, jsonPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const safetyBefore = await getSafetyCounts();
  const importRun = args.skipImport ? null : await runImportWithFallback(args.mode, args.requestedOn);

  if (importRun && importFailed(importRun)) {
    throw new Error(
      `${ORDER_TYPE} ${ORDER_NUMBER} import failed: ${JSON.stringify(
        importRun.importResult,
        null,
        2
      )}`
    );
  }

  const baselineOrder = await loadOrder();
  requireCompleteOrder(baselineOrder);
  const beforeScenarioSnapshot = snapshotOrder(baselineOrder);

  const scenarioReports: ScenarioEvaluationReport[] = [];
  for (const scenario of scenarios) {
    scenarioReports.push(...(await evaluateScenarioInTransaction(scenario, baselineOrder)));
  }

  const afterScenarioOrder = await loadOrder();
  requireCompleteOrder(afterScenarioOrder);
  const afterScenarioSnapshot = snapshotOrder(afterScenarioOrder);
  const safetyAfter = await getSafetyCounts();
  const baseline = baselineSummary(baselineOrder);
  const persistentStateUnchanged = beforeScenarioSnapshot === afterScenarioSnapshot;
  const reports = await writeReports({
    baseline,
    importRun,
    scenarioReports,
    safetyBefore,
    safetyAfter,
    persistentStateUnchanged,
  });

  const failedEvaluations = scenarioReports.filter((report) => !report.deterministicPass);
  const businessReview = scenarioReports.filter((report) => report.businessReviewNeeded);

  console.log(
    JSON.stringify(
      {
        orderType: ORDER_TYPE,
        orderNumber: ORDER_NUMBER,
        importMethod: importRun
          ? {
              mode: importRun.mode,
              fallbackReason: "fallbackReason" in importRun ? importRun.fallbackReason : null,
              summary: importRun.importResult,
            }
          : { mode: "skipped", summary: null },
        baseline,
        scenarioPassFail: {
          evaluations: scenarioReports.length,
          deterministicPassed: scenarioReports.length - failedEvaluations.length,
          deterministicFailed: failedEvaluations.length,
          failed: failedEvaluations.map((report) => ({
            scenarioId: report.scenarioId,
            scenarioName: report.scenarioName,
            groupLabel: report.groupLabel,
            failures: report.deterministicFailures,
          })),
        },
        amountDueResults: scenarioReports.map((report) => ({
          scenarioId: report.scenarioId,
          scenarioName: report.scenarioName,
          groupLabel: report.groupLabel,
          deliveryDate: report.deliveryDate,
          amountDueNow: report.amountDueNow,
          amountDueNowRounded: report.amountDueNowRounded,
          currentDeliveryGroupValue: report.currentDeliveryGroupValue,
          remainingUndeliveredValueAfterCurrentDelivery:
            report.remainingUndeliveredValueAfterCurrentDelivery,
          creditAfterCurrentDelivery: report.creditAfterCurrentDelivery,
          requiredDownOnRemaining: report.requiredDownOnRemaining,
          paymentStatus: report.paymentStatus,
          paymentApplicabilityStatus: report.paymentApplicabilityStatus,
          businessReviewNeeded: report.businessReviewNeeded,
        })),
        businessReview,
        reports,
        safety: {
          before: safetyBefore,
          after: safetyAfter,
          notificationAttemptsUnchanged:
            safetyBefore.notificationAttempts === safetyAfter.notificationAttempts,
          notificationEventsUnchanged: safetyBefore.notificationEvents === safetyAfter.notificationEvents,
          persistentScenarioStateUnchanged: persistentStateUnchanged,
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
