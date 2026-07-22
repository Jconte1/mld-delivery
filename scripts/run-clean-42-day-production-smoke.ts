import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import {
  NotificationActionType,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  create42DayDeliveryConfirmationEvents,
  DELIVERY_CONFIRMATION_42_DAY_INTERVAL_DAYS,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import { render42DayEmailConfirmationMessage } from "../lib/notifications/deliveryConfirmationEmail";
import { buildDeliveryConfirmationLink } from "../lib/notifications/deliveryConfirmationLinks";
import { render42DaySmsConfirmationMessage } from "../lib/notifications/deliveryConfirmationSms";
import { getActiveSalespersonContact } from "../lib/notifications/salespersonContactCache";
import {
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getNotificationTargetDate,
} from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";
import { sendDemoEmail, sendDemoSms } from "./manual-demo/demoNotificationDispatch";

const REQUESTED_ON_TIME = "09:19:00.000Z";
const REPORT_DIR = "reports";

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function requireEnv(name: string) {
  const value = envValue(name);
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function redactedEmail(value: string) {
  const [local, domain] = value.split("@");
  if (!domain) return "<redacted>";
  return `${local.slice(0, 1)}***@${domain}`;
}

function redactedPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***-***-${digits.slice(-4)}`;
}

function todayInMountainTime() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return dateKey(new Date());
  return `${year}-${month}-${day}`;
}

function ensureQueueMode() {
  process.env.USE_QUEUE_ERP = "true";
  process.env.MLD_QUEUE_JOB_POLL_TIMEOUT_MS ||= "120000";
  process.env.MLD_QUEUE_JOB_POLL_INTERVAL_MS ||= "1000";
  process.env.MLD_QUEUE_STEP1_TIMEOUT_MS ||= "120000";
  process.env.MLD_QUEUE_STEP2_TIMEOUT_MS ||= "120000";
  process.env.MLD_QUEUE_CONTACT_TIMEOUT_MS ||= "120000";
  process.env.ERP_IMPORT_TRANSACTION_TIMEOUT_MS ||= "30000";
}

function preflight() {
  const mldQueueBaseUrl = requireEnv("MLD_QUEUE_BASE_URL");
  const deliveryAppBaseUrl = requireEnv("DELIVERY_APP_BASE_URL");
  const testEmail = requireEnv("NOTIFICATIONS_TEST_EMAIL");
  const testPhone = requireEnv("NOTIFICATIONS_TEST_PHONE");
  requireEnv("MLD_QUEUE_TOKEN");
  requireEnv("TWILIO_ACCOUNT_SID");
  requireEnv("TWILIO_AUTH_TOKEN");
  if (!envValue("TWILIO_MESSAGING_SERVICE_SID") && !envValue("TWILIO_FROM_NUMBER")) {
    throw new Error("Missing Twilio sender env var: TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER");
  }
  requireEnv("MS_GRAPH_TENANT_ID");
  requireEnv("MS_GRAPH_CLIENT_ID");
  requireEnv("MS_GRAPH_CLIENT_SECRET");
  requireEnv("MS_GRAPH_FROM_EMAIL");

  if (mldQueueBaseUrl !== "https://mld-queue.vercel.app") {
    throw new Error(`MLD_QUEUE_BASE_URL must be https://mld-queue.vercel.app, got ${mldQueueBaseUrl}`);
  }
  if (deliveryAppBaseUrl !== "https://mld-delivery.vercel.app") {
    throw new Error(`DELIVERY_APP_BASE_URL must be https://mld-delivery.vercel.app, got ${deliveryAppBaseUrl}`);
  }
  if (envValue("DEMO_NOTIFICATION_SEND_ENABLED").toLowerCase() !== "true") {
    throw new Error("DEMO_NOTIFICATION_SEND_ENABLED must be true for controlled test-recipient provider sends");
  }

  return {
    mldQueueBaseUrl,
    deliveryAppBaseUrl,
    mldQueueTokenConfigured: true,
    testEmailConfigured: true,
    testPhoneConfigured: true,
    testEmailRedacted: redactedEmail(testEmail),
    testPhoneRedacted: redactedPhone(testPhone),
    deliveryConfirmationWritebackDryRun: envValue("DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN") || null,
  };
}

