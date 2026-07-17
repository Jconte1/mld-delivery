import { DeliveryConfirmationStatus } from "../lib/generated/prisma/client";
import { confirmDeliveryFromWebpage } from "../lib/notifications/confirmDeliveryFromWebpage";
import { dateKey } from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";

type Args = {
  token?: string;
  deliveryConfirmationId?: string;
  realRecord: boolean;
  forceResetFixture: boolean;
};

class RollbackValidation extends Error {
  constructor(readonly output: Record<string, unknown>) {
    super("rollback_webpage_confirmation_writeback_validation");
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    realRecord: false,
    forceResetFixture: false,
  };

  for (const arg of argv) {
    if (arg === "--real-record") args.realRecord = true;
    else if (arg === "--force-reset-fixture") args.forceResetFixture = true;
    else if (arg.startsWith("--token=")) args.token = arg.slice("--token=".length).trim();
    else if (arg.startsWith("--delivery-confirmation-id=")) {
      args.deliveryConfirmationId = arg.slice("--delivery-confirmation-id=".length).trim();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if ((args.token || args.deliveryConfirmationId) && !args.realRecord) {
    throw new Error("--real-record is required when using --token or --delivery-confirmation-id");
  }

  return args;
}

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

async function safetyCounts() {
  const [notificationAttempts, deliveryConfirmations] = await Promise.all([
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
  ]);

  return { notificationAttempts, deliveryConfirmations };
}

function assert(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

function mockQueueFetch(requests: Array<{ url: string; payload: Record<string, unknown> }>) {
  return async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      payload: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });

    return new Response(JSON.stringify({ jobId: "mock-confirmation-writeback-job" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
}

async function validateFixtureMode() {
  const before = await safetyCounts();
  const unique = `WBC${Date.now()}`;
  const linkToken = `token-${unique}`;
  const requests: Array<{ url: string; payload: Record<string, unknown> }> = [];
  let output: Record<string, unknown> | null = null;

  try {
    await prisma.$transaction(
      async (tx) => {
        const contact = await tx.contact.create({
          data: {
            contactId: `${unique}-CONTACT`,
            displayName: null,
            companyName: "Fixture Company",
            firstName: "Fallback",
            lastName: "Name",
            email: "fixture@example.com",
            smsOptIn: true,
            emailOptIn: true,
          },
        });
        const order = await tx.order.create({
          data: {
            orderType: "TS",
            orderNumber: `${unique}-ORDER`,
            status: "Open",
            customerDescription: "Webpage Confirmation Fixture",
            locationDescription: "Dry Run",
            contactId: contact.contactId,
          },
        });
        const deliveryGroup = await tx.orderDeliveryGroup.create({
          data: {
            orderId: order.id,
            orderType: order.orderType,
            orderNumber: order.orderNumber,
            deliveryDate: day("2099-02-12"),
            status: order.status,
            isActive: true,
            lineCount: 1,
          },
        });
        const confirmation = await tx.deliveryConfirmation.create({
          data: {
            orderId: order.id,
            deliveryGroupId: deliveryGroup.id,
            orderType: order.orderType,
            orderNumber: order.orderNumber,
            deliveryDate: deliveryGroup.deliveryDate,
            contactId: contact.contactId,
            status: DeliveryConfirmationStatus.PENDING,
            linkToken,
          },
        });
        const original = {
          deliveryGroupId: confirmation.deliveryGroupId,
          deliveryDate: dateKey(confirmation.deliveryDate),
        };

        const result = await confirmDeliveryFromWebpage({
          linkToken,
          prismaClient: tx,
          now: day("2099-01-01"),
          queueOptions: {
            baseUrl: "http://mld-queue.local.test",
            token: "test-token",
            fetchImpl: mockQueueFetch(requests),
          },
        });
        const persisted = await tx.deliveryConfirmation.findUniqueOrThrow({
          where: { id: confirmation.id },
          select: {
            id: true,
            status: true,
            confirmedAt: true,
            deliveryGroupId: true,
            deliveryDate: true,
            requestedNewDate: true,
          },
        });
        const attempts = await tx.notificationAttempt.count();

        assert(result.outcome === "confirmed", "Expected helper to confirm fixture");
        assert(persisted.status === DeliveryConfirmationStatus.CONFIRMED, "status must be CONFIRMED");
        assert(Boolean(persisted.confirmedAt), "confirmedAt must be set");
        assert(persisted.deliveryGroupId === original.deliveryGroupId, "deliveryGroupId changed");
        assert(dateKey(persisted.deliveryDate) === original.deliveryDate, "deliveryDate changed");
        assert(persisted.requestedNewDate === null, "requested-different-date path was used");
        assert(result.writeback?.payload.confirmedWith === "Fixture Company", "confirmedWith fallback failed");
        assert(result.writeback?.payload.confirmedVia === "WEBPAGE", "confirmedVia must be WEBPAGE");
        assert(result.writeback?.payload.dryRun === true, "dryRun must be true");
        assert(result.writeback?.jobId === "mock-confirmation-writeback-job", "queue job id missing");
        assert(result.writeback?.error === null, "queue enqueue error was not expected");
        assert(requests.length === 1, "expected one queue request");
        assert(
          requests[0].url.endsWith("/api/erp/jobs/delivery/confirmation-attributes"),
          "helper did not call the mld-queue confirmation-attributes route"
        );
        assert(!/acumatica/i.test(requests[0].url), "delivery helper called an Acumatica-looking URL");
        assert(attempts === before.notificationAttempts, "notification_attempts changed");

        output = {
          mode: "rollback_fixture",
          diagnosticRolledBack: true,
          confirmationState: {
            id: persisted.id,
            status: persisted.status,
            confirmedAtSet: Boolean(persisted.confirmedAt),
            deliveryGroupIdPreserved: persisted.deliveryGroupId === original.deliveryGroupId,
            deliveryDatePreserved: dateKey(persisted.deliveryDate) === original.deliveryDate,
            requestedDifferentDatePathUsed: Boolean(persisted.requestedNewDate),
          },
          queuePayload: result.writeback?.payload,
          queueRequest: {
            url: requests[0].url,
            payload: requests[0].payload,
          },
          queueResult: {
            jobId: result.writeback?.jobId,
            error: result.writeback?.error,
          },
          assertions: {
            confirmedWithFallback: "companyName",
            noNotificationAttemptsCreated: true,
            deliveryCalledMldQueueRouteOnly: true,
          },
        };

        throw new RollbackValidation(output);
      },
      { timeout: 30_000 }
    );
  } catch (error) {
    if (error instanceof RollbackValidation) {
      output = error.output;
    } else {
      throw error;
    }
  }

  const after = await safetyCounts();
  assert(
    before.notificationAttempts === after.notificationAttempts &&
      before.deliveryConfirmations === after.deliveryConfirmations,
    "rollback fixture changed persistent counts"
  );

  return {
    ...output,
    safetyCounts: {
      before,
      after,
      unchanged: true,
    },
  };
}

async function findRealRecordToken(args: Args) {
  if (args.token) return args.token;
  if (!args.deliveryConfirmationId) {
    throw new Error("--token or --delivery-confirmation-id is required with --real-record");
  }

  const confirmation = await prisma.deliveryConfirmation.findUnique({
    where: { id: args.deliveryConfirmationId },
    select: { linkToken: true },
  });
  if (!confirmation?.linkToken) {
    throw new Error(`DeliveryConfirmation ${args.deliveryConfirmationId} does not have a linkToken`);
  }
  return confirmation.linkToken;
}

async function validateRealRecordMode(args: Args) {
  const token = await findRealRecordToken(args);
  const before = await safetyCounts();
  const existing = await prisma.deliveryConfirmation.findUnique({
    where: { linkToken: token },
    select: {
      id: true,
      status: true,
      confirmedAt: true,
      deliveryGroupId: true,
      deliveryDate: true,
    },
  });

  if (!existing) throw new Error("No DeliveryConfirmation found for token");
  if (
    (existing.status === DeliveryConfirmationStatus.CONFIRMED ||
      existing.status === DeliveryConfirmationStatus.NEW_DATE_REQUESTED) &&
    !args.forceResetFixture
  ) {
    return {
      mode: "real_record",
      stopped: true,
      reason: "DeliveryConfirmation is already final; rerun with --force-reset-fixture if you intentionally want to reset this record first.",
      confirmation: {
        id: existing.id,
        status: existing.status,
        confirmedAtSet: Boolean(existing.confirmedAt),
        deliveryGroupId: existing.deliveryGroupId,
        deliveryDate: dateKey(existing.deliveryDate),
      },
      safetyCounts: {
        before,
        after: await safetyCounts(),
      },
    };
  }

  if (args.forceResetFixture) {
    await prisma.deliveryConfirmation.update({
      where: { id: existing.id },
      data: {
        status: DeliveryConfirmationStatus.PENDING,
        confirmedAt: null,
        responseChannel: null,
        rawResponse: null,
        normalizedResponse: null,
      },
    });
  }

  const result = await confirmDeliveryFromWebpage({ linkToken: token });
  const afterConfirmation = await prisma.deliveryConfirmation.findUniqueOrThrow({
    where: { id: existing.id },
    select: {
      id: true,
      status: true,
      confirmedAt: true,
      deliveryGroupId: true,
      deliveryDate: true,
      requestedNewDate: true,
    },
  });
  const after = await safetyCounts();

  assert(result.outcome === "confirmed", "Expected real record to be confirmed");
  assert(afterConfirmation.status === DeliveryConfirmationStatus.CONFIRMED, "status must be CONFIRMED");
  assert(Boolean(afterConfirmation.confirmedAt), "confirmedAt must be set");
  assert(afterConfirmation.deliveryGroupId === existing.deliveryGroupId, "deliveryGroupId changed");
  assert(dateKey(afterConfirmation.deliveryDate) === dateKey(existing.deliveryDate), "deliveryDate changed");
  assert(after.notificationAttempts === before.notificationAttempts, "notification_attempts changed");

  return {
    mode: "real_record",
    warning: "This mode permanently confirms the selected DeliveryConfirmation.",
    confirmationState: {
      id: afterConfirmation.id,
      status: afterConfirmation.status,
      confirmedAtSet: Boolean(afterConfirmation.confirmedAt),
      deliveryGroupIdPreserved: afterConfirmation.deliveryGroupId === existing.deliveryGroupId,
      deliveryDatePreserved:
        dateKey(afterConfirmation.deliveryDate) === dateKey(existing.deliveryDate),
      requestedDifferentDatePathUsed: Boolean(afterConfirmation.requestedNewDate),
    },
    queuePayload: result.outcome === "confirmed" ? result.writeback.payload : null,
    queueResult:
      result.outcome === "confirmed"
        ? { jobId: result.writeback.jobId, error: result.writeback.error }
        : null,
    safetyCounts: {
      before,
      after,
      notificationAttemptsUnchanged: before.notificationAttempts === after.notificationAttempts,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = args.realRecord ? await validateRealRecordMode(args) : await validateFixtureMode();
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
