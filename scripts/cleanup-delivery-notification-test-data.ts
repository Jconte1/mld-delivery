import { prisma } from "../lib/prisma";

type CliOptions = {
  apply: boolean;
  confirmPhrase: string | null;
  testRunIds: string[];
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    confirmPhrase: null,
    testRunIds: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--preview") continue;
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      const parsed = readOption(args, index, "--confirm");
      options.confirmPhrase = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--test-run-id" || arg.startsWith("--test-run-id=")) {
      const parsed = readOption(args, index, "--test-run-id");
      options.testRunIds.push(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const expectedConfirmPhrase =
    process.env.DELIVERY_NOTIFICATION_TEST_DATA_CLEANUP_CONFIRM_PHRASE?.trim() ?? "";

  if (options.apply) {
    if (!expectedConfirmPhrase) {
      throw new Error("Apply requires DELIVERY_NOTIFICATION_TEST_DATA_CLEANUP_CONFIRM_PHRASE.");
    }
    if (options.confirmPhrase !== expectedConfirmPhrase) {
      throw new Error("Cleanup confirmation phrase did not match.");
    }

    throw new Error("Cleanup apply is intentionally disabled in this production-readiness phase.");
  }

  const controlledAttemptWhere = {
    OR: [
      { controlledRecipientMode: true },
      { testRunId: { startsWith: "controlled_" } },
      ...options.testRunIds.map((testRunId) => ({ testRunId })),
    ],
  };

  const controlledAttempts = await prisma.notificationAttempt.findMany({
    where: controlledAttemptWhere,
    select: {
      id: true,
      notificationEventId: true,
      testRunId: true,
      channel: true,
      status: true,
    },
  });
  const controlledEventIds = Array.from(
    new Set(controlledAttempts.map((attempt) => attempt.notificationEventId))
  );

  const [
    controlledEvents,
    live42Events,
    live42Confirmations,
    controlledCallbacks,
    live42Callbacks,
    live42Inbound,
    controlledHoldActions,
  ] = await Promise.all([
    controlledEventIds.length
      ? prisma.notificationEvent.count({ where: { id: { in: controlledEventIds } } })
      : Promise.resolve(0),
    prisma.notificationEvent.count({ where: { orderNumber: { startsWith: "LIVE42-" } } }),
    prisma.deliveryConfirmation.count({ where: { id: { startsWith: "live42_" } } }),
    controlledEventIds.length
      ? prisma.twilioMessageStatusCallback.count({
          where: { notificationEventId: { in: controlledEventIds } },
        })
      : Promise.resolve(0),
    prisma.twilioMessageStatusCallback.count({
      where: { deliveryConfirmationId: { startsWith: "live42_" } },
    }),
    prisma.twilioInboundMessage.count({
      where: { deliveryConfirmationId: { startsWith: "live42_" } },
    }),
    controlledEventIds.length
      ? prisma.deliveryOrderHoldAction.count({
          where: { customerNotificationEventId: { in: controlledEventIds } },
        })
      : Promise.resolve(0),
  ]);

  const attemptsByStatus = controlledAttempts.reduce<Record<string, number>>((acc, attempt) => {
    const key = `${attempt.channel}:${attempt.status}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    JSON.stringify(
      {
        mode: "preview",
        applySupportedThisPhase: false,
        sensitiveValuesPrinted: false,
        testRunIdFilters: options.testRunIds,
        candidates: {
          controlledNotificationAttempts: controlledAttempts.length,
          controlledNotificationEvents: controlledEvents,
          live42NotificationEvents: live42Events,
          live42DisposableConfirmations: live42Confirmations,
          controlledTwilioCallbacks: controlledCallbacks,
          live42TwilioCallbacks: live42Callbacks,
          live42TwilioInboundMessages: live42Inbound,
          controlledDeliveryOrderHoldActions: controlledHoldActions,
        },
        attemptsByStatus,
        requiredBeforeAnyFutureApply: [
          "fresh database backup/export",
          "explicit testRunId or fixture filters",
          "confirmation phrase",
          "review of candidate IDs before deletion",
        ],
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
