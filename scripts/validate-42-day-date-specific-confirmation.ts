import {
  DeliveryConfirmationStatus,
  NotificationChannel,
  NotificationEventStatus,
} from "../lib/generated/prisma/client";
import {
  create42DayDeliveryConfirmationEvents,
  DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
  DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_IN_ACUMATICA_REASON,
  type DeliveryConfirmation42DayClient,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import { dateKey } from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";

type ScenarioResult = {
  passed: boolean;
  details: Record<string, unknown>;
};

type ValidationResult = {
  firstRun: {
    eventsCreated: number;
    eventsDeduped: number;
    eventsSkipped: number;
    scheduledEvents: number;
    scheduledByChannel: { SMS: number; EMAIL: number };
    skippedReasons: Record<string, number>;
  };
  secondRun: {
    eventsCreated: number;
    eventsDeduped: number;
    eventsSkipped: number;
    scheduledEvents: number;
    scheduledByChannel: { SMS: number; EMAIL: number };
    skippedReasons: Record<string, number>;
  };
  scenarios: Record<string, ScenarioResult>;
};

class RollbackValidation extends Error {
  constructor(readonly result: ValidationResult) {
    super("rollback_42_day_date_specific_confirmation_validation");
  }
}

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function summarizeRun(run: Awaited<ReturnType<typeof create42DayDeliveryConfirmationEvents>>) {
  return {
    eventsCreated: run.eventsCreated,
    eventsDeduped: run.eventsDeduped,
    eventsSkipped: run.eventsSkipped,
    scheduledEvents: run.scheduledEvents,
    scheduledByChannel: run.scheduledByChannel,
    skippedReasons: run.skippedReasons,
  };
}

async function safetyCounts() {
  const [notificationEvents, deliveryConfirmations, notificationAttempts] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.deliveryConfirmation.count(),
    prisma.notificationAttempt.count(),
  ]);

  return { notificationEvents, deliveryConfirmations, notificationAttempts };
}

function isPassed(...checks: boolean[]) {
  return checks.every(Boolean);
}

async function createFixture(params: {
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
  unique: string;
  suffix: string;
  deliveryDate: Date;
  smsOptIn?: boolean;
  emailOptIn?: boolean;
  email?: string | null;
  phone1?: string | null;
  confirmVia?: string | null;
}) {
  const contact = await params.tx.contact.create({
    data: {
      contactId: `${params.unique}-${params.suffix}-CONTACT`,
      displayName: `${params.suffix} Contact`,
      email: params.email ?? `${params.unique.toLowerCase()}-${params.suffix.toLowerCase()}@example.com`,
      phone1: params.phone1 ?? "8015550100",
      smsOptIn: params.smsOptIn ?? true,
      emailOptIn: params.emailOptIn ?? true,
    },
  });
  const order = await params.tx.order.create({
    data: {
      orderType: "TS",
      orderNumber: `${params.unique}-${params.suffix}`,
      status: "Open",
      customerDescription: "Date Specific Confirmation Fixture",
      locationDescription: params.suffix,
      contactId: contact.contactId,
      confirmVia: params.confirmVia ?? null,
    },
  });
  const deliveryGroup = await params.tx.orderDeliveryGroup.create({
    data: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderType: order.orderType,
      deliveryDate: params.deliveryDate,
      status: order.status,
      isActive: true,
      lineCount: 1,
      lastSeenAt: day("2099-01-01"),
      lastSyncedAt: day("2099-01-01"),
    },
  });

  return { contact, order, deliveryGroup };
}

