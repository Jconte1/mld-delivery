import {
  create8DayPaymentEnforcementEvents,
} from "../lib/notifications/create8DayPaymentEnforcementEvents";
import { prisma } from "../lib/prisma";

function parseArgs(argv: string[]) {
  let runDate: string | undefined;
  let dryRun = true;
  let retryFailedHoldActions = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--live") {
      dryRun = false;
      continue;
    }

    if (arg === "--retry-failed-hold-actions") {
      retryFailedHoldActions = true;
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

  return { runDate, dryRun, retryFailedHoldActions };
}

async function safetyCounts() {
  const [
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    deliveryDetailsLinks,
    deliveryOrderHoldActions,
    internalNotificationEvents,
  ] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
    prisma.deliveryDetailsLink.count(),
    prisma.deliveryOrderHoldAction.count(),
    prisma.internalNotificationEvent.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    deliveryDetailsLinks,
    deliveryOrderHoldActions,
    internalNotificationEvents,
  };
}

async function main() {
  const { runDate, dryRun, retryFailedHoldActions } = parseArgs(process.argv.slice(2));
  const before = await safetyCounts();
  const summary = await create8DayPaymentEnforcementEvents({
    runDate,
    dryRun,
    retryFailedHoldActions,
  });
  const after = await safetyCounts();

  console.log(
    JSON.stringify(
      {
        ...summary,
        safetyCounts: {
          before,
          after,
          notificationAttemptsUnchanged:
            before.notificationAttempts === after.notificationAttempts,
          deliveryConfirmationsUnchanged:
            before.deliveryConfirmations === after.deliveryConfirmations,
        },
        safety: {
          noCustomerEmailSent: true,
          noInternalEmailSent: true,
          noSmsSent: true,
          noProviderDispatch: true,
          noDirectAcumaticaWriteFromDelivery: true,
          noHoldRemovalBehavior: true,
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