async function tableCounts() {
  return {
    contacts: await prisma.contact.count(),
    orders: await prisma.order.count(),
    order_totals: await prisma.orderTotal.count(),
    order_tax_details: await prisma.orderTaxDetail.count(),
    order_lines: await prisma.orderLine.count(),
    order_line_allocations: await prisma.orderLineAllocation.count(),
    order_addresses: await prisma.orderAddress.count(),
    order_delivery_groups: await prisma.orderDeliveryGroup.count(),
    delivery_confirmations: await prisma.deliveryConfirmation.count(),
    notification_events: await prisma.notificationEvent.count(),
    notification_attempts: await prisma.notificationAttempt.count(),
    sms_opt_outs: await prisma.smsOptOut.count(),
    email_opt_outs: await prisma.emailOptOut.count(),
  };
}

async function clearDeliveryTestData() {
  const results = await prisma.$transaction([
    prisma.notificationAttempt.deleteMany(),
    prisma.deliveryConfirmation.deleteMany(),
    prisma.notificationEvent.deleteMany(),
    prisma.orderDeliveryGroup.deleteMany(),
    prisma.orderLineAllocation.deleteMany(),
    prisma.orderLine.deleteMany(),
    prisma.orderAddress.deleteMany(),
    prisma.orderTaxDetail.deleteMany(),
    prisma.orderTotal.deleteMany(),
    prisma.order.deleteMany(),
    prisma.contact.deleteMany(),
  ]);

  return {
    notification_attempts: results[0].count,
    delivery_confirmations: results[1].count,
    notification_events: results[2].count,
    order_delivery_groups: results[3].count,
    order_line_allocations: results[4].count,
    order_lines: results[5].count,
    order_addresses: results[6].count,
    order_tax_details: results[7].count,
    order_totals: results[8].count,
    orders: results[9].count,
    contacts: results[10].count,
  };
}

async function notificationEventCounts(targetDeliveryDate: string) {
  const rows = await prisma.notificationEvent.groupBy({
    by: ["status", "reasonSkipped"],
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    },
    _count: { _all: true },
  });
  const scheduled = rows
    .filter((row) => row.status === NotificationEventStatus.SCHEDULED)
    .reduce((sum, row) => sum + row._count._all, 0);
  const skipped = rows
    .filter((row) => row.status === NotificationEventStatus.SKIPPED)
    .reduce((sum, row) => sum + row._count._all, 0);
  const skippedByReason: Record<string, number> = {};
  for (const row of rows) {
    if (row.status !== NotificationEventStatus.SKIPPED) continue;
    const reason = row.reasonSkipped ?? "unknown";
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + row._count._all;
  }
  return { scheduled, skipped, skippedByReason, groupedRows: rows };
}

async function selectedScheduledEvent(targetDeliveryDate: string) {
  return prisma.notificationEvent.findFirst({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
      status: NotificationEventStatus.SCHEDULED,
    },
    orderBy: [{ orderNumber: "asc" }, { createdAt: "asc" }],
    include: {
      orderDeliveryGroup: {
        include: {
          order: {
            include: {
              contact: true,
              address: true,
            },
          },
        },
      },
    },
  });
}

type SelectedEvent = NonNullable<Awaited<ReturnType<typeof selectedScheduledEvent>>>;

async function renderSelected42Messages(event: SelectedEvent) {
  const group = event.orderDeliveryGroup;
  const order = group.order;
  const contactName = formatContactName(order.contact);
  const salespersonContact = await getActiveSalespersonContact(order.salespersonNumber);
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const jobAddress = formatJobAddress(order.address ?? {}) || "the job site";
  const confirmation = await prisma.deliveryConfirmation.findUnique({
    where: {
      deliveryGroupId_deliveryDate: {
        deliveryGroupId: group.id,
        deliveryDate: group.deliveryDate,
      },
    },
    select: { id: true, linkToken: true, status: true },
  });
  if (!confirmation?.linkToken) {
    throw new Error(`Selected 42-day event is missing DeliveryConfirmation link token eventId=${event.id}`);
  }

  const link = buildDeliveryConfirmationLink(confirmation.linkToken);
  const payment = await getDeliveryGroupPaymentEvaluation(group.id);
  const paymentReminderApplies =
    payment.paymentStatus === "balance_due" &&
    Number(payment.amountDueNowRounded ?? "0") > 2 &&
    payment.calculationWarnings.length === 0;
  const email = render42DayEmailConfirmationMessage({
    contactName,
    buyerGroup: order.buyerGroup,
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
    jobName,
    jobAddress,
    deliveryDate: group.deliveryDate,
    link,
    paymentReminderApplies,
    amountDueNowRounded: payment.amountDueNowRounded,
    salespersonContact,
  });
  const smsBody = render42DaySmsConfirmationMessage({
    contactName,
    buyerGroup: order.buyerGroup,
    jobName,
    deliveryDate: group.deliveryDate,
    link,
    deliveryAddress: order.address,
  });

  return {
    subject: email.subject,
    emailBody: email.body,
    emailHtmlBody: email.htmlBody,
    smsBody,
    confirmationLink: link,
    confirmationId: confirmation.id,
    confirmationStatus: confirmation.status,
  };
}

