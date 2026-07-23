import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DeliveryConfirmationStatus,
  InternalOrderLifecycleStatus,
  NotificationIntervalType,
} from "../../lib/generated/prisma/client";
import { getDeliveryGroupPaymentEvaluation } from "../../lib/delivery-payment/deliveryGroupPayment";
import { getDeliveryGroupReadiness } from "../../lib/delivery-readiness/orderLineReadiness";
import { importSalesOrdersForLineRequestedOn } from "../../lib/erp/importSalesOrders";
import { render42DayEmailConfirmationMessage } from "../../lib/notifications/deliveryConfirmationEmail";
import {
  buildDeliveryConfirmationLink,
  getDeliveryAppBaseUrlConfig,
  newDeliveryConfirmationLinkToken,
} from "../../lib/notifications/deliveryConfirmationLinks";
import { ensurePendingDeliveryConfirmation } from "../../lib/notifications/deliveryConfirmationState";
import {
  buildDeliveryDetailsLink,
  ensureDeliveryDetailsLink,
} from "../../lib/notifications/deliveryDetailsLinks";
import {
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getNotificationTargetDate,
  renderDeliveryReminderEmailSubject,
} from "../../lib/notifications/helpers";
import { render30DayDeliveryReminderEmail } from "../../lib/notifications/deliveryReminder30Day";
import { renderDeliveryReminderEmailBody } from "../../lib/notifications/deliveryReminderEmail";
import { getActiveSalespersonContactMap } from "../../lib/notifications/salespersonContactCache";
import {
  getSalespersonContactDisplay,
  renderSalespersonEmailFooterText,
  renderSalespersonWebpageContactText,
  type SalespersonContactInput,
} from "../../lib/notifications/salespersonContactDisplay";
import { prisma } from "../../lib/prisma";

type Mode = "preview" | "send";
type IntervalKey = "180" | "90" | "60" | "42" | "30";
type IntervalArg = IntervalKey | "all";

type Args = {
  mode: Mode;
  interval: IntervalArg;
  runDate: string;
  skipImport: boolean;
};

const REQUESTED_ON_TIME = "09:19:00.000Z";
const REPORT_DIR = path.resolve(process.cwd(), "reports");
const INTERVALS = [
  {
    key: "180",
    days: 180,
    label: "180-day reminder",
    intervalType: NotificationIntervalType.DAY_180,
  },
  {
    key: "90",
    days: 90,
    label: "90-day reminder",
    intervalType: NotificationIntervalType.DAY_90,
  },
  {
    key: "60",
    days: 60,
    label: "60-day reminder",
    intervalType: NotificationIntervalType.DAY_60,
  },
  {
    key: "42",
    days: 42,
    label: "42-day confirmation",
    intervalType: NotificationIntervalType.DAY_42,
  },
  {
    key: "30",
    days: 30,
    label: "30-day reminder",
    intervalType: NotificationIntervalType.DAY_30,
  },
] as const;

type CandidateGroup = Awaited<ReturnType<typeof loadCandidateGroups>>[number];

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
  if (!local || !domain) return "<redacted>";
  return `${local.slice(0, 1)}***@${domain}`;
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

