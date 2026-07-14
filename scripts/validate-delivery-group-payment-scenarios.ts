import {
  getDeliveryGroupPaymentEvaluationByOrderDate,
  type DeliveryGroupPaymentEvaluation,
  type PaymentApplicabilityStatus,
  type PaymentStatus,
} from "../lib/delivery-payment/deliveryGroupPayment";
import { prisma } from "../lib/prisma";

type ScenarioLine = {
  lineNbr: number;
  requestedOn: string;
  discountedUnitPrice: string | null;
  orderQty: string;
  openQty: string;
  taxCategory?: string | null;
  itemType?: string | null;
  itemClass?: string | null;
  inventoryId?: string | null;
  lineDescription?: string | null;
};

type ScenarioTaxDetail = {
  rowNumber: number;
  taxId: string | null;
  customerTaxZone: string | null;
  taxRate: string | null;
  taxableAmount: string | null;
  taxAmount: string | null;
};

type ScenarioDefinition = {
  name: string;
  description: string;
  paymentTerms: string;
  orderTotal: string;
  unpaidBalance: string;
  taxTotal?: string;
  deliveryDate: string;
  lines: ScenarioLine[];
  taxDetails?: ScenarioTaxDetail[];
  expected: {
    amountDueNowRounded: string | null;
    paymentApplicabilityStatus: PaymentApplicabilityStatus;
    paymentStatus: PaymentStatus;
    currentDeliveryGroupMerchandiseValue?: string;
    currentDeliveryGroupTaxAmount?: string | null;
    currentDeliveryGroupValue?: string | null;
    completedValueBeforeCurrentDelivery?: string | null;
    remainingUndeliveredValueAfterCurrentDelivery?: string | null;
    creditAfterCurrentDelivery?: string | null;
    requiredDownOnRemaining?: string | null;
  };
};

type ScenarioReport = {
  name: string;
  description: string;
  passed: boolean;
  expected: ScenarioDefinition["expected"];
  actual: Pick<
    DeliveryGroupPaymentEvaluation,
    | "paymentApplicabilityStatus"
    | "paymentStatus"
    | "paidToDate"
    | "currentDeliveryGroupMerchandiseValue"
    | "currentDeliveryGroupTaxAmount"
    | "currentDeliveryGroupValue"
    | "completedValueBeforeCurrentDelivery"
    | "remainingUndeliveredValueAfterCurrentDelivery"
    | "creditAfterCurrentDelivery"
    | "requiredDownOnRemaining"
    | "amountDueNow"
    | "amountDueNowRounded"
    | "calculationWarnings"
  >;
  failures: string[];
  failedLineDetails?: DeliveryGroupPaymentEvaluation["lines"];
};

class RollbackScenarioValidation extends Error {
  constructor() {
    super("Rollback payment scenario fixtures");
    this.name = "RollbackScenarioValidation";
  }
}

const FIXTURE_PREFIX = "PAYVAL";
const ORDER_TYPE = "PV";
const FIXTURE_CONTACT_ID = `${FIXTURE_PREFIX}_CONTACT`;

