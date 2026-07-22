import { mkdir, writeFile } from "fs/promises";
import path from "path";

import {
  DeliveryConfirmationStatus,
  InternalOrderLifecycleStatus,
  NotificationChannel,
  NotificationEventStatus,
} from "../lib/generated/prisma/client";
import { syncOrderDeliveryGroups } from "../lib/erp/syncOrderDeliveryGroups";
import {
  create42DayDeliveryConfirmationEvents,
  DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
  DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_IN_ACUMATICA_REASON,
  type DeliveryConfirmation42DayClient,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import { dateKey } from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type ScenarioResult = {
  passed: boolean;
  details: Record<string, unknown>;
};

type ValidationReport = {
  generatedAt: string;
  diagnosticRolledBack: boolean;
  runDate: string;
  targetDeliveryDate: string;
  method: string;
  sourceFindings: {
    alreadyConfirmedCheckLocation: string;
    alreadyConfirmedRunsBeforeChannelSelection: boolean;
    noChannelStillSeparate: boolean;
    ineligibleFilteringStillFirst: boolean;
    readinessRulesChanged: boolean;
    paymentRulesChanged: boolean;
    acumaticaConfirmationFieldsUsedAsSkipConditions: boolean;
  };
  firstRun: ReturnType<typeof summarizeRun>;
  secondRun: ReturnType<typeof summarizeRun>;
  scenarios: Record<string, ScenarioResult>;
  dedupe: {
    includesDeliveryDate: boolean;
    channelIncluded: boolean;
    rerunCreatedDuplicates: boolean;
  };
  safetyCounts: {
    before: Awaited<ReturnType<typeof safetyCounts>>;
    after: Awaited<ReturnType<typeof safetyCounts>>;
    unchanged: boolean;
  };
  reportPaths?: {
    json: string;
    markdown: string;
  };
};

class RollbackValidation extends Error {
  constructor(readonly report: ValidationReport) {
    super("rollback_42_day_real_world_scenario_validation");
  }
}

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function summarizeRun(run: Awaited<ReturnType<typeof create42DayDeliveryConfirmationEvents>>) {
  return {
    targetDeliveryGroups: run.targetDeliveryGroups,
    eligibleDeliveryGroups: run.eligibleDeliveryGroups,
    deliveryGroupsSkippedIneligible: run.deliveryGroupsSkippedIneligible,
    eventsCreated: run.eventsCreated,
    eventsDeduped: run.eventsDeduped,
    eventsSkipped: run.eventsSkipped,
    scheduledEvents: run.scheduledEvents,
    scheduledByChannel: run.scheduledByChannel,
    skippedReasons: run.skippedReasons,
    confirmationsCreatedOrReused: run.confirmationsCreatedOrReused,
    confirmationsCreated: run.confirmationsCreated,
    confirmationsReused: run.confirmationsReused,
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

function passed(...checks: boolean[]) {
  return checks.every(Boolean);
}

async function createFixture(params: {
  tx: Tx;
  unique: string;
  suffix: string;
  deliveryDate: Date;
  orderStatus?: string | null;
  groupStatus?: string | null;
  lifecycleStatus?: InternalOrderLifecycleStatus;
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
      email:
        params.email === undefined
          ? `${params.unique.toLowerCase()}-${params.suffix.toLowerCase()}@example.com`
          : params.email,
      phone1: params.phone1 === undefined ? "8015550100" : params.phone1,
      smsOptIn: params.smsOptIn ?? true,
      emailOptIn: params.emailOptIn ?? true,
    },
  });
  const order = await params.tx.order.create({
    data: {
      orderType: "TS",
      orderNumber: `${params.unique}-${params.suffix}`,
      status: params.orderStatus ?? "Open",
      internalLifecycleStatus: params.lifecycleStatus ?? InternalOrderLifecycleStatus.ACTIVE,
      customerDescription: "42-Day Scenario Validation",
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
      status: params.groupStatus ?? order.status,
      isActive: true,
      lineCount: 1,
      lastSeenAt: day("2099-01-01"),
      lastSyncedAt: day("2099-01-01"),
    },
  });

  return { contact, order, deliveryGroup };
}

async function createConfirmedDeliveryConfirmation(params: {
  tx: Tx;
  orderId: string;
  deliveryGroupId: string;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  contactId: string;
}) {
  return params.tx.deliveryConfirmation.create({
    data: {
      orderId: params.orderId,
      deliveryGroupId: params.deliveryGroupId,
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      deliveryDate: params.deliveryDate,
      contactId: params.contactId,
      status: DeliveryConfirmationStatus.CONFIRMED,
      responseChannel: NotificationChannel.SMS,
      confirmedAt: day("2098-12-31"),
    },
  });
}

function findByOrder<T extends { orderNumber: string }>(rows: T[], orderNumber: string) {
  return rows.find((row) => row.orderNumber === orderNumber);
}

function findConfirmation(
  confirmations: Array<{
    id: string;
    orderNumber: string;
    deliveryDate: Date;
    status: DeliveryConfirmationStatus;
    linkToken: string | null;
  }>,
  orderNumber: string,
  deliveryDate: Date
) {
  return confirmations.find(
    (confirmation) =>
      confirmation.orderNumber === orderNumber &&
      dateKey(confirmation.deliveryDate) === dateKey(deliveryDate)
  );
}

function markdownReport(report: ValidationReport) {
  const lines = [
    "# 42-Day Date-Specific Confirmation Validation",
    "",
    `Generated: ${report.generatedAt}`,
    `Run date: ${report.runDate}`,
    `Target delivery date: ${report.targetDeliveryDate}`,
    `Method: ${report.method}`,
    `Diagnostic rolled back: ${report.diagnosticRolledBack ? "yes" : "no"}`,
    "",
    "## A. What Qualifies",
    "",
    "- Active delivery groups whose delivery date equals runDate + 42 days are considered.",
    "- Completed/cancelled group/order statuses and blocked/manual-review lifecycle statuses are filtered before channel selection.",
    "- If eligible and not already confirmed for the same delivery group/date, SMS is preferred when available, then email.",
    "",
    "## B. What Disqualifies Before Channel Selection",
    "",
    "- Completed, canceled/cancelled, or closed order/group status.",
    "- Internal lifecycle status BLOCKED, MANUAL_REVIEW, COMPLETED, or CANCELLED.",
    "",
    "## C. What Creates A SKIPPED Event Instead Of SCHEDULED",
    "",
    "- Same deliveryGroupId + deliveryDate has DeliveryConfirmation.status = CONFIRMED.",
    "- Acumatica Document.AttributeCONFIRMVIA is populated.",
    "- No automated SMS/email channel is available.",
    "",
    "## D. Same-Date Already Confirmed",
    "",
    `- Passed: ${report.scenarios.sameDateAlreadyConfirmed.passed}`,
    `- Reason: ${String(report.scenarios.sameDateAlreadyConfirmed.details.reasonSkipped)}`,
    "",
    "## E. Old-Date Confirmed, New-Date Target",
    "",
    `- Passed: ${report.scenarios.oldDateConfirmedNewDate.passed}`,
    `- New date status: ${String(report.scenarios.oldDateConfirmedNewDate.details.newEventStatus)}`,
    "",
    "## F. No-Channel Behavior",
    "",
    `- Passed: ${report.scenarios.noAutomatedChannel.passed}`,
    `- Reason: ${String(report.scenarios.noAutomatedChannel.details.reasonSkipped)}`,
    "",
    "## G. Ineligible Orders",
    "",
    `- Passed: ${report.scenarios.ineligibleOrders.passed}`,
    `- Skipped before event creation: ${String(report.scenarios.ineligibleOrders.details.ineligibleSkippedCount)}`,
    "",
    "## H. Acumatica Confirmation Fields",
    "",
    "- CONFIRMVIA is stored as Order.confirmVia.",
    "- A non-empty CONFIRMVIA value skips only the 42-day confirmation request.",
    "- CONFIRMWTH / CONFIRMWITH do not control the skip.",
    "",
    "## I. Remaining Business Questions",
    "",
    "- If the exact same delivery date disappears and later reappears, current behavior reuses the same order/date delivery group. That means an existing confirmation for that same group/date still applies. Confirm this remains desired.",
    "",
    "## Scenario Results",
    "",
  ];

  for (const [name, scenario] of Object.entries(report.scenarios)) {
    lines.push(`### ${name}`, "");
    lines.push(`Passed: ${scenario.passed}`, "");
    lines.push("```json");
    lines.push(JSON.stringify(scenario.details, null, 2));
    lines.push("```", "");
  }

  lines.push("## Safety Counts", "");
  lines.push("```json");
  lines.push(JSON.stringify(report.safetyCounts, null, 2));
  lines.push("```", "");

  return lines.join("\n");
}

async function writeReports(report: ValidationReport) {
  await mkdir("reports", { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join("reports", `42-day-date-specific-real-world-validation-${stamp}.json`);
  const markdownPath = path.join(
    "reports",
    `42-day-date-specific-real-world-validation-${stamp}.md`
  );
  const reportWithPaths = {
    ...report,
    reportPaths: { json: jsonPath, markdown: markdownPath },
  };

  await writeFile(jsonPath, JSON.stringify(reportWithPaths, null, 2), "utf8");
  await writeFile(markdownPath, markdownReport(reportWithPaths), "utf8");

  return reportWithPaths;
}

async function main() {
  const before = await safetyCounts();
  const unique = `D42RW${Date.now()}`;
  const runDate = "2099-01-01";
  const targetDeliveryDate = day("2099-02-12");
  const oldDeliveryDate = day("2099-01-15");
  let report: ValidationReport | null = null;

  try {
    await prisma.$transaction(
      async (tx) => {
        const scenarioA = await createFixture({
          tx,
          unique,
          suffix: "A-NEW",
          deliveryDate: targetDeliveryDate,
        });

        const scenarioB = await createFixture({
          tx,
          unique,
          suffix: "B-CONFIRMED",
          deliveryDate: targetDeliveryDate,
        });
        const scenarioBConfirmation = await createConfirmedDeliveryConfirmation({
          tx,
          orderId: scenarioB.order.id,
          deliveryGroupId: scenarioB.deliveryGroup.id,
          orderType: scenarioB.order.orderType,
          orderNumber: scenarioB.order.orderNumber,
          deliveryDate: scenarioB.deliveryGroup.deliveryDate,
          contactId: scenarioB.contact.contactId,
        });

        const scenarioC = await createFixture({
          tx,
          unique,
          suffix: "C-MOVED",
          deliveryDate: targetDeliveryDate,
        });
        const scenarioCOldGroup = await tx.orderDeliveryGroup.create({
          data: {
            orderId: scenarioC.order.id,
            orderNumber: scenarioC.order.orderNumber,
            orderType: scenarioC.order.orderType,
            deliveryDate: oldDeliveryDate,
            status: scenarioC.order.status,
            isActive: false,
            supersededAt: day("2098-12-15"),
            supersededReason: "fixture_old_date_confirmed",
            lineCount: 1,
            lastSeenAt: day("2098-12-01"),
            lastSyncedAt: day("2098-12-15"),
          },
        });
        await createConfirmedDeliveryConfirmation({
          tx,
          orderId: scenarioC.order.id,
          deliveryGroupId: scenarioCOldGroup.id,
          orderType: scenarioC.order.orderType,
          orderNumber: scenarioC.order.orderNumber,
          deliveryDate: scenarioCOldGroup.deliveryDate,
          contactId: scenarioC.contact.contactId,
        });

        const scenarioD = await createFixture({
          tx,
          unique,
          suffix: "D-REAPPEAR",
          deliveryDate: targetDeliveryDate,
        });
        const originalScenarioDGroupId = scenarioD.deliveryGroup.id;
        await createConfirmedDeliveryConfirmation({
          tx,
          orderId: scenarioD.order.id,
          deliveryGroupId: scenarioD.deliveryGroup.id,
          orderType: scenarioD.order.orderType,
          orderNumber: scenarioD.order.orderNumber,
          deliveryDate: scenarioD.deliveryGroup.deliveryDate,
          contactId: scenarioD.contact.contactId,
        });
        await syncOrderDeliveryGroups(tx, {
          orderId: scenarioD.order.id,
          orderNumber: scenarioD.order.orderNumber,
          orderType: scenarioD.order.orderType,
          status: scenarioD.order.status,
          currentDeliveryGroups: [],
          importAt: day("2098-12-20"),
        });
        await syncOrderDeliveryGroups(tx, {
          orderId: scenarioD.order.id,
          orderNumber: scenarioD.order.orderNumber,
          orderType: scenarioD.order.orderType,
          status: scenarioD.order.status,
          currentDeliveryGroups: [{ deliveryDate: targetDeliveryDate, lineCount: 1 }],
          importAt: day("2098-12-21"),
        });
        const reappearedScenarioDGroup = await tx.orderDeliveryGroup.findUniqueOrThrow({
          where: {
            orderId_deliveryDate: {
              orderId: scenarioD.order.id,
              deliveryDate: targetDeliveryDate,
            },
          },
        });

        const scenarioF = await createFixture({
          tx,
          unique,
          suffix: "F-NOCHANNEL",
          deliveryDate: targetDeliveryDate,
          smsOptIn: false,
          emailOptIn: false,
          email: null,
          phone1: null,
        });
        const scenarioE = await createFixture({
          tx,
          unique,
          suffix: "E-ACUMATICA",
          deliveryDate: targetDeliveryDate,
          confirmVia: "WEBPAGE",
        });

        const ineligibleFixtures = [
          await createFixture({
            tx,
            unique,
            suffix: "G-COMPLETED",
            deliveryDate: targetDeliveryDate,
            orderStatus: "Completed",
          }),
          await createFixture({
            tx,
            unique,
            suffix: "G-CANCELLED",
            deliveryDate: targetDeliveryDate,
            groupStatus: "Cancelled",
          }),
          await createFixture({
            tx,
            unique,
            suffix: "G-BLOCKED",
            deliveryDate: targetDeliveryDate,
            lifecycleStatus: InternalOrderLifecycleStatus.BLOCKED,
          }),
          await createFixture({
            tx,
            unique,
            suffix: "G-MANUAL",
            deliveryDate: targetDeliveryDate,
            lifecycleStatus: InternalOrderLifecycleStatus.MANUAL_REVIEW,
          }),
        ];

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

        const allOrderNumbers = [
          scenarioA.order.orderNumber,
          scenarioB.order.orderNumber,
          scenarioC.order.orderNumber,
          scenarioD.order.orderNumber,
          scenarioE.order.orderNumber,
          scenarioF.order.orderNumber,
          ...ineligibleFixtures.map((fixture) => fixture.order.orderNumber),
        ];
        const events = await tx.notificationEvent.findMany({
          where: { orderNumber: { in: allOrderNumbers } },
          orderBy: { orderNumber: "asc" },
        });
        const confirmations = await tx.deliveryConfirmation.findMany({
          where: { orderNumber: { in: allOrderNumbers } },
          orderBy: [{ orderNumber: "asc" }, { deliveryDate: "asc" }],
        });
        const attempts = await tx.notificationAttempt.count({
          where: { notificationEventId: { in: events.map((event) => event.id) } },
        });

        const reportByOrder = new Map(
          firstRun.eventReports.map((eventReport) => [eventReport.orderNumber, eventReport])
        );
        const eventA = findByOrder(events, scenarioA.order.orderNumber);
        const eventB = findByOrder(events, scenarioB.order.orderNumber);
        const eventC = findByOrder(events, scenarioC.order.orderNumber);
        const eventD = findByOrder(events, scenarioD.order.orderNumber);
        const eventE = findByOrder(events, scenarioE.order.orderNumber);
        const eventF = findByOrder(events, scenarioF.order.orderNumber);
        const reportA = reportByOrder.get(scenarioA.order.orderNumber);
        const reportB = reportByOrder.get(scenarioB.order.orderNumber);
        const reportC = reportByOrder.get(scenarioC.order.orderNumber);
        const reportD = reportByOrder.get(scenarioD.order.orderNumber);
        const reportE = reportByOrder.get(scenarioE.order.orderNumber);
        const reportF = reportByOrder.get(scenarioF.order.orderNumber);
        const confirmationA = findConfirmation(
          confirmations,
          scenarioA.order.orderNumber,
          targetDeliveryDate
        );
        const confirmationB = findConfirmation(
          confirmations,
          scenarioB.order.orderNumber,
          targetDeliveryDate
        );
        const confirmationCOld = findConfirmation(
          confirmations,
          scenarioC.order.orderNumber,
          oldDeliveryDate
        );
        const confirmationCNew = findConfirmation(
          confirmations,
          scenarioC.order.orderNumber,
          targetDeliveryDate
        );
        const confirmationD = findConfirmation(
          confirmations,
          scenarioD.order.orderNumber,
          targetDeliveryDate
        );
        const confirmationE = findConfirmation(
          confirmations,
          scenarioE.order.orderNumber,
          targetDeliveryDate
        );
        const confirmationF = findConfirmation(
          confirmations,
          scenarioF.order.orderNumber,
          targetDeliveryDate
        );
        const ineligibleEvents = events.filter((event) =>
          ineligibleFixtures.some((fixture) => fixture.order.orderNumber === event.orderNumber)
        );

        const generatedAt = new Date().toISOString();
        const firstRunSummary = summarizeRun(firstRun);
        const secondRunSummary = summarizeRun(secondRun);

        report = {
          generatedAt,
          diagnosticRolledBack: true,
          runDate,
          targetDeliveryDate: dateKey(targetDeliveryDate),
          method:
            "Rollback-only representative fixtures executed through create42DayDeliveryConfirmationEvents.",
          sourceFindings: {
            alreadyConfirmedCheckLocation:
              "lib/notifications/create42DayDeliveryConfirmationEvents.ts before selectNotificationChannel",
            alreadyConfirmedRunsBeforeChannelSelection: true,
            noChannelStillSeparate: true,
            ineligibleFilteringStillFirst: true,
            readinessRulesChanged: false,
            paymentRulesChanged: false,
            acumaticaConfirmationFieldsUsedAsSkipConditions: true,
          },
          firstRun: firstRunSummary,
          secondRun: secondRunSummary,
          scenarios: {
            newTargetNoConfirmation: {
              passed: passed(
                eventA?.status === NotificationEventStatus.SCHEDULED,
                eventA?.selectedChannel === NotificationChannel.SMS,
                eventA?.reasonSkipped === null,
                reportA?.alreadyConfirmedForDeliveryDate === false,
                reportA?.linkTokenPresent === true,
                confirmationA?.status === DeliveryConfirmationStatus.PENDING,
                Boolean(confirmationA?.linkToken)
              ),
              details: {
                status: eventA?.status,
                selectedChannel: eventA?.selectedChannel,
                reasonSkipped: eventA?.reasonSkipped,
                scheduledAt: eventA?.scheduledAt?.toISOString() ?? null,
                alreadyConfirmedForDeliveryDate: reportA?.alreadyConfirmedForDeliveryDate,
                linkTokenPresent: reportA?.linkTokenPresent,
                confirmationStatus: confirmationA?.status,
                confirmationDeliveryDate: confirmationA ? dateKey(confirmationA.deliveryDate) : null,
              },
            },
            sameDateAlreadyConfirmed: {
              passed: passed(
                eventB?.status === NotificationEventStatus.SKIPPED,
                eventB?.reasonSkipped === DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
                eventB?.selectedChannel === null,
                eventB?.recipientEmail === null,
                eventB?.recipientPhone === null,
                eventB?.scheduledAt === null,
                reportB?.alreadyConfirmedForDeliveryDate === true,
                reportB?.linkTokenPresent === false,
                confirmationB?.status === DeliveryConfirmationStatus.CONFIRMED,
                confirmationB?.id === scenarioBConfirmation.id,
                confirmationB?.linkToken === null
              ),
              details: {
                status: eventB?.status,
                reasonSkipped: eventB?.reasonSkipped,
                selectedChannel: eventB?.selectedChannel,
                recipientEmail: eventB?.recipientEmail,
                recipientPhone: eventB?.recipientPhone,
                scheduledAt: eventB?.scheduledAt?.toISOString() ?? null,
                alreadyConfirmedForDeliveryDate: reportB?.alreadyConfirmedForDeliveryDate,
                linkTokenPresent: reportB?.linkTokenPresent,
                confirmationStatus: confirmationB?.status,
                confirmationDeliveryDate: confirmationB ? dateKey(confirmationB.deliveryDate) : null,
                confirmationLinkToken: confirmationB?.linkToken,
              },
            },
            oldDateConfirmedNewDate: {
              passed: passed(
                confirmationCOld?.status === DeliveryConfirmationStatus.CONFIRMED,
                dateKey(confirmationCOld?.deliveryDate ?? oldDeliveryDate) === dateKey(oldDeliveryDate),
                eventC?.status === NotificationEventStatus.SCHEDULED,
                eventC?.reasonSkipped !== DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
                eventC?.selectedChannel === NotificationChannel.SMS,
                reportC?.alreadyConfirmedForDeliveryDate === false,
                confirmationCNew?.status === DeliveryConfirmationStatus.PENDING,
                dateKey(confirmationCNew?.deliveryDate ?? targetDeliveryDate) ===
                  dateKey(targetDeliveryDate)
              ),
              details: {
                oldConfirmationStatus: confirmationCOld?.status,
                oldConfirmationDeliveryDate: confirmationCOld
                  ? dateKey(confirmationCOld.deliveryDate)
                  : null,
                newEventStatus: eventC?.status,
                newEventReasonSkipped: eventC?.reasonSkipped,
                newEventSelectedChannel: eventC?.selectedChannel,
                newReportAlreadyConfirmed: reportC?.alreadyConfirmedForDeliveryDate,
                newConfirmationStatus: confirmationCNew?.status,
                newConfirmationDeliveryDate: confirmationCNew
                  ? dateKey(confirmationCNew.deliveryDate)
                  : null,
              },
            },
            sameDateDisappearsAndReappears: {
              passed: passed(
                reappearedScenarioDGroup.id === originalScenarioDGroupId,
                reappearedScenarioDGroup.isActive === true,
                eventD?.status === NotificationEventStatus.SKIPPED,
                eventD?.reasonSkipped === DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
                reportD?.alreadyConfirmedForDeliveryDate === true,
                confirmationD?.status === DeliveryConfirmationStatus.CONFIRMED
              ),
              details: {
                originalDeliveryGroupId: originalScenarioDGroupId,
                reappearedDeliveryGroupId: reappearedScenarioDGroup.id,
                sameDeliveryGroupIdReused:
                  reappearedScenarioDGroup.id === originalScenarioDGroupId,
                isActiveAfterReappear: reappearedScenarioDGroup.isActive,
                confirmationStillApplied: confirmationD?.status === DeliveryConfirmationStatus.CONFIRMED,
                eventStatus: eventD?.status,
                reasonSkipped: eventD?.reasonSkipped,
                alreadyConfirmedForDeliveryDate: reportD?.alreadyConfirmedForDeliveryDate,
                businessRuleConfirmationPoint:
                  "Current behavior treats same deliveryGroupId + same deliveryDate as the same confirmation scope after reactivation.",
              },
            },
            acumaticaConfirmViaSkipped: {
              passed: passed(
                eventE?.status === NotificationEventStatus.SKIPPED,
                eventE?.reasonSkipped ===
                  DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_IN_ACUMATICA_REASON,
                eventE?.selectedChannel === null,
                eventE?.recipientEmail === null,
                eventE?.recipientPhone === null,
                eventE?.scheduledAt === null,
                reportE?.alreadyConfirmedInAcumatica === true,
                reportE?.acumaticaConfirmVia === "WEBPAGE",
                reportE?.alreadyConfirmedForDeliveryDate === false,
                reportE?.linkTokenPresent === false,
                confirmationE === undefined
              ),
              details: {
                status: eventE?.status,
                reasonSkipped: eventE?.reasonSkipped,
                selectedChannel: eventE?.selectedChannel,
                recipientEmail: eventE?.recipientEmail,
                recipientPhone: eventE?.recipientPhone,
                scheduledAt: eventE?.scheduledAt?.toISOString() ?? null,
                alreadyConfirmedInAcumatica: reportE?.alreadyConfirmedInAcumatica,
                acumaticaConfirmVia: reportE?.acumaticaConfirmVia,
                alreadyConfirmedForDeliveryDate: reportE?.alreadyConfirmedForDeliveryDate,
                linkTokenPresent: reportE?.linkTokenPresent,
                deliveryConfirmationCreated: Boolean(confirmationE),
              },
            },
            noAutomatedChannel: {
              passed: passed(
                eventF?.status === NotificationEventStatus.SKIPPED,
                eventF?.reasonSkipped === "no_automated_channel_available",
                eventF?.selectedChannel === null,
                eventF?.recipientEmail === null,
                eventF?.recipientPhone === null,
                eventF?.scheduledAt === null,
                reportF?.alreadyConfirmedForDeliveryDate === false,
                confirmationF === undefined
              ),
              details: {
                status: eventF?.status,
                reasonSkipped: eventF?.reasonSkipped,
                selectedChannel: eventF?.selectedChannel,
                recipientEmail: eventF?.recipientEmail,
                recipientPhone: eventF?.recipientPhone,
                scheduledAt: eventF?.scheduledAt?.toISOString() ?? null,
                alreadyConfirmedForDeliveryDate: reportF?.alreadyConfirmedForDeliveryDate,
                deliveryConfirmationCreated: Boolean(confirmationF),
              },
            },
            ineligibleOrders: {
              passed: passed(
                firstRun.deliveryGroupsSkippedIneligible === ineligibleFixtures.length,
                ineligibleEvents.length === 0
              ),
              details: {
                ineligibleFixtureCount: ineligibleFixtures.length,
                ineligibleSkippedCount: firstRun.deliveryGroupsSkippedIneligible,
                notificationEventsCreatedForIneligibleOrders: ineligibleEvents.length,
                orderNumbers: ineligibleFixtures.map((fixture) => fixture.order.orderNumber),
                behavior:
                  "Ineligible delivery groups are excluded before notification_event creation.",
              },
            },
            dedupeAndOutput: {
              passed: passed(
                firstRun.eventsCreated === 6,
                secondRun.eventsCreated === 0,
                secondRun.eventsDeduped === 6,
                events.length === 6,
                [eventA, eventB, eventC, eventD, eventE, eventF].every((event) =>
                  event?.dedupeKey.includes(dateKey(targetDeliveryDate))
                )
              ),
              details: {
                firstRunEventsCreated: firstRun.eventsCreated,
                secondRunEventsCreated: secondRun.eventsCreated,
                secondRunEventsDeduped: secondRun.eventsDeduped,
                notificationEventsForEligibleFixtures: events.length,
                dedupeKeys: [eventA, eventB, eventC, eventD, eventE, eventF].map(
                  (event) => event?.dedupeKey
                ),
                deliveryDateInDedupeKey: true,
                channelInDedupeKey: false,
                reportsIncludeAlreadyConfirmedForDeliveryDate: firstRun.eventReports.every(
                  (eventReport) =>
                    typeof eventReport.alreadyConfirmedForDeliveryDate === "boolean"
                ),
                reportsIncludeAlreadyConfirmedInAcumatica: firstRun.eventReports.every(
                  (eventReport) => typeof eventReport.alreadyConfirmedInAcumatica === "boolean"
                ),
              },
            },
            notificationAttemptsUntouched: {
              passed: attempts === 0,
              details: { notificationAttemptsForFixtureEvents: attempts },
            },
          },
          dedupe: {
            includesDeliveryDate: true,
            channelIncluded: false,
            rerunCreatedDuplicates: secondRun.eventsCreated > 0,
          },
          safetyCounts: {
            before,
            after: before,
            unchanged: true,
          },
        };

        throw new RollbackValidation(report);
      },
      { timeout: 30_000 }
    );
  } catch (error) {
    if (error instanceof RollbackValidation) {
      report = error.report;
    } else {
      throw error;
    }
  }

  const after = await safetyCounts();
  if (!report) {
    throw new Error("Validation did not produce a report.");
  }

  report.safetyCounts = {
    before,
    after,
    unchanged:
      before.notificationEvents === after.notificationEvents &&
      before.deliveryConfirmations === after.deliveryConfirmations &&
      before.notificationAttempts === after.notificationAttempts,
  };

  const failedScenarios = Object.entries(report.scenarios)
    .filter(([, scenario]) => !scenario.passed)
    .map(([scenario]) => scenario);

  const reportWithPaths = await writeReports(report);
  console.log(JSON.stringify(reportWithPaths, null, 2));

  if (failedScenarios.length > 0) {
    throw new Error(`42-day real-world scenario validation failed: ${failedScenarios.join(", ")}`);
  }

  if (!report.safetyCounts.unchanged) {
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
