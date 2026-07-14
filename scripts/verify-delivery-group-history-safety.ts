import {
  DeliveryConfirmationStatus,
  NotificationActionType,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import { syncOrderDeliveryGroups } from "../lib/erp/syncOrderDeliveryGroups";
import { prisma } from "../lib/prisma";

type ScenarioResult = {
  passed: boolean;
  details: Record<string, unknown>;
};

type DiagnosticResult = {
  syncResult: {
    upserted: number;
    superseded: number;
  };
  scenarios: Record<"A" | "B" | "C" | "D" | "E", ScenarioResult>;
};

class RollbackDiagnostic extends Error {
  constructor(readonly diagnosticResult: DiagnosticResult) {
    super("rollback_delivery_group_history_safety_diagnostic");
  }
}

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function key(value: Date | null | undefined) {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

async function safetyCounts() {
  const [notificationEvents, deliveryConfirmations, notificationAttempts] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.deliveryConfirmation.count(),
    prisma.notificationAttempt.count(),
  ]);

  return {
    notificationEvents,
    deliveryConfirmations,
    notificationAttempts,
  };
}

async function main() {
  const before = await safetyCounts();
  let diagnosticResult: DiagnosticResult | null = null;
  const unique = `DGSAFE${Date.now()}`;

  try {
    await prisma.$transaction(
      async (tx) => {
        const importAt = new Date();
        const contact = await tx.contact.create({
          data: {
            contactId: `${unique}-CONTACT`,
            displayName: "Delivery Group History Diagnostic",
            email: `${unique.toLowerCase()}@example.com`,
          },
        });

        const order = await tx.order.create({
          data: {
            orderType: "TS",
            orderNumber: unique,
            status: "Open",
            contactId: contact.contactId,
          },
        });

        const oldWithHistory = await tx.orderDeliveryGroup.create({
          data: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderType: order.orderType,
            deliveryDate: day("2027-01-01"),
            status: order.status,
            isActive: true,
            lineCount: 2,
            lastSeenAt: day("2026-12-01"),
            lastSyncedAt: day("2026-12-01"),
          },
        });

        await tx.orderDeliveryGroup.create({
          data: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderType: order.orderType,
            deliveryDate: day("2027-01-02"),
            status: order.status,
            isActive: true,
            lineCount: 1,
            lastSeenAt: day("2026-12-01"),
            lastSyncedAt: day("2026-12-01"),
          },
        });

        const existingCurrent = await tx.orderDeliveryGroup.create({
          data: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderType: order.orderType,
            deliveryDate: day("2027-01-03"),
            status: order.status,
            isActive: true,
            lineCount: 1,
            lastSeenAt: day("2026-12-01"),
            lastSyncedAt: day("2026-12-01"),
          },
        });

        const notificationEvent = await tx.notificationEvent.create({
          data: {
            orderId: order.id,
            deliveryGroupId: oldWithHistory.id,
            contactId: contact.contactId,
            orderType: order.orderType,
            orderNumber: order.orderNumber,
            deliveryDate: oldWithHistory.deliveryDate,
            intervalType: NotificationIntervalType.DAY_42,
            actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
            dedupeKey: `${unique}-confirmation`,
            selectedChannel: NotificationChannel.EMAIL,
            recipientEmail: contact.email,
            status: NotificationEventStatus.SCHEDULED,
          },
        });

        await tx.deliveryConfirmation.create({
          data: {
            orderId: order.id,
            deliveryGroupId: oldWithHistory.id,
            notificationEventId: notificationEvent.id,
            orderType: order.orderType,
            orderNumber: order.orderNumber,
            deliveryDate: oldWithHistory.deliveryDate,
            contactId: contact.contactId,
            status: DeliveryConfirmationStatus.PENDING,
            responseChannel: NotificationChannel.EMAIL,
          },
        });

        const syncResult = await syncOrderDeliveryGroups(tx, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          orderType: order.orderType,
          status: order.status,
          importAt,
          currentDeliveryGroups: [
            {
              deliveryDate: existingCurrent.deliveryDate,
              lineCount: 3,
            },
            {
              deliveryDate: day("2027-01-04"),
              lineCount: 1,
            },
          ],
        });

        const groups = await tx.orderDeliveryGroup.findMany({
          where: { orderId: order.id },
          orderBy: { deliveryDate: "asc" },
          include: {
            _count: {
              select: {
                notificationEvents: true,
                deliveryConfirmations: true,
              },
            },
          },
        });

        const byDate = new Map(groups.map((group) => [key(group.deliveryDate), group]));
        const activeTargets = groups.filter((group) => group.isActive).map((group) => key(group.deliveryDate));
        const historyGroup = byDate.get("2027-01-01");
        const noHistoryGroup = byDate.get("2027-01-02");
        const currentGroup = byDate.get("2027-01-03");
        const newGroup = byDate.get("2027-01-04");

        diagnosticResult = {
          syncResult,
          scenarios: {
            A: {
              passed:
                Boolean(historyGroup) &&
                historyGroup?.isActive === false &&
                Boolean(historyGroup.supersededAt) &&
                historyGroup.supersededReason === "not_present_in_latest_erp_payload" &&
                historyGroup._count.notificationEvents === 1 &&
                historyGroup._count.deliveryConfirmations === 1,
              details: {
                groupStillExists: Boolean(historyGroup),
                isActive: historyGroup?.isActive,
                supersededAt: historyGroup?.supersededAt?.toISOString() ?? null,
                supersededReason: historyGroup?.supersededReason,
                notificationEvents: historyGroup?._count.notificationEvents,
                deliveryConfirmations: historyGroup?._count.deliveryConfirmations,
              },
            },
            B: {
              passed:
                Boolean(noHistoryGroup) &&
                noHistoryGroup?.isActive === false &&
                Boolean(noHistoryGroup.supersededAt) &&
                noHistoryGroup.supersededReason === "not_present_in_latest_erp_payload",
              details: {
                groupStillExists: Boolean(noHistoryGroup),
                isActive: noHistoryGroup?.isActive,
                supersededAt: noHistoryGroup?.supersededAt?.toISOString() ?? null,
                supersededReason: noHistoryGroup?.supersededReason,
                notificationEvents: noHistoryGroup?._count.notificationEvents,
                deliveryConfirmations: noHistoryGroup?._count.deliveryConfirmations,
              },
            },
            C: {
              passed:
                Boolean(newGroup) &&
                newGroup?.isActive === true &&
                newGroup.lineCount === 1 &&
                newGroup.supersededAt === null,
              details: {
                groupCreated: Boolean(newGroup),
                isActive: newGroup?.isActive,
                lineCount: newGroup?.lineCount,
                lastSeenAt: newGroup?.lastSeenAt?.toISOString() ?? null,
                supersededAt: newGroup?.supersededAt?.toISOString() ?? null,
              },
            },
            D: {
              passed:
                Boolean(currentGroup) &&
                currentGroup?.isActive === true &&
                currentGroup.lineCount === 3 &&
                currentGroup.supersededAt === null,
              details: {
                groupStillExists: Boolean(currentGroup),
                isActive: currentGroup?.isActive,
                lineCount: currentGroup?.lineCount,
                lastSeenAt: currentGroup?.lastSeenAt?.toISOString() ?? null,
                supersededAt: currentGroup?.supersededAt?.toISOString() ?? null,
              },
            },
            E: {
              passed:
                activeTargets.length === 2 &&
                activeTargets.includes("2027-01-03") &&
                activeTargets.includes("2027-01-04") &&
                !activeTargets.includes("2027-01-01") &&
                !activeTargets.includes("2027-01-02"),
              details: {
                activeTargets,
              },
            },
          },
        };

        throw new RollbackDiagnostic(diagnosticResult);
      },
      { timeout: 30_000 }
    );
  } catch (error) {
    if (error instanceof RollbackDiagnostic) {
      diagnosticResult = error.diagnosticResult;
    } else {
      throw error;
    }
  }

  const after = await safetyCounts();
  const output = {
    diagnosticRolledBack: true,
    safetyCounts: {
      before,
      after,
      unchanged:
        before.notificationEvents === after.notificationEvents &&
        before.deliveryConfirmations === after.deliveryConfirmations &&
        before.notificationAttempts === after.notificationAttempts,
    },
    result: diagnosticResult,
  };

  console.log(JSON.stringify(output, null, 2));

  if (!diagnosticResult) {
    throw new Error("Diagnostic did not produce a result.");
  }

  const failedScenarios = Object.entries(diagnosticResult.scenarios)
    .filter(([, scenario]) => !scenario.passed)
    .map(([scenario]) => scenario);
  if (failedScenarios.length > 0) {
    throw new Error(`Delivery group history diagnostic failed scenarios: ${failedScenarios.join(", ")}`);
  }

  if (!output.safetyCounts.unchanged) {
    throw new Error("Rollback diagnostic changed persistent notification/confirmation counts.");
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