function dateFromKey(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function fiveItemLines(params: {
  deliveryDate: string;
  futureDate?: string;
  currentCount?: number;
  price?: string;
  taxCategory?: string;
  currentItemTypes?: Array<string | null>;
}) {
  const futureDate = params.futureDate ?? "2026-09-01";
  const currentCount = params.currentCount ?? 2;
  const price = params.price ?? "200";
  return Array.from({ length: 5 }, (_, index): ScenarioLine => {
    const lineNumber = index + 1;
    return {
      lineNbr: lineNumber,
      requestedOn: lineNumber <= currentCount ? params.deliveryDate : futureDate,
      discountedUnitPrice: price,
      orderQty: "1",
      openQty: "1",
      taxCategory: params.taxCategory ?? "EXEMPT",
      itemType: params.currentItemTypes?.[index] ?? "F",
      itemClass: "TEST",
      inventoryId: `ITEM-${lineNumber}`,
      lineDescription: `Fixture item ${lineNumber}`,
    };
  });
}

function singleRateTaxDetail(rate: string, taxableAmount = "1000", taxAmount = "67.50") {
  return [
    {
      rowNumber: 1,
      taxId: "TEST-TAX",
      customerTaxZone: "TEST-ZONE",
      taxRate: rate,
      taxableAmount,
      taxAmount,
    },
  ];
}

const scenarios: ScenarioDefinition[] = [
  {
    name: "01_basic_50_percent_deposit_no_tax",
    description: "Basic 50% deposit / 45% remaining rule with no tax.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01" }),
    expected: {
      amountDueNowRounded: "170.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "400.00",
      currentDeliveryGroupTaxAmount: "0.00",
      currentDeliveryGroupValue: "400.00",
      completedValueBeforeCurrentDelivery: "0.00",
      remainingUndeliveredValueAfterCurrentDelivery: "600.00",
      creditAfterCurrentDelivery: "100.00",
      requiredDownOnRemaining: "270.00",
    },
  },
  {
    name: "02_paid_enough_no_due",
    description: "Customer has already paid enough for current and remaining value.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "300",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01" }),
    expected: {
      amountDueNowRounded: "0.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "no_balance_due",
    },
  },
  {
    name: "03_amount_due_capped_at_unpaid_balance",
    description: "Inconsistent edge case where formula exceeds unpaid balance; cap must apply.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "100",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: [
      {
        lineNbr: 1,
        requestedOn: "2026-08-01",
        discountedUnitPrice: "1200",
        orderQty: "1",
        openQty: "1",
        taxCategory: "EXEMPT",
        itemType: "F",
      },
    ],
    expected: {
      amountDueNowRounded: "100.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
    },
  },
  {
    name: "04_unpaid_balance_two_or_less",
    description: "Eligible terms but unpaid balance is not meaningful.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "2",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01", currentCount: 5 }),
    expected: {
      amountDueNowRounded: null,
      paymentApplicabilityStatus: "no_meaningful_balance_due",
      paymentStatus: "no_balance_due",
    },
  },
  {
    name: "05_non_prepay_terms",
    description: "Non-eligible terms do not apply.",
    paymentTerms: "N30NODEP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01" }),
    expected: {
      amountDueNowRounded: null,
      paymentApplicabilityStatus: "not_applicable_terms",
      paymentStatus: "not_applicable",
    },
  },
  {
    name: "06_taxable_single_clear_rate",
    description: "Taxable order with one clear 6.75% tax rate.",
    paymentTerms: "PP",
    orderTotal: "1067.50",
    unpaidBalance: "500",
    taxTotal: "67.50",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01", taxCategory: "TAXABLE" }),
    taxDetails: singleRateTaxDetail("6.75"),
    expected: {
      amountDueNowRounded: "147.73",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "400.00",
      currentDeliveryGroupTaxAmount: "27.00",
      currentDeliveryGroupValue: "427.00",
      remainingUndeliveredValueAfterCurrentDelivery: "640.50",
      creditAfterCurrentDelivery: "140.50",
      requiredDownOnRemaining: "288.23",
    },
  },
  {
    name: "07_mixed_taxable_and_exempt_lines",
    description: "One taxable and one exempt current line with one clear nonzero tax rate.",
    paymentTerms: "PP",
    orderTotal: "1054.00",
    unpaidBalance: "500",
    taxTotal: "54.00",
    deliveryDate: "2026-08-01",
    lines: [
      ...fiveItemLines({ deliveryDate: "2026-08-01", currentCount: 0, taxCategory: "TAXABLE" }),
      {
        lineNbr: 6,
        requestedOn: "2026-08-01",
        discountedUnitPrice: "200",
        orderQty: "1",
        openQty: "1",
        taxCategory: "TAXABLE",
        itemType: "F",
        inventoryId: "CURRENT-TAXABLE",
      },
      {
        lineNbr: 7,
        requestedOn: "2026-08-01",
        discountedUnitPrice: "200",
        orderQty: "1",
        openQty: "1",
        taxCategory: "EXEMPT",
        itemType: "F",
        inventoryId: "CURRENT-EXEMPT",
      },
    ],
    taxDetails: [
      ...singleRateTaxDetail("6.75", "800", "54.00"),
      {
        rowNumber: 2,
        taxId: "EXEMPT",
        customerTaxZone: "TEST-ZONE",
        taxRate: "0",
        taxableAmount: "200",
        taxAmount: "0",
      },
    ],
    expected: {
      amountDueNowRounded: "147.73",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "400.00",
      currentDeliveryGroupTaxAmount: "13.50",
      currentDeliveryGroupValue: "413.50",
    },
  },
  {
    name: "08_tax_total_zero_no_tax_details_taxable_lines",
    description: "Taxable lines with taxTotal 0 and no tax details should not invent tax.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01", taxCategory: "TAXABLE" }),
    expected: {
      amountDueNowRounded: "170.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupTaxAmount: "0.00",
    },
  },
  {
    name: "09_blank_tax_details_tax_total_zero",
    description: "Blank TaxDetails with taxTotal 0 should not invent tax.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01", taxCategory: "TAXABLE" }),
    taxDetails: [
      {
        rowNumber: 1,
        taxId: null,
        customerTaxZone: null,
        taxRate: null,
        taxableAmount: null,
        taxAmount: null,
      },
    ],
    expected: {
      amountDueNowRounded: "170.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupTaxAmount: "0.00",
    },
  },
  {
    name: "10_multiple_quantities",
    description: "Current/open value uses discountedUnitPrice * openQty.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: [
      {
        lineNbr: 1,
        requestedOn: "2026-08-01",
        discountedUnitPrice: "100",
        orderQty: "5",
        openQty: "3",
        taxCategory: "EXEMPT",
        itemType: "F",
      },
      {
        lineNbr: 2,
        requestedOn: "2026-09-01",
        discountedUnitPrice: "100",
        orderQty: "5",
        openQty: "5",
        taxCategory: "EXEMPT",
        itemType: "F",
      },
    ],
    expected: {
      amountDueNowRounded: "225.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "300.00",
      completedValueBeforeCurrentDelivery: "200.00",
    },
  },
  {
    name: "11_partially_completed_line",
    description: "orderQty 4/openQty 2 derives completed quantity 2.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: [
      {
        lineNbr: 1,
        requestedOn: "2026-08-01",
        discountedUnitPrice: "100",
        orderQty: "4",
        openQty: "2",
        taxCategory: "EXEMPT",
        itemType: "F",
      },
      {
        lineNbr: 2,
        requestedOn: "2026-09-01",
        discountedUnitPrice: "600",
        orderQty: "1",
        openQty: "1",
        taxCategory: "EXEMPT",
        itemType: "F",
      },
    ],
    expected: {
      amountDueNowRounded: "170.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "200.00",
      completedValueBeforeCurrentDelivery: "200.00",
    },
  },
  {
    name: "12_open_qty_zero_complete_line",
    description: "Complete line contributes to completed value, not current open value.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: [
      {
        lineNbr: 1,
        requestedOn: "2026-08-01",
        discountedUnitPrice: "400",
        orderQty: "2",
        openQty: "0",
        taxCategory: "EXEMPT",
        itemType: "F",
      },
      {
        lineNbr: 2,
        requestedOn: "2026-09-01",
        discountedUnitPrice: "200",
        orderQty: "1",
        openQty: "1",
        taxCategory: "EXEMPT",
        itemType: "F",
      },
    ],
    expected: {
      amountDueNowRounded: "390.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "0.00",
      completedValueBeforeCurrentDelivery: "800.00",
    },
  },
  {
    name: "13_charged_non_stock_line",
    description: "Charged itemType N line is included in payment calculation.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({
      deliveryDate: "2026-08-01",
      currentItemTypes: ["N", "F", "F", "F", "F"],
    }),
    expected: {
      amountDueNowRounded: "170.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "400.00",
    },
  },
  {
    name: "14_free_or_null_price_line",
    description: "Null price current line adds no monetary value and does not break calculation.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: [
      ...fiveItemLines({ deliveryDate: "2026-08-01" }),
      {
        lineNbr: 6,
        requestedOn: "2026-08-01",
        discountedUnitPrice: null,
        orderQty: "1",
        openQty: "1",
        taxCategory: "EXEMPT",
        itemType: "F",
        inventoryId: "FREE-NULL",
      },
    ],
    expected: {
      amountDueNowRounded: "170.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "400.00",
    },
  },
  {
    name: "15_multiple_delivery_groups",
    description: "Only Date A lines count as current group; Date B remains undelivered.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01", futureDate: "2026-08-15" }),
    expected: {
      amountDueNowRounded: "170.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "400.00",
      remainingUndeliveredValueAfterCurrentDelivery: "600.00",
    },
  },
  {
    name: "16_final_delivery_remaining_zero",
    description: "All remaining value is in current final delivery.",
    paymentTerms: "PP",
    orderTotal: "1000",
    unpaidBalance: "500",
    taxTotal: "0",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01", currentCount: 5 }),
    expected: {
      amountDueNowRounded: "500.00",
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "balance_due",
      currentDeliveryGroupMerchandiseValue: "1000.00",
      remainingUndeliveredValueAfterCurrentDelivery: "0.00",
      requiredDownOnRemaining: "0.00",
    },
  },
  {
    name: "17_multiple_nonzero_tax_rates_blocks",
    description: "Multiple nonzero tax rates without line mapping must block calculation.",
    paymentTerms: "PP",
    orderTotal: "1070",
    unpaidBalance: "500",
    taxTotal: "70",
    deliveryDate: "2026-08-01",
    lines: fiveItemLines({ deliveryDate: "2026-08-01", taxCategory: "TAXABLE" }),
    taxDetails: [
      {
        rowNumber: 1,
        taxId: "TAX-6",
        customerTaxZone: "ZONE",
        taxRate: "6",
        taxableAmount: "500",
        taxAmount: "30",
      },
      {
        rowNumber: 2,
        taxId: "TAX-8",
        customerTaxZone: "ZONE",
        taxRate: "8",
        taxableAmount: "500",
        taxAmount: "40",
      },
    ],
    expected: {
      amountDueNowRounded: null,
      paymentApplicabilityStatus: "applicable",
      paymentStatus: "calculation_blocked",
      currentDeliveryGroupTaxAmount: null,
      currentDeliveryGroupValue: null,
    },
  },
];