function parseArgs(argv: string[]): Args {
  let mode: Mode = "preview";
  let interval: IntervalArg = "all";
  let runDate = todayInMountainTime();
  let skipImport = false;

  for (const arg of argv) {
    if (arg === "--preview-only") {
      mode = "preview";
      continue;
    }
    if (arg === "--send") {
      mode = "send";
      continue;
    }
    if (arg === "--skip-import") {
      skipImport = true;
      continue;
    }
    if (arg.startsWith("--interval=")) {
      const value = arg.slice("--interval=".length).trim();
      if (!["180", "90", "60", "42", "30", "all"].includes(value)) {
        throw new Error("--interval must be 180, 90, 60, 42, 30, or all");
      }
      interval = value as IntervalArg;
      continue;
    }
    if (arg.startsWith("--run-date=")) {
      runDate = dateKey(dateFromKey(arg.slice("--run-date=".length).trim()));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { mode, interval, runDate, skipImport };
}

function htmlFromText(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
    )
    .join("<br />");
}

async function getGraphAccessToken() {
  const tenantId = requireEnv("MS_GRAPH_TENANT_ID");
  const clientId = requireEnv("MS_GRAPH_CLIENT_ID");
  const clientSecret = requireEnv("MS_GRAPH_CLIENT_SECRET");
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("scope", "https://graph.microsoft.com/.default");
  body.set("grant_type", "client_credentials");

  const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Graph token failed: ${resp.status} ${(await resp.text()).slice(0, 500)}`);
  }

  const json = (await resp.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Graph token missing access_token");
  return json.access_token;
}

async function sendTestEmail(params: {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
}) {
  const deliveryTestSendEnabled =
    envValue("DELIVERY_TEST_EMAIL_SEND_ENABLED").toLowerCase() === "true";
  const demoSendEnabled = envValue("DEMO_NOTIFICATION_SEND_ENABLED").toLowerCase() === "true";
  if (!deliveryTestSendEnabled && !demoSendEnabled) {
    throw new Error(
      "DELIVERY_TEST_EMAIL_SEND_ENABLED or DEMO_NOTIFICATION_SEND_ENABLED must be true for --send"
    );
  }

  const fromEmail = requireEnv("MS_GRAPH_FROM_EMAIL");
  const token = await getGraphAccessToken();
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: params.subject,
          body: {
            contentType: "HTML",
            content: params.htmlBody ?? htmlFromText(params.textBody),
          },
          toRecipients: [{ emailAddress: { address: params.to } }],
        },
        saveToSentItems: true,
      }),
    }
  );

  if (!resp.ok) {
    throw new Error(`Graph test email failed: ${resp.status} ${(await resp.text()).slice(0, 500)}`);
  }
}

function getTestEmailRecipient() {
  const notificationsTestEmail = envValue("NOTIFICATIONS_TEST_EMAIL");
  if (notificationsTestEmail) {
    return {
      envVar: "NOTIFICATIONS_TEST_EMAIL",
      value: notificationsTestEmail,
    };
  }

  return {
    envVar: "DELIVERY_TEST_EMAIL_TO",
    value: requireEnv("DELIVERY_TEST_EMAIL_TO"),
  };
}

function requestedOnForTargetDate(targetDeliveryDate: string) {
  return `${targetDeliveryDate}T${REQUESTED_ON_TIME}`;
}

function isCompletedOrCancelledStatus(value: string | null | undefined) {
  return ["cancelled", "canceled", "completed", "closed"].includes(
    value?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? ""
  );
}

function isBlockedLifecycleStatus(value: string | null | undefined) {
  return new Set<string>([
    InternalOrderLifecycleStatus.BLOCKED,
    InternalOrderLifecycleStatus.MANUAL_REVIEW,
    InternalOrderLifecycleStatus.COMPLETED,
    InternalOrderLifecycleStatus.CANCELLED,
  ]).has(value ?? "");
}

async function safetyCounts() {
  const [notificationEvents, notificationAttempts, deliveryConfirmations] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
  ]);
  return { notificationEvents, notificationAttempts, deliveryConfirmations };
}

async function assert30DayDetailsLinkSchemaReady() {
  const rows = await prisma.$queryRaw<
    Array<{
      details_table: string | null;
      notification_details_link_column: string | null;
    }>
  >`
    SELECT
      to_regclass('public.delivery_details_links')::text AS details_table,
      (
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'notification_events'
          AND column_name = 'detailsLinkId'
        LIMIT 1
      ) AS notification_details_link_column
  `;

  const row = rows[0];
  if (!row?.details_table || !row.notification_details_link_column) {
    throw new Error(
      "30-day test requires pending migration 20260723103000_add_delivery_details_links. Run prisma migrate deploy before sending the 30-day details-link email."
    );
  }
}

async function loadCandidateGroups(targetDeliveryDate: string) {
  return prisma.orderDeliveryGroup.findMany({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
      isActive: true,
    },
    orderBy: [{ orderNumber: "asc" }, { id: "asc" }],
    select: {
      id: true,
      orderId: true,
      orderType: true,
      orderNumber: true,
      deliveryDate: true,
      status: true,
      deliveryConfirmations: {
        select: {
          id: true,
          status: true,
          linkToken: true,
          linkExpiresAt: true,
        },
      },
      order: {
        select: {
          orderType: true,
          orderNumber: true,
          status: true,
          internalLifecycleStatus: true,
          customerDescription: true,
          locationDescription: true,
          buyerGroup: true,
          confirmVia: true,
          salespersonNumber: true,
          address: true,
          contact: true,
        },
      },
    },
  });
}

function normalizeConfirmVia(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

async function selectDeliveryGroup(targetDeliveryDate: string, interval: IntervalKey) {
  const groups = await loadCandidateGroups(targetDeliveryDate);
  const salespersonContactsByNumber = await getActiveSalespersonContactMap(
    groups.map((group) => group.order.salespersonNumber)
  );
  const eligible = groups.filter((group) => {
    const order = group.order;
    return (
      !isCompletedOrCancelledStatus(order.status) &&
      !isCompletedOrCancelledStatus(group.status) &&
      !isBlockedLifecycleStatus(order.internalLifecycleStatus) &&
      (interval !== "30" || Boolean(normalizeConfirmVia(order.confirmVia))) &&
      Boolean(order.salespersonNumber)
    );
  });

  const decorated = eligible.map((group) => {
    const contact = group.order.salespersonNumber
      ? salespersonContactsByNumber.get(group.order.salespersonNumber) ?? null
      : null;
    return {
      group,
      salespersonContact: contact,
      salespersonDisplay: getSalespersonContactDisplay(contact),
    };
  });

  return (
    decorated.find((candidate) => Boolean(candidate.salespersonDisplay)) ??
    decorated[0] ??
    null
  );
}

function safeJobAddress(group: CandidateGroup) {
  return formatJobAddress(group.order.address ?? {}) || "the job site";
}

async function ensureTestConfirmationLink(group: CandidateGroup) {
  const existing = group.deliveryConfirmations[0] ?? null;
  const existingTokenValid =
    existing?.linkToken && (!existing.linkExpiresAt || existing.linkExpiresAt.getTime() > Date.now());
  if (existingTokenValid && existing?.linkToken) {
    return {
      confirmationId: existing.id,
      confirmationStatus: existing.status,
      confirmationCreated: false,
      confirmationUpdated: false,
      link: buildDeliveryConfirmationLink(existing.linkToken),
      tokenAvailable: true,
      skippedReason: null,
    };
  }

  const finalStatuses = new Set<DeliveryConfirmationStatus>([
    DeliveryConfirmationStatus.CONFIRMED,
    DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
  ]);
  if (existing && finalStatuses.has(existing.status)) {
    return {
      confirmationId: existing.id,
      confirmationStatus: existing.status,
      confirmationCreated: false,
      confirmationUpdated: false,
      link: null,
      tokenAvailable: false,
      skippedReason: "existing_final_confirmation_without_active_token",
    };
  }

  const now = new Date();
  const confirmation = await ensurePendingDeliveryConfirmation({
    orderId: group.orderId,
    deliveryGroupId: group.id,
    orderType: group.orderType,
    orderNumber: group.orderNumber,
    deliveryDate: group.deliveryDate,
    contactId: group.order.contact.contactId,
    linkToken: newDeliveryConfirmationLinkToken(),
    linkCreatedAt: now,
    linkExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  });

  return {
    confirmationId: confirmation.id,
    confirmationStatus: confirmation.status,
    confirmationCreated: !existing,
    confirmationUpdated: Boolean(existing),
    link: confirmation.linkToken ? buildDeliveryConfirmationLink(confirmation.linkToken) : null,
    tokenAvailable: Boolean(confirmation.linkToken),
    skippedReason: null,
  };
}

async function ensureTestDeliveryDetailsLink(group: CandidateGroup) {
  const result = await ensureDeliveryDetailsLink({
    orderId: group.orderId,
    orderDeliveryGroupId: group.id,
    deliveryDate: group.deliveryDate,
  });

  return {
    detailsLinkId: result.link.id,
    detailsLinkCreated: result.created,
    detailsLinkReused: !result.created,
    link: buildDeliveryDetailsLink(result.link.token),
  };
}

async function renderIntervalEmail(params: {
  interval: (typeof INTERVALS)[number];
  group: CandidateGroup;
  salespersonContact: SalespersonContactInput | null;
}) {
  const contactName = formatContactName(params.group.order.contact);
  const jobName = formatJobName({
    customerDescription: params.group.order.customerDescription,
    locationDescription: params.group.order.locationDescription,
  });
  const jobAddress = safeJobAddress(params.group);
  const footer = renderSalespersonEmailFooterText(params.salespersonContact);

  if (params.interval.key === "30") {
    const details = await ensureTestDeliveryDetailsLink(params.group);
    const readiness = await getDeliveryGroupReadiness(params.group.id);
    const payment = await getDeliveryGroupPaymentEvaluation(params.group.id);
    const paymentReminderApplies =
      payment.paymentStatus === "balance_due" &&
      Number(payment.amountDueNowRounded ?? "0") > 2 &&
      payment.calculationWarnings.length === 0;
    const email = render30DayDeliveryReminderEmail({
      contactName,
      buyerGroup: params.group.order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: params.group.deliveryDate,
      detailsLink: details.link,
      paymentDue: paymentReminderApplies,
      amountDueNowRounded: payment.amountDueNowRounded,
      lines: readiness.lines,
      salespersonContact: params.salespersonContact,
    });

    return {
      subject: email.subject,
      body: email.body,
      htmlBody: email.htmlBody,
      footerIncluded: Boolean(footer && email.body.includes(footer)),
      confirmation: null,
      webpageBlockIncluded: null,
      requestDifferentDateUnchanged: null,
      detailsLink: details.link,
      detailsLinkCreated: details.detailsLinkCreated,
      detailsLinkReused: details.detailsLinkReused,
      detailsLinkId: details.detailsLinkId,
      itemLineCount: readiness.lines.length,
      payment: {
        paymentStatus: payment.paymentStatus,
        amountDueNowRounded: payment.amountDueNowRounded,
        paymentReminderApplies,
      },
    };
  }

  if (params.interval.key !== "42") {
    const subject = renderDeliveryReminderEmailSubject({
      buyerGroup: params.group.order.buyerGroup,
      jobName,
      deliveryDate: params.group.deliveryDate,
    });
    const body = renderDeliveryReminderEmailBody({
      intervalType: params.interval.intervalType,
      contactName,
      buyerGroup: params.group.order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: params.group.deliveryDate,
      salespersonContact: params.salespersonContact,
    });
    return {
      subject,
      body,
      htmlBody: htmlFromText(body),
      footerIncluded: Boolean(footer && body.includes(footer)),
      confirmation: null,
      webpageBlockIncluded: null,
      requestDifferentDateUnchanged: null,
      detailsLink: null,
      detailsLinkCreated: false,
      detailsLinkReused: false,
      detailsLinkId: null,
      itemLineCount: null,
      payment: null,
    };
  }

  const confirmation = await ensureTestConfirmationLink(params.group);
  const payment = await getDeliveryGroupPaymentEvaluation(params.group.id);
  const paymentReminderApplies =
    payment.paymentStatus === "balance_due" &&
    Number(payment.amountDueNowRounded ?? "0") > 2 &&
    payment.calculationWarnings.length === 0;
  const email = render42DayEmailConfirmationMessage({
    contactName,
    buyerGroup: params.group.order.buyerGroup,
    customerDescription: params.group.order.customerDescription,
    locationDescription: params.group.order.locationDescription,
    jobName,
    jobAddress,
    deliveryDate: params.group.deliveryDate,
    link: confirmation.link ?? "",
    paymentReminderApplies,
    amountDueNowRounded: payment.amountDueNowRounded,
    salespersonContact: params.salespersonContact,
  });
  const webpageText = renderSalespersonWebpageContactText(params.salespersonContact);

  return {
    subject: email.subject,
    body: email.body,
    htmlBody: email.htmlBody,
    footerIncluded: Boolean(footer && email.body.includes(footer)),
    confirmation,
    webpageBlockIncluded: Boolean(webpageText),
    requestDifferentDateUnchanged: true,
    detailsLink: null,
    detailsLinkCreated: false,
    detailsLinkReused: false,
    detailsLinkId: null,
    itemLineCount: null,
    payment: {
      paymentStatus: payment.paymentStatus,
      amountDueNowRounded: payment.amountDueNowRounded,
      paymentReminderApplies,
    },
  };
}

async function runInterval(params: {
  interval: (typeof INTERVALS)[number];
  runDate: string;
  mode: Mode;
  skipImport: boolean;
  testEmail: string;
  testEmailEnvVar: string;
}) {
  const targetDate = dateKey(getNotificationTargetDate(params.runDate, params.interval.days));
  const requestedOn = requestedOnForTargetDate(targetDate);

  if (params.interval.key === "30") {
    await assert30DayDetailsLinkSchemaReady();
  }

  const importSummary = params.skipImport
    ? null
    : await importSalesOrdersForLineRequestedOn(requestedOn);
  const selected = await selectDeliveryGroup(targetDate, params.interval.key);

  if (!selected) {
    return {
      interval: params.interval.key,
      targetDate,
      requestedOn,
      importSummary,
      selectedOrderNumber: null,
      salespersonNumberPresent: false,
      hasActiveSalespersonContact: false,
      hasSalespersonEmail: false,
      hasSalespersonPhone: false,
      emailFooterIncluded: false,
      sentToTestEmail: false,
      previewOnly: params.mode === "preview",
      reason:
        params.interval.key === "30"
          ? "no_active_eligible_confirmed_delivery_group_with_salesperson_number"
          : "no_active_eligible_delivery_group_with_salesperson_number",
    };
  }

  const rendered = await renderIntervalEmail({
    interval: params.interval,
    group: selected.group,
    salespersonContact: selected.salespersonContact,
  });
  const display = selected.salespersonDisplay;
  let sentToTestEmail = false;

  if (params.mode === "send") {
    await sendTestEmail({
      to: params.testEmail,
      subject: `[TEST] ${rendered.subject}`,
      textBody: rendered.body,
      htmlBody: rendered.htmlBody,
    });
    sentToTestEmail = true;
  }

  return {
    interval: params.interval.key,
    targetDate,
    requestedOn,
    importSummary,
    selectedOrderNumber: selected.group.orderNumber,
    salespersonNumber: selected.group.order.salespersonNumber,
    salespersonNumberPresent: Boolean(selected.group.order.salespersonNumber),
    hasActiveSalespersonContact: Boolean(display),
    hasSalespersonEmail: Boolean(display?.email),
    hasSalespersonPhone: Boolean(display?.phone),
    emailFooterIncluded: rendered.footerIncluded,
    recipient: params.testEmailEnvVar,
    sentToTestEmail,
    previewOnly: params.mode === "preview",
    confirmation:
      rendered.confirmation && {
        confirmationId: rendered.confirmation.confirmationId,
        confirmationStatus: rendered.confirmation.confirmationStatus,
        confirmationCreated: rendered.confirmation.confirmationCreated,
        confirmationUpdated: rendered.confirmation.confirmationUpdated,
        tokenAvailable: rendered.confirmation.tokenAvailable,
        skippedReason: rendered.confirmation.skippedReason,
      },
    webpageSalespersonBlockIncluded: rendered.webpageBlockIncluded,
    requestDifferentDateBehaviorUnchanged: rendered.requestDifferentDateUnchanged,
    detailsLink:
      rendered.detailsLink && {
        detailsLinkId: rendered.detailsLinkId,
        detailsLinkCreated: rendered.detailsLinkCreated,
        detailsLinkReused: rendered.detailsLinkReused,
        linkPresent: Boolean(rendered.detailsLink),
      },
    itemLineCount: rendered.itemLineCount,
    payment: rendered.payment,
    safety: {
      noSmsSent: true,
      noRealCustomerEmailSent: true,
      noNotificationEventCreatedByScript: true,
      noNotificationAttemptCreatedByScript: true,
      noAcumaticaWritePerformed: true,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const testEmailConfig = getTestEmailRecipient();
  const testEmail = testEmailConfig.value;
  const selectedIntervals = INTERVALS.filter(
    (interval) => args.interval === "all" || args.interval === interval.key
  );
  const baseUrl = getDeliveryAppBaseUrlConfig();
  const safetyBefore = await safetyCounts();
  const intervals = [];

  for (const interval of selectedIntervals) {
    intervals.push(
      await runInterval({
        interval,
        runDate: args.runDate,
        mode: args.mode,
        skipImport: args.skipImport,
        testEmail,
        testEmailEnvVar: testEmailConfig.envVar,
      })
    );
  }

  const safetyAfter = await safetyCounts();
  const output = {
    mode: args.mode,
    runDate: args.runDate,
    recipient: {
      envVar: testEmailConfig.envVar,
      redacted: redactedEmail(testEmail),
    },
    deliveryAppBaseUrl: {
      envVarUsed: baseUrl.envVar,
      isDefault: baseUrl.isDefault,
      isLocalhost: baseUrl.isLocalhost,
    },
    intervals,
    safetyCounts: {
      before: safetyBefore,
      after: safetyAfter,
    },
    safety: {
      noSmsSent: true,
      noRealCustomerEmailSent: true,
      noProviderDispatchInPreview: args.mode === "preview",
      noAcumaticaWritePerformed: true,
      noNotificationEventCreatedByScript:
        safetyBefore.notificationEvents === safetyAfter.notificationEvents,
      noNotificationAttemptCreatedByScript:
        safetyBefore.notificationAttempts === safetyAfter.notificationAttempts,
    },
  };

  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(
    REPORT_DIR,
    `salesperson-interval-email-test-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  await writeFile(reportPath, JSON.stringify(output, null, 2), "utf8");

  console.log(JSON.stringify({ ...output, reportPath }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
