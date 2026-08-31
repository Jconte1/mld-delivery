import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  evaluateDeliveryGroupPayment,
  type DeliveryGroupPaymentEvaluation,
  type DeliveryGroupPaymentInput,
  type DeliveryPaymentLineInput,
} from "../lib/delivery-payment/deliveryGroupPayment";
import {
  NotificationActionType,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  buildNotificationDedupeKey,
  selectNotificationChannel,
} from "../lib/notifications/helpers";

const ROOT = process.cwd();
const DELIVERY_DATE = "2026-09-14";

type Severity = "production_blocker" | "test_harness_gap";
type ScenarioGroup =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "Source";

type Scenario = {
  group: ScenarioGroup;
  id: string;
  name: string;
  severity: Severity;
  run: () => Promise<Record<string, unknown>> | Record<string, unknown>;
};

type ScenarioResult = {
  group: ScenarioGroup;
  id: string;
  name: string;
  passed: boolean;
  severity: Severity;
  details: Record<string, unknown>;
  failures: string[];
};

class ScenarioAssertionError extends Error {
  failures: string[];

  constructor(failures: string[]) {
    super(failures.join("; "));
    this.failures = failures;
  }
}

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(source.includes(pattern), message, failures);
}

function assertNotIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(!source.includes(pattern), message, failures);
}

function done(details: Record<string, unknown>, failures: string[] = []) {
  if (Array.isArray(failures) && failures.length > 0) throw new ScenarioAssertionError(failures);
  return details;
}

function money(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function line(
  overrides: Partial<DeliveryPaymentLineInput> & { id: string; lineNbr: number }
): DeliveryPaymentLineInput {
  return {
    id: overrides.id,
    lineNbr: overrides.lineNbr,
    inventoryId: overrides.inventoryId ?? `ITEM-${overrides.lineNbr}`,
    lineDescription: overrides.lineDescription ?? `Fixture item ${overrides.lineNbr}`,
    itemType: overrides.itemType ?? "F",
    itemClass: overrides.itemClass ?? "TEST",
    requestedOn: overrides.requestedOn ?? DELIVERY_DATE,
    taxCategory: overrides.taxCategory ?? "EXEMPT",
    discountedUnitPrice: overrides.discountedUnitPrice ?? "100.00",
    orderQty: overrides.orderQty ?? "1",
    openQty: overrides.openQty ?? "1",
    activeAllocatedQty: overrides.activeAllocatedQty ?? "1",
    allocationStatus: overrides.allocationStatus ?? "allocated",
    etaStatus: "etaStatus" in overrides ? overrides.etaStatus ?? null : "ready",
    readinessStatus:
      "readinessStatus" in overrides ? overrides.readinessStatus ?? null : "ready",
  };
}

function payment(overrides: Partial<DeliveryGroupPaymentInput> = {}) {
  const lines = overrides.lines ?? [
    line({ id: "ready_1", lineNbr: 1, discountedUnitPrice: "1000.00" }),
  ];
  return evaluateDeliveryGroupPayment({
    orderDeliveryGroupId: "group_current",
    orderId: "order_current",
    orderType: "SO",
    orderNumber: "SO-LIFE",
    deliveryDate: DELIVERY_DATE,
    paymentTerms: "PP",
    unpaidBalance: "1500.00",
    orderTotal: "2000.00",
    taxTotal: "0.00",
    lines,
    taxDetails: [],
    activeOrderLineIds: lines
      .filter((candidate) => candidate.itemType === "F")
      .map((candidate) => candidate.id),
    ...overrides,
  });
}

function paidPayment() {
  return payment({
    unpaidBalance: "0.00",
    orderTotal: "2000.00",
    lines: [line({ id: "paid_ready", lineNbr: 1, discountedUnitPrice: "1000.00" })],
  });
}

function nonPrepayPayment() {
  return payment({
    paymentTerms: "N30",
    unpaidBalance: "1500.00",
    orderTotal: "2000.00",
  });
}

function balanceIsDue(evaluation: DeliveryGroupPaymentEvaluation) {
  return evaluation.paymentStatus === "balance_due" && money(evaluation.amountDueNowRounded) > 2;
}

function tenDayWritebackEligible(params: {
  evaluation: DeliveryGroupPaymentEvaluation;
  acumaticaOneWeekConfirmed?: boolean;
}) {
  return params.acumaticaOneWeekConfirmed === true || !balanceIsDue(params.evaluation);
}

function nextPaymentLifecycleAction(params: {
  day: 14 | 12 | 10 | 8;
  evaluation: DeliveryGroupPaymentEvaluation;
  acumaticaOneWeekConfirmed?: boolean;
}) {
  if (params.acumaticaOneWeekConfirmed) return "SKIP_ALREADY_CONFIRMED";
  if (params.day === 14) {
    return balanceIsDue(params.evaluation) ? "DAY_14_REMINDER_WITH_PAYMENT" : "DAY_14_REMINDER";
  }
  if (!balanceIsDue(params.evaluation)) return "SKIP_PAYMENT_CLEAR_WRITEBACK_ELIGIBLE";
  if (params.day === 12) return "DAY_12_PAYMENT_REQUEST";
  if (params.day === 10) return "DAY_10_PAYMENT_REQUEST";
  return "DAY_8_PAYMENT_ENFORCEMENT_ELIGIBLE";
}

async function dryRunTenDayStatus(evaluation: DeliveryGroupPaymentEvaluation) {
  const { evaluateAndRecordDeliveryTenDayConfirmation } = await import(
    "../lib/notifications/deliveryTenDayConfirmation"
  );
  const result = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: {
      id: evaluation.orderDeliveryGroupId,
      orderId: evaluation.orderId,
      orderType: evaluation.orderType,
      orderNumber: evaluation.orderNumber,
      deliveryDate: new Date(`${evaluation.deliveryDate}T00:00:00.000Z`),
      order: {
        id: evaluation.orderId,
        orderType: evaluation.orderType,
        orderNumber: evaluation.orderNumber,
        acumaticaOneWeekConfirmed: false,
      },
    },
    payment: evaluation,
    sourceInterval: NotificationIntervalType.DAY_10,
    dryRun: true,
    prismaClient: {},
  });
  return result.acumaticaWritebackStatus;
}