async function main() {
  const before = await safetyCounts();
  const unique = `D42${Date.now()}`;
  const runDate = "2099-01-01";
  const targetDate = day("2099-02-12");
  const oldDate = day("2099-01-15");
  let validationResult: ValidationResult | null = null;

  try {
    await prisma.$transaction(
      async (tx) => {
        const sameDateConfirmed = await createFixture({
          tx,
          unique,
          suffix: "SAME",
          deliveryDate: targetDate,
        });
        await tx.deliveryConfirmation.create({
          data: {
            orderId: sameDateConfirmed.order.id,
            deliveryGroupId: sameDateConfirmed.deliveryGroup.id,
            orderType: sameDateConfirmed.order.orderType,
            orderNumber: sameDateConfirmed.order.orderNumber,
            deliveryDate: sameDateConfirmed.deliveryGroup.deliveryDate,
            contactId: sameDateConfirmed.contact.contactId,
            status: DeliveryConfirmationStatus.CONFIRMED,
            responseChannel: NotificationChannel.SMS,
            confirmedAt: day("2098-12-31"),
          },
        });

        const notConfirmed = await createFixture({
          tx,
          unique,
          suffix: "OPEN",
          deliveryDate: targetDate,
        });
        const acumaticaConfirmed = await createFixture({
          tx,
          unique,
          suffix: "ACU",
          deliveryDate: targetDate,
          confirmVia: "WEBPAGE",
        });

        const oldDateConfirmed = await createFixture({
          tx,
          unique,
          suffix: "OLD",
          deliveryDate: targetDate,
        });
        const oldGroup = await tx.orderDeliveryGroup.create({
          data: {
            orderId: oldDateConfirmed.order.id,
            orderNumber: oldDateConfirmed.order.orderNumber,
            orderType: oldDateConfirmed.order.orderType,
            deliveryDate: oldDate,
            status: oldDateConfirmed.order.status,
            isActive: false,
            supersededAt: day("2098-12-15"),
            supersededReason: "fixture_old_date",
            lineCount: 1,
            lastSeenAt: day("2098-12-01"),
            lastSyncedAt: day("2098-12-15"),
          },
        });
        await tx.deliveryConfirmation.create({
          data: {
            orderId: oldDateConfirmed.order.id,
            deliveryGroupId: oldGroup.id,
            orderType: oldDateConfirmed.order.orderType,
            orderNumber: oldDateConfirmed.order.orderNumber,
            deliveryDate: oldGroup.deliveryDate,
            contactId: oldDateConfirmed.contact.contactId,
            status: DeliveryConfirmationStatus.CONFIRMED,
            responseChannel: NotificationChannel.SMS,
            confirmedAt: day("2098-12-10"),
          },
        });

        const noChannel = await createFixture({
          tx,
          unique,
          suffix: "NOCH",
          deliveryDate: targetDate,
          smsOptIn: false,
          emailOptIn: false,
          email: null,
          phone1: null,
        });

        const client = tx as unknown as DeliveryConfirmation42DayClient;
        const firstRun = await create42DayDeliveryConfirmationEvents({
          runDate,
          now: day(runDate),
          prismaClient: client,
        });
        const secondRun = await create42DayDeliveryConfirmationEvents({
          runDate,
          now: day(runDate),
          prismaClient: client,
        });

        const orderNumbers = [
          sameDateConfirmed.order.orderNumber,
          notConfirmed.order.orderNumber,
          acumaticaConfirmed.order.orderNumber,
          oldDateConfirmed.order.orderNumber,
          noChannel.order.orderNumber,
        ];
        const events = await tx.notificationEvent.findMany({
          where: { orderNumber: { in: orderNumbers } },
          orderBy: { orderNumber: "asc" },
        });
        const confirmations = await tx.deliveryConfirmation.findMany({
          where: { orderNumber: { in: orderNumbers } },
          orderBy: [{ orderNumber: "asc" }, { deliveryDate: "asc" }],
        });
        const eventIds = events.map((event) => event.id);
        const notificationAttempts = await tx.notificationAttempt.count({
          where: { notificationEventId: { in: eventIds } },
        });

        const eventByOrder = new Map(events.map((event) => [event.orderNumber, event]));
        const reportByOrder = new Map(
          firstRun.eventReports.map((report) => [report.orderNumber, report])
        );
        const confirmationFor = (orderNumber: string, deliveryDate: Date) =>
          confirmations.find(
            (confirmation) =>
              confirmation.orderNumber === orderNumber &&
              dateKey(confirmation.deliveryDate) === dateKey(deliveryDate)
          );

        const sameEvent = eventByOrder.get(sameDateConfirmed.order.orderNumber);
        const sameReport = reportByOrder.get(sameDateConfirmed.order.orderNumber);
        const sameConfirmation = confirmationFor(
          sameDateConfirmed.order.orderNumber,
          targetDate
        );
        const openEvent = eventByOrder.get(notConfirmed.order.orderNumber);
        const openReport = reportByOrder.get(notConfirmed.order.orderNumber);
        const openConfirmation = confirmationFor(notConfirmed.order.orderNumber, targetDate);
        const acumaticaEvent = eventByOrder.get(acumaticaConfirmed.order.orderNumber);
        const acumaticaReport = reportByOrder.get(acumaticaConfirmed.order.orderNumber);
        const acumaticaConfirmation = confirmationFor(
          acumaticaConfirmed.order.orderNumber,
          targetDate
        );
        const oldEvent = eventByOrder.get(oldDateConfirmed.order.orderNumber);
        const oldReport = reportByOrder.get(oldDateConfirmed.order.orderNumber);
        const oldConfirmation = confirmationFor(oldDateConfirmed.order.orderNumber, oldDate);
        const newConfirmation = confirmationFor(oldDateConfirmed.order.orderNumber, targetDate);
        const noChannelEvent = eventByOrder.get(noChannel.order.orderNumber);
        const noChannelReport = reportByOrder.get(noChannel.order.orderNumber);

        validationResult = {
          firstRun: summarizeRun(firstRun),
          secondRun: summarizeRun(secondRun),
          scenarios: {
            sameDateConfirmedSkipped: {
              passed: isPassed(
                sameEvent?.status === NotificationEventStatus.SKIPPED,
                sameEvent?.reasonSkipped === DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
                sameEvent?.selectedChannel === null,
                sameEvent?.recipientEmail === null,
                sameEvent?.recipientPhone === null,
                sameEvent?.scheduledAt === null,
                sameReport?.alreadyConfirmedForDeliveryDate === true,
                sameReport?.alreadyConfirmedInAcumatica === false,
                sameReport?.acumaticaConfirmVia === null,
                sameReport?.linkTokenPresent === false,
                sameConfirmation?.status === DeliveryConfirmationStatus.CONFIRMED,
                sameConfirmation?.linkToken === null
              ),
              details: {
                status: sameEvent?.status,
                reasonSkipped: sameEvent?.reasonSkipped,
                selectedChannel: sameEvent?.selectedChannel,
                linkTokenPresent: sameReport?.linkTokenPresent,
                alreadyConfirmedForDeliveryDate: sameReport?.alreadyConfirmedForDeliveryDate,
                alreadyConfirmedInAcumatica: sameReport?.alreadyConfirmedInAcumatica,
                acumaticaConfirmVia: sameReport?.acumaticaConfirmVia,
                confirmationStatus: sameConfirmation?.status,
                confirmationLinkToken: sameConfirmation?.linkToken,
              },
            },
            notConfirmedNormalBehavior: {
              passed: isPassed(
                openEvent?.status === NotificationEventStatus.SCHEDULED,
                openEvent?.selectedChannel === NotificationChannel.SMS,
                openEvent?.reasonSkipped === null,
                openReport?.alreadyConfirmedForDeliveryDate === false,
                openReport?.alreadyConfirmedInAcumatica === false,
                openReport?.acumaticaConfirmVia === null,
                openReport?.linkTokenPresent === true,
                openConfirmation?.status === DeliveryConfirmationStatus.PENDING,
                Boolean(openConfirmation?.linkToken)
              ),
              details: {
                status: openEvent?.status,
                selectedChannel: openEvent?.selectedChannel,
                reasonSkipped: openEvent?.reasonSkipped,
                alreadyConfirmedForDeliveryDate: openReport?.alreadyConfirmedForDeliveryDate,
                alreadyConfirmedInAcumatica: openReport?.alreadyConfirmedInAcumatica,
                acumaticaConfirmVia: openReport?.acumaticaConfirmVia,
                confirmationStatus: openConfirmation?.status,
                linkTokenPresent: Boolean(openConfirmation?.linkToken),
              },
            },
            acumaticaConfirmViaSkipped: {
              passed: isPassed(
                acumaticaEvent?.status === NotificationEventStatus.SKIPPED,
                acumaticaEvent?.reasonSkipped ===
                  DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_IN_ACUMATICA_REASON,
                acumaticaEvent?.selectedChannel === null,
                acumaticaEvent?.recipientEmail === null,
                acumaticaEvent?.recipientPhone === null,
                acumaticaEvent?.scheduledAt === null,
                acumaticaReport?.alreadyConfirmedInAcumatica === true,
                acumaticaReport?.acumaticaConfirmVia === "WEBPAGE",
                acumaticaReport?.alreadyConfirmedForDeliveryDate === false,
                acumaticaReport?.linkTokenPresent === false,
                acumaticaConfirmation === undefined
              ),
              details: {
                status: acumaticaEvent?.status,
                reasonSkipped: acumaticaEvent?.reasonSkipped,
                selectedChannel: acumaticaEvent?.selectedChannel,
                recipientEmail: acumaticaEvent?.recipientEmail,
                recipientPhone: acumaticaEvent?.recipientPhone,
                scheduledAt: acumaticaEvent?.scheduledAt,
                alreadyConfirmedInAcumatica: acumaticaReport?.alreadyConfirmedInAcumatica,
                acumaticaConfirmVia: acumaticaReport?.acumaticaConfirmVia,
                alreadyConfirmedForDeliveryDate:
                  acumaticaReport?.alreadyConfirmedForDeliveryDate,
                linkTokenPresent: acumaticaReport?.linkTokenPresent,
                confirmationCreated: Boolean(acumaticaConfirmation),
              },
            },
            oldDateDoesNotBlockNewDate: {
              passed: isPassed(
                oldConfirmation?.status === DeliveryConfirmationStatus.CONFIRMED,
                dateKey(oldConfirmation?.deliveryDate ?? oldDate) === dateKey(oldDate),
                oldEvent?.status === NotificationEventStatus.SCHEDULED,
                oldEvent?.reasonSkipped !== DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
                oldReport?.alreadyConfirmedForDeliveryDate === false,
                oldReport?.alreadyConfirmedInAcumatica === false,
                newConfirmation?.status === DeliveryConfirmationStatus.PENDING,
                dateKey(newConfirmation?.deliveryDate ?? targetDate) === dateKey(targetDate)
              ),
              details: {
                oldConfirmationStatus: oldConfirmation?.status,
                oldConfirmationDeliveryDate: oldConfirmation
                  ? dateKey(oldConfirmation.deliveryDate)
                  : null,
                newEventStatus: oldEvent?.status,
                newEventReasonSkipped: oldEvent?.reasonSkipped,
                newReportAlreadyConfirmed: oldReport?.alreadyConfirmedForDeliveryDate,
                newReportAlreadyConfirmedInAcumatica: oldReport?.alreadyConfirmedInAcumatica,
                newConfirmationStatus: newConfirmation?.status,
                newConfirmationDeliveryDate: newConfirmation
                  ? dateKey(newConfirmation.deliveryDate)
                  : null,
              },
            },
            noChannelStillSkippedNormally: {
              passed: isPassed(
                noChannelEvent?.status === NotificationEventStatus.SKIPPED,
                noChannelEvent?.reasonSkipped === "no_automated_channel_available",
                noChannelReport?.alreadyConfirmedForDeliveryDate === false,
                noChannelReport?.alreadyConfirmedInAcumatica === false
              ),
              details: {
                status: noChannelEvent?.status,
                reasonSkipped: noChannelEvent?.reasonSkipped,
                alreadyConfirmedForDeliveryDate:
                  noChannelReport?.alreadyConfirmedForDeliveryDate,
                alreadyConfirmedInAcumatica: noChannelReport?.alreadyConfirmedInAcumatica,
              },
            },
            sameDateRerunDedupes: {
              passed: isPassed(
                firstRun.eventsCreated === 5,
                secondRun.eventsCreated === 0,
                secondRun.eventsDeduped === 5,
                events.length === 5
              ),
              details: {
                firstRunEventsCreated: firstRun.eventsCreated,
                secondRunEventsCreated: secondRun.eventsCreated,
                secondRunEventsDeduped: secondRun.eventsDeduped,
                notificationEventsForFixtures: events.length,
              },
            },
            noNotificationAttemptsCreated: {
              passed: notificationAttempts === 0,
              details: { notificationAttemptsForFixtureEvents: notificationAttempts },
            },
          },
        };

        throw new RollbackValidation(validationResult);
      },
      { timeout: 30_000 }
    );
  } catch (error) {
    if (error instanceof RollbackValidation) {
      validationResult = error.result;
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
    result: validationResult,
  };

  console.log(JSON.stringify(output, null, 2));

  if (!validationResult) {
    throw new Error("Validation did not produce a result.");
  }

  const failedScenarios = Object.entries(validationResult.scenarios)
    .filter(([, scenario]) => !scenario.passed)
    .map(([scenario]) => scenario);
  if (failedScenarios.length > 0) {
    throw new Error(`42-day date-specific validation failed: ${failedScenarios.join(", ")}`);
  }

  if (!output.safetyCounts.unchanged) {
    throw new Error("Rollback validation changed persistent notification/confirmation counts.");
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
