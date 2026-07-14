import { create90DayDeliveryReminderEvents } from "../lib/notifications/create90DayDeliveryReminderEvents";
import { prisma } from "../lib/prisma";

function parseArgs(argv: string[]) {
  let runDate: string | undefined;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg.startsWith("--run-date=")) {
      runDate = arg.slice("--run-date=".length);
      continue;
    }

    if (!arg.startsWith("-") && !runDate) {
      runDate = arg;
    }
  }

  return { runDate, dryRun };
}

async function main() {
  const { runDate, dryRun } = parseArgs(process.argv.slice(2));
  const summary = await create90DayDeliveryReminderEvents({ runDate, dryRun });
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
