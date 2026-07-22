import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import {
  NotificationActionType,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import { create180DayDeliveryReminderEvents } from "../lib/notifications/create180DayDeliveryReminderEvents";
import {
  create42DayDeliveryConfirmationEvents,
  DELIVERY_CONFIRMATION_42_DAY_INTERVAL_DAYS,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import { create60DayDeliveryReminderEvents } from "../lib/notifications/create60DayDeliveryReminderEvents";
import { create90DayDeliveryReminderEvents } from "../lib/notifications/create90DayDeliveryReminderEvents";
import { render42DayEmailConfirmationMessage } from "../lib/notifications/deliveryConfirmationEmail";
import { buildDeliveryConfirmationLink } from "../lib/notifications/deliveryConfirmationLinks";
import { render42DaySmsConfirmationMessage } from "../lib/notifications/deliveryConfirmationSms";
import { renderDeliveryReminderEmailBody } from "../lib/notifications/deliveryReminderEmail";
import {
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getNotificationTargetDate,
  renderDeliveryReminderEmailSubject,
  renderDeliveryReminderMessage,
} from "../lib/notifications/helpers";
import { getActiveSalespersonContact } from "../lib/notifications/salespersonContactCache";
import { prisma } from "../lib/prisma";
import { sendDemoEmail, sendDemoSms } from "./manual-demo/demoNotificationDispatch";

const REQUESTED_ON_TIME = "09:19:00.000Z";
const REPORT_DIR = "reports";

type IntervalKey = "180" | "90" | "60" | "42";

type IntervalConfig = {
  key: IntervalKey;
  label: string;
  days: number;
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
};

const INTERVALS: IntervalConfig[] = [
  {
    key: "180",
    label: "180-day reminder",
    days: 180,
    intervalType: NotificationIntervalType.DAY_180,
    actionType: NotificationActionType.DELIVERY_REMINDER,
  },
  {
    key: "90",
    label: "90-day reminder",
    days: 90,
    intervalType: NotificationIntervalType.DAY_90,
    actionType: NotificationActionType.DELIVERY_REMINDER,
  },
  {
    key: "60",
    label: "60-day reminder",
    days: 60,
    intervalType: NotificationIntervalType.DAY_60,
    actionType: NotificationActionType.DELIVERY_REMINDER,
  },
  {
    key: "42",
    label: "42-day confirmation request",
    days: DELIVERY_CONFIRMATION_42_DAY_INTERVAL_DAYS,
    intervalType: NotificationIntervalType.DAY_42,
    actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
  },
];

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

function requestedOnForTargetDate(targetDeliveryDate: string) {
  return `${targetDeliveryDate}T${REQUESTED_ON_TIME}`;
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
  if (/localhost|127\.0\.0\.1/i.test(deliveryAppBaseUrl)) {
    throw new Error(`DELIVERY_APP_BASE_URL must be hosted, got ${deliveryAppBaseUrl}`);
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
    demoSendEnabled: true,
    localWritebackDryRun: envValue("DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN") || null,
  };
}

async function safetyCounts() {
  const [notificationEvents, notificationAttempts, deliveryConfirmations] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
  ]);
  return { notificationEvents, notificationAttempts, deliveryConfirmations };
}

async function activeDeliveryGroupCount(targetDeliveryDate: string) {
  return prisma.orderDeliveryGroup.count({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      isActive: true,
    },
  });
}

