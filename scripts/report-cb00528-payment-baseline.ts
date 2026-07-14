import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  getOrderPaymentEvaluations,
  type DeliveryGroupPaymentEvaluation,
} from "../lib/delivery-payment/deliveryGroupPayment";
import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import { prisma } from "../lib/prisma";

const ORDER_TYPE = "CB";
const ORDER_NUMBER = "CB00528";
const DEFAULT_REQUESTED_ON = "1900-01-01T00:00:00.000Z";
const REPORTS_DIR = "reports";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const SCALE = BigInt(1_000_000);

type ImportMode = "auto" | "queue" | "direct";

type SafetyCounts = {
  notificationEvents: number;
  notificationAttempts: number;
  smsOptOuts: number;
  emailOptOuts: number;
};

type MoneyLike = number | string | { toString(): string } | null | undefined;

type BaselineOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
type BaselineLine = BaselineOrder["lines"][number];
type BaselineDeliveryGroup = BaselineOrder["deliveryGroups"][number];

type LineBaseline = {
  lineNbr: number;
  inventoryId: string | null;
  lineDescription: string | null;
  itemType: string | null;
  itemClass: string | null;
  requestedOn: string | null;
  eta: string | null;
  taxCategory: string | null;
  discountedUnitPrice: string | null;
  orderQty: string | null;
  openQty: string | null;
  completedQtyDerived: string;
  grossMerchandiseValue: string;
  openMerchandiseValue: string;
  completedMerchandiseValue: string;
  allocationRows: string;
  activeAllocatedQty: string | null;
  allocationStatus: string | null;
  etaStatus: string | null;
  readinessStatus: string | null;
  displayStatus: string | null;
};

function parseArgs(argv: string[]) {
  const args: { mode: ImportMode; requestedOn: string } = {
    mode: "auto",
    requestedOn: DEFAULT_REQUESTED_ON,
  };

  for (const arg of argv) {
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

function resultHasQueueAvailabilityFailure(result: Awaited<ReturnType<typeof runImport>>) {
  return (
    result.importResult.failedOrders > 0 &&
    result.importResult.errors.some((error) => queueUnavailableReason(error.reason))
  );
}

async function getSafetyCounts(): Promise<SafetyCounts> {
  const [notificationEvents, notificationAttempts, smsOptOuts, emailOptOuts] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.smsOptOut.count(),
    prisma.emailOptOut.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
    smsOptOuts,
    emailOptOuts,
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
    const result = await runImport(resolvedMode, requestedOn);
    if (resolvedMode === "queue" && mode === "auto" && resultHasQueueAvailabilityFailure(result)) {
      const fallback = await runImport("direct", requestedOn);
      return {
        ...fallback,
        fallbackReason: "Queue import returned an availability/job error; retried in direct mode.",
        queueAttempt: result.importResult,
      };
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (resolvedMode === "queue" && mode === "auto" && queueUnavailableReason(message)) {
      const fallback = await runImport("direct", requestedOn);
      return {
        ...fallback,
        fallbackReason: `Queue import threw an availability/config error; retried in direct mode: ${message}`,
      };
    }
    throw error;
  }
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
          allocations: {
            orderBy: { splitLineNbr: "asc" },
          },
        },
      },
      deliveryGroups: {
        orderBy: { deliveryDate: "asc" },
      },
    },
  });
}

