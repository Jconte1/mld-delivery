import type { Prisma } from "@/lib/generated/prisma/client";

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
  completedQtyDerived: string;
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
  paymentApplicabilityStatus: PaymentApplicabilityStatus;
  paymentStatus: PaymentStatus;
  urgencyStatus: PaymentUrgencyStatus;
  calculationWarnings: string[];
  lines: DeliveryGroupPaymentLineEvaluation[];
};

type DeliveryPaymentPrismaClient = Pick<
  Prisma.TransactionClient,
  "order" | "orderDeliveryGroup"
>;

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const SCALE = BigInt(1_000_000);
const ELIGIBLE_PAYMENT_TERMS = new Set(["PIF", "PP", "PPP", "PPT"]);
const MEANINGFUL_BALANCE_THRESHOLD = TWO * SCALE;
const DOWN_PAYMENT_RATE_NUMERATOR = BigInt(45);
const DOWN_PAYMENT_RATE_DENOMINATOR = BigInt(100);

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

export function evaluateDeliveryGroupPayment(
  input: DeliveryGroupPaymentInput
): DeliveryGroupPaymentEvaluation {
  const warnings: string[] = [];
  const deliveryDate = dateKey(input.deliveryDate);
  if (!deliveryDate) {
    throw new Error(`Invalid delivery group date: ${String(input.deliveryDate)}`);
  }

  const paymentTerms = input.paymentTerms?.trim().toUpperCase() || null;
  const unpaidBalance = parseScaledDecimal(input.unpaidBalance);
  const orderTotal = parseScaledDecimal(input.orderTotal);
  const taxTotal = parseScaledDecimal(input.taxTotal) ?? ZERO;
  const eligibleTerms = paymentTerms !== null && ELIGIBLE_PAYMENT_TERMS.has(paymentTerms);
  const nonZeroTaxRates = taxTotal > ZERO ? uniqueNonZeroTaxRates(input.taxDetails) : [];
  const seenWarnings = new Set<string>();

  function addWarning(warning: string) {
    if (!seenWarnings.has(warning)) {
      seenWarnings.add(warning);
      warnings.push(warning);
    }
  }

  if (taxTotal > ZERO && input.taxDetails.length === 0) {
    addWarning("Order has taxTotal but no TaxDetails rows; effective tax treated as 0.");
  }

  let taxCalculationBlocked = false;
  let currentDeliveryGroupMerchandiseValue = ZERO;
  let currentDeliveryGroupTaxAmount: ScaledDecimal | null = ZERO;
  let completedValueBeforeCurrentDelivery: ScaledDecimal | null = ZERO;

  const lineEvaluations: DeliveryGroupPaymentLineEvaluation[] = input.lines.map((line) => {
    const lineWarnings: string[] = [];
    const price = parseScaledDecimal(line.discountedUnitPrice) ?? ZERO;
    const orderQty = parseScaledDecimal(line.orderQty) ?? ZERO;
    const openQty = parseScaledDecimal(line.openQty) ?? ZERO;
    const completedQty = clampAtZero(orderQty - openQty);
    const lineDate = dateKey(line.requestedOn);
    const includedInCurrentDeliveryGroup = lineDate === deliveryDate;
    const taxRate = taxRateForLine({
      taxCategory: line.taxCategory,
      taxTotal,
      nonZeroTaxRates,
      warnings: lineWarnings,
    });

    if (line.discountedUnitPrice === null || line.discountedUnitPrice === undefined) {
      addWarning(`Line ${line.lineNbr} missing discountedUnitPrice; treated as 0.`);
    }
    if (line.orderQty === null || line.orderQty === undefined) {
      addWarning(`Line ${line.lineNbr} missing orderQty; treated as 0.`);
    }
    if (line.openQty === null || line.openQty === undefined) {
      addWarning(`Line ${line.lineNbr} missing openQty; treated as 0.`);
    }
    for (const warning of lineWarnings) addWarning(`Line ${line.lineNbr}: ${warning}`);

    const lineGrossMerchandiseValue = multiplyScaled(price, orderQty);
    const lineOpenMerchandiseValue = multiplyScaled(price, openQty);
    const lineCompletedMerchandiseValue = multiplyScaled(price, completedQty);

    let lineGrossTaxAmount: ScaledDecimal | null = null;
    let lineOpenTaxAmount: ScaledDecimal | null = null;
    let lineCompletedTaxAmount: ScaledDecimal | null = null;

    if (taxRate.blocked || taxRate.rate === null) {
      taxCalculationBlocked = true;
      currentDeliveryGroupTaxAmount = null;
      completedValueBeforeCurrentDelivery = null;
    } else {
      lineGrossTaxAmount = multiplyByPercent(lineGrossMerchandiseValue, taxRate.rate);
      lineOpenTaxAmount = multiplyByPercent(lineOpenMerchandiseValue, taxRate.rate);
      lineCompletedTaxAmount = multiplyByPercent(lineCompletedMerchandiseValue, taxRate.rate);

      if (includedInCurrentDeliveryGroup && openQty > ZERO && price > ZERO) {
        currentDeliveryGroupTaxAmount =
          currentDeliveryGroupTaxAmount === null
            ? null
            : currentDeliveryGroupTaxAmount + lineOpenTaxAmount;
      }

      completedValueBeforeCurrentDelivery =
        completedValueBeforeCurrentDelivery === null
          ? null
          : completedValueBeforeCurrentDelivery +
            lineCompletedMerchandiseValue +
            lineCompletedTaxAmount;
    }

    if (includedInCurrentDeliveryGroup && openQty > ZERO && price > ZERO) {
      currentDeliveryGroupMerchandiseValue += lineOpenMerchandiseValue;
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
      completedQtyDerived: formatQuantity(completedQty),
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
    currentDeliveryGroupTaxAmount === null
      ? null
      : currentDeliveryGroupMerchandiseValue + currentDeliveryGroupTaxAmount;

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

function inputFromDeliveryGroup(deliveryGroup: DeliveryGroupWithPaymentData): DeliveryGroupPaymentInput {
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
      order: {
        include: {
          total: true,
          lines: { orderBy: { lineNbr: "asc" } },
          taxDetails: { orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }] },
        },
      },
    },
  });
}

