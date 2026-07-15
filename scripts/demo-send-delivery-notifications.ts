import { NotificationIntervalType } from "../lib/generated/prisma/client";
import { getDeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import {
  buildDeliveryConfirmationLink,
  getDeliveryAppBaseUrlConfig,
  newDeliveryConfirmationLinkToken,
} from "../lib/notifications/deliveryConfirmationLinks";
import { ensurePendingDeliveryConfirmation } from "../lib/notifications/deliveryConfirmationState";
import { render42DayEmailConfirmationMessage } from "../lib/notifications/deliveryConfirmationEmail";
import {
  buildDeliveryConfirmationScopeKey,
  render42DaySmsConfirmationMessage,
} from "../lib/notifications/deliveryConfirmationSms";
import {
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
  renderDeliveryReminderEmailSubject,
  renderDeliveryReminderMessage,
} from "../lib/notifications/helpers";
import {
  sendDemoEmail,
  sendDemoSms,
  type DemoSendResult,
} from "../lib/demo/demoNotificationDispatch";
import { prisma } from "../lib/prisma";

type DemoMode = "preview" | "send";
type DemoInterval = "180" | "90" | "60" | "42" | "all";
type SpecificDemoInterval = Exclude<DemoInterval, "all">;

type ParsedArgs = {
  mode: DemoMode;
  interval: DemoInterval;
} & (
  | {
      deliveryGroupId: string;
      orderType?: undefined;
      orderNumber?: undefined;
      deliveryDate?: undefined;
    }
  | {
      deliveryGroupId?: undefined;
      orderType: string;
      orderNumber: string;
      deliveryDate: string;
    }
);

type DemoDeliveryGroup = NonNullable<Awaited<ReturnType<typeof loadDeliveryGroup>>>;

type DemoMessage = {
  label: string;
  interval: SpecificDemoInterval;
  channel: "EMAIL" | "SMS";
  recipientEnvVar: "NOTIFICATIONS_TEST_EMAIL" | "NOTIFICATIONS_TEST_PHONE";
  to: string;
  subject?: string;
  body: string;
  htmlBody?: string;
};

type DemoMessageSendResult = {
  label: string;
  interval: SpecificDemoInterval;
  channel: "EMAIL" | "SMS";
  provider: DemoSendResult["provider"] | null;
  recipientEnvVar: DemoMessage["recipientEnvVar"];
  ok: boolean;
  idPresent?: boolean;
  errorMessage?: string;
};

const REMINDER_INTERVALS = [
  {
    interval: "180",
    label: "DEMO 180-day reminder",
    intervalType: NotificationIntervalType.DAY_180,
  },
  {
    interval: "90",
    label: "DEMO 90-day reminder",
    intervalType: NotificationIntervalType.DAY_90,
  },
  {
    interval: "60",
    label: "DEMO 60-day reminder",
    intervalType: NotificationIntervalType.DAY_60,
  },
] as const;

function usage() {
  return [
    "Usage:",
    "  npx.cmd --no-install tsx --env-file=.env scripts\\demo-send-delivery-notifications.ts --preview-only --delivery-group-id=<id> --interval=all",
    "  npx.cmd --no-install tsx --env-file=.env scripts\\demo-send-delivery-notifications.ts --preview-only --order-type=SO --order-number=SO40466 --delivery-date=2026-07-22 --interval=42",
    "  npx.cmd --no-install tsx --env-file=.env scripts\\demo-send-delivery-notifications.ts --send --delivery-group-id=<id> --interval=180",
    "",
    "Intervals: --interval=180, --interval=90, --interval=60, --interval=42, --interval=all",
    "Default interval: all",
  ].join("\n");
}

function parseInterval(value: string): DemoInterval {
  if (["180", "90", "60", "42", "all"].includes(value)) {
    return value as DemoInterval;
  }
  throw new Error(`Invalid --interval=${value}. Expected 180, 90, 60, 42, or all.`);
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: DemoMode = "preview";
  let interval: DemoInterval = "all";
  let deliveryGroupId: string | undefined;
  let orderType: string | undefined;
  let orderNumber: string | undefined;
  let deliveryDate: string | undefined;

  for (const arg of argv) {
    if (arg === "--preview-only") {
      mode = "preview";
      continue;
    }
    if (arg === "--send") {
      mode = "send";
      continue;
    }
    if (arg.startsWith("--interval=")) {
      interval = parseInterval(arg.slice("--interval=".length).trim());
      continue;
    }
    if (arg.startsWith("--delivery-group-id=")) {
      deliveryGroupId = arg.slice("--delivery-group-id=".length).trim();
      continue;
    }
    if (arg.startsWith("--order-type=")) {
      orderType = arg.slice("--order-type=".length).trim();
      continue;
    }
    if (arg.startsWith("--order-number=")) {
      orderNumber = arg.slice("--order-number=".length).trim();
      continue;
    }
    if (arg.startsWith("--delivery-date=")) {
      deliveryDate = arg.slice("--delivery-date=".length).trim();
      continue;
    }
  }

  if (deliveryGroupId) {
    return { mode, interval, deliveryGroupId };
  }

  if (orderType && orderNumber && deliveryDate) {
    return { mode, interval, orderType, orderNumber, deliveryDate };
  }

  throw new Error(usage());
}

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function isIntervalIncluded(selected: DemoInterval, interval: SpecificDemoInterval) {
  return selected === "all" || selected === interval;
}

function includesConfirmationLinkInterval(interval: DemoInterval) {
  return interval === "all" || interval === "42";
}

function demoRecipientForMode(
  name: "NOTIFICATIONS_TEST_EMAIL" | "NOTIFICATIONS_TEST_PHONE",
  mode: DemoMode
) {
  const value = envValue(name);
  if (value) return value;
  if (mode === "send") {
    throw new Error(`Missing env var: ${name}`);
  }
  return `<missing ${name}>`;
}

async function loadDeliveryGroup(args: ParsedArgs) {
  const where =
    "deliveryGroupId" in args
      ? { id: args.deliveryGroupId }
      : {
          orderType: args.orderType,
          orderNumber: args.orderNumber,
          deliveryDate: dateFromKey(args.deliveryDate),
          isActive: true,
        };

  return prisma.orderDeliveryGroup.findFirst({
    where,
    include: {
      order: {
        include: {
          contact: true,
          address: true,
        },
      },
    },
  });
}

function safeJobAddress(group: DemoDeliveryGroup) {
  return formatJobAddress(group.order.address ?? {}) || "the job site";
}

function paymentReminderApplies(payment: Awaited<ReturnType<typeof getDeliveryGroupPaymentEvaluation>>) {
  const due = Number(payment.amountDueNowRounded ?? "0");
  return (
    payment.paymentStatus === "balance_due" &&
    Number.isFinite(due) &&
    due > 2 &&
    payment.calculationWarnings.length === 0
  );
}

async function ensureDemoConfirmation(group: DemoDeliveryGroup) {
  const existing = await prisma.deliveryConfirmation.findUnique({
    where: {
      deliveryGroupId_deliveryDate: {
        deliveryGroupId: group.id,
        deliveryDate: group.deliveryDate,
      },
    },
    select: { linkToken: true, linkExpiresAt: true },
  });
  const existingTokenValid =
    existing?.linkToken &&
    (!existing.linkExpiresAt || existing.linkExpiresAt.getTime() > Date.now());
  const linkToken =
    existingTokenValid && existing?.linkToken
      ? existing.linkToken
      : newDeliveryConfirmationLinkToken();
  const now = new Date();

  const confirmation = await ensurePendingDeliveryConfirmation({
    orderId: group.orderId,
    deliveryGroupId: group.id,
    orderType: group.orderType,
    orderNumber: group.orderNumber,
    deliveryDate: group.deliveryDate,
    contactId: group.order.contact.contactId,
    linkToken,
    linkCreatedAt: now,
    linkExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  });

  return {
    confirmation,
    link: buildDeliveryConfirmationLink(linkToken),
    linkToken,
  };
}

function demoSubject(label: string, subject: string) {
  return `${label}: ${subject}`;
}

function demoBody(label: string, body: string) {
  return `${label}\n\n${body}`;
}

function demoHtmlBody(label: string, htmlBody: string) {
  return `<p>${label}</p>\n${htmlBody}`;
}

function buildReminderMessages(params: {
  interval: DemoInterval;
  group: DemoDeliveryGroup;
  contactName: string;
  jobName: string;
  jobAddress: string;
  testEmail: string;
  testPhone: string;
}) {
  const messages: DemoMessage[] = [];

  for (const interval of REMINDER_INTERVALS) {
    if (!isIntervalIncluded(params.interval, interval.interval)) continue;

    const subject = renderDeliveryReminderEmailSubject({
      buyerGroup: params.group.order.buyerGroup,
      jobName: params.jobName,
      deliveryDate: params.group.deliveryDate,
    });
    const body = renderDeliveryReminderMessage({
      intervalType: interval.intervalType,
      contactName: params.contactName,
      buyerGroup: params.group.order.buyerGroup,
      jobName: params.jobName,
      jobAddress: params.jobAddress,
      deliveryDate: params.group.deliveryDate,
    });

    messages.push({
      label: interval.label,
      interval: interval.interval,
      channel: "EMAIL",
      recipientEnvVar: "NOTIFICATIONS_TEST_EMAIL",
      to: params.testEmail,
      subject: demoSubject(interval.label, subject),
      body: demoBody(interval.label, body),
    });
    messages.push({
      label: interval.label,
      interval: interval.interval,
      channel: "SMS",
      recipientEnvVar: "NOTIFICATIONS_TEST_PHONE",
      to: params.testPhone,
      body: demoBody(interval.label, body),
    });
  }

  return messages;
}

async function build42DayMessages(params: {
  group: DemoDeliveryGroup;
  contactName: string;
  jobName: string;
  jobAddress: string;
  testEmail: string;
  testPhone: string;
}) {
  const { confirmation, link, linkToken } = await ensureDemoConfirmation(params.group);
  const payment = await getDeliveryGroupPaymentEvaluation(params.group.id);
  const applies = paymentReminderApplies(payment);
  const email = render42DayEmailConfirmationMessage({
    contactName: params.contactName,
    buyerGroup: params.group.order.buyerGroup,
    jobName: params.jobName,
    jobAddress: params.jobAddress,
    deliveryDate: params.group.deliveryDate,
    link,
    paymentReminderApplies: applies,
    amountDueNowRounded: payment.amountDueNowRounded,
  });
  const sms = render42DaySmsConfirmationMessage({
    contactName: params.contactName,
    buyerGroup: params.group.order.buyerGroup,
    jobName: params.jobName,
    deliveryDate: params.group.deliveryDate,
    link,
  });

  return {
    link,
    linkToken,
    confirmationId: confirmation.id,
    confirmationStatus: confirmation.status,
    payment: {
      paymentTerms: payment.paymentTerms,
      paymentStatus: payment.paymentStatus,
      paymentApplicabilityStatus: payment.paymentApplicabilityStatus,
      amountDueNow: payment.amountDueNow,
      amountDueNowRounded: payment.amountDueNowRounded,
      unpaidBalance: payment.unpaidBalance,
      currentDeliveryGroupValue: payment.currentDeliveryGroupValue,
      calculationWarnings: payment.calculationWarnings,
      paymentReminderApplies: applies,
    },
    messages: [
      {
        label: "DEMO 42-day confirmation request",
        interval: "42" as const,
        channel: "EMAIL" as const,
        recipientEnvVar: "NOTIFICATIONS_TEST_EMAIL" as const,
        to: params.testEmail,
        subject: demoSubject("DEMO 42-day confirmation request", email.subject),
        body: demoBody("DEMO 42-day confirmation request", email.body),
        htmlBody: demoHtmlBody("DEMO 42-day confirmation request", email.htmlBody),
      },
      {
        label: "DEMO 42-day confirmation request",
        interval: "42" as const,
        channel: "SMS" as const,
        recipientEnvVar: "NOTIFICATIONS_TEST_PHONE" as const,
        to: params.testPhone,
        body: demoBody("DEMO 42-day confirmation request", sms),
      },
    ],
  };
}

function redactKnownRecipients(value: string) {
  const replacements = [
    ["NOTIFICATIONS_TEST_PHONE", envValue("NOTIFICATIONS_TEST_PHONE")],
    ["NOTIFICATIONS_TEST_EMAIL", envValue("NOTIFICATIONS_TEST_EMAIL")],
  ] as const;
  let redacted = value;
  for (const [name, recipient] of replacements) {
    if (recipient) redacted = redacted.split(recipient).join(name);
  }
  return redacted;
}

async function sendMessages(messages: DemoMessage[]): Promise<DemoMessageSendResult[]> {
  const results: DemoMessageSendResult[] = [];

  for (const message of messages) {
    try {
      const result =
        message.channel === "SMS"
          ? await sendDemoSms({ toOverride: message.to, body: message.body })
          : await sendDemoEmail({
              toOverride: message.to,
              subject: message.subject ?? message.label,
              textBody: message.body,
              htmlBody: message.htmlBody,
            });

      results.push({
        label: message.label,
        interval: message.interval,
        channel: message.channel,
        provider: result.provider,
        recipientEnvVar: message.recipientEnvVar,
        ok: result.ok,
        idPresent: Boolean(result.id),
      });
    } catch (error) {
      results.push({
        label: message.label,
        interval: message.interval,
        channel: message.channel,
        provider: null,
        recipientEnvVar: message.recipientEnvVar,
        ok: false,
        errorMessage: redactKnownRecipients(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return results;
}

function messageOutput(messages: DemoMessage[]) {
  return messages.map((message) => ({
    label: message.label,
    interval: message.interval,
    channel: message.channel,
    recipientEnvVar: message.recipientEnvVar,
    to: message.recipientEnvVar,
    subject: message.subject,
    body: message.body,
    htmlBodyPresent: Boolean(message.htmlBody),
  }));
}

function countByChannel(messages: Pick<DemoMessage, "channel">[]) {
  return {
    smsCount: messages.filter((message) => message.channel === "SMS").length,
    emailCount: messages.filter((message) => message.channel === "EMAIL").length,
  };
}

function providerSummary(sendResults: DemoMessageSendResult[]) {
  const sms = sendResults.filter((result) => result.channel === "SMS");
  const email = sendResults.filter((result) => result.channel === "EMAIL");

  return {
    sms: {
      okCount: sms.filter((result) => result.ok).length,
      failedCount: sms.filter((result) => !result.ok).length,
    },
    email: {
      okCount: email.filter((result) => result.ok).length,
      failedCount: email.filter((result) => !result.ok).length,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = getDeliveryAppBaseUrlConfig();
  const linkIntervalSelected = includesConfirmationLinkInterval(args.interval);
  const allowLocalhostLinks = envValue("DEMO_ALLOW_LOCALHOST_LINKS").toLowerCase() === "true";
  const warnings: string[] = [];

  if (baseUrl.isDefault) {
    warnings.push(
      "No DELIVERY_APP_BASE_URL, APP_BASE_URL, or NEXT_PUBLIC_APP_BASE_URL is configured; falling back to http://localhost:3000."
    );
  }
  if (linkIntervalSelected && baseUrl.isLocalhost) {
    warnings.push(
      "Confirmation links use localhost. Phone recipients cannot open localhost links unless they are on the same device."
    );
  }
  if (args.mode === "send" && linkIntervalSelected && baseUrl.isLocalhost && !allowLocalhostLinks) {
    throw new Error(
      "Refusing demo send: confirmation link base URL is localhost. Set DELIVERY_APP_BASE_URL, APP_BASE_URL, or NEXT_PUBLIC_APP_BASE_URL to a reachable URL, or set DEMO_ALLOW_LOCALHOST_LINKS=true for an explicit local override."
    );
  }

  const group = await loadDeliveryGroup(args);
  if (!group) {
    throw new Error("Delivery group not found for supplied selector");
  }
  if (!group.isActive) {
    throw new Error("Selected delivery group is inactive/superseded; choose an active group");
  }

  const testEmail = demoRecipientForMode("NOTIFICATIONS_TEST_EMAIL", args.mode);
  const testPhone = demoRecipientForMode("NOTIFICATIONS_TEST_PHONE", args.mode);
  const contactName = formatContactName(group.order.contact);
  const jobName = formatJobName({
    customerDescription: group.order.customerDescription,
    locationDescription: group.order.locationDescription,
  });
  const jobAddress = safeJobAddress(group);
  const reminderMessages = buildReminderMessages({
    interval: args.interval,
    group,
    contactName,
    jobName,
    jobAddress,
    testEmail,
    testPhone,
  });
  const confirmation = linkIntervalSelected
    ? await build42DayMessages({
        group,
        contactName,
        jobName,
        jobAddress,
        testEmail,
        testPhone,
      })
    : null;
  const messages = [...reminderMessages, ...(confirmation?.messages ?? [])];
  const sendResults = args.mode === "send" ? await sendMessages(messages) : [];
  const failedSendResults = sendResults.filter((result) => !result.ok);
  const counts = countByChannel(messages);
  const testPhoneUsedForAllSms = messages
    .filter((message) => message.channel === "SMS")
    .every((message) => message.to === testPhone && message.recipientEnvVar === "NOTIFICATIONS_TEST_PHONE");
  const testEmailUsedForAllEmails = messages
    .filter((message) => message.channel === "EMAIL")
    .every(
      (message) => message.to === testEmail && message.recipientEnvVar === "NOTIFICATIONS_TEST_EMAIL"
    );
  const sendSucceeded =
    args.mode === "send" && messages.length > 0 && sendResults.length === messages.length
      ? failedSendResults.length === 0
      : null;
  const noProviderSendsInPreview = args.mode === "preview" ? sendResults.length === 0 : false;

  console.log(
    JSON.stringify(
      {
        mode: args.mode,
        interval: args.interval,
        orderType: group.orderType,
        orderNumber: group.orderNumber,
        deliveryDate: dateKey(group.deliveryDate),
        messageCount: messages.length,
        smsCount: counts.smsCount,
        emailCount: counts.emailCount,
        testPhoneUsedForAllSms,
        testEmailUsedForAllEmails,
        confirmationLinkPresent: Boolean(confirmation?.link),
        confirmationLink: confirmation?.link ?? null,
        baseUrlUsed: baseUrl.baseUrl,
        baseUrlEnvVarUsed: baseUrl.envVar,
        localhostLinkBlocked:
          args.mode === "send" && linkIntervalSelected && baseUrl.isLocalhost && !allowLocalhostLinks,
        localhostLinksBlockedByDefault: linkIntervalSelected && baseUrl.isLocalhost,
        noProviderSendsInPreview,
        sendSucceeded,
        providerSummary: providerSummary(sendResults),
        warnings,
        demoGuardRequiredForSend: "DEMO_NOTIFICATION_SEND_ENABLED=true",
        selected: {
          deliveryGroupId: group.id,
          orderType: group.orderType,
          orderNumber: group.orderNumber,
          deliveryDate: dateKey(group.deliveryDate),
          customerDescription: group.order.customerDescription,
          locationDescription: group.order.locationDescription,
          buyerGroup: group.order.buyerGroup,
          realContactEmailPresent: Boolean(group.order.contact.email),
          realContactPhonePresent: Boolean(group.order.contact.phone1 || group.order.contact.phone2),
        },
        recipients: {
          sms: "NOTIFICATIONS_TEST_PHONE",
          email: "NOTIFICATIONS_TEST_EMAIL",
        },
        confirmationId: confirmation?.confirmationId ?? null,
        confirmationStatus: confirmation?.confirmationStatus ?? null,
        linkScopeKey: confirmation
          ? buildDeliveryConfirmationScopeKey({
              orderType: group.orderType,
              orderNumber: group.orderNumber,
              deliveryDate: group.deliveryDate,
              deliveryGroupId: group.id,
            })
          : null,
        payment: confirmation?.payment ?? null,
        messages: messageOutput(messages),
        sendResults,
        failedSendResults,
        safety: {
          noCustomerRecipientUsed: true,
          noNotificationAttemptsCreated: true,
          noAcumaticaWriteback: true,
          noProductionProviderArchitectureChanged: true,
          demoOnlyProviderPathUsed: true,
        },
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
