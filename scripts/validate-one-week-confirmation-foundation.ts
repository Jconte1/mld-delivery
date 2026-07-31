import {
  type DeliveryGroupPaymentEvaluation,
} from "../lib/delivery-payment/deliveryGroupPayment";
import {
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import type { EnqueueDeliveryTenDayConfirmationWritebackResult } from "../lib/notifications/deliveryTenDayConfirmationWritebackQueue";

type DeliveryTenDayConfirmationModule =
  typeof import("../lib/notifications/deliveryTenDayConfirmation");

type ConfirmationRecord = Record<string, unknown>;

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function payment(
  overrides: Partial<DeliveryGroupPaymentEvaluation> = {}
): DeliveryGroupPaymentEvaluation {
  return {
    orderDeliveryGroupId: "group_one_week",
    orderId: "order_one_week",
    orderType: "SO",
    orderNumber: "SO1W",
    deliveryDate: "2026-08-09",
    paymentTerms: "PP",
    unpaidBalance: "500.00",
    orderTotal: "1000.00",
    taxTotal: "0.00",
    paidToDate: "500.00",
    currentDeliveryGroupMerchandiseValue: "400.00",
    currentDeliveryGroupTaxAmount: "0.00",
    currentDeliveryGroupValue: "400.00",
    completedValueBeforeCurrentDelivery: "0.00",
    remainingUndeliveredValueAfterCurrentDelivery: "600.00",
    creditAfterCurrentDelivery: "100.00",
    requiredDownOnRemaining: "270.00",
    amountDueNow: "170.000000",
    amountDueNowRounded: "170.00",
    payableStockValue: "400.00",
    assignedFreightDeliveryChargeValue: "0.00",
    newlyAssignedFreightDeliveryChargeValue: "0.00",
    payableBasisValue: "400.00",
    freightDeliveryChargeTodos: [],
    paymentApplicabilityStatus: "applicable",
    paymentStatus: "balance_due",
    urgencyStatus: "payment_required",
    calculationWarnings: [],
    lines: [],
    ...overrides,
  };
}

function group(overrides: {
  acumaticaOneWeekConfirmed?: boolean | null;
  id?: string;
  orderNumber?: string;
} = {}) {
  const id = overrides.id ?? "group_one_week";
  const orderNumber = overrides.orderNumber ?? "SO1W";
  return {
    id,
    orderId: `order_${id}`,
    orderType: "SO",
    orderNumber,
    deliveryDate: new Date("2026-08-09T00:00:00.000Z"),
    order: {
      id: `order_${id}`,
      orderType: "SO",
      orderNumber,
      acumaticaOneWeekConfirmed: overrides.acumaticaOneWeekConfirmed ?? false,
    },
  };
}

function fakeClient(existing: ConfirmationRecord[] = []) {
  const records = [...existing];
  return {
    records,
    client: {
      deliveryGroupTenDayConfirmation: {
        findUnique: async (args: { where: { orderDeliveryGroupId: string } }) =>
          records.find((record) => record.orderDeliveryGroupId === args.where.orderDeliveryGroupId) ??
          null,
        upsert: async (args: {
          where: { orderDeliveryGroupId: string };
          create: ConfirmationRecord;
          update: ConfirmationRecord;
        }) => {
          const existingRecord = records.find(
            (record) => record.orderDeliveryGroupId === args.where.orderDeliveryGroupId
          );
          if (existingRecord) {
            Object.assign(existingRecord, args.update);
            return existingRecord;
          }
          const created = { id: `confirm_${records.length + 1}`, ...args.create };
          records.push(created);
          return created;
        },
      },
    },
  };
}

function queueResult(
  status: string,
  reason: string
): EnqueueDeliveryTenDayConfirmationWritebackResult {
  return {
    jobId: `job_${status}`,
    payload: {
      orderType: "SO",
      orderNumber: "SO1W",
      dryRun: status === "dry_run",
      reason: "delivery_group_cleared",
      deliveryDate: "2026-08-09",
      sourceInterval: "DAY_10",
    },
    result: {
      status,
      reason,
      dryRun: status === "dry_run",
      wouldWrite: status !== "already_true",
      intendedOneWeekConfirmed: true,
    },
  };
}

async function main() {
  const failures: string[] = [];
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const {
    DELIVERY_TEN_DAY_CONFIRMATION_REASONS,
    DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES,
    evaluateAndRecordDeliveryTenDayConfirmation,
    isCompleteTenDayConfirmationWritebackStatus,
  }: DeliveryTenDayConfirmationModule = await import(
    "../lib/notifications/deliveryTenDayConfirmation"
  );

  assert(
    isCompleteTenDayConfirmationWritebackStatus("WRITTEN"),
    "WRITTEN is complete",
    failures
  );
  assert(
    isCompleteTenDayConfirmationWritebackStatus("ALREADY_TRUE"),
    "ALREADY_TRUE is complete",
    failures
  );
  assert(
    !isCompleteTenDayConfirmationWritebackStatus("DRY_RUN"),
    "DRY_RUN is not production-complete",
    failures
  );

  const nonPrepayDryRun = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: group({ id: "group_nonprepay" }),
    payment: payment({
      paymentTerms: "N30",
      paymentStatus: "not_applicable",
      paymentApplicabilityStatus: "not_applicable_terms",
      amountDueNow: null,
      amountDueNowRounded: null,
    }),
    sourceInterval: NotificationIntervalType.DAY_14,
    dryRun: true,
    prismaClient: {},
  });
  assert(nonPrepayDryRun.localCleared, "non-prepay group is locally clear after interval qualification", failures);
  assert(nonPrepayDryRun.localConfirmed === false, "dry-run does not locally confirm", failures);
  assert(nonPrepayDryRun.acumaticaWritebackStatus === "DRY_RUN", "dry-run status is recorded in result", failures);

  const balanceDue = fakeClient();
  const balanceDueResult = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: group({ id: "group_due" }),
    payment: payment(),
    sourceInterval: NotificationIntervalType.DAY_10,
    dryRun: false,
    prismaClient: balanceDue.client,
    enqueueWriteback: async () => {
      throw new Error("balance-due group must not enqueue writeback");
    },
  });
  assert(!balanceDueResult.localCleared, "prepay balance due is not locally clear", failures);
  assert(balanceDueResult.acumaticaWritebackStatus === "NOT_CLEARED", "balance due records NOT_CLEARED", failures);
  assert(balanceDue.records[0]?.localConfirmed === false, "balance due persists localConfirmed=false", failures);

  const blocked = fakeClient();
  const blockedResult = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: group({ id: "group_blocked" }),
    payment: payment({
      paymentStatus: "calculation_blocked",
      amountDueNow: null,
      amountDueNowRounded: null,
      calculationWarnings: ["Payment calculation blocked."],
    }),
    sourceInterval: NotificationIntervalType.DAY_12,
    dryRun: false,
    prismaClient: blocked.client,
    enqueueWriteback: async () => {
      throw new Error("blocked payment group must not enqueue writeback");
    },
  });
  assert(!blockedResult.localCleared, "blocked payment data is not locally clear", failures);
  assert(blockedResult.reason === DELIVERY_TEN_DAY_CONFIRMATION_REASONS.prepayBalanceNotCleared, "blocked payment uses not-cleared reason", failures);

  const mismatch = fakeClient();
  const mismatchResult = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: group({ id: "group_mismatch", acumaticaOneWeekConfirmed: true }),
    payment: payment({ paymentStatus: "balance_due", amountDueNowRounded: "250.00" }),
    sourceInterval: NotificationIntervalType.DAY_8,
    dryRun: false,
    prismaClient: mismatch.client,
    enqueueWriteback: async () => {
      throw new Error("mismatch must not enqueue writeback");
    },
  });
  assert(!mismatchResult.localConfirmed, "Acumatica true plus local balance due is not locally confirmed", failures);
  assert(mismatchResult.acumaticaWritebackStatus === "MISMATCH_BALANCE_DUE", "mismatch status is recorded", failures);
  assert(
    mismatchResult.mismatchReason ===
      DELIVERY_TEN_DAY_CONFIRMATION_REASONS.mismatchPaymentNotCleared,
    "mismatch reason is explicit",
    failures
  );

  const dryQueue = fakeClient();
  const dryQueueResult = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: group({ id: "group_queue_dry" }),
    payment: payment({
      paymentStatus: "no_balance_due",
      amountDueNow: "0.000000",
      amountDueNowRounded: "0.00",
    }),
    sourceInterval: NotificationIntervalType.DAY_10,
    dryRun: false,
    prismaClient: dryQueue.client,
    enqueueWriteback: async () => queueResult("dry_run", "dry_run"),
  });
  assert(dryQueueResult.localCleared, "prepay no balance is locally clear", failures);
  assert(!dryQueueResult.localConfirmed, "queue dry-run does not locally confirm", failures);
  assert(dryQueue.records[0]?.acumaticaWritebackStatus === "DRY_RUN", "queue dry-run is persisted", failures);

  const written = fakeClient();
  const writtenResult = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: group({ id: "group_written" }),
    payment: payment({
      paymentStatus: "no_balance_due",
      amountDueNow: "0.000000",
      amountDueNowRounded: "0.00",
    }),
    sourceInterval: NotificationIntervalType.DAY_12,
    dryRun: false,
    prismaClient: written.client,
    enqueueWriteback: async () => queueResult("written", "one_week_confirmation_written"),
  });
  assert(writtenResult.localConfirmed, "written queue result locally confirms", failures);
  assert(written.records[0]?.acumaticaWritebackStatus === "WRITTEN", "WRITTEN is persisted", failures);

  let enqueueCalledForExisting = false;
  const existing = fakeClient([
    {
      id: "confirm_existing",
      orderDeliveryGroupId: "group_existing",
      localConfirmed: true,
      acumaticaWritebackStatus: DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_STATUSES.WRITTEN,
      acumaticaWritebackJobId: "job_existing",
      confirmedReason: "one_week_confirmation_written",
      mismatchReason: null,
    },
  ]);
  const existingResult = await evaluateAndRecordDeliveryTenDayConfirmation({
    deliveryGroup: group({ id: "group_existing" }),
    payment: payment({
      paymentStatus: "no_balance_due",
      amountDueNow: "0.000000",
      amountDueNowRounded: "0.00",
    }),
    sourceInterval: NotificationIntervalType.DAY_10,
    dryRun: false,
    prismaClient: existing.client,
    enqueueWriteback: async () => {
      enqueueCalledForExisting = true;
      return queueResult("written", "one_week_confirmation_written");
    },
  });
  assert(existingResult.localConfirmed, "existing completed local confirmation is reused", failures);
  assert(!enqueueCalledForExisting, "existing completed local confirmation does not enqueue duplicate writeback", failures);

  if (failures.length > 0) {
    console.error("One-week confirmation foundation validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "One-week confirmation foundation validation passed. No SMS/email, provider dispatch, live Acumatica write, or deployment was performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