function expectedEntries(expected: ScenarioDefinition["expected"]) {
  return Object.entries(expected).filter(([, value]) => value !== undefined);
}

function actualForExpected(
  evaluation: DeliveryGroupPaymentEvaluation,
  field: keyof ScenarioDefinition["expected"]
) {
  return evaluation[field as keyof DeliveryGroupPaymentEvaluation];
}

function compareScenario(
  scenario: ScenarioDefinition,
  evaluation: DeliveryGroupPaymentEvaluation
): ScenarioReport {
  const failures: string[] = [];

  for (const [field, expectedValue] of expectedEntries(scenario.expected)) {
    const actualValue = actualForExpected(evaluation, field as keyof ScenarioDefinition["expected"]);
    if (actualValue !== expectedValue) {
      failures.push(`${field}: expected ${String(expectedValue)} got ${String(actualValue)}`);
    }
  }

  return {
    name: scenario.name,
    description: scenario.description,
    passed: failures.length === 0,
    expected: scenario.expected,
    actual: {
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
      calculationWarnings: evaluation.calculationWarnings,
    },
    failures,
    ...(failures.length > 0 ? { failedLineDetails: evaluation.lines } : {}),
  };
}

async function createScenarioFixtures(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  contactId: string,
  scenario: ScenarioDefinition,
  index: number
) {
  const orderNumber = `${FIXTURE_PREFIX}${String(index + 1).padStart(3, "0")}`;
  const order = await tx.order.create({
    data: {
      orderType: ORDER_TYPE,
      orderNumber,
      status: "Open",
      contactId,
      customerId: FIXTURE_PREFIX,
      customerDescription: "Payment Validation Fixture",
      locationDescription: scenario.name,
      lastSyncedAt: new Date(),
    },
  });

  await tx.orderTotal.create({
    data: {
      orderId: order.id,
      orderNumber,
      paymentTerms: scenario.paymentTerms,
      unpaidBalance: scenario.unpaidBalance,
      orderTotal: scenario.orderTotal,
      taxTotal: scenario.taxTotal ?? "0",
      lineTotalAmount: scenario.orderTotal,
      lastSyncedAt: new Date(),
    },
  });

  const deliveryDates = new Set(scenario.lines.map((line) => line.requestedOn));
  for (const deliveryDate of deliveryDates) {
    await tx.orderDeliveryGroup.create({
      data: {
        orderId: order.id,
        orderType: ORDER_TYPE,
        orderNumber,
        deliveryDate: dateFromKey(deliveryDate),
        status: "Open",
        isActive: true,
        lineCount: scenario.lines.filter((line) => line.requestedOn === deliveryDate).length,
        lastSeenAt: new Date(),
        lastSyncedAt: new Date(),
      },
    });
  }

  await tx.orderLine.createMany({
    data: scenario.lines.map((line) => ({
      orderId: order.id,
      orderType: ORDER_TYPE,
      orderNumber,
      requestedOn: dateFromKey(line.requestedOn),
      lineNbr: line.lineNbr,
      inventoryId: line.inventoryId ?? `PAY-${line.lineNbr}`,
      lineDescription: line.lineDescription ?? scenario.description,
      itemType: line.itemType ?? "F",
      itemClass: line.itemClass ?? "TEST",
      taxCategory: line.taxCategory ?? "EXEMPT",
      discountedUnitPrice: line.discountedUnitPrice,
      orderQty: line.orderQty,
      openQty: line.openQty,
      lastSyncedAt: new Date(),
    })),
  });

  if (scenario.taxDetails && scenario.taxDetails.length > 0) {
    await tx.orderTaxDetail.createMany({
      data: scenario.taxDetails.map((taxDetail) => ({
        orderId: order.id,
        orderType: ORDER_TYPE,
        orderNumber,
        rowNumber: taxDetail.rowNumber,
        taxId: taxDetail.taxId,
        customerTaxZone: taxDetail.customerTaxZone,
        taxRate: taxDetail.taxRate,
        taxableAmount: taxDetail.taxableAmount,
        taxAmount: taxDetail.taxAmount,
        taxType: "Sales",
        lastSyncedAt: new Date(),
      })),
    });
  }

  return { orderNumber };
}

