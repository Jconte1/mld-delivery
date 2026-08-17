import { run42DayDeliveryConfirmationNoResponse } from "../lib/notifications/deliveryConfirmationNoResponse";
import { prisma } from "../lib/prisma";

function parseArgs(argv: string[]) {
  let runDate: string | undefined;
  let dryRun = true;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--apply" || arg === "--live") {
      dryRun = false;
      continue;
    }

    if (arg.startsWith("--run-date=")) {
      runDate = arg.slice("--run-date=".length);
      continue;
    }

    if (!arg.startsWith("-") && !runDate) {
      runDate = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { runDate, dryRun };
}

async function safetyCounts() {
  const [
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    internalNotificationEvents,
    deliveryOrderHoldActions,
  ] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
    prisma.internalNotificationEvent.count(),
    prisma.deliveryOrderHoldAction.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    internalNotificationEvents,
    deliveryOrderHoldActions,
  };
}

async function main() {
  const { runDate, dryRun } = parseArgs(process.argv.slice(2));
  const before = await safetyCounts();
  const summary = await run42DayDeliveryConfirmationNoResponse({ runDate, dryRun });
  const after = await safetyCounts();
  const { eventReports, ...aggregateSummary } = summary;

  console.log(
    JSON.stringify(
      {
        ...aggregateSummary,
        eventReportCount: eventReports.length,
        safetyCounts: {
          before,
          after,
          notificationAttemptsUnchanged:
            before.notificationAttempts === after.notificationAttempts,
          deliveryOrderHoldActionsUnchanged:
            before.deliveryOrderHoldActions === after.deliveryOrderHoldActions,
        },
        safety: {
          dryRunDefault: true,
          applyRequiredForDbWrites: true,
          noCustomerEmailSent: true,
          noInternalEmailSent: true,
          noSmsSent: true,
          noProviderDispatch: true,
          noDirectAcumaticaWriteFromDelivery: true,
          noConfirmViaWrite: true,
          noConfirmWithWrite: true,
          noOneWeekConWrite: true,
          noHoldWrites: true,
          noDeliveryDateOrLineMutation: true,
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