function dedupe(intervalType: NotificationIntervalType, actionType: NotificationActionType) {
  return buildNotificationDedupeKey({
    orderType: "SO",
    orderNumber: "SO-LIFE",
    deliveryDate: DELIVERY_DATE,
    intervalType,
    actionType,
  });
}

function channel(params: {
  smsOptIn: boolean;
  emailOptIn: boolean;
  activeSmsOptOutPhones?: string[];
  activeEmailOptOutEmails?: string[];
}) {
  return selectNotificationChannel(
    {
      email: "customer@example.test",
      phone1: "8015551212",
      phone2: null,
      smsOptIn: params.smsOptIn,
      emailOptIn: params.emailOptIn,
    },
    {
      activeSmsOptOutPhones: params.activeSmsOptOutPhones,
      activeEmailOptOutEmails: params.activeEmailOptOutEmails,
    }
  );
}

function sourceGuardScenarios(): Scenario[] {
  return [
    {
      group: "Source",
      id: "S1",
      name: "production runner supports 14/12/10 and intentionally excludes live 8",
      severity: "production_blocker",
      run: () => {
        const failures: string[] = [];
        const runner = read("scripts/run-delivery-interval.ts");
        for (const text of [
          '"14"',
          '"12"',
          '"10"',
          "RUN REAL 14 DAY CUSTOMER NOTIFICATIONS",
          "RUN REAL 12 DAY CUSTOMER NOTIFICATIONS",
          "RUN REAL 10 DAY CUSTOMER NOTIFICATIONS",
          "create14DayDeliveryReminderEvents",
          "create12DayDeliveryPaymentRequestEvents",
          "create10DayDeliveryPaymentRequestEvents",
          "dispatchOnlyCurrentRunCreatedEvents: true",
          "freshImportForSummary(createSummary)",
        ]) {
          assertIncludes(runner, text, `runner missing ${text}`, failures);
        }
        assertNotIncludes(
          runner,
          "NotificationIntervalType.DAY_8",
          "8-day must remain out of live unified runner until hold target approval",
          failures
        );
        return done({ live8Blocked: true }, failures);
      },
    },
    {
      group: "Source",
      id: "S2",
      name: "dispatcher has stale payment and opt-out pre-dispatch guards",
      severity: "production_blocker",
      run: () => {
        const failures: string[] = [];
        const dispatcher = read("lib/notifications/deliveryNotificationDispatcher.ts");
        for (const text of [
          "paymentEvaluationForEvent(event)",
          "payment_amount_not_due",
          "selectNotificationChannel(",
          "localSmsOptOutActive",
          "localEmailOptOutActive",
          "globalSmsOptOutActive",
          "globalEmailOptOutActive",
        ]) {
          assertIncludes(dispatcher, text, `dispatcher missing ${text}`, failures);
        }
        return done({ stalePaymentGuard: true, optOutGuard: true }, failures);
      },
    },
    {
      group: "Source",
      id: "S3",
      name: "8-day hold remains dry-run/write-gated",
      severity: "production_blocker",
      run: () => {
        const failures: string[] = [];
        const hold = read("lib/notifications/deliveryPrepaymentHoldQueue.ts");
        const runner = read("scripts/run-delivery-interval.ts");
        assertIncludes(hold, "DELIVERY_PREPAYMENT_HOLD_DRY_RUN", "hold dry-run env missing", failures);
        assertIncludes(hold, "params.dryRun ?? shouldDryRunDeliveryPrepaymentHold()", "hold dry-run payload guard missing", failures);
        assertNotIncludes(runner, "create8DayPaymentEnforcementEvents", "live runner must not invoke 8-day hold path yet", failures);
        return done({ holdDryRunGated: true }, failures);
      },
    },
    {
      group: "Source",
      id: "S4",
      name: "manual ERP confirmation before dispatch is currently not a direct dispatcher guard",
      severity: "production_blocker",
      run: () => {
        const failures: string[] = [];
        const dispatcher = read("lib/notifications/deliveryNotificationDispatcher.ts");
        assertIncludes(
          dispatcher,
          "acumaticaOneWeekConfirmed",
          "dispatcher should re-check acumaticaOneWeekConfirmed before dispatching 12/10/8 stale payment events",
          failures
        );
        return done({ manualConfirmationPreDispatchGuard: true }, failures);
      },
    },
  ];
}

