import { create42DayDeliveryConfirmationEvents } from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import { prisma } from "../lib/prisma";

function parseArgs(argv: string[]) {
  let runDate: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--run-date=")) {
      runDate = arg.slice("--run-date=".length);
      continue;
    }

    if (!arg.startsWith("-") && !runDate) {
      runDate = arg;
    }
  }

  return { runDate };
}

async function safetyCounts() {
  const [
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    smsOptOuts,
    emailOptOuts,
  ] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
    prisma.smsOptOut.count(),
    prisma.emailOptOut.count(),
  ]);

  return {
    notificationEvents,
    notificationAttempts,
    deliveryConfirmations,
    smsOptOuts,
    emailOptOuts,
  };
}

async function main() {
  const { runDate } = parseArgs(process.argv.slice(2));
  const before = await safetyCounts();
  const summary = await create42DayDeliveryConfirmationEvents({ runDate });
  const after = await safetyCounts();

  console.log(
    JSON.stringify(
      {
        ...summary,
        eventReports: summary.eventReports,
        safetyCounts: {
          before,
          after,
          notificationAttemptsUnchanged:
            before.notificationAttempts === after.notificationAttempts,
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
