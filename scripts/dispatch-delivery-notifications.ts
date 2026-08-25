import { NotificationIntervalType } from "../lib/generated/prisma/client";
import {
  dispatchDeliveryNotifications,
  type DispatcherChannelFilter,
} from "../lib/notifications/deliveryNotificationDispatcher";
import { prisma } from "../lib/prisma";

type CliOptions = {
  preview: boolean;
  send: boolean;
  controlledRecipientSend: boolean;
  testRunId: string | null;
  interval: NotificationIntervalType | null;
  limit: number | null;
  channel: DispatcherChannelFilter;
  eventId: string | null;
  confirmPhrase: string | null;
};

function readOption(args: string[], index: number, name: string) {
  const arg = args[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function parseInterval(value: string) {
  const normalized = value.trim().toUpperCase();
  const enumValue = normalized.startsWith("DAY_") ? normalized : `DAY_${normalized}`;
  if (!Object.values(NotificationIntervalType).includes(enumValue as NotificationIntervalType)) {
    throw new Error(`Unsupported interval: ${value}`);
  }
  return enumValue as NotificationIntervalType;
}

function parseChannel(value: string): DispatcherChannelFilter {
  const normalized = value.trim().toLowerCase();
  if (normalized === "sms" || normalized === "email" || normalized === "both") {
    return normalized;
  }
  throw new Error(`Unsupported channel: ${value}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    preview: true,
    send: false,
    controlledRecipientSend: false,
    testRunId: null,
    interval: null,
    limit: null,
    channel: "both",
    eventId: null,
    confirmPhrase: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--preview") {
      options.preview = true;
      options.send = false;
      continue;
    }
    if (arg === "--send") {
      options.send = true;
      options.preview = false;
      continue;
    }
    if (arg === "--controlled-recipient-send") {
      options.controlledRecipientSend = true;
      continue;
    }
    if (arg === "--test-run-id" || arg.startsWith("--test-run-id=")) {
      const parsed = readOption(args, index, "--test-run-id");
      options.testRunId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const parsed = readOption(args, index, "--interval");
      options.interval = parseInterval(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = readOption(args, index, "--limit");
      const limit = Number(parsed.value);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer: ${parsed.value}`);
      }
      options.limit = limit;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--channel" || arg.startsWith("--channel=")) {
      const parsed = readOption(args, index, "--channel");
      options.channel = parseChannel(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--event-id" || arg.startsWith("--event-id=")) {
      const parsed = readOption(args, index, "--event-id");
      options.eventId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      const parsed = readOption(args, index, "--confirm");
      options.confirmPhrase = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const beforeAttempts = await prisma.notificationAttempt.count();
  const summary = await dispatchDeliveryNotifications({
    preview: options.preview,
    send: options.send,
    controlledRecipientSend: options.controlledRecipientSend,
    testRunId: options.testRunId,
    interval: options.interval,
    limit: options.limit,
    channel: options.channel,
    eventId: options.eventId,
    confirmPhrase: options.confirmPhrase,
  });
  const afterAttempts = await prisma.notificationAttempt.count();

  console.log(
    JSON.stringify(
      {
        ...summary,
        safetyCounts: {
          notificationAttemptsBefore: beforeAttempts,
          notificationAttemptsAfter: afterAttempts,
          notificationAttemptsCreated: afterAttempts - beforeAttempts,
          previewCreatedNoAttempts: summary.preview && beforeAttempts === afterAttempts,
        },
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