function parseScaledDecimal(value: MoneyLike): bigint | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "number" ? String(value) : value.toString();
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const match = trimmed.replace(/,/g, "").match(/^(-)?(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const sign = match[1] ? -ONE : ONE;
  const whole = BigInt(match[2]);
  const fraction = (match[3] ?? "").slice(0, 6).padEnd(6, "0");
  return sign * (whole * SCALE + BigInt(fraction));
}

function formatScaled(value: bigint, decimals: number) {
  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  const divisor = TEN ** BigInt(6 - decimals);
  const rounded = (absolute + divisor / TWO) / divisor;
  const scale = TEN ** BigInt(decimals);
  const whole = rounded / scale;
  const fraction = rounded % scale;
  const sign = negative ? "-" : "";
  return decimals === 0
    ? `${sign}${whole.toString()}`
    : `${sign}${whole.toString()}.${fraction.toString().padStart(decimals, "0")}`;
}

function formatMoneyValue(value: MoneyLike) {
  const parsed = parseScaledDecimal(value);
  return parsed === null ? null : formatScaled(parsed, 2);
}

function formatQuantityValue(value: MoneyLike) {
  const parsed = parseScaledDecimal(value);
  return parsed === null ? null : formatScaled(parsed, 4);
}

function moneyFromScaled(value: bigint) {
  return formatScaled(value, 2);
}

function quantityFromScaled(value: bigint) {
  return formatScaled(value, 4);
}

function multiplyScaled(left: bigint, right: bigint) {
  return (left * right + SCALE / TWO) / SCALE;
}

function clampAtZero(value: bigint) {
  return value < ZERO ? ZERO : value;
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
  return String(value);
}

function allocationCompact(line: BaselineLine) {
  if (line.allocations.length === 0) return "";
  return line.allocations
    .map((allocation) =>
      [
        `split=${allocation.splitLineNbr}`,
        `allocated=${allocation.allocated}`,
        `completed=${allocation.completed}`,
        `qty=${formatQuantityValue(allocation.qty) ?? ""}`,
      ].join("|")
    )
    .join("; ");
}

function lineBaseline(line: BaselineLine): LineBaseline {
  const price = parseScaledDecimal(line.discountedUnitPrice) ?? ZERO;
  const orderQty = parseScaledDecimal(line.orderQty) ?? ZERO;
  const openQty = parseScaledDecimal(line.openQty) ?? ZERO;
  const completedQty = clampAtZero(orderQty - openQty);

  return {
    lineNbr: line.lineNbr,
    inventoryId: line.inventoryId,
    lineDescription: line.lineDescription,
    itemType: line.itemType,
    itemClass: line.itemClass,
    requestedOn: dateKey(line.requestedOn),
    eta: dateKey(line.eta),
    taxCategory: line.taxCategory,
    discountedUnitPrice: formatMoneyValue(line.discountedUnitPrice),
    orderQty: formatQuantityValue(line.orderQty),
    openQty: formatQuantityValue(line.openQty),
    completedQtyDerived: quantityFromScaled(completedQty),
    grossMerchandiseValue: moneyFromScaled(multiplyScaled(price, orderQty)),
    openMerchandiseValue: moneyFromScaled(multiplyScaled(price, openQty)),
    completedMerchandiseValue: moneyFromScaled(multiplyScaled(price, completedQty)),
    allocationRows: allocationCompact(line),
    activeAllocatedQty: formatQuantityValue(line.activeAllocatedQty),
    allocationStatus: line.allocationStatus,
    etaStatus: line.etaStatus,
    readinessStatus: line.readinessStatus,
    displayStatus: line.displayStatus,
  };
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

function markdownTable(headers: string[], rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "_None._\n";
  const separator = headers.map(() => "---");
  const values = rows.map((row) => headers.map((header) => toDisplay(row[header])));
  return [
    `| ${headers.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...values.map((row) => `| ${row.map((value) => value.replace(/\|/g, "\\|")).join(" | ")} |`),
    "",
  ].join("\n");
}

function paidToDate(order: BaselineOrder) {
  const orderTotal = parseScaledDecimal(order.total?.orderTotal);
  const unpaidBalance = parseScaledDecimal(order.total?.unpaidBalance);
  if (orderTotal === null || unpaidBalance === null) return null;
  return moneyFromScaled(orderTotal - unpaidBalance);
}

function readinessTotalsForGroup(lines: BaselineLine[], group: BaselineDeliveryGroup) {
  const groupDate = dateKey(group.deliveryDate);
  const groupLines = lines.filter((line) => dateKey(line.requestedOn) === groupDate);
  const readinessStatus: Record<string, number> = {};
  const displayStatus: Record<string, number> = {};
  const allocationStatus: Record<string, number> = {};
  const etaStatus: Record<string, number> = {};

  for (const line of groupLines) {
    readinessStatus[line.readinessStatus ?? "null"] =
      (readinessStatus[line.readinessStatus ?? "null"] ?? 0) + 1;
    displayStatus[line.displayStatus ?? "null"] =
      (displayStatus[line.displayStatus ?? "null"] ?? 0) + 1;
    allocationStatus[line.allocationStatus ?? "null"] =
      (allocationStatus[line.allocationStatus ?? "null"] ?? 0) + 1;
    etaStatus[line.etaStatus ?? "null"] = (etaStatus[line.etaStatus ?? "null"] ?? 0) + 1;
  }

  return {
    deliveryGroupId: group.id,
    deliveryDate: groupDate,
    lineCount: groupLines.length,
    readinessStatus: JSON.stringify(readinessStatus),
    displayStatus: JSON.stringify(displayStatus),
    allocationStatus: JSON.stringify(allocationStatus),
    etaStatus: JSON.stringify(etaStatus),
  };
}

function paymentEvaluationRow(evaluation: DeliveryGroupPaymentEvaluation) {
  return {
    deliveryGroupId: evaluation.orderDeliveryGroupId,
    deliveryDate: evaluation.deliveryDate,
    lineCount: evaluation.lines.filter((line) => line.includedInCurrentDeliveryGroup).length,
    paymentApplicabilityStatus: evaluation.paymentApplicabilityStatus,
    paymentStatus: evaluation.paymentStatus,
    paidToDate: evaluation.paidToDate,
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
    calculationWarnings: evaluation.calculationWarnings.join("; "),
  };
}

async function writeReports(params: {
  order: BaselineOrder;
  lineRows: LineBaseline[];
  paymentEvaluations: DeliveryGroupPaymentEvaluation[];
  safetyBefore: SafetyCounts;
  safetyAfter: SafetyCounts;
  importMode: string;
  importSummary: unknown;
  fallbackReason?: string;
}) {
  await mkdir(REPORTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(
    REPORTS_DIR,
    `CB00528-baseline-order-payment-tax-summary-${timestamp}.md`
  );
  const lineCsvPath = path.join(
    REPORTS_DIR,
    `CB00528-line-level-scenario-input-${timestamp}.csv`
  );
  const paymentPath = path.join(
    REPORTS_DIR,
    `CB00528-delivery-group-payment-evaluation-${timestamp}.md`
  );

  const activeGroups = params.order.deliveryGroups.filter((group) => group.isActive);
  const taxRows = params.order.taxDetails.map((taxDetail) => ({
    taxId: taxDetail.taxId,
    customerTaxZone: taxDetail.customerTaxZone,
    taxRate: taxDetail.taxRate?.toString() ?? null,
    taxableAmount: taxDetail.taxableAmount?.toString() ?? null,
    taxAmount: taxDetail.taxAmount?.toString() ?? null,
    taxType: taxDetail.taxType,
    lineNbr: taxDetail.lineNbr,
    recordId: taxDetail.recordId,
  }));
  const deliveryGroupRows = params.order.deliveryGroups.map((group) => ({
    deliveryGroupId: group.id,
    deliveryDate: dateKey(group.deliveryDate),
    isActive: group.isActive,
    status: group.status,
    lineCount: group.lineCount,
    lastSeenAt: group.lastSeenAt?.toISOString() ?? null,
    supersededAt: group.supersededAt?.toISOString() ?? null,
    supersededReason: group.supersededReason,
  }));
  const readinessRows = activeGroups.map((group) =>
    readinessTotalsForGroup(params.order.lines, group)
  );

  const summary = [
    `# CB00528 Baseline Order / Payment / Tax Summary`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Import mode used: ${params.importMode}`,
    params.fallbackReason ? `Fallback: ${params.fallbackReason}` : null,
    "",
    "## Import Summary",
    "",
    "```json",
    JSON.stringify(params.importSummary, null, 2),
    "```",
    "",
    "## Order",
    "",
    markdownTable(
      ["field", "value"],
      [
        { field: "orderType", value: params.order.orderType },
        { field: "orderNumber", value: params.order.orderNumber },
        { field: "status", value: params.order.status },
        { field: "paymentTerms", value: params.order.total?.paymentTerms ?? null },
        { field: "unpaidBalance", value: params.order.total?.unpaidBalance?.toString() ?? null },
        { field: "orderTotal", value: params.order.total?.orderTotal?.toString() ?? null },
        { field: "taxTotal", value: params.order.total?.taxTotal?.toString() ?? null },
        {
          field: "lineTotalAmount",
          value: params.order.total?.lineTotalAmount?.toString() ?? null,
        },
        { field: "paidToDate", value: paidToDate(params.order) },
        { field: "buyerGroup", value: params.order.buyerGroup },
        { field: "customerDescription", value: params.order.customerDescription },
        { field: "locationDescription", value: params.order.locationDescription },
        { field: "contactId", value: params.order.contactId },
      ]
    ),
    "## Contact",
    "",
    markdownTable(
      ["field", "value"],
      [
        { field: "companyName", value: params.order.contact.companyName },
        { field: "displayName", value: params.order.contact.displayName },
        { field: "firstName", value: params.order.contact.firstName },
        { field: "lastName", value: params.order.contact.lastName },
        { field: "email", value: params.order.contact.email },
        { field: "phone1", value: params.order.contact.phone1 },
        { field: "phone2", value: params.order.contact.phone2 },
        { field: "smsOptIn", value: params.order.contact.smsOptIn },
        { field: "emailOptIn", value: params.order.contact.emailOptIn },
      ]
    ),
    "## Delivery Groups",
    "",
    `Delivery groups found: ${params.order.deliveryGroups.length}`,
    `Active delivery groups found: ${activeGroups.length}`,
    "",
    markdownTable(
      [
        "deliveryGroupId",
        "deliveryDate",
        "isActive",
        "status",
        "lineCount",
        "lastSeenAt",
        "supersededAt",
        "supersededReason",
      ],
      deliveryGroupRows
    ),
    "## Tax Details",
    "",
    markdownTable(
      [
        "taxId",
        "customerTaxZone",
        "taxRate",
        "taxableAmount",
        "taxAmount",
        "taxType",
        "lineNbr",
        "recordId",
      ],
      taxRows
    ),
    "## Line-Level Baseline",
    "",
    markdownTable(
      [
        "lineNbr",
        "inventoryId",
        "lineDescription",
        "itemType",
        "itemClass",
        "requestedOn",
        "eta",
        "taxCategory",
        "discountedUnitPrice",
        "orderQty",
        "openQty",
        "completedQtyDerived",
        "grossMerchandiseValue",
        "openMerchandiseValue",
        "completedMerchandiseValue",
        "allocationRows",
        "activeAllocatedQty",
        "allocationStatus",
        "etaStatus",
        "readinessStatus",
        "displayStatus",
      ],
      params.lineRows
    ),
    "## Active Delivery Group Readiness Totals",
    "",
    markdownTable(
      [
        "deliveryGroupId",
        "deliveryDate",
        "lineCount",
        "readinessStatus",
        "displayStatus",
        "allocationStatus",
        "etaStatus",
      ],
      readinessRows
    ),
    "## Future Rollback-Only Scenario Script Shape",
    "",
    [
      "1. Start a Prisma transaction and load the current CB00528 order graph.",
      "2. Update only scenario input fields on copied/current test rows: requestedOn, openQty, orderQty, discountedUnitPrice, taxCategory, and tax detail rows.",
      "3. Run the real delivery group sync, persisted readiness helper, and delivery group payment helper.",
      "4. Write the calculated helper output to a report.",
      "5. Throw a sentinel rollback error so all scenario mutations are discarded.",
      "6. Assert fixture/order counts and notification_attempts are unchanged after rollback.",
    ].join("\n"),
    "",
    "## Safety Counts",
    "",
    markdownTable(
      ["table", "before", "after"],
      [
        {
          table: "notification_events",
          before: params.safetyBefore.notificationEvents,
          after: params.safetyAfter.notificationEvents,
        },
        {
          table: "notification_attempts",
          before: params.safetyBefore.notificationAttempts,
          after: params.safetyAfter.notificationAttempts,
        },
        {
          table: "sms_opt_outs",
          before: params.safetyBefore.smsOptOuts,
          after: params.safetyAfter.smsOptOuts,
        },
        {
          table: "email_opt_outs",
          before: params.safetyBefore.emailOptOuts,
          after: params.safetyAfter.emailOptOuts,
        },
      ]
    ),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const scenarioHeaders = [
    "lineNbr",
    "inventoryId",
    "lineDescription",
    "itemType",
    "itemClass",
    "currentRequestedOn",
    "scenarioRequestedOn",
    "eta",
    "taxCategory",
    "discountedUnitPrice",
    "orderQty",
    "openQty",
    "completedQtyDerived",
    "grossMerchandiseValue",
    "openMerchandiseValue",
    "completedMerchandiseValue",
    "allocationRows",
    "activeAllocatedQty",
    "allocationStatus",
    "etaStatus",
    "readinessStatus",
    "displayStatus",
    "manualScenarioGroup",
    "manualExpectedPaymentDue",
    "manualNotes",
  ];
  const scenarioRows = params.lineRows.map((line) => ({
    ...line,
    currentRequestedOn: line.requestedOn,
    scenarioRequestedOn: "",
    manualScenarioGroup: "",
    manualExpectedPaymentDue: "",
    manualNotes: "",
  }));

  const paymentRows = params.paymentEvaluations.map(paymentEvaluationRow);
  const paymentLineRows = params.paymentEvaluations.flatMap((evaluation) =>
    evaluation.lines
      .filter((line) => line.includedInCurrentDeliveryGroup)
      .map((line) => ({
        deliveryGroupId: evaluation.orderDeliveryGroupId,
        deliveryDate: evaluation.deliveryDate,
        lineNbr: line.lineNbr,
        inventoryId: line.inventoryId,
        taxCategory: line.taxCategory,
        taxRate: line.taxRate,
        discountedUnitPrice: line.discountedUnitPrice,
        orderQty: line.orderQty,
        openQty: line.openQty,
        completedQtyDerived: line.completedQtyDerived,
        lineOpenMerchandiseValue: line.lineOpenMerchandiseValue,
        lineOpenTaxAmount: line.lineOpenTaxAmount,
        lineOpenTotalValue: line.lineOpenTotalValue,
      }))
  );
  const paymentReport = [
    `# CB00528 Current Delivery-Group Payment Evaluation`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Delivery Group Payment Output",
    "",
    markdownTable(
      [
        "deliveryGroupId",
        "deliveryDate",
        "lineCount",
        "paymentApplicabilityStatus",
        "paymentStatus",
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
        "calculationWarnings",
      ],
      paymentRows
    ),
    "## Grouped Readiness Totals",
    "",
    markdownTable(
      [
        "deliveryGroupId",
        "deliveryDate",
        "lineCount",
        "readinessStatus",
        "displayStatus",
        "allocationStatus",
        "etaStatus",
      ],
      readinessRows
    ),
    "## Included Lines Per Active Delivery Group",
    "",
    markdownTable(
      [
        "deliveryGroupId",
        "deliveryDate",
        "lineNbr",
        "inventoryId",
        "taxCategory",
        "taxRate",
        "discountedUnitPrice",
        "orderQty",
        "openQty",
        "completedQtyDerived",
        "lineOpenMerchandiseValue",
        "lineOpenTaxAmount",
        "lineOpenTotalValue",
      ],
      paymentLineRows
    ),
  ].join("\n");

  await writeFile(summaryPath, summary, "utf8");
  await writeFile(lineCsvPath, csv(scenarioHeaders, scenarioRows), "utf8");
  await writeFile(paymentPath, paymentReport, "utf8");

  return {
    summaryPath,
    lineCsvPath,
    paymentPath,
  };
}

function requireSuccessfulImport(result: Awaited<ReturnType<typeof runImportWithFallback>>) {
  const orderErrors = result.importResult.errors.filter(
    (error) => !error.orderNumber || error.orderNumber === ORDER_NUMBER
  );

  if (result.importResult.failedOrders > 0 || orderErrors.length > 0) {
    throw new Error(
      `${ORDER_NUMBER} import did not complete cleanly: ${JSON.stringify(
        result.importResult,
        null,
        2
      )}`
    );
  }
}

function requireCompleteOrder(order: BaselineOrder | null): asserts order is BaselineOrder {
  if (!order) {
    throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} was not found after import`);
  }
  if (!order.contact) {
    throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} is missing a related contact after import`);
  }
  if (!order.total) {
    throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} is missing order_totals after import`);
  }
  if (order.lines.length === 0) {
    throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} has no order_lines after import`);
  }
  if (order.deliveryGroups.length === 0) {
    throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} has no order_delivery_groups after import`);
  }
}

function fallbackReasonFor(result: Awaited<ReturnType<typeof runImportWithFallback>>) {
  return "fallbackReason" in result ? result.fallbackReason : undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const safetyBefore = await getSafetyCounts();
  const importRun = await runImportWithFallback(args.mode, args.requestedOn);

  requireSuccessfulImport(importRun);

  const order = await loadOrder();
  requireCompleteOrder(order);

  const total = order.total;
  if (!total) {
    throw new Error(`${ORDER_TYPE} ${ORDER_NUMBER} is missing order_totals after import`);
  }

  const lineRows = order.lines.map(lineBaseline);
  const paymentEvaluations = await getOrderPaymentEvaluations(order.id);
  const safetyAfter = await getSafetyCounts();
  const fallbackReason = fallbackReasonFor(importRun);
  const reportPaths = await writeReports({
    order,
    lineRows,
    paymentEvaluations,
    safetyBefore,
    safetyAfter,
    importMode: importRun.mode,
    importSummary: importRun.importResult,
    fallbackReason,
  });

  const activeGroups = order.deliveryGroups.filter((group) => group.isActive);
  const warnings = paymentEvaluations.flatMap((evaluation) =>
    evaluation.calculationWarnings.map((warning) => ({
      deliveryGroupId: evaluation.orderDeliveryGroupId,
      deliveryDate: evaluation.deliveryDate,
      warning,
    }))
  );

  console.log(
    JSON.stringify(
      {
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        importMode: importRun.mode,
        fallbackReason: fallbackReason ?? null,
        importSummary: importRun.importResult,
        orderSummary: {
          status: order.status,
          paymentTerms: total.paymentTerms,
          unpaidBalance: total.unpaidBalance?.toString() ?? null,
          orderTotal: total.orderTotal?.toString() ?? null,
          taxTotal: total.taxTotal?.toString() ?? null,
          lineTotalAmount: total.lineTotalAmount?.toString() ?? null,
          paidToDate: paidToDate(order),
          buyerGroup: order.buyerGroup,
          customerDescription: order.customerDescription,
          locationDescription: order.locationDescription,
          contactId: order.contactId,
          contactName: order.contact.displayName,
          contactCompanyName: order.contact.companyName,
          contactEmail: order.contact.email,
          contactPhone1: order.contact.phone1,
          contactPhone2: order.contact.phone2,
          deliveryGroupsFound: order.deliveryGroups.length,
          activeDeliveryGroupsFound: activeGroups.length,
          taxDetailRows: order.taxDetails.length,
          lineRows: order.lines.length,
        },
        activeDeliveryGroupPayment: paymentEvaluations.map(paymentEvaluationRow),
        warnings,
        safety: {
          before: safetyBefore,
          after: safetyAfter,
          notificationAttemptsUnchanged:
            safetyBefore.notificationAttempts === safetyAfter.notificationAttempts,
          notificationEventsUnchanged:
            safetyBefore.notificationEvents === safetyAfter.notificationEvents,
        },
        reports: reportPaths,
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
