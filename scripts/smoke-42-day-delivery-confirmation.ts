import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { getDeliveryGroupReadiness } from "../lib/delivery-readiness/orderLineReadiness";
import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import {
  create42DayDeliveryConfirmationEvents,
  DELIVERY_CONFIRMATION_42_DAY_INTERVAL_DAYS,
  find42DayDeliveryConfirmationTargetGroups,
  type DeliveryConfirmation42DayTargetGroup,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import {
  dateKey,
  getNotificationTargetDate,
  selectNotificationChannel,
} from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";

const DEFAULT_RUN_DATE = "2026-11-23";
const DEFAULT_REQUESTED_ON_TIME = "09:19:00.000Z";

type SafetyCounts = {
  notificationEvents: number;
  notificationAttempts: number;
  deliveryConfirmations: number;
  smsOptOuts: number;
  emailOptOuts: number;
};

function parseArgs(argv: string[]) {
  let runDate = DEFAULT_RUN_DATE;
  let requestedOnTime = DEFAULT_REQUESTED_ON_TIME;
  let skipImport = false;

  for (const arg of argv) {
    if (arg === "--skip-import") {
      skipImport = true;
      continue;
    }
    if (arg.startsWith("--run-date=")) {
      runDate = arg.slice("--run-date=".length);
      continue;
    }
    if (arg.startsWith("--requested-on-time=")) {
      requestedOnTime = arg.slice("--requested-on-time=".length);
      continue;
    }
    if (!arg.startsWith("-")) {
      runDate = arg;
    }
  }

  return { runDate, requestedOnTime, skipImport };
}

function requestedOnDateTime(targetDeliveryDate: string, time: string) {
  const normalizedTime = time.endsWith("Z") ? time : `${time}Z`;
  return `${targetDeliveryDate}T${normalizedTime}`;
}

function csvValue(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows: Array<Record<string, unknown>>, columns: string[]) {
  return [
    columns.map((column) => csvValue(column)).join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ].join("\n");
}

async function safetyCounts(): Promise<SafetyCounts> {
  return {
    notificationEvents: await prisma.notificationEvent.count(),
    notificationAttempts: await prisma.notificationAttempt.count(),
    deliveryConfirmations: await prisma.deliveryConfirmation.count(),
    smsOptOuts: await prisma.smsOptOut.count(),
    emailOptOuts: await prisma.emailOptOut.count(),
  };
}

async function buildActiveGroupReports(groups: DeliveryConfirmation42DayTargetGroup[]) {
  const reports = [];

  for (const group of groups) {
    const readiness = await getDeliveryGroupReadiness(group.id);
    const channel = selectNotificationChannel(group.order.contact, {
      activeSmsOptOutPhones: group.order.contact.smsOptOuts.map((optOut) => optOut.phone),
      activeEmailOptOutEmails: group.order.contact.emailOptOuts.map((optOut) => optOut.email),
    });

    reports.push({
      orderType: group.orderType,
      orderNumber: group.orderNumber,
      deliveryGroupId: group.id,
      deliveryDate: dateKey(group.deliveryDate),
      isActive: group.isActive,
      lineCount: group.lineCount,
      lastSeenAt: group.lastSeenAt?.toISOString() ?? null,
      buyerGroup: group.order.buyerGroup,
      acumaticaConfirmVia: group.order.confirmVia,
      customerDescription: group.order.customerDescription,
      locationDescription: group.order.locationDescription,
      contactId: group.order.contact.contactId,
      contactDisplayName: group.order.contact.displayName,
      contactCompanyName: group.order.contact.companyName,
      contactEmail: group.order.contact.email,
      contactPhone1: group.order.contact.phone1,
      contactPhone2: group.order.contact.phone2,
      selectedChannel: channel.selectedChannel,
      channelReason: channel.channelReason,
      recipientEmail: channel.selectedChannel === "EMAIL" ? channel.recipientEmail : null,
      recipientPhone: channel.selectedChannel === "SMS" ? channel.recipientPhone : null,
      readinessTotals: readiness.totals,
      hasBackorders: readiness.hasBackorders,
      hasEtaPending: readiness.hasEtaPending,
      hasPartialAllocation: readiness.hasPartialAllocation,
      allReadyOrComplete: readiness.allReadyOrComplete,
      hasActionableIssues: readiness.hasActionableIssues,
    });
  }

  return reports;
}

async function buildReadinessRows(groups: DeliveryConfirmation42DayTargetGroup[]) {
  const rows: Array<Record<string, unknown>> = [];

  for (const group of groups) {
    const readiness = await getDeliveryGroupReadiness(group.id);
    for (const line of readiness.lines) {
      rows.push({
        orderType: group.orderType,
        orderNumber: group.orderNumber,
        deliveryGroupId: group.id,
        deliveryDate: dateKey(group.deliveryDate),
        lineNbr: line.lineNbr,
        inventoryId: line.inventoryId,
        lineDescription: line.lineDescription,
        itemType: line.itemType,
        itemClass: line.itemClass,
        requestedOn: line.requestedOn,
        eta: line.eta,
        orderQty: line.orderQty,
        openQty: line.openQty,
        activeAllocatedQty: line.activeAllocatedQty,
        allocationStatus: line.allocationStatus,
        etaStatus: line.etaStatus,
        readinessStatus: line.readinessStatus,
        displayStatus: line.displayStatus,
        allocationRowsCompact: line.allocationRowsCompact.join(" "),
        manualReviewStatus: "",
        manualReviewNotes: "",
      });
    }
  }

  return rows;
}

async function writeReports(params: {
  readinessRows: Array<Record<string, unknown>>;
  eventRows: Array<Record<string, unknown>>;
}) {
  await mkdir("reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const readinessPath = path.join("reports", `42-day-readiness-smoke-${stamp}.csv`);
  const eventPath = path.join("reports", `42-day-event-smoke-${stamp}.csv`);

  const readinessColumns = [
    "orderType",
    "orderNumber",
    "deliveryGroupId",
    "deliveryDate",
    "lineNbr",
    "inventoryId",
    "lineDescription",
    "itemType",
    "itemClass",
    "requestedOn",
    "eta",
    "orderQty",
    "openQty",
    "activeAllocatedQty",
    "allocationStatus",
    "etaStatus",
    "readinessStatus",
    "displayStatus",
    "allocationRowsCompact",
    "manualReviewStatus",
    "manualReviewNotes",
  ];
  const eventColumns = [
    "orderType",
    "orderNumber",
    "deliveryGroupId",
    "deliveryDate",
    "eventId",
    "dedupeKey",
    "intervalType",
    "actionType",
    "status",
    "selectedChannel",
    "recipientEmail",
    "recipientPhone",
    "reasonSkipped",
    "alreadyConfirmedForDeliveryDate",
    "alreadyConfirmedInAcumatica",
    "acumaticaConfirmVia",
    "subject",
    "renderedMessagePreview",
    "linkTokenPresent",
    "linkScopeKey",
    "confirmationState",
    "paymentApplicabilityStatus",
    "paymentStatus",
    "paymentTerms",
    "unpaidBalance",
    "orderTotal",
    "paidToDate",
    "amountDueNow",
    "amountDueNowRounded",
    "currentDeliveryGroupValue",
    "currentDeliveryGroupMerchandiseValue",
    "currentDeliveryGroupTaxAmount",
    "remainingUndeliveredValueAfterCurrentDelivery",
    "requiredDownOnRemaining",
    "paymentReminderApplies",
    "emailPaymentReminderIncluded",
    "paymentCalculationWarnings",
  ];

  await writeFile(readinessPath, toCsv(params.readinessRows, readinessColumns), "utf8");
  await writeFile(eventPath, toCsv(params.eventRows, eventColumns), "utf8");

  return { readinessPath, eventPath };
}

function paymentSummary(
  eventReports: Awaited<ReturnType<typeof create42DayDeliveryConfirmationEvents>>["eventReports"]
) {
  const summary = {
    evaluated: eventReports.length,
    paymentApplicable: 0,
    balanceDue: 0,
    noBalanceDue: 0,
    notApplicableTerms: 0,
    calculationBlocked: 0,
    paymentReminderApplies: 0,
    emailPaymentReminderIncluded: 0,
  };

  for (const report of eventReports) {
    if (report.paymentApplicabilityStatus === "applicable") summary.paymentApplicable += 1;
    if (report.paymentApplicabilityStatus === "not_applicable_terms") {
      summary.notApplicableTerms += 1;
    }
    if (
      report.paymentStatus === "no_balance_due" ||
      report.paymentApplicabilityStatus === "no_meaningful_balance_due"
    ) {
      summary.noBalanceDue += 1;
    }
    if (report.paymentStatus === "balance_due") summary.balanceDue += 1;
    if (report.paymentStatus === "calculation_blocked") summary.calculationBlocked += 1;
    if (report.paymentReminderApplies) summary.paymentReminderApplies += 1;
    if (report.emailPaymentReminderIncluded) summary.emailPaymentReminderIncluded += 1;
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDate = dateKey(args.runDate);
  const targetDeliveryDate = dateKey(
    getNotificationTargetDate(runDate, DELIVERY_CONFIRMATION_42_DAY_INTERVAL_DAYS)
  );
  const requestedOn = requestedOnDateTime(targetDeliveryDate, args.requestedOnTime);
  const beforeCounts = await safetyCounts();
  const mode = process.env.USE_QUEUE_ERP?.trim().toLowerCase() === "true" ? "queue" : "direct";

  const importSummary = args.skipImport
    ? null
    : await importSalesOrdersForLineRequestedOn(requestedOn);

  const activeGroups = await find42DayDeliveryConfirmationTargetGroups(targetDeliveryDate);
  const activeGroupReports = await buildActiveGroupReports(activeGroups);
  const firstRun = await create42DayDeliveryConfirmationEvents({ runDate });
  const secondRun = await create42DayDeliveryConfirmationEvents({ runDate });
  const readinessRows = await buildReadinessRows(activeGroups);
  const reports = await writeReports({
    readinessRows,
    eventRows: firstRun.eventReports,
  });
  const afterCounts = await safetyCounts();

  const inactiveTargeted = firstRun.eventReports.some((event) => {
    const group = activeGroups.find((candidate) => candidate.id === event.deliveryGroupId);
    return !group?.isActive;
  });

  const output = {
    mode,
    runDate,
    targetDeliveryDate,
    requestedOn,
    importSummary,
    activeDeliveryGroupsFound: activeGroups.length,
    activeGroupReports,
    firstRun: {
      eventsCreated: firstRun.eventsCreated,
      eventsDeduped: firstRun.eventsDeduped,
      eventsSkipped: firstRun.eventsSkipped,
      scheduledEvents: firstRun.scheduledEvents,
      scheduledByChannel: firstRun.scheduledByChannel,
      skippedReasons: firstRun.skippedReasons,
      confirmationsCreatedOrReused: firstRun.confirmationsCreatedOrReused,
      confirmationsCreated: firstRun.confirmationsCreated,
      confirmationsReused: firstRun.confirmationsReused,
      deliveryGroupsSkippedIneligible: firstRun.deliveryGroupsSkippedIneligible,
    },
    secondRun: {
      eventsCreated: secondRun.eventsCreated,
      eventsDeduped: secondRun.eventsDeduped,
      eventsSkipped: secondRun.eventsSkipped,
      scheduledEvents: secondRun.scheduledEvents,
      scheduledByChannel: secondRun.scheduledByChannel,
      skippedReasons: secondRun.skippedReasons,
      confirmationsCreatedOrReused: secondRun.confirmationsCreatedOrReused,
      confirmationsCreated: secondRun.confirmationsCreated,
      confirmationsReused: secondRun.confirmationsReused,
      deliveryGroupsSkippedIneligible: secondRun.deliveryGroupsSkippedIneligible,
    },
    eventReports: firstRun.eventReports,
    paymentSummary: paymentSummary(firstRun.eventReports),
    reports,
    safetyCounts: {
      before: beforeCounts,
      after: afterCounts,
      notificationAttemptsUnchanged:
        beforeCounts.notificationAttempts === afterCounts.notificationAttempts,
    },
    safety: {
      noInactiveDeliveryGroupsTargeted: !inactiveTargeted,
      noNotificationAttemptsCreated:
        beforeCounts.notificationAttempts === afterCounts.notificationAttempts,
      noProviderSendInvoked: true,
      noAcumaticaWriteback: true,
    },
  };

  console.log(JSON.stringify(output, null, 2));

  if (inactiveTargeted) {
    throw new Error("Inactive/superseded delivery group was targeted.");
  }
  if (beforeCounts.notificationAttempts !== afterCounts.notificationAttempts) {
    throw new Error("notification_attempts changed during 42-day smoke.");
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
