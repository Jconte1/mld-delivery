import { NotificationIntervalType, type Prisma } from "@/lib/generated/prisma/client";
import { getFreshExternalStockMatchesForInventoryIds } from "@/lib/sharepoint-stock/externalStockReadiness";
import { normalizeStockInventoryId } from "@/lib/sharepoint-stock/stockInventoryNormalization";

export type PaymentApplicabilityStatus =
  | "not_applicable_terms"
  | "no_meaningful_balance_due"
  | "applicable";

export type PaymentStatus =
  | "not_applicable"
  | "no_balance_due"
  | "balance_due"
  | "calculation_blocked";

export type PaymentUrgencyStatus =
  | "reminder_only"
  | "payment_required"
  | "final_payment_required"
  | "escalation_required"
  | "not_applicable";

type DecimalLike = number | string | { toString(): string } | null | undefined;
type ScaledDecimal = bigint;
type MoneyString = string;

export type DeliveryPaymentTaxDetailInput = {
  taxId: string | null;
  taxType: string | null;
  customerTaxZone: string | null;
  taxRate: DecimalLike;
  taxableAmount: DecimalLike;
  taxAmount: DecimalLike;
};

export type DeliveryPaymentLineInput = {
  id: string;
  lineNbr: number;
  inventoryId: string | null;
  lineDescription: string | null;
  itemType: string | null;
  itemClass: string | null;
  requestedOn: Date | string | null;
  taxCategory: string | null;
  discountedUnitPrice: DecimalLike;
  orderQty: DecimalLike;
  openQty: DecimalLike;
  activeAllocatedQty?: DecimalLike;
  allocationStatus?: string | null;
  etaStatus?: string | null;
  readinessStatus?: string | null;
};

export type DeliveryPaymentChargeAllocationInput = {
  orderDeliveryGroupId: string;
  orderLineId: string;
  amountIncluded: DecimalLike;
  sourceInterval?: NotificationIntervalType | string | null;
};

export type DeliveryGroupPaymentInput = {
  orderDeliveryGroupId: string;
  orderId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
  paymentTerms: string | null;
  unpaidBalance: DecimalLike;
  orderTotal: DecimalLike;
  taxTotal: DecimalLike;
  lines: DeliveryPaymentLineInput[];
  taxDetails: DeliveryPaymentTaxDetailInput[];
  activeOrderLineIds?: string[];
  freightDeliveryChargeAllocations?: DeliveryPaymentChargeAllocationInput[];
  newlyAssignedFreightDeliveryChargeLines?: DeliveryPaymentLineInput[];
  externalStockReadyInventoryIds?: Set<string>;
};

export type DeliveryGroupPaymentLineEvaluation = {
  lineNbr: number;
  inventoryId: string | null;
  lineDescription: string | null;
  itemType: string | null;
  itemClass: string | null;
  requestedOn: string | null;
  taxCategory: string | null;
  taxRate: string | null;
  discountedUnitPrice: MoneyString;
  orderQty: string;
  openQty: string;
  activeAllocatedQty: string;
  allocationStatus: string | null;
  etaStatus: string | null;
  readinessStatus: string | null;
  completedQtyDerived: string;
  payableQuantity: string;
  payableStockMerchandiseValue: MoneyString;
  payableStockTaxAmount: MoneyString | null;
  payableStockTotalValue: MoneyString | null;
  payableBasisIncluded: boolean;
  payableBasisExclusionReason: string | null;
  externalStockReadinessMatched?: boolean;
  lineGrossMerchandiseValue: MoneyString;
  lineGrossTaxAmount: MoneyString | null;
  lineGrossTotalValue: MoneyString | null;
  lineOpenMerchandiseValue: MoneyString;
  lineOpenTaxAmount: MoneyString | null;
  lineOpenTotalValue: MoneyString | null;
  lineCompletedMerchandiseValue: MoneyString;
  lineCompletedTaxAmount: MoneyString | null;
  lineCompletedTotalValue: MoneyString | null;
  includedInCurrentDeliveryGroup: boolean;
};

export type DeliveryGroupPaymentEvaluation = {
  orderDeliveryGroupId: string;
  orderId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: string;
  paymentTerms: string | null;
  unpaidBalance: MoneyString | null;
  orderTotal: MoneyString | null;
  taxTotal: MoneyString | null;
  paidToDate: MoneyString | null;
  currentDeliveryGroupMerchandiseValue: MoneyString;
  currentDeliveryGroupTaxAmount: MoneyString | null;
  currentDeliveryGroupValue: MoneyString | null;
  completedValueBeforeCurrentDelivery: MoneyString | null;
  remainingUndeliveredValueAfterCurrentDelivery: MoneyString | null;
  creditAfterCurrentDelivery: MoneyString | null;
  requiredDownOnRemaining: MoneyString | null;
  amountDueNow: string | null;
  amountDueNowRounded: MoneyString | null;
  payableStockValue: MoneyString;
  assignedFreightDeliveryChargeValue: MoneyString;
  newlyAssignedFreightDeliveryChargeValue: MoneyString;
  payableBasisValue: MoneyString;
  freightDeliveryChargeTodos?: string[];
  paymentApplicabilityStatus: PaymentApplicabilityStatus;
  paymentStatus: PaymentStatus;
  urgencyStatus: PaymentUrgencyStatus;
  calculationWarnings: string[];
  lines: DeliveryGroupPaymentLineEvaluation[];
};

type DeliveryPaymentPrismaClient = Pick<
  Prisma.TransactionClient,
  "orderDeliveryGroup"