async function sendSelectedTestMessages(params: {
  subject: string;
  emailBody: string;
  emailHtmlBody?: string;
  smsBody: string;
}) {
  const testEmail = requireEnv("NOTIFICATIONS_TEST_EMAIL");
  const testPhone = requireEnv("NOTIFICATIONS_TEST_PHONE");
  const [email, sms] = await Promise.allSettled([
    sendDemoEmail({
      toOverride: testEmail,
      subject: params.subject,
      textBody: params.emailBody,
      htmlBody: params.emailHtmlBody,
    }),
    sendDemoSms({
      toOverride: testPhone,
      body: params.smsBody,
    }),
  ]);

  return {
    email: {
      recipientEnvVar: "NOTIFICATIONS_TEST_EMAIL",
      ok: email.status === "fulfilled" ? email.value.ok : false,
      provider: email.status === "fulfilled" ? email.value.provider : null,
      error: email.status === "rejected" ? String(email.reason) : null,
    },
    sms: {
      recipientEnvVar: "NOTIFICATIONS_TEST_PHONE",
      ok: sms.status === "fulfilled" ? sms.value.ok : false,
      provider: sms.status === "fulfilled" ? sms.value.provider : null,
      idPresent: sms.status === "fulfilled" ? Boolean(sms.value.id) : false,
      error: sms.status === "rejected" ? String(sms.reason) : null,
    },
  };
}

async function sampleImportedGroups(targetDeliveryDate: string) {
  const groups = await prisma.orderDeliveryGroup.findMany({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      isActive: true,
    },
    orderBy: [{ orderNumber: "asc" }],
    take: 10,
    include: {
      notificationEvents: {
        where: {
          intervalType: NotificationIntervalType.DAY_42,
          actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
        },
      },
      deliveryConfirmations: true,
      order: {
        include: {
          contact: true,
          lines: {
            where: { requestedOn: dateFromKey(targetDeliveryDate) },
            include: { allocations: true },
          },
        },
      },
    },
  });

  return groups.map((group) => {
    const lineCount = group.order.lines.length;
    const allocationCount = group.order.lines.reduce(
      (sum, line) => sum + line.allocations.length,
      0
    );
    const event = group.notificationEvents[0] ?? null;
    const confirmation = group.deliveryConfirmations[0] ?? null;
    return {
      orderType: group.orderType,
      orderNumber: group.orderNumber,
      acumaticaConfirmVia: group.order.confirmVia,
      contact: {
        displayNamePresent: Boolean(group.order.contact.displayName),
        companyNamePresent: Boolean(group.order.contact.companyName),
        emailPresent: Boolean(group.order.contact.email),
        phonePresent: Boolean(group.order.contact.phone1 || group.order.contact.phone2),
      },
      deliveryDate: dateKey(group.deliveryDate),
      deliveryGroupId: group.id,
      lineCount,
      allocationCount,
      notificationEventStatus: event?.status ?? null,
      notificationEventReasonSkipped: event?.reasonSkipped ?? null,
      deliveryConfirmationStatus: confirmation?.status ?? null,
      confirmationLinkTokenPresent: Boolean(confirmation?.linkToken),
    };
  });
}

