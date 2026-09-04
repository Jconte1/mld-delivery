import { dateKey } from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";

type CliOptions = {
  interval: string | null;
  runDate: string | null;
  take: number;
};

function readOption(args: string[], index: number, name: string) {
  const arg = args[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, nextIndex: index + 1 };
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    interval: null,
    runDate: null,
    take: 50,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const parsed = readOption(args, index, "--interval");
      options.interval = parsed.value.trim();
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--run-date" || arg.startsWith("--run-date=")) {
      const parsed = readOption(args, index, "--run-date");
      options.runDate = dateKey(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--take" || arg.startsWith("--take=")) {
      const parsed = readOption(args, index, "--take");
      const take = Number(parsed.value);
      if (!Number.isInteger(take) || take <= 0 || take > 500) {
        throw new Error("--take must be an integer from 1 to 500.");
      }
      options.take = take;
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const where = {
    ...(options.interval ? { interval: options.interval } : {}),
    ...(options.runDate ? { runDate: new Date(`${options.runDate}T00:00:00.000Z`) } : {}),
  };
  const rows = await prisma.deliveryIntervalSchedulerRun.findMany({
    where,
    orderBy: [{ startedAt: "desc" }],
    take: options.take,
    select: {
      id: true,
      lockKey: true,
      interval: true,
      runDate: true,
      timezone: true,
      expectedLocalTime: true,
      actualLocalTime: true,
      status: true,
      retryCount: true,
      startedAt: true,
      completedAt: true,
      failedAt: true,
      errorMessage: true,
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        filters: options,
        count: rows.length,
        rows: rows.map((row) => ({
          ...row,
          runDate: dateKey(row.runDate),
          startedAt: row.startedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
          failedAt: row.failedAt?.toISOString() ?? null,
          errorMessage: row.errorMessage ? row.errorMessage.slice(0, 500) : null,
        })),
        readOnly: true,
        sensitiveValuesPrinted: false,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          readOnly: true,
          sensitiveValuesPrinted: false,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