async function eventCounts(config: IntervalConfig, targetDeliveryDate: string) {
  const rows = await prisma.notificationEvent.groupBy({
    by: ["status", "reasonSkipped"],
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      intervalType: config.intervalType,
      actionType: config.actionType,
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

async function createEvents(config: IntervalConfig, runDate: string) {
  switch (config.key) {
    case "180":
      return create180DayDeliveryReminderEvents({ runDate, dryRun: false });
    case "90":
      return create90DayDeliveryReminderEvents({ runDate, dryRun: false });
    case "60":
      return create60DayDeliveryReminderEvents({ runDate, dryRun: false });
    case "42":
      return create42DayDeliveryConfirmationEvents({ runDate });
  }
}

async function findSelectedScheduledEvent(config: IntervalConfig, targetDeliveryDate: string) {
  return prisma.notificationEvent.findFirst({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      intervalType: config.intervalType,
      actionType: config.actionType,
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

function safeJobAddress(event: NonNullable<Awaited<ReturnType<typeof findSelectedScheduledEvent>>>) {
  return formatJobAddress(event.orderDeliveryGroup.order.address ?? {}) || "the job site";
}

async function renderSelectedMessages(
  config: IntervalConfig,
  event: NonNullable<Awaited<ReturnType<typeof findSelectedScheduledEvent>>>
) {
  const group = event.orderDeliveryGroup;
  const order = group.order;
  const contactName = formatContactName(order.contact);
  const salespersonContact = await getActiveSalespersonContact(order.salespersonNumber);
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const jobAddress = safeJobAddress(event);

  if (config.key !== "42") {
    const subject = renderDeliveryReminderEmailSubject({
      buyerGroup: order.buyerGroup,
      jobName,
      deliveryDate: group.deliveryDate,
    });
    const smsBody = renderDeliveryReminderMessage({
      intervalType: config.intervalType,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: group.deliveryDate,
    });
    const emailBody = renderDeliveryReminderEmailBody({
      intervalType: config.intervalType,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: group.deliveryDate,
      salespersonContact,
    });
    return { subject, emailBody, smsBody, confirmationLink: null, confirmationId: null };
  }

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

async function writeJsonReport(name: string, data: unknown) {
  await mkdir(REPORT_DIR, { recursive: true });
  const filePath = path.join(REPORT_DIR, name);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

function markdownSummary(data: {
  runDate: string;
  intervals: Array<{
    config: IntervalConfig;
    targetDeliveryDate: string;
    reportPath: string;
    importSummary: unknown;
    activeDeliveryGroups: number;
    eventCounts: Awaited<ReturnType<typeof eventCounts>>;
    selected: unknown;
    sendResults: unknown;
  }>;
  preflight: unknown;
  safetyBefore: unknown;
  safetyAfter: unknown;
  confirmationLink: string | null;
  writebackReadiness: {
    selected42Order: string | null;
    liveWritebackRequires: string;
  };
}) {
  const lines = [
    "# Full Delivery Interval Production-Style Smoke",
    "",
    `Run date: ${data.runDate}`,
    "",
    "Durable event/dedupe note: this run created or reused real notification_events for matching delivery groups. These events may dedupe future runs for the same order/date/interval/action combinations. This is accepted for this controlled pre-go-live test.",
    "",
    "Provider safety: only NOTIFICATIONS_TEST_EMAIL and NOTIFICATIONS_TEST_PHONE were used as provider recipients. Both email and SMS were sent only as controlled test-recipient overrides; normal production channel policy remains SMS-first with email fallback.",
    "",
    "## Intervals",
  ];

  for (const interval of data.intervals) {
    const importSummary = interval.importSummary as {
      qualifyingOrdersFetched?: number;
      fullOrdersFetched?: number;
      failedOrders?: number;
    } | null;
    lines.push(
      "",
      `### ${interval.config.label}`,
      `- Target delivery date: ${interval.targetDeliveryDate}`,
      `- Qualifying orders fetched: ${importSummary?.qualifyingOrdersFetched ?? "n/a"}`,
      `- Full orders fetched/imported: ${importSummary?.fullOrdersFetched ?? "n/a"}`,
      `- Failed orders: ${importSummary?.failedOrders ?? "n/a"}`,
      `- Active delivery groups: ${interval.activeDeliveryGroups}`,
      `- Scheduled events: ${interval.eventCounts.scheduled}`,
      `- Skipped events: ${interval.eventCounts.skipped}`,
      `- Report: ${interval.reportPath}`
    );
  }

  lines.push(
    "",
    "## 42-Day Confirmation",
    `- Confirmation link: ${data.confirmationLink ?? "none"}`,
    `- Selected 42 order: ${data.writebackReadiness.selected42Order ?? "none"}`,
    `- Live writeback requirements: ${data.writebackReadiness.liveWritebackRequires}`,
    "",
    "## Safety Counts",
    "```json",
    JSON.stringify({ before: data.safetyBefore, after: data.safetyAfter }, null, 2),
    "```"
  );

  return lines.join("\n");
}

async function main() {
  ensureQueueMode();
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const runDate = todayInMountainTime();
  const preflightResult = preflight();
  const safetyBefore = await safetyCounts();
  const intervals = [];
  let confirmationLink: string | null = null;
  let selected42Order: string | null = null;

  for (const config of INTERVALS) {
    const targetDeliveryDate = dateKey(getNotificationTargetDate(runDate, config.days));
    const requestedOn = requestedOnForTargetDate(targetDeliveryDate);
    const importSummary = await importSalesOrdersForLineRequestedOn(requestedOn);
    const eventSummary = await createEvents(config, runDate);
    const activeDeliveryGroups = await activeDeliveryGroupCount(targetDeliveryDate);
    const counts = await eventCounts(config, targetDeliveryDate);
    const selectedEvent = await findSelectedScheduledEvent(config, targetDeliveryDate);
    let selected = null;
    let sendResults = null;

    if (selectedEvent) {
      const rendered = await renderSelectedMessages(config, selectedEvent);
      sendResults = await sendSelectedTestMessages({
        subject: rendered.subject,
        emailBody: rendered.emailBody,
        emailHtmlBody: rendered.emailHtmlBody,
        smsBody: rendered.smsBody,
      });
      if (config.key === "42") {
        confirmationLink = rendered.confirmationLink;
        selected42Order = selectedEvent.orderNumber;
      }
      selected = {
        eventId: selectedEvent.id,
        orderType: selectedEvent.orderType,
        orderNumber: selectedEvent.orderNumber,
        deliveryGroupId: selectedEvent.deliveryGroupId,
        deliveryDate: dateKey(selectedEvent.deliveryDate),
        productionSelectedChannel: selectedEvent.selectedChannel,
        productionChannelReason: selectedEvent.channelReason,
        providerRecipientsOverriddenToTestOnly: true,
        testEmailRecipient: preflightResult.testEmailRedacted,
        testPhoneRecipient: preflightResult.testPhoneRedacted,
        confirmationLink: rendered.confirmationLink,
        confirmationId: rendered.confirmationId,
        confirmationStatus: rendered.confirmationStatus,
      };
    }

    const reportData = {
      testMarker: "controlled-production-style-delivery-notification-smoke",
      runDate,
      targetDeliveryDate,
      requestedOn,
      interval: config.label,
      importSummary,
      eventSummary,
      activeDeliveryGroups,
      notificationEventCounts: counts,
      selected,
      sendResults,
      safety: {
        providerRecipientsOverriddenToTestOnly: true,
        noRealCustomerRecipientsUsed: true,
        bothEmailAndSmsSentOnlyForControlledTestRecipientOverride: Boolean(selectedEvent),
      },
    };
    const reportPath = await writeJsonReport(
      `${config.key}-day-production-style-test-${stamp}.json`,
      reportData
    );

    intervals.push({
      config,
      targetDeliveryDate,
      requestedOn,
      reportPath,
      importSummary,
      eventSummary,
      activeDeliveryGroups,
      eventCounts: counts,
      selected,
      sendResults,
    });
  }

  const safetyAfter = await safetyCounts();
  const writebackReadiness = {
    selected42Order,
    liveWritebackRequires:
      "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN=false in delivery and ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED=true in mld-queue worker",
  };
  const summaryPath = path.join(
    REPORT_DIR,
    `full-interval-production-style-test-summary-${stamp}.md`
  );
  await writeFile(
    summaryPath,
    markdownSummary({
      runDate,
      intervals,
      preflight: preflightResult,
      safetyBefore,
      safetyAfter,
      confirmationLink,
      writebackReadiness,
    }),
    "utf8"
  );

  const output = {
    startedAt: startedAt.toISOString(),
    runDate,
    targetDates: Object.fromEntries(
      intervals.map((interval) => [interval.config.key, interval.targetDeliveryDate])
    ),
    preflight: preflightResult,
    reportPaths: {
      intervals: intervals.map((interval) => interval.reportPath),
      summary: summaryPath,
    },
    intervals: intervals.map((interval) => ({
      interval: interval.config.label,
      targetDeliveryDate: interval.targetDeliveryDate,
      importSummary: interval.importSummary,
      activeDeliveryGroups: interval.activeDeliveryGroups,
      eventSummary: interval.eventSummary,
      notificationEventCounts: interval.eventCounts,
      selected: interval.selected,
      sendResults: interval.sendResults,
    })),
    safetyCounts: {
      before: safetyBefore,
      after: safetyAfter,
      notificationAttemptsUnchanged:
        safetyBefore.notificationAttempts === safetyAfter.notificationAttempts,
    },
    confirmationLink,
    writebackReadiness,
    stopPoint:
      "Manual stop point: after this cleanup is deployed and live writeback envs are confirmed, open the confirmation link and click Confirm Delivery, then run after-click verification.",
  };

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