> &
  Partial<Pick<Prisma.TransactionClient, "order" | "deliveryGroupPaymentChargeAllocation">>;

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const SCALE = BigInt(1_000_000);
export const APPROVED_DELIVERY_PAYMENT_TERMS = ["PIF", "PP", "PPP", "PPT"] as const;

const ELIGIBLE_PAYMENT_TERMS = new Set<string>(APPROVED_DELIVERY_PAYMENT_TERMS);
const MEANINGFUL_BALANCE_THRESHOLD = TWO * SCALE;
const DOWN_PAYMENT_RATE_NUMERATOR = BigInt(45);
const DOWN_PAYMENT_RATE_DENOMINATOR = BigInt(100);
const DELIVERABLE_STOCK_ITEM_TYPE = "F";
const NON_STOCK_ITEM_TYPE = "N";
const FREIGHT_DELIVERY_CHARGE_TYPE = "freight_delivery";
const PAYABLE_STOCK_READINESS_STATUSES = new Set([
  "ready",
  "expected_on_time",
  "partially_allocated",
]);
const PAYMENT_GATED_INTERVALS = new Set<NotificationIntervalType>([
  NotificationIntervalType.DAY_14,
  NotificationIntervalType.DAY_12,
  NotificationIntervalType.DAY_10,
  NotificationIntervalType.DAY_8,
]);

export type DeliveryGroupPaymentEvaluationOptions = {
  sourceInterval?: NotificationIntervalType | null;
  allocateFreightDeliveryCharges?: boolean;
  dryRun?: boolean;
};

async function getPaymentPrisma(client?: DeliveryPaymentPrismaClient) {
  if (client) return client;
  const { prisma } = await import("@/lib/prisma");
  return prisma;
}