export async function getDeliveryGroupPaymentEvaluation(
  deliveryGroupId: string,
  client?: DeliveryPaymentPrismaClient
) {
  const deliveryGroup = await getDeliveryGroupWithPaymentData(deliveryGroupId, client);
  if (!deliveryGroup) {
    throw new Error(`Delivery group not found: ${deliveryGroupId}`);
  }
  if (!deliveryGroup.isActive) {
    throw new Error(`Delivery group is not active: ${deliveryGroupId}`);
  }

  return evaluateDeliveryGroupPayment(inputFromDeliveryGroup(deliveryGroup));
}

export async function getDeliveryGroupPaymentEvaluationByOrderDate(
  params: { orderType: string; orderNumber: string; deliveryDate: Date | string },
  client?: DeliveryPaymentPrismaClient
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
      order: {
        include: {
          total: true,
          lines: { orderBy: { lineNbr: "asc" } },
          taxDetails: { orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }] },
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

  return evaluateDeliveryGroupPayment(inputFromDeliveryGroup(deliveryGroup));
}

export async function getOrderPaymentEvaluations(
  orderId: string,
  client?: DeliveryPaymentPrismaClient
) {
  const db = await getPaymentPrisma(client);
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      total: true,
      lines: { orderBy: { lineNbr: "asc" } },
      taxDetails: { orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }] },
      deliveryGroups: {
        where: { isActive: true },
        orderBy: { deliveryDate: "asc" },
      },
    },
  });

  if (!order) {
    throw new Error(`Order not found: ${orderId}`);
  }

  return order.deliveryGroups.map((deliveryGroup) =>
    evaluateDeliveryGroupPayment({
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
    })
  );
}
