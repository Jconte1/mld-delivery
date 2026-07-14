import {
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import { getDeliveryGroupPaymentEvaluation } from "../lib/delivery-payment/deliveryGroupPayment";
import {
  buildDeliveryConfirmationLink,
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
import { sendDemoEmail, sendDemoSms } from "../lib/demo/demoNotificationDispatch";
import { prisma } from "../lib/prisma";

type DemoMode = "preview" | "send";

type ParsedArgs =
  | {
      mode: DemoMode;
      deliveryGroupId: string;
      orderType?: undefined;
      orderNumber?: undefined;
      deliveryDate?: undefined;
    }
  | {
      mode: DemoMode;
      deliveryGroupId?: undefined;
      orderType: string;
      orderNumber: string;
      deliveryDate: string;
    };

type DemoDeliveryGroup = NonNullable<Awaited<ReturnType<typeof loadDeliveryGroup>>>;

type DemoMessage = {
  label: string;
  channel: "EMAIL" | "SMS";
  to: string;
  subject?: string;
  body: string;
};

function usage() {
  return [
    "Usage:",
    "  npx.cmd --no-install tsx --env-file=.env scripts\\demo-send-delivery-notifications.ts --preview-only --delivery-group-id=<id>",
    "  npx.cmd --no-install tsx --env-file=.env scripts\\demo-send-delivery-notifications.ts --preview-only --order-type=SO --order-number=SO40466 --delivery-date=2026-07-22",
    "  npx.cmd --no-install tsx --env-file=.env scripts\\demo-send-delivery-notifications.ts --send --delivery-group-id=<id>",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: DemoMode = "preview";
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
    return { mode, deliveryGroupId };
  }

  if (orderType && orderNumber && deliveryDate) {
    return { mode, orderType, orderNumber, deliveryDate };
  }

  throw new Error(usage());
}

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function demoRecipientForMode(name: "NOTIFICATIONS_TEST_EMAIL" | "NOTIFICATIONS_TEST_PHONE", mode: DemoMode) {
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

function buildReminderMessages(params: {
  group: DemoDeliveryGroup;
  contactName: string;
  jobName: string;
  jobAddress: string;
  testEmail: string;
  testPhone: string;
}) {
  const intervals = [
    { label: "DEMO 180-day reminder", intervalType: NotificationIntervalType.DAY_180 },
    { label: "DEMO 90-day reminder", intervalType: NotificationIntervalType.DAY_90 },
    { label: "DEMO 60-day reminder", intervalType: NotificationIntervalType.DAY_60 },
  ] as const;
  const messages: DemoMessage[] = [];

  for (const interval of intervals) {
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
      channel: "EMAIL",
      to: params.testEmail,
      subject: demoSubject(interval.label, subject),
      body: demoBody(interval.label, body),
    });
    messages.push({
      label: interval.label,
      channel: "SMS",
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
        channel: "EMAIL" as const,
        to: params.testEmail,
        subject: demoSubject("DEMO 42-day confirmation request", email.subject),
        body: demoBody("DEMO 42-day confirmation request", email.body),
      },
      {
        label: "DEMO 42-day confirmation request",
        channel: "SMS" as const,
        to: params.testPhone,
        body: demoBody("DEMO 42-day confirmation request", sms),
      },
    ],
  };
}

async function sendMessages(messages: DemoMessage[]) {
  const results = [];
  for (const message of messages) {
    if (message.channel === "SMS") {
      results.push(await sendDemoSms({ toOverride: message.to, body: message.body }));
    } else {
      results.push(
        await sendDemoEmail({
          toOverride: message.to,
          subject: message.subject ?? message.label,
          textBody: message.body,
        })
      );
    }
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
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
    group,
    contactName,
    jobName,
    jobAddress,
    testEmail,
    testPhone,
  });
  const confirmation = await build42DayMessages({
    group,
    contactName,
    jobName,
    jobAddress,
    testEmail,
    testPhone,
  });
  const messages = [...reminderMessages, ...confirmation.messages];
  const sendResults = args.mode === "send" ? await sendMessages(messages) : [];

  console.log(
    JSON.stringify(
      {
        mode: args.mode,
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
        confirmationLink: confirmation.link,
        confirmationId: confirmation.confirmationId,
        confirmationStatus: confirmation.confirmationStatus,
        linkScopeKey: buildDeliveryConfirmationScopeKey({
          orderType: group.orderType,
          orderNumber: group.orderNumber,
          deliveryDate: group.deliveryDate,
          deliveryGroupId: group.id,
        }),
        payment: confirmation.payment,
        messages,
        sendResults,
        safety: {
          noCustomerRecipientUsed: true,
          noNotificationAttemptsCreated: true,
          noAcumaticaWriteback: true,
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
