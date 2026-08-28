import {
  InternalNotificationPurpose,
  InternalNotificationStatus,
} from "../lib/generated/prisma/client";
import { dateKey } from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";

type CliOptions = {
  runDate: string | null;
  limit: number;
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
    runDate: null,
    limit: 50,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run-date" || arg.startsWith("--run-date=")) {
      const parsed = readOption(args, index, "--run-date");
      options.runDate = dateKey(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = readOption(args, index, "--limit");
      const limit = Number(parsed.value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new Error("--limit must be an integer from 1 to 500.");
      }
      options.limit = limit;
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function redactEmail(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return "<redacted-email>";
  return `${local.slice(0, 1)}***@${domain}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const where = {
    purpose: InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE,
    ...(options.runDate ? { createdAt: { gte: new Date(`${options.runDate}T00:00:00.000Z`) } } : {}),
  };
  const [pending, skipped, failed, sent, rows] = await Promise.all([
    prisma.internalNotificationEvent.count({
      where: { ...where, status: InternalNotificationStatus.PENDING },
    }),
    prisma.internalNotificationEvent.count({
      where: { ...where, status: InternalNotificationStatus.SKIPPED },
    }),
    prisma.internalNotificationEvent.count({
      where: { ...where, status: InternalNotificationStatus.FAILED },
    }),
    prisma.internalNotificationEvent.count({
      where: { ...where, status: InternalNotificationStatus.SENT },
    }),
    prisma.internalNotificationEvent.findMany({
      where: {
        ...where,
        status: { in: [InternalNotificationStatus.PENDING, InternalNotificationStatus.SKIPPED] },
      },
      orderBy: [{ createdAt: "desc" }],
      take: options.limit,
      select: {
        id: true,
        orderType: true,
        orderNumber: true,
        deliveryDate: true,
        audienceType: true,
        recipientEmail: true,
        recipientName: true,
        subject: true,
        status: true,
        reasonSkipped: true,
        createdAt: true,
      },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        purpose: InternalNotificationPurpose.DELIVERY_CONFIRMATION_NO_RESPONSE,
        runDateFilter: options.runDate,
        counts: { pending, skipped, failed, sent },
        reviewQueue: rows.map((row) => ({
          id: row.id,
          order: `${row.orderType} ${row.orderNumber}`,
          deliveryDate: dateKey(row.deliveryDate),
          audienceType: row.audienceType,
          recipientEmailMasked: redactEmail(row.recipientEmail),
          recipientNamePresent: Boolean(row.recipientName),
          subject: row.subject,
          status: row.status,
          reasonSkipped: row.reasonSkipped,
          createdAt: row.createdAt.toISOString(),
        })),
        sendsPerformed: 0,
        acumaticaWritesPerformed: 0,
        sensitiveValuesPrinted: false,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