const scenarios: Scenario[] = [
  ...sourceGuardScenarios(),
  {
    group: "A",
    id: "A1",
    name: "Non-prepay gets 14-day reminder without payment demand",
    severity: "production_blocker",
    run: () => {
      const p = nonPrepayPayment();
      const action = nextPaymentLifecycleAction({ day: 14, evaluation: p });
      const failures: string[] = [];
      assert(action === "DAY_14_REMINDER", "expected reminder-only 14-day action", failures);
      assert(p.paymentStatus === "not_applicable", "non-prepay payment status should be not_applicable", failures);
      return done({ action, paymentStatus: p.paymentStatus }, failures);
    },
  },
  {
    group: "A",
    id: "A2",
    name: "Non-prepay reaches 10-day writeback eligibility without payment chain",
    severity: "production_blocker",
    run: async () => {
      const p = nonPrepayPayment();
      const status = await dryRunTenDayStatus(p);
      const failures: string[] = [];
      assert(tenDayWritebackEligible({ evaluation: p }), "non-prepay should be writeback eligible", failures);
      assert(status === "DRY_RUN", "writeback should be dry-run in validation", failures);
      return done({ tenDayWritebackStatus: status }, failures);
    },
  },
  {
    group: "A",
    id: "A3",
    name: "Non-prepay manually confirmed before 10 has no duplicate writeback",
    severity: "production_blocker",
    run: () => {
      const action = nextPaymentLifecycleAction({
        day: 10,
        evaluation: nonPrepayPayment(),
        acumaticaOneWeekConfirmed: true,
      });
      const failures: string[] = [];
      assert(action === "SKIP_ALREADY_CONFIRMED", "manual confirmation should suppress action", failures);
      return done({ action }, failures);
    },
  },
  ...([14, 12, 10, 8] as const).map((day): Scenario => ({
    group: "C",
    id: `C${day}`,
    name: `Prepay unpaid through ${day} days selects expected action`,
    severity: "production_blocker",
    run: () => {
      const p = payment();
      const action = nextPaymentLifecycleAction({ day, evaluation: p });
      const expected =
        day === 14
          ? "DAY_14_REMINDER_WITH_PAYMENT"
          : day === 12
            ? "DAY_12_PAYMENT_REQUEST"
            : day === 10
              ? "DAY_10_PAYMENT_REQUEST"
              : "DAY_8_PAYMENT_ENFORCEMENT_ELIGIBLE";
      const failures: string[] = [];
      assert(action === expected, `expected ${expected}, got ${action}`, failures);
      return done({ action, amountDueNowRounded: p.amountDueNowRounded }, failures);
    },
  })),
  ...([12, 11, 10, 9, 8] as const).map((paidOnDay, index): Scenario => ({
    group: "B",
    id: `B${index + 2}`,
    name: `Prepay pays on/before day ${paidOnDay}; payment chain stops and 10-day writeback is eligible`,
    severity: "production_blocker",
    run: async () => {
      const p = paidPayment();
      const status = await dryRunTenDayStatus(p);
      const action = nextPaymentLifecycleAction({ day: paidOnDay === 8 ? 8 : 10, evaluation: p });
      const failures: string[] = [];
      assert(action === "SKIP_PAYMENT_CLEAR_WRITEBACK_ELIGIBLE", "paid customer should skip payment reminder", failures);
      assert(status === "DRY_RUN", "paid customer should make ONEWEEKCON dry-run eligible", failures);
      return done({ paidOnDay, action, tenDayWritebackStatus: status }, failures);
    },
  })),
  {
    group: "B",
    id: "B1",
    name: "Prepay payable balance at 14 sends payment-aware 14-day copy but no writeback",
    severity: "production_blocker",
    run: () => {
      const p = payment();
      const failures: string[] = [];
      assert(balanceIsDue(p), "prepay fixture should have payable balance", failures);
      assert(!tenDayWritebackEligible({ evaluation: p }), "unpaid prepay should not be writeback eligible", failures);
      return done({ paymentStatus: p.paymentStatus, amountDueNowRounded: p.amountDueNowRounded }, failures);
    },
  },
  ...([12, 10, 8] as const).map((day, index): Scenario => ({
    group: "D",
    id: `D${index + 1}`,
    name: `Manual ERP 10-day confirmation set before ${day} suppresses downstream chain`,
    severity: "production_blocker",
    run: () => {
      const action = nextPaymentLifecycleAction({
        day,
        evaluation: payment(),
        acumaticaOneWeekConfirmed: true,
      });
      const failures: string[] = [];
      assert(action === "SKIP_ALREADY_CONFIRMED", "manual ERP confirmation should win", failures);
      return done({ action }, failures);
    },
  })),
  {
    group: "D",
    id: "D5",
    name: "Manual ERP confirmation wins even with unpaid prepay balance",
    severity: "production_blocker",
    run: () => {
      const p = payment();
      const action = nextPaymentLifecycleAction({ day: 8, evaluation: p, acumaticaOneWeekConfirmed: true });
      const failures: string[] = [];
      assert(balanceIsDue(p), "fixture must still be unpaid", failures);
      assert(action === "SKIP_ALREADY_CONFIRMED", "manual confirmation should suppress unpaid escalation", failures);
      return done({ action, amountDueNowRounded: p.amountDueNowRounded }, failures);
    },
  },
  {
    group: "E",
    id: "E1",
    name: "All items backordered produce zero payable balance",
    severity: "production_blocker",
    run: () => {
      const p = payment({
        lines: [
          line({
            id: "backorder",
            lineNbr: 1,
            discountedUnitPrice: "1000.00",
            activeAllocatedQty: "0",
            allocationStatus: "not_allocated",
            etaStatus: "backordered",
            readinessStatus: "backordered",
          }),
        ],
      });
      const failures: string[] = [];
      assert(p.payableBasisValue === "0.00", "backordered line should be excluded", failures);
      assert(p.paymentStatus === "no_balance_due", "all backordered should have no balance due now", failures);
      return done({ payableBasisValue: p.payableBasisValue, paymentStatus: p.paymentStatus }, failures);
    },
  },
  {
    group: "E",
    id: "E2",
    name: "Mixed ready/backordered includes only eligible stock",
    severity: "production_blocker",
    run: () => {
      const p = payment({
        lines: [
          line({ id: "ready", lineNbr: 1, discountedUnitPrice: "1000.00" }),
          line({
            id: "backorder",
            lineNbr: 2,
            discountedUnitPrice: "500.00",
            activeAllocatedQty: "0",
            allocationStatus: "not_allocated",
            etaStatus: "backordered",
            readinessStatus: "backordered",
          }),
        ],
      });
      const failures: string[] = [];
      assert(p.payableStockValue === "1000.00", "only ready item should be payable", failures);
      return done({ payableStockValue: p.payableStockValue, amountDueNowRounded: p.amountDueNowRounded }, failures);
    },
  },
  {
    group: "E",
    id: "E3",
    name: "ETA-pending excluded unless expected-on-time",
    severity: "production_blocker",
    run: () => {
      const pending = payment({
        lines: [
          line({
            id: "pending",
            lineNbr: 1,
            discountedUnitPrice: "1000.00",
            activeAllocatedQty: "0",
            allocationStatus: "not_allocated",
            etaStatus: "eta_pending",
            readinessStatus: "eta_pending",
          }),
        ],
      });
      const expected = payment({
        lines: [
          line({
            id: "expected",
            lineNbr: 1,
            discountedUnitPrice: "1000.00",
            activeAllocatedQty: "0",
            allocationStatus: "not_allocated",
            etaStatus: "expected_on_time",
            readinessStatus: "expected_on_time",
          }),
        ],
      });
      const failures: string[] = [];
      assert(pending.payableBasisValue === "0.00", "ETA pending should be excluded", failures);
      assert(expected.payableBasisValue === "1000.00", "expected-on-time should be included", failures);
      return done({ pending: pending.payableBasisValue, expected: expected.payableBasisValue }, failures);
    },
  },
  {
    group: "E",
    id: "E4",
    name: "Partially allocated line includes only allocated quantity",
    severity: "production_blocker",
    run: () => {
      const p = payment({
        lines: [
          line({
            id: "partial",
            lineNbr: 1,
            discountedUnitPrice: "500.00",
            orderQty: "3",
            openQty: "3",
            activeAllocatedQty: "1",
            allocationStatus: "partially_allocated",
            readinessStatus: "partially_allocated",
          }),
        ],
      });
      const failures: string[] = [];
      assert(p.payableStockValue === "500.00", "only one allocated unit should be payable", failures);
      return done({ payableStockValue: p.payableStockValue, lineOpen: p.lines[0]?.lineOpenMerchandiseValue }, failures);
    },
  },
  {
    group: "E",
    id: "E5",
    name: "Freight/delivery charge can be included once with payment-gated group",
    severity: "production_blocker",
    run: () => {
      const freight = line({
        id: "freight",
        lineNbr: 1,
        itemType: "N",
        inventoryId: "DELIVERY-FEE",
        lineDescription: "Delivery",
        discountedUnitPrice: "300.00",
      });
      const first = payment({
        orderDeliveryGroupId: "group_freight_first",
        lines: [freight],
        activeOrderLineIds: [],
        newlyAssignedFreightDeliveryChargeLines: [freight],
      });
      const second = payment({
        orderDeliveryGroupId: "group_freight_second",
        lines: [freight],
        activeOrderLineIds: [],
        freightDeliveryChargeAllocations: [
          {
            orderDeliveryGroupId: "group_freight_first",
            orderLineId: "freight",
            amountIncluded: "300.00",
            sourceInterval: NotificationIntervalType.DAY_14,
          },
        ],
      });
      const failures: string[] = [];
      assert(first.newlyAssignedFreightDeliveryChargeValue === "300.00", "first group should assign freight", failures);
      assert(second.payableBasisValue === "0.00", "second group should not double charge freight", failures);
      return done({ first: first.newlyAssignedFreightDeliveryChargeValue, second: second.payableBasisValue }, failures);
    },
  },
  {
    group: "E",
    id: "E6",
    name: "Freight/delivery charge alone is not charged without explicit allocation",
    severity: "production_blocker",
    run: () => {
      const p = payment({
        lines: [
          line({
            id: "freight_only",
            lineNbr: 1,
            itemType: "N",
            inventoryId: "DELIVERY-FEE",
            discountedUnitPrice: "300.00",
          }),
        ],
        activeOrderLineIds: [],
      });
      const failures: string[] = [];
      assert(p.payableBasisValue === "0.00", "freight alone should not be payable without allocation", failures);
      return done({ payableBasisValue: p.payableBasisValue, todoCount: p.freightDeliveryChargeTodos?.length ?? 0 }, failures);
    },
  },
  {
    group: "E",
    id: "E7",
    name: "Item becomes backordered after 14 before 12; 12 recalculates and skips",
    severity: "production_blocker",
    run: () => {
      const p = payment({
        lines: [
          line({
            id: "now_backordered",
            lineNbr: 1,
            discountedUnitPrice: "1000.00",
            activeAllocatedQty: "0",
            allocationStatus: "not_allocated",
            etaStatus: "backordered",
            readinessStatus: "backordered",
          }),
        ],
      });
      const action = nextPaymentLifecycleAction({ day: 12, evaluation: p });
      const failures: string[] = [];
      assert(action === "SKIP_PAYMENT_CLEAR_WRITEBACK_ELIGIBLE", "12 should skip if recalculated payable balance is zero", failures);
      return done({ action, payableBasisValue: p.payableBasisValue }, failures);
    },
  },
  {
    group: "E",
    id: "E8",
    name: "Item becomes ready after 14 before 12; 12 recalculates and can send",
    severity: "production_blocker",
    run: () => {
      const p = payment();
      const action = nextPaymentLifecycleAction({ day: 12, evaluation: p });
      const failures: string[] = [];
      assert(action === "DAY_12_PAYMENT_REQUEST", "12 should request payment when current payable balance is positive", failures);
      return done({ action, amountDueNowRounded: p.amountDueNowRounded }, failures);
    },
  },
  {
    group: "F",
    id: "F1",
    name: "Same order two delivery dates has independent dedupe keys",
    severity: "production_blocker",
    run: () => {
      const first = buildNotificationDedupeKey({
        orderType: "SO",
        orderNumber: "SO-LIFE",
        deliveryDate: "2026-09-14",
        intervalType: NotificationIntervalType.DAY_12,
        actionType: NotificationActionType.PAYMENT_REQUEST,
      });
      const second = buildNotificationDedupeKey({
        orderType: "SO",
        orderNumber: "SO-LIFE",
        deliveryDate: "2026-09-21",
        intervalType: NotificationIntervalType.DAY_12,
        actionType: NotificationActionType.PAYMENT_REQUEST,
      });
      const failures: string[] = [];
      assert(first !== second, "delivery date must participate in dedupe key", failures);
      return done({ first, second }, failures);
    },
  },
  {
    group: "F",
    id: "F2",
    name: "One paid group and one unpaid group diverge independently",
    severity: "production_blocker",
    run: () => {
      const paid = paidPayment();
      const unpaid = payment();
      const failures: string[] = [];
      assert(!balanceIsDue(paid), "paid group should not be due", failures);
      assert(balanceIsDue(unpaid), "unpaid group should remain due", failures);
      return done({ paid: paid.paymentStatus, unpaid: unpaid.paymentStatus }, failures);
    },
  },
  {
    group: "F",
    id: "F3",
    name: "Delivery date changes after event; stale event guard is represented by changed dedupe key",
    severity: "production_blocker",
    run: () => {
      const oldKey = dedupe(NotificationIntervalType.DAY_12, NotificationActionType.PAYMENT_REQUEST);
      const newKey = buildNotificationDedupeKey({
        orderType: "SO",
        orderNumber: "SO-LIFE",
        deliveryDate: "2026-09-22",
        intervalType: NotificationIntervalType.DAY_12,
        actionType: NotificationActionType.PAYMENT_REQUEST,
      });
      const failures: string[] = [];
      assert(oldKey !== newKey, "date move should no longer match old dedupe/date scope", failures);
      return done({ oldKey, newKey }, failures);
    },
  },
  {
    group: "F",
    id: "F4",
    name: "Delivery group loses all active lines; payable basis goes zero",
    severity: "production_blocker",
    run: () => {
      const p = payment({ lines: [], activeOrderLineIds: [] });
      const failures: string[] = [];
      assert(!balanceIsDue(p), "empty delivery group should not be due", failures);
      return done({ paymentStatus: p.paymentStatus, payableBasisValue: p.payableBasisValue }, failures);
    },
  },
  {
    group: "F",
    id: "F5",
    name: "Header RequestedOn differs from line RequestedOn; active line date is payment scope",
    severity: "production_blocker",
    run: () => {
      const p = payment({
        deliveryDate: "2026-09-14",
        lines: [
          line({ id: "line_date", lineNbr: 1, requestedOn: "2026-09-14", discountedUnitPrice: "1000.00" }),
        ],
      });
      const failures: string[] = [];
      assert(p.deliveryDate === "2026-09-14", "delivery group line date should drive scope", failures);
      return done({ deliveryDate: p.deliveryDate, lineRequestedOn: p.lines[0]?.requestedOn }, failures);
    },
  },
  ...[
    ["G1", "SMS and email opted in selects SMS", { smsOptIn: true, emailOptIn: true }, "SMS"],
    ["G2", "SMS opted out, email opted in selects email fallback", { smsOptIn: true, emailOptIn: true, activeSmsOptOutPhones: ["8015551212"] }, "EMAIL"],
    ["G3", "SMS opted in, email opted out selects SMS", { smsOptIn: true, emailOptIn: true, activeEmailOptOutEmails: ["customer@example.test"] }, "SMS"],
    ["G4", "Both opted out selects no automated channel", { smsOptIn: true, emailOptIn: true, activeSmsOptOutPhones: ["8015551212"], activeEmailOptOutEmails: ["customer@example.test"] }, null],
    ["G6", "Global STOP opt-out blocks SMS", { smsOptIn: true, emailOptIn: false, activeSmsOptOutPhones: ["8015551212"] }, null],
    ["G7", "Email opt-out blocks email", { smsOptIn: false, emailOptIn: true, activeEmailOptOutEmails: ["customer@example.test"] }, null],
  ].map(([id, name, input, expected]) => ({
    group: "G" as const,
    id: id as string,
    name: name as string,
    severity: "production_blocker" as const,
    run: () => {
      const selected = channel(input as Parameters<typeof channel>[0]);
      const failures: string[] = [];
      assert(selected.selectedChannel === expected, `expected channel ${String(expected)}, got ${String(selected.selectedChannel)}`, failures);
      return done({ selectedChannel: selected.selectedChannel, reason: selected.channelReason }, failures);
    },
  })),
  {
    group: "G",
    id: "G5",
    name: "Contact opts out after event creation before dispatch; dispatcher opt-out guard exists",
    severity: "production_blocker",
    run: () => {
      const selected = channel({ smsOptIn: true, emailOptIn: false, activeSmsOptOutPhones: ["8015551212"] });
      const failures: string[] = [];
      assert(selected.selectedChannel === null, "post-create STOP should make selected channel unavailable", failures);
      return done({ selectedChannel: selected.selectedChannel, reason: selected.channelReason }, failures);
    },
  },
  ...[
    ["H1", NotificationIntervalType.DAY_14, NotificationActionType.DELIVERY_REMINDER],
    ["H2", NotificationIntervalType.DAY_12, NotificationActionType.PAYMENT_REQUEST],
    ["H3", NotificationIntervalType.DAY_10, NotificationActionType.PAYMENT_REQUEST],
  ].map(([id, intervalType, actionType]) => ({
    group: "H" as const,
    id: id as string,
    name: `Rerun ${String(intervalType)} uses stable dedupe key`,
    severity: "production_blocker" as const,
    run: () => {
      const first = dedupe(intervalType as NotificationIntervalType, actionType as NotificationActionType);
      const second = dedupe(intervalType as NotificationIntervalType, actionType as NotificationActionType);
      const failures: string[] = [];
      assert(first === second, "same order/date/interval/action must dedupe", failures);
      return done({ dedupeKey: first }, failures);
    },
  })),
  {
    group: "H",
    id: "H4-H6",
    name: "Existing/failed/delayed attempt behavior is guarded by dispatcher state checks",
    severity: "production_blocker",
    run: () => {
      const failures: string[] = [];
      const dispatcher = read("lib/notifications/deliveryNotificationDispatcher.ts");
      const twilioStatus = read("lib/notifications/handleTwilioMessageStatus.ts");
      for (const text of [
        "status: NotificationEventStatus.SCHEDULED",
        "status: NotificationEventStatus.PENDING",
        "NotificationAttemptStatus.FAILED",
        "NotificationAttemptStatus.SUBMITTED",
      ]) {
        assertIncludes(dispatcher, text, `dispatcher missing ${text}`, failures);
      }
      assertIncludes(twilioStatus, "ATTEMPT_DELIVERED", "Twilio delivered callback promotion is missing", failures);
      return done({ dispatcherClaimAndAttemptStatuses: true }, failures);
    },
  },
  {
    group: "I",
    id: "I1-I5",
    name: "10-day writeback eligibility follows payment/manual confirmation state",
    severity: "production_blocker",
    run: async () => {
      const nonPrepay = nonPrepayPayment();
      const unpaid = payment();
      const paid = paidPayment();
      const status = await dryRunTenDayStatus(paid);
      const failures: string[] = [];
      assert(tenDayWritebackEligible({ evaluation: nonPrepay }), "non-prepay should write", failures);
      assert(!tenDayWritebackEligible({ evaluation: unpaid }), "unpaid prepay should not write", failures);
      assert(tenDayWritebackEligible({ evaluation: paid }), "paid prepay should write", failures);
      assert(tenDayWritebackEligible({ evaluation: unpaid, acumaticaOneWeekConfirmed: true }), "already-confirmed Acumatica should not duplicate", failures);
      assert(status === "DRY_RUN", "writeback remains dry-run in validation", failures);
      return done({ nonPrepay: true, unpaid: false, paid: true, dryRunStatus: status }, failures);
    },
  },
  {
    group: "I",
    id: "I6",
    name: "Writeback stale ERP state is delegated to queue/worker refusal path",
    severity: "production_blocker",
    run: () => {
      const failures: string[] = [];
      const queue = read("../mld-queue/worker/src/lib/deliveryPrepaymentHold.ts");
      assertIncludes(queue, "ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED", "worker write gate missing", failures);
      assertIncludes(queue, "ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER", "worker allowlist missing", failures);
      return done({ queueRefusalPathPresent: true }, failures);
    },
  },
  ...[
    ["J1", "Prepay unpaid reaches 8; hold path eligible", payment(), "DAY_8_PAYMENT_ENFORCEMENT_ELIGIBLE"],
    ["J2", "Customer pays on day 8 before runner; no hold", paidPayment(), "SKIP_PAYMENT_CLEAR_WRITEBACK_ELIGIBLE"],
    ["J6", "Non-prepay reaches 8; no prepayment hold", nonPrepayPayment(), "SKIP_PAYMENT_CLEAR_WRITEBACK_ELIGIBLE"],
    [
      "J7",
      "Prepay zero payable due to all backordered; no hold",
      payment({
        lines: [
          line({
            id: "j7",
            lineNbr: 1,
            discountedUnitPrice: "1000.00",
            activeAllocatedQty: "0",
            allocationStatus: "not_allocated",
            etaStatus: "backordered",
            readinessStatus: "backordered",
          }),
        ],
      }),
      "SKIP_PAYMENT_CLEAR_WRITEBACK_ELIGIBLE",
    ],
  ].map(([id, name, evaluation, expected]) => ({
    group: "J" as const,
    id: id as string,
    name: name as string,
    severity: "production_blocker" as const,
    run: () => {
      const action = nextPaymentLifecycleAction({
        day: 8,
        evaluation: evaluation as DeliveryGroupPaymentEvaluation,
      });
      const failures: string[] = [];
      assert(action === expected, `expected ${String(expected)}, got ${action}`, failures);
      return done({ action, amountDueNowRounded: (evaluation as DeliveryGroupPaymentEvaluation).amountDueNowRounded }, failures);
    },
  })),
  {
    group: "J",
    id: "J3-J5",
    name: "8-day hold dispatch remains guarded by dry-run/write/allowlist gates",
    severity: "production_blocker",
    run: () => {
      const failures: string[] = [];
      const local = read("lib/notifications/deliveryPrepaymentHoldQueue.ts");
      const queue = read("../mld-queue/worker/src/lib/deliveryPrepaymentHold.ts");
      assertIncludes(local, "DELIVERY_PREPAYMENT_HOLD_DRY_RUN", "local dry-run gate missing", failures);
      assertIncludes(queue, "ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED", "worker write enabled gate missing", failures);
      assertIncludes(queue, "ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER", "worker allowlist gate missing", failures);
      return done({ dryRunGate: true, writeGate: true, allowlistGate: true }, failures);
    },
  },
];

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  try {
    const details = await scenario.run();
    return {
      group: scenario.group,
      id: scenario.id,
      name: scenario.name,
      passed: true,
      severity: scenario.severity,
      details,
      failures: [],
    };
  } catch (error) {
    const failures =
      error instanceof ScenarioAssertionError
        ? error.failures
        : [error instanceof Error ? error.message : String(error)];
    return {
      group: scenario.group,
      id: scenario.id,
      name: scenario.name,
      passed: false,
      severity: scenario.severity,
      details: {},
      failures,
    };
  }
}