async function writeReports(params: {
  stamp: string;
  reportData: unknown;
  summaryLines: string[];
}) {
  await mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, `42-day-clean-db-smoke-${params.stamp}.json`);
  const summaryPath = path.join(REPORT_DIR, `42-day-clean-db-smoke-summary-${params.stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(params.reportData, null, 2), "utf8");
  await writeFile(summaryPath, params.summaryLines.join("\n"), "utf8");
  return { jsonPath, summaryPath };
}

async function main() {
  ensureQueueMode();
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const runDate = todayInMountainTime();
  const targetDeliveryDate = dateKey(
    getNotificationTargetDate(runDate, DELIVERY_CONFIRMATION_42_DAY_INTERVAL_DAYS)
  );
  const requestedOn = `${targetDeliveryDate}T${REQUESTED_ON_TIME}`;
  const preflightResult = preflight();

  const beforeClearCounts = await tableCounts();
  const cleared = await clearDeliveryTestData();
  const afterClearCounts = await tableCounts();
  const importSummary = await importSalesOrdersForLineRequestedOn(requestedOn);
  if (importSummary.qualifyingOrdersFetched === 0) {
    throw new Error(`Zero qualifying orders for 42-day target ${targetDeliveryDate}`);
  }

  const eventSummary = await create42DayDeliveryConfirmationEvents({ runDate });
  const afterImportCounts = await tableCounts();
  const counts = await notificationEventCounts(targetDeliveryDate);
  const samples = await sampleImportedGroups(targetDeliveryDate);
  const selected = await selectedScheduledEvent(targetDeliveryDate);
  let selectedReport = null;
  let sendResults = null;
  let confirmationLink: string | null = null;

  if (selected) {
    const rendered = await renderSelected42Messages(selected);
    sendResults = await sendSelectedTestMessages({
      subject: rendered.subject,
      emailBody: rendered.emailBody,
      emailHtmlBody: rendered.emailHtmlBody,
      smsBody: rendered.smsBody,
    });
    confirmationLink = rendered.confirmationLink;
    selectedReport = {
      eventId: selected.id,
      orderType: selected.orderType,
      orderNumber: selected.orderNumber,
      deliveryGroupId: selected.deliveryGroupId,
      deliveryDate: dateKey(selected.deliveryDate),
      productionSelectedChannel: selected.selectedChannel,
      productionChannelReason: selected.channelReason,
      providerRecipientsOverriddenToTestOnly: true,
      testEmailRecipient: preflightResult.testEmailRedacted,
      testPhoneRecipient: preflightResult.testPhoneRedacted,
      confirmationLink,
      confirmationId: rendered.confirmationId,
      confirmationStatus: rendered.confirmationStatus,
    };
  }

  const attemptsAfterSend = await prisma.notificationAttempt.count();
  const reportData = {
    testMarker: "clean-db-42-day-production-style-smoke",
    startedAt: startedAt.toISOString(),
    runDate,
    targetDeliveryDate,
    requestedOn,
    preflight: preflightResult,
    beforeClearCounts,
    tablesCleared: cleared,
    afterClearCounts,
    importSummary,
    eventSummary,
    notificationEventCounts: counts,
    afterImportCounts,
    sampleImportedGroups: samples,
    selected: selectedReport,
    sendResults,
    notificationAttemptsAfterSend: attemptsAfterSend,
    confirmationLink,
    manualStopPoint:
      "Open the hosted confirmation link and click Confirm Delivery manually. Do not confirm by script or manual DB edit.",
    safety: {
      optOutRowsPreserved:
        beforeClearCounts.sms_opt_outs === afterClearCounts.sms_opt_outs &&
        beforeClearCounts.email_opt_outs === afterClearCounts.email_opt_outs,
      notificationAttemptsCreatedByTestSend: attemptsAfterSend - afterImportCounts.notification_attempts,
      providerRecipientsOverriddenToTestOnly: Boolean(selected),
      noRealCustomerRecipientsUsed: Boolean(selected),
      no1809060Run: true,
      noAcumaticaWriteDuringImportEventCreation: true,
    },
  };
  const summaryLines = [
    "# 42-Day Clean DB Production-Style Smoke",
    "",
    `Run date: ${runDate}`,
    `42-day target date: ${targetDeliveryDate}`,
    `RequestedOn import timestamp: ${requestedOn}`,
    "",
    "## Counts",
    "```json",
    JSON.stringify(
      {
        beforeClearCounts,
        tablesCleared: cleared,
        afterClearCounts,
        afterImportCounts,
        notificationAttemptsAfterSend: attemptsAfterSend,
      },
      null,
      2
    ),
    "```",
    "",
    "## Import",
    "```json",
    JSON.stringify(importSummary, null, 2),
    "```",
    "",
    "## Events",
    "```json",
    JSON.stringify(
      {
        eventsCreated: eventSummary.eventsCreated,
        eventsDeduped: eventSummary.eventsDeduped,
        eventsSkipped: eventSummary.eventsSkipped,
        scheduledEvents: eventSummary.scheduledEvents,
        skippedReasons: eventSummary.skippedReasons,
        confirmationsCreatedOrReused: eventSummary.confirmationsCreatedOrReused,
        confirmationsCreated: eventSummary.confirmationsCreated,
        confirmationsReused: eventSummary.confirmationsReused,
        notificationEventCounts: counts,
      },
      null,
      2
    ),
    "```",
    "",
    "## Selected Test Event",
    "```json",
    JSON.stringify({ selected: selectedReport, sendResults, confirmationLink }, null, 2),
    "```",
    "",
    "Manual stop point: open the hosted confirmation link and click Confirm Delivery manually.",
  ];
  const reports = await writeReports({ stamp, reportData, summaryLines });

  console.log(JSON.stringify({ ...reportData, reports }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