function parseScaledDecimal(value: DecimalLike): ScaledDecimal | null {
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

function formatScaled(value: ScaledDecimal, decimals: number) {
  if (decimals < 0 || decimals > 6) {
    throw new Error(`Unsupported decimal precision: ${decimals}`);
  }

  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  const divisor = TEN ** BigInt(6 - decimals);
  const rounded = (absolute + divisor / TWO) / divisor;
  const scale = TEN ** BigInt(decimals);
  const whole = rounded / scale;
  const fraction = rounded % scale;
  const sign = negative ? "-" : "";

  if (decimals === 0) return `${sign}${whole.toString()}`;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(decimals, "0")}`;
}

function formatMoney(value: ScaledDecimal): MoneyString {
  return formatScaled(value, 2);
}

function formatExactMoney(value: ScaledDecimal) {
  return formatScaled(value, 6);
}

function formatQuantity(value: ScaledDecimal) {
  return formatScaled(value, 4);
}

function normalizeRate(value: ScaledDecimal) {
  let formatted = formatScaled(value, 6);
  formatted = formatted.replace(/\.?0+$/, "");
  return formatted || "0";
}

function multiplyScaled(left: ScaledDecimal, right: ScaledDecimal) {
  return (left * right + SCALE / TWO) / SCALE;
}

function multiplyByPercent(value: ScaledDecimal, percent: ScaledDecimal) {
  const denominator = SCALE * BigInt(100);
  return (value * percent + denominator / TWO) / denominator;
}

function clampAtZero(value: ScaledDecimal) {
  return value < ZERO ? ZERO : value;
}

function dateKey(value: Date | string | null | undefined) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const trimmed = value.trim();
  const isoDatePrefix = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDatePrefix) return isoDatePrefix[1];

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateKey(parsed);
}

function dateFromDateKey(value: Date | string) {
  const key = dateKey(value);
  if (!key) {
    throw new Error(`Invalid delivery date: ${String(value)}`);
  }
  return new Date(`${key}T00:00:00.000Z`);
}

function uniqueNonZeroTaxRates(taxDetails: DeliveryPaymentTaxDetailInput[]) {
  const rates = new Map<string, ScaledDecimal>();

  for (const detail of taxDetails) {
    const rate = parseScaledDecimal(detail.taxRate) ?? ZERO;
    if (rate <= ZERO) continue;
    rates.set(normalizeRate(rate), rate);
  }

  return [...rates.values()];
}

function taxRateForLine(params: {
  taxCategory: string | null;
  taxTotal: ScaledDecimal;
  nonZeroTaxRates: ScaledDecimal[];
  warnings: string[];
}) {
  if (params.taxTotal <= ZERO || params.nonZeroTaxRates.length === 0) {
    return { rate: ZERO, blocked: false };
  }

  const category = params.taxCategory?.trim().toUpperCase() || null;
  if (category === "EXEMPT") return { rate: ZERO, blocked: false };
  if (category !== "TAXABLE") {
    params.warnings.push(`Line has missing/unknown taxCategory=${category ?? "null"}; tax treated as 0.`);
    return { rate: ZERO, blocked: false };
  }

  if (params.nonZeroTaxRates.length === 1) {
    return { rate: params.nonZeroTaxRates[0], blocked: false };
  }

  params.warnings.push(
    `Tax calculation blocked: taxable line has multiple nonzero tax rates (${params.nonZeroTaxRates
      .map(normalizeRate)
      .join(", ")}).`
  );
  return { rate: null, blocked: true };
}

function moneyOrNull(value: ScaledDecimal | null) {
  return value === null ? null : formatMoney(value);
}

export function isMeaningfulDeliveryPaymentAmount(value: string | null | undefined) {
  const parsed = parseScaledDecimal(value);
  return parsed !== null && parsed > MEANINGFUL_BALANCE_THRESHOLD;
}

function normalizedText(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function normalizedStatus(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? null;
}

function lineIsDeliverableStock(line: DeliveryPaymentLineInput) {
  return line.itemType === DELIVERABLE_STOCK_ITEM_TYPE;
}

function lineHasExternalStockReadinessMatch(
  line: DeliveryPaymentLineInput,
  externalStockReadyInventoryIds: Set<string> | undefined
) {
  if (!externalStockReadyInventoryIds || !lineIsDeliverableStock(line)) return false;
  const normalizedInventoryId = normalizeStockInventoryId(line.inventoryId);
  return Boolean(
    normalizedInventoryId && externalStockReadyInventoryIds.has(normalizedInventoryId)
  );
}

function lineBelongsToCurrentDeliveryGroup(params: {
  line: DeliveryPaymentLineInput;
  deliveryDate: string;
  activeOrderLineIds: Set<string> | null;
}) {
  if (params.activeOrderLineIds) {
    return params.activeOrderLineIds.has(params.line.id);
  }
  return dateKey(params.line.requestedOn) === params.deliveryDate;
}

function freightDeliveryChargeMatchesKeyword(line: DeliveryPaymentLineInput) {
  const inventoryId = normalizedText(line.inventoryId);
  const description = normalizedText(line.lineDescription);
  return (
    inventoryId.includes("freight") ||
    inventoryId.includes("delivery") ||
    description.includes("freight") ||
    description.includes("delivery")
  );
}

export function isFreightDeliveryChargeLine(line: DeliveryPaymentLineInput) {
  return line.itemType === NON_STOCK_ITEM_TYPE && freightDeliveryChargeMatchesKeyword(line);
}

function lineOpenMerchandiseAmount(line: DeliveryPaymentLineInput) {
  const price = parseScaledDecimal(line.discountedUnitPrice) ?? ZERO;
  const openQty = parseScaledDecimal(line.openQty) ?? ZERO;
  return multiplyScaled(price, openQty);
}

function freightDeliveryOpenAmount(line: DeliveryPaymentLineInput) {
  if (!isFreightDeliveryChargeLine(line)) return ZERO;
  return lineOpenMerchandiseAmount(line);
}

function payableStockQuantity(params: {
  line: DeliveryPaymentLineInput;
  externalStockReadinessMatched: boolean;
}) {
  const { line } = params;
  if (!lineIsDeliverableStock(line)) return { quantity: ZERO, reason: "not_deliverable_stock" };

  const price = parseScaledDecimal(line.discountedUnitPrice) ?? ZERO;
  if (price <= ZERO) return { quantity: ZERO, reason: "non_positive_price" };

  const openQty = parseScaledDecimal(line.openQty) ?? ZERO;
  if (openQty <= ZERO) return { quantity: ZERO, reason: "non_positive_open_qty" };

  if (params.externalStockReadinessMatched) {
    return { quantity: openQty, reason: null };
  }

  const readinessStatus = normalizedStatus(line.readinessStatus);
  if (!readinessStatus || !PAYABLE_STOCK_READINESS_STATUSES.has(readinessStatus)) {
    return { quantity: ZERO, reason: `readiness_${readinessStatus ?? "unknown"}_excluded` };
  }

  const activeAllocatedQty = parseScaledDecimal(line.activeAllocatedQty) ?? ZERO;
  if (readinessStatus === "partially_allocated") {
    if (activeAllocatedQty <= ZERO) {
      return { quantity: ZERO, reason: "partially_allocated_without_active_allocation" };
    }
    return { quantity: activeAllocatedQty < openQty ? activeAllocatedQty : openQty, reason: null };
  }

  if (readinessStatus === "ready" && activeAllocatedQty > ZERO) {
    return { quantity: activeAllocatedQty < openQty ? activeAllocatedQty : openQty, reason: null };
  }

  return { quantity: openQty, reason: null };
}

function shouldAllocateFreightDeliveryCharges(
  options: DeliveryGroupPaymentEvaluationOptions | undefined
) {
  return (
    Boolean(options?.allocateFreightDeliveryCharges) &&
    Boolean(options?.sourceInterval) &&
    PAYMENT_GATED_INTERVALS.has(options?.sourceInterval as NotificationIntervalType)
  );
}

export function normalizeDeliveryPaymentTerms(value: string | null | undefined) {
  return value?.trim().toUpperCase() || null;
}

export function isEligibleDeliveryPaymentTerm(value: string | null | undefined) {
  const normalized = normalizeDeliveryPaymentTerms(value);
  return normalized !== null && ELIGIBLE_PAYMENT_TERMS.has(normalized);
}

export function evaluateDeliveryGroupPayment(
  input: DeliveryGroupPaymentInput
): DeliveryGroupPaymentEvaluation {
  const warnings: string[] = [];
  const freightDeliveryChargeTodos: string[] = [];
  const deliveryDate = dateKey(input.deliveryDate);
  if (!deliveryDate) {
    throw new Error(`Invalid delivery group date: ${String(input.deliveryDate)}`);
  }

  const paymentTerms = normalizeDeliveryPaymentTerms(input.paymentTerms);
  const unpaidBalance = parseScaledDecimal(input.unpaidBalance);
  const orderTotal = parseScaledDecimal(input.orderTotal);
  const taxTotal = parseScaledDecimal(input.taxTotal) ?? ZERO;
  const eligibleTerms = isEligibleDeliveryPaymentTerm(paymentTerms);
  const nonZeroTaxRates = taxTotal > ZERO ? uniqueNonZeroTaxRates(input.taxDetails) : [];
  const seenWarnings = new Set<string>();
  const seenTodos = new Set<string>();
  const activeOrderLineIds = input.activeOrderLineIds
    ? new Set(input.activeOrderLineIds.filter(Boolean))
    : null;
  const externalStockReadyInventoryIds = input.externalStockReadyInventoryIds;
  const currentFreightAllocationLineIds = new Set(
    (input.freightDeliveryChargeAllocations ?? [])
      .filter((allocation) => allocation.orderDeliveryGroupId === input.orderDeliveryGroupId)
      .map((allocation) => allocation.orderLineId)
  );
  const allocatedFreightLineIds = new Set(
    (input.freightDeliveryChargeAllocations ?? []).map((allocation) => allocation.orderLineId)
  );
  const newlyAssignedFreightLines = input.newlyAssignedFreightDeliveryChargeLines ?? [];
  const newlyAssignedFreightLineIds = new Set(
    newlyAssignedFreightLines
      .filter((line) => !allocatedFreightLineIds.has(line.id))
      .filter((line) => freightDeliveryOpenAmount(line) > ZERO)
      .map((line) => line.id)
  );

  function addWarning(warning: string) {
    if (!seenWarnings.has(warning)) {
      seenWarnings.add(warning);
      warnings.push(warning);
    }
  }

  function addTodo(todo: string) {
    if (!seenTodos.has(todo)) {
      seenTodos.add(todo);
      freightDeliveryChargeTodos.push(todo);
    }
  }

  if (taxTotal > ZERO && input.taxDetails.length === 0) {
    addWarning("Order has taxTotal but no TaxDetails rows; effective tax treated as 0.");
  }

  let taxCalculationBlocked = false;
  let currentDeliveryGroupMerchandiseValue = ZERO;
  let currentDeliveryGroupTaxAmount: ScaledDecimal | null = ZERO;
  let completedValueBeforeCurrentDelivery: ScaledDecimal | null = ZERO;
  let payableStockValue: ScaledDecimal | null = ZERO;
  let assignedFreightDeliveryChargeValue = ZERO;
  let newlyAssignedFreightDeliveryChargeValue = ZERO;

  for (const allocation of input.freightDeliveryChargeAllocations ?? []) {
    if (allocation.orderDeliveryGroupId !== input.orderDeliveryGroupId) continue;
    const amount = parseScaledDecimal(allocation.amountIncluded) ?? ZERO;
    if (amount > ZERO) assignedFreightDeliveryChargeValue += amount;
  }

  for (const line of newlyAssignedFreightLines) {
    if (allocatedFreightLineIds.has(line.id)) continue;
    const amount = freightDeliveryOpenAmount(line);
    if (amount > ZERO) newlyAssignedFreightDeliveryChargeValue += amount;
  }

  const lineEvaluations: DeliveryGroupPaymentLineEvaluation[] = input.lines.map((line) => {
    const lineWarnings: string[] = [];
    const price = parseScaledDecimal(line.discountedUnitPrice) ?? ZERO;
    const orderQty = parseScaledDecimal(line.orderQty) ?? ZERO;
    const openQty = parseScaledDecimal(line.openQty) ?? ZERO;
    const activeAllocatedQty = parseScaledDecimal(line.activeAllocatedQty) ?? ZERO;
    const completedQty = clampAtZero(orderQty - openQty);
    const lineDate = dateKey(line.requestedOn);
    const includedInCurrentDeliveryGroup = lineBelongsToCurrentDeliveryGroup({
      line,
      deliveryDate,
      activeOrderLineIds,
    });
    const isStock = lineIsDeliverableStock(line);
    const externalStockReadinessMatched =
      includedInCurrentDeliveryGroup &&
      lineHasExternalStockReadinessMatch(line, externalStockReadyInventoryIds);
    const isFreightDeliveryCharge = isFreightDeliveryChargeLine(line);
    const isRelevantForPaymentBasis = isStock;
    const taxRate = isRelevantForPaymentBasis
      ? taxRateForLine({
          taxCategory: line.taxCategory,
          taxTotal,
          nonZeroTaxRates,
          warnings: lineWarnings,
        })
      : { rate: ZERO, blocked: false };

    if (
      isRelevantForPaymentBasis &&
      (line.discountedUnitPrice === null || line.discountedUnitPrice === undefined)
    ) {
      addWarning(`Line ${line.lineNbr} missing discountedUnitPrice; treated as 0.`);
    }
    if (isRelevantForPaymentBasis && (line.orderQty === null || line.orderQty === undefined)) {
      addWarning(`Line ${line.lineNbr} missing orderQty; treated as 0.`);
    }
    if (isRelevantForPaymentBasis && (line.openQty === null || line.openQty === undefined)) {
      addWarning(`Line ${line.lineNbr} missing openQty; treated as 0.`);
    }
    for (const warning of lineWarnings) addWarning(`Line ${line.lineNbr}: ${warning}`);

    const lineGrossMerchandiseValue = multiplyScaled(price, orderQty);
    const lineOpenMerchandiseValue = multiplyScaled(price, openQty);
    const lineCompletedMerchandiseValue = multiplyScaled(price, completedQty);
    const stockQuantity = payableStockQuantity({
      line,
      externalStockReadinessMatched,
    });
    const payableQuantity =
      includedInCurrentDeliveryGroup && stockQuantity.reason === null
        ? stockQuantity.quantity
        : ZERO;
    const payableStockMerchandiseValue = multiplyScaled(price, payableQuantity);
    const freightAllocatedToCurrentGroup =
      currentFreightAllocationLineIds.has(line.id) || newlyAssignedFreightLineIds.has(line.id);
    const payableBasisIncluded = payableQuantity > ZERO || freightAllocatedToCurrentGroup;
    let payableBasisExclusionReason: string | null = null;

    if (!payableBasisIncluded) {
      if (isStock && !includedInCurrentDeliveryGroup) {
        payableBasisExclusionReason = "not_current_delivery_group";
      } else if (isStock) {
        payableBasisExclusionReason = stockQuantity.reason;
      } else if (isFreightDeliveryCharge && allocatedFreightLineIds.has(line.id)) {
        payableBasisExclusionReason = "freight_delivery_charge_already_allocated";
      } else if (isFreightDeliveryCharge && freightDeliveryOpenAmount(line) <= ZERO) {
        payableBasisExclusionReason = "freight_delivery_charge_no_positive_open_amount";
      } else if (line.itemType === NON_STOCK_ITEM_TYPE) {
        payableBasisExclusionReason = "ordinary_non_stock_excluded";
      } else {
        payableBasisExclusionReason = "not_payable_line_type";
      }
    }

    if (
      isFreightDeliveryCharge &&
      !allocatedFreightLineIds.has(line.id) &&
      freightDeliveryOpenAmount(line) <= ZERO &&
      lineGrossMerchandiseValue > ZERO
    ) {
      addTodo(
        `Line ${line.lineNbr} freight/delivery charge has positive gross value but no positive open value; not automatically included.`
      );
    }

    let lineGrossTaxAmount: ScaledDecimal | null = null;
    let lineOpenTaxAmount: ScaledDecimal | null = null;
    let lineCompletedTaxAmount: ScaledDecimal | null = null;
    let payableStockTaxAmount: ScaledDecimal | null = ZERO;

    if (taxRate.blocked || taxRate.rate === null) {
      taxCalculationBlocked = true;
      currentDeliveryGroupTaxAmount = null;
      completedValueBeforeCurrentDelivery = null;
      payableStockValue = null;
      payableStockTaxAmount = null;
    } else {
      lineGrossTaxAmount = multiplyByPercent(lineGrossMerchandiseValue, taxRate.rate);
      lineOpenTaxAmount = multiplyByPercent(lineOpenMerchandiseValue, taxRate.rate);
      lineCompletedTaxAmount = multiplyByPercent(lineCompletedMerchandiseValue, taxRate.rate);
      payableStockTaxAmount = multiplyByPercent(payableStockMerchandiseValue, taxRate.rate);

      if (payableQuantity > ZERO) {
        currentDeliveryGroupTaxAmount =
          currentDeliveryGroupTaxAmount === null
            ? null
            : currentDeliveryGroupTaxAmount + payableStockTaxAmount;
      }

      if (isStock) {
        completedValueBeforeCurrentDelivery =
          completedValueBeforeCurrentDelivery === null
            ? null
            : completedValueBeforeCurrentDelivery +
              lineCompletedMerchandiseValue +
              lineCompletedTaxAmount;
      }
    }

    if (payableQuantity > ZERO) {
      currentDeliveryGroupMerchandiseValue += payableStockMerchandiseValue;
    }

    return {
      lineNbr: line.lineNbr,
      inventoryId: line.inventoryId,
      lineDescription: line.lineDescription,
      itemType: line.itemType,
      itemClass: line.itemClass,
      requestedOn: lineDate,
      taxCategory: line.taxCategory,
      taxRate: taxRate.rate === null ? null : normalizeRate(taxRate.rate),
      discountedUnitPrice: formatMoney(price),
      orderQty: formatQuantity(orderQty),
      openQty: formatQuantity(openQty),
      activeAllocatedQty: formatQuantity(activeAllocatedQty),
      allocationStatus: line.allocationStatus ?? null,
      etaStatus: line.etaStatus ?? null,
      readinessStatus: line.readinessStatus ?? null,
      completedQtyDerived: formatQuantity(completedQty),
      payableQuantity: formatQuantity(payableQuantity),
      payableStockMerchandiseValue: formatMoney(payableStockMerchandiseValue),
      payableStockTaxAmount: moneyOrNull(payableStockTaxAmount),
      payableStockTotalValue: moneyOrNull(
        payableStockTaxAmount === null
          ? null
          : payableStockMerchandiseValue + payableStockTaxAmount
      ),
      payableBasisIncluded,
      payableBasisExclusionReason,
      externalStockReadinessMatched,
      lineGrossMerchandiseValue: formatMoney(lineGrossMerchandiseValue),
      lineGrossTaxAmount: moneyOrNull(lineGrossTaxAmount),
      lineGrossTotalValue: moneyOrNull(
        lineGrossTaxAmount === null ? null : lineGrossMerchandiseValue + lineGrossTaxAmount
      ),
      lineOpenMerchandiseValue: formatMoney(lineOpenMerchandiseValue),
      lineOpenTaxAmount: moneyOrNull(lineOpenTaxAmount),
      lineOpenTotalValue: moneyOrNull(
        lineOpenTaxAmount === null ? null : lineOpenMerchandiseValue + lineOpenTaxAmount
      ),
      lineCompletedMerchandiseValue: formatMoney(lineCompletedMerchandiseValue),
      lineCompletedTaxAmount: moneyOrNull(lineCompletedTaxAmount),
      lineCompletedTotalValue: moneyOrNull(
        lineCompletedTaxAmount === null
          ? null
          : lineCompletedMerchandiseValue + lineCompletedTaxAmount
      ),
      includedInCurrentDeliveryGroup,
    };
  });

  if (payableStockValue !== null && currentDeliveryGroupTaxAmount !== null) {
    payableStockValue = currentDeliveryGroupMerchandiseValue + currentDeliveryGroupTaxAmount;
  }

  let paymentApplicabilityStatus: PaymentApplicabilityStatus = "applicable";
  let paymentStatus: PaymentStatus = "no_balance_due";
  let urgencyStatus: PaymentUrgencyStatus = "reminder_only";

  if (!eligibleTerms) {
    paymentApplicabilityStatus = "not_applicable_terms";
    paymentStatus = "not_applicable";
    urgencyStatus = "not_applicable";
  } else if (unpaidBalance !== null && unpaidBalance <= MEANINGFUL_BALANCE_THRESHOLD) {
    paymentApplicabilityStatus = "no_meaningful_balance_due";
    paymentStatus = "no_balance_due";
    urgencyStatus = "not_applicable";
  }

  const paidToDate = orderTotal !== null && unpaidBalance !== null ? orderTotal - unpaidBalance : null;
  const currentDeliveryGroupValue =
    payableStockValue === null
      ? null
      : payableStockValue +
        assignedFreightDeliveryChargeValue +
        newlyAssignedFreightDeliveryChargeValue;

  let remainingUndeliveredValueAfterCurrentDelivery: ScaledDecimal | null = null;
  let creditAfterCurrentDelivery: ScaledDecimal | null = null;
  let requiredDownOnRemaining: ScaledDecimal | null = null;
  let amountDueNow: ScaledDecimal | null = null;

  if (
    paymentApplicabilityStatus === "applicable" &&
    (orderTotal === null || unpaidBalance === null || paidToDate === null)
  ) {
    paymentStatus = "calculation_blocked";
    urgencyStatus = "not_applicable";
    addWarning("Payment calculation blocked: orderTotal or unpaidBalance is missing.");
  } else if (paymentApplicabilityStatus === "applicable" && taxCalculationBlocked) {
    paymentStatus = "calculation_blocked";
    urgencyStatus = "not_applicable";
  } else if (
    paymentApplicabilityStatus === "applicable" &&
    currentDeliveryGroupValue !== null &&
    currentDeliveryGroupValue <= ZERO
  ) {
    paymentStatus = "no_balance_due";
    urgencyStatus = "reminder_only";
  } else if (
    paymentApplicabilityStatus === "applicable" &&
    orderTotal !== null &&
    unpaidBalance !== null &&
    paidToDate !== null &&
    currentDeliveryGroupValue !== null &&
    completedValueBeforeCurrentDelivery !== null
  ) {
    remainingUndeliveredValueAfterCurrentDelivery = clampAtZero(
      orderTotal - completedValueBeforeCurrentDelivery - currentDeliveryGroupValue
    );
    creditAfterCurrentDelivery =
      paidToDate - completedValueBeforeCurrentDelivery - currentDeliveryGroupValue;
    requiredDownOnRemaining =
      (remainingUndeliveredValueAfterCurrentDelivery * DOWN_PAYMENT_RATE_NUMERATOR +
        DOWN_PAYMENT_RATE_DENOMINATOR / TWO) /
      DOWN_PAYMENT_RATE_DENOMINATOR;
    amountDueNow = requiredDownOnRemaining - creditAfterCurrentDelivery;
    amountDueNow = clampAtZero(amountDueNow);
    if (amountDueNow > unpaidBalance) amountDueNow = unpaidBalance;

    if (amountDueNow > MEANINGFUL_BALANCE_THRESHOLD) {
      paymentStatus = "balance_due";
      urgencyStatus = "payment_required";
    } else {
      paymentStatus = "no_balance_due";
      urgencyStatus = "reminder_only";
    }
  }

  return {
    orderDeliveryGroupId: input.orderDeliveryGroupId,
    orderId: input.orderId,
    orderType: input.orderType,
    orderNumber: input.orderNumber,
    deliveryDate,
    paymentTerms,
    unpaidBalance: moneyOrNull(unpaidBalance),
    orderTotal: moneyOrNull(orderTotal),
    taxTotal: formatMoney(taxTotal),
    paidToDate: moneyOrNull(paidToDate),
    currentDeliveryGroupMerchandiseValue: formatMoney(currentDeliveryGroupMerchandiseValue),
    currentDeliveryGroupTaxAmount: moneyOrNull(currentDeliveryGroupTaxAmount),
    currentDeliveryGroupValue: moneyOrNull(currentDeliveryGroupValue),
    completedValueBeforeCurrentDelivery: moneyOrNull(completedValueBeforeCurrentDelivery),
    remainingUndeliveredValueAfterCurrentDelivery: moneyOrNull(
      remainingUndeliveredValueAfterCurrentDelivery
    ),
    creditAfterCurrentDelivery: moneyOrNull(creditAfterCurrentDelivery),
    requiredDownOnRemaining: moneyOrNull(requiredDownOnRemaining),
    amountDueNow: amountDueNow === null ? null : formatExactMoney(amountDueNow),
    amountDueNowRounded: moneyOrNull(amountDueNow),
    payableStockValue: moneyOrNull(payableStockValue) ?? "0.00",
    assignedFreightDeliveryChargeValue: formatMoney(assignedFreightDeliveryChargeValue),
    newlyAssignedFreightDeliveryChargeValue: formatMoney(newlyAssignedFreightDeliveryChargeValue),
    payableBasisValue: moneyOrNull(currentDeliveryGroupValue) ?? "0.00",
    freightDeliveryChargeTodos,
    paymentApplicabilityStatus,
    paymentStatus,
    urgencyStatus,
    calculationWarnings: warnings,
    lines: lineEvaluations,
  };
}

type DeliveryGroupWithPaymentData = NonNullable<
  Awaited<ReturnType<typeof getDeliveryGroupWithPaymentData>>
>;

function inputFromDeliveryGroup(
  deliveryGroup: DeliveryGroupWithPaymentData,
  params: {
    freightDeliveryChargeAllocations?: DeliveryPaymentChargeAllocationInput[];
    newlyAssignedFreightDeliveryChargeLines?: DeliveryPaymentLineInput[];
  } = {}
): DeliveryGroupPaymentInput {
  return {
    orderDeliveryGroupId: deliveryGroup.id,
    orderId: deliveryGroup.orderId,
    orderType: deliveryGroup.orderType,
    orderNumber: deliveryGroup.orderNumber,
    deliveryDate: deliveryGroup.deliveryDate,
    paymentTerms: deliveryGroup.order.total?.paymentTerms ?? null,
    unpaidBalance: deliveryGroup.order.total?.unpaidBalance,
    orderTotal: deliveryGroup.order.total?.orderTotal,
    taxTotal: deliveryGroup.order.total?.taxTotal,
    lines: deliveryGroup.order.lines,
    taxDetails: deliveryGroup.order.taxDetails,
    activeOrderLineIds: deliveryGroup.deliveryGroupLines
      .map((line) => line.orderLineId)
      .filter((orderLineId): orderLineId is string => Boolean(orderLineId)),
    freightDeliveryChargeAllocations:
      params.freightDeliveryChargeAllocations ??
      deliveryGroup.order.deliveryGroupPaymentChargeAllocations,
    newlyAssignedFreightDeliveryChargeLines: params.newlyAssignedFreightDeliveryChargeLines,
  };
}

function orderLinePaymentWhere(): Prisma.OrderLineWhereInput {
  return {
    OR: [
      { deliveryGroupLines: { some: { isActive: true } } },
      {
        itemType: NON_STOCK_ITEM_TYPE,
        OR: [
          { inventoryId: { contains: "freight", mode: "insensitive" } },
          { inventoryId: { contains: "delivery", mode: "insensitive" } },
          { lineDescription: { contains: "freight", mode: "insensitive" } },
          { lineDescription: { contains: "delivery", mode: "insensitive" } },
        ],
      },
    ],
  };
}

function getUnallocatedFreightDeliveryChargeLines(input: DeliveryGroupPaymentInput) {
  const allocatedLineIds = new Set(
    (input.freightDeliveryChargeAllocations ?? []).map((allocation) => allocation.orderLineId)
  );
  return input.lines.filter(
    (line) =>
      isFreightDeliveryChargeLine(line) &&
      !allocatedLineIds.has(line.id) &&
      freightDeliveryOpenAmount(line) > ZERO
  );
}

function chargeAllocationDelegate(client: DeliveryPaymentPrismaClient) {
  const delegate = client.deliveryGroupPaymentChargeAllocation;
  if (!delegate) {
    throw new Error(
      "DeliveryGroupPaymentChargeAllocation delegate is unavailable; run prisma generate after applying the payable-basis schema change."
    );
  }
  return delegate;
}

async function refreshPaymentChargeAllocations(params: {
  client: DeliveryPaymentPrismaClient;
  orderId: string;
}) {
  return chargeAllocationDelegate(params.client).findMany({
    where: { orderId: params.orderId },
    select: {
      orderDeliveryGroupId: true,
      orderLineId: true,
      amountIncluded: true,
      sourceInterval: true,
    },
    orderBy: [{ includedAt: "asc" }, { orderLineId: "asc" }],
  });
}

async function inputWithFreightDeliveryAllocations(
  deliveryGroup: DeliveryGroupWithPaymentData,
  client: DeliveryPaymentPrismaClient,
  options?: DeliveryGroupPaymentEvaluationOptions
) {
  const input = inputFromDeliveryGroup(deliveryGroup);
  if (!shouldAllocateFreightDeliveryCharges(options)) {
    return input;
  }

  const candidates = getUnallocatedFreightDeliveryChargeLines(input);
  if (options?.dryRun) {
    return inputFromDeliveryGroup(deliveryGroup, {
      newlyAssignedFreightDeliveryChargeLines: candidates,
    });
  }

  if (candidates.length > 0) {
    const includedAt = new Date();
    await chargeAllocationDelegate(client).createMany({
      data: candidates.map((line) => ({
        orderDeliveryGroupId: deliveryGroup.id,
        orderLineId: line.id,
        orderId: deliveryGroup.orderId,
        orderType: deliveryGroup.orderType,
        orderNumber: deliveryGroup.orderNumber,
        deliveryDate: deliveryGroup.deliveryDate,
        lineNbr: line.lineNbr,
        inventoryId: line.inventoryId,
        lineDescription: line.lineDescription,
        chargeType: FREIGHT_DELIVERY_CHARGE_TYPE,
        amountIncluded: formatMoney(freightDeliveryOpenAmount(line)),
        sourceInterval: options?.sourceInterval as NotificationIntervalType,
        includedAt,
        createdAt: includedAt,
        updatedAt: includedAt,
      })),
      skipDuplicates: true,
    });
  }

  return inputFromDeliveryGroup(deliveryGroup, {
    freightDeliveryChargeAllocations: await refreshPaymentChargeAllocations({
      client,
      orderId: deliveryGroup.orderId,
    }),
  });
}

async function inputWithExternalStockReadiness(
  input: DeliveryGroupPaymentInput
): Promise<DeliveryGroupPaymentInput> {
  const activeOrderLineIds = input.activeOrderLineIds
    ? new Set(input.activeOrderLineIds.filter(Boolean))
    : null;
  const inventoryIds = input.lines
    .filter((line) =>
      lineBelongsToCurrentDeliveryGroup({
        line,
        deliveryDate: dateKey(input.deliveryDate) ?? "",
        activeOrderLineIds,
      })
    )
    .filter(lineIsDeliverableStock)
    .map((line) => line.inventoryId);

  return {
    ...input,
    externalStockReadyInventoryIds:
      await getFreshExternalStockMatchesForInventoryIds(inventoryIds),
  };
}

async function getDeliveryGroupWithPaymentData(
  deliveryGroupId: string,
  client?: DeliveryPaymentPrismaClient
) {
  const db = await getPaymentPrisma(client);
  return db.orderDeliveryGroup.findUnique({
    where: { id: deliveryGroupId },
    include: {
      deliveryGroupLines: {
        where: { isActive: true },
        select: { orderLineId: true },
      },
      order: {
        include: {
          total: true,
          lines: {
            where: orderLinePaymentWhere(),
            orderBy: { lineNbr: "asc" },
          },
          taxDetails: { orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }] },
          deliveryGroupPaymentChargeAllocations: {
            select: {
              orderDeliveryGroupId: true,
              orderLineId: true,
              amountIncluded: true,
              sourceInterval: true,
            },
            orderBy: [{ includedAt: "asc" }, { orderLineId: "asc" }],
          },
        },
      },
    },
  });
}

export async function getDeliveryGroupPaymentEvaluation(
  deliveryGroupId: string,
  client?: DeliveryPaymentPrismaClient,
  options?: DeliveryGroupPaymentEvaluationOptions
) {
  const db = await getPaymentPrisma(client);
  const deliveryGroup = await getDeliveryGroupWithPaymentData(deliveryGroupId, db);
  if (!deliveryGroup) {
    throw new Error(`Delivery group not found: ${deliveryGroupId}`);
  }
  if (!deliveryGroup.isActive) {
    throw new Error(`Delivery group is not active: ${deliveryGroupId}`);
  }

  return evaluateDeliveryGroupPayment(
    await inputWithExternalStockReadiness(
      await inputWithFreightDeliveryAllocations(deliveryGroup, db, options)
    )
  );
}

export async function getDeliveryGroupPaymentEvaluationByOrderDate(
  params: { orderType: string; orderNumber: string; deliveryDate: Date | string },
  client?: DeliveryPaymentPrismaClient,
  options?: DeliveryGroupPaymentEvaluationOptions
) {
  const db = await getPaymentPrisma(client);
  const deliveryGroup = await db.orderDeliveryGroup.findFirst({
    where: {
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      deliveryDate: dateFromDateKey(params.deliveryDate),
      isActive: true,
    },
    include: {
      deliveryGroupLines: {
        where: { isActive: true },
        select: { orderLineId: true },
      },
      order: {
        include: {
          total: true,
          lines: {
            where: orderLinePaymentWhere(),
            orderBy: { lineNbr: "asc" },
          },
          taxDetails: { orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }] },
          deliveryGroupPaymentChargeAllocations: {
            select: {
              orderDeliveryGroupId: true,
              orderLineId: true,
              amountIncluded: true,
              sourceInterval: true,
            },
            orderBy: [{ includedAt: "asc" }, { orderLineId: "asc" }],
          },
        },
      },
    },
  });

  if (!deliveryGroup) {
    throw new Error(
      `Active delivery group not found for ${params.orderType} ${params.orderNumber} ${dateKey(
        params.deliveryDate
      )}`
    );
  }

  return evaluateDeliveryGroupPayment(
    await inputWithExternalStockReadiness(
      await inputWithFreightDeliveryAllocations(deliveryGroup, db, options)
    )
  );
}

export async function getOrderPaymentEvaluations(
  orderId: string,
  client?: DeliveryPaymentPrismaClient
) {
  const db = await getPaymentPrisma(client);
  if (!db.order) {
    throw new Error("Order delegate is unavailable for order-level payment evaluation.");
  }
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      total: true,
      lines: {
        where: orderLinePaymentWhere(),
        orderBy: { lineNbr: "asc" },
      },
      taxDetails: { orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }] },
      deliveryGroupPaymentChargeAllocations: {
        select: {
          orderDeliveryGroupId: true,
          orderLineId: true,
          amountIncluded: true,
          sourceInterval: true,
        },
        orderBy: [{ includedAt: "asc" }, { orderLineId: "asc" }],
      },
      deliveryGroups: {
        where: {
          isActive: true,
          deliveryGroupLines: { some: { isActive: true } },
        },
        orderBy: { deliveryDate: "asc" },
        include: {
          deliveryGroupLines: {
            where: { isActive: true },
            select: { orderLineId: true },
          },
        },
      },
    },
  });

  if (!order) {
    throw new Error(`Order not found: ${orderId}`);
  }

  return Promise.all(
    order.deliveryGroups.map(async (deliveryGroup) =>
      evaluateDeliveryGroupPayment(
        await inputWithExternalStockReadiness({
          orderDeliveryGroupId: deliveryGroup.id,
          orderId: order.id,
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          deliveryDate: deliveryGroup.deliveryDate,
          paymentTerms: order.total?.paymentTerms ?? null,
          unpaidBalance: order.total?.unpaidBalance,
          orderTotal: order.total?.orderTotal,
          taxTotal: order.total?.taxTotal,
          lines: order.lines,
          taxDetails: order.taxDetails,
          activeOrderLineIds: deliveryGroup.deliveryGroupLines
            .map((line) => line.orderLineId)
            .filter((orderLineId): orderLineId is string => Boolean(orderLineId)),
          freightDeliveryChargeAllocations: order.deliveryGroupPaymentChargeAllocations,
        })
      )
    )
  );
}