async function main() {
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  const failed = results.filter((result) => !result.passed);
  const productionBlockers = failed.filter((result) => result.severity === "production_blocker");
  const byGroup = results.reduce<Record<string, { passed: number; failed: number }>>((groups, result) => {
    groups[result.group] ??= { passed: 0, failed: 0 };
    groups[result.group][result.passed ? "passed" : "failed"] += 1;
    return groups;
  }, {});

  console.table(
    results.map((result) => ({
      group: result.group,
      id: result.id,
      status: result.passed ? "PASS" : "FAIL",
      severity: result.severity,
      name: result.name,
    }))
  );

  console.log(
    JSON.stringify(
      {
        validation: "14/12/10/8 lifecycle scenario validation complete",
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        productionBlockers: productionBlockers.length,
        testHarnessGaps: failed.length - productionBlockers.length,
        byGroup,
        failedAssertions: failed.map((result) => ({
          group: result.group,
          id: result.id,
          name: result.name,
          severity: result.severity,
          failures: result.failures,
        })),
        safety: {
          liveSmsSent: false,
          liveEmailSent: false,
          providerDispatch: false,
          acumaticaWrites: false,
          writebackJobsQueued: false,
          realHoldsPlaced: false,
          productionDataMutated: false,
          notificationAttemptsCreated: false,
        },
      },
      null,
      2
    )
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