async function fixtureCount() {
  return prisma.order.count({
    where: {
      OR: [
        { orderType: ORDER_TYPE, orderNumber: { startsWith: FIXTURE_PREFIX } },
        { contactId: FIXTURE_CONTACT_ID },
      ],
    },
  });
}

async function notificationAttemptCount() {
  return prisma.notificationAttempt.count();
}

async function runRealOrderDiagnostics() {
  const targets = [
    { orderType: "SO", orderNumber: "SO39963", deliveryDate: "2026-07-22" },
    { orderType: "HW", orderNumber: "HW06205", deliveryDate: "2026-07-24" },
    { orderType: "SO", orderNumber: "SO40064", deliveryDate: "2026-07-24" },
  ];

  const diagnostics = [];
  for (const target of targets) {
    try {
      const result = await getDeliveryGroupPaymentEvaluationByOrderDate(target);
      diagnostics.push({
        ...target,
        found: true,
        paymentApplicabilityStatus: result.paymentApplicabilityStatus,
        paymentStatus: result.paymentStatus,
        amountDueNow: result.amountDueNow,
        amountDueNowRounded: result.amountDueNowRounded,
        currentDeliveryGroupValue: result.currentDeliveryGroupValue,
        currentDeliveryGroupTaxAmount: result.currentDeliveryGroupTaxAmount,
        calculationWarnings: result.calculationWarnings,
      });
    } catch (error) {
      diagnostics.push({
        ...target,
        found: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return diagnostics;
}

async function main() {
  const attemptsBefore = await notificationAttemptCount();
  const fixturesBefore = await fixtureCount();
  const scenarioReports: ScenarioReport[] = [];

  try {
    await prisma.$transaction(
      async (tx) => {
        const contact = await tx.contact.create({
          data: {
            contactId: FIXTURE_CONTACT_ID,
            status: "Active",
            displayName: "Payment Validation Fixture",
            emailOptIn: false,
            smsOptIn: false,
          },
        });

        for (const [index, scenario] of scenarios.entries()) {
          const fixture = await createScenarioFixtures(tx, contact.contactId, scenario, index);
          const evaluation = await getDeliveryGroupPaymentEvaluationByOrderDate(
            {
              orderType: ORDER_TYPE,
              orderNumber: fixture.orderNumber,
              deliveryDate: scenario.deliveryDate,
            },
            tx
          );
          scenarioReports.push(compareScenario(scenario, evaluation));
        }

        throw new RollbackScenarioValidation();
      },
      { timeout: 30_000 }
    );
  } catch (error) {
    if (!(error instanceof RollbackScenarioValidation)) {
      throw error;
    }
  }

  const fixturesAfter = await fixtureCount();
  const attemptsAfter = await notificationAttemptCount();
  const realOrderDiagnostics = await runRealOrderDiagnostics();
  const failedScenarios = scenarioReports.filter((report) => !report.passed);
  const businessQuestions = [
    "Final delivery currently collects up to unpaidBalance when creditAfterCurrentDelivery is negative and remainingUndeliveredValueAfterCurrentDelivery is 0.",
    "Multiple nonzero tax rates remain calculation_blocked without line-level tax mapping.",
    "Null discountedUnitPrice is treated as 0 and reported as a calculation warning.",
  ];

  const report = {
    summary: {
      totalScenarios: scenarioReports.length,
      passed: scenarioReports.length - failedScenarios.length,
      failed: failedScenarios.length,
      fixtureRowsBefore: fixturesBefore,
      fixtureRowsAfter: fixturesAfter,
      notificationAttemptsBefore: attemptsBefore,
      notificationAttemptsAfter: attemptsAfter,
      rollbackVerified: fixturesAfter === fixturesBefore,
      notificationAttemptsUnchanged: attemptsAfter === attemptsBefore,
    },
    scenarios: scenarioReports,
    failedScenarios,
    realOrderDiagnostics,
    businessQuestions,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failedScenarios.length > 0 || fixturesAfter !== fixturesBefore || attemptsAfter !== attemptsBefore) {
    process.exitCode = 1;
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
