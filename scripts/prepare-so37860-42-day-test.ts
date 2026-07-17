import {
  DeliveryConfirmationStatus,
  NotificationActionType,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
} from "../lib/generated/prisma/client";
import {
  DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
  find42DayDeliveryConfirmationTargetGroups,
  is42DayDeliveryGroupEligible,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import {
  buildDeliveryConfirmationLink,
  getDeliveryAppBaseUrlConfig,
  newDeliveryConfirmationLinkToken,
} from "../lib/notifications/deliveryConfirmationLinks";
import {
  ensurePendingDeliveryConfirmation,
  isDeliveryGroupDateConfirmed,
} from "../lib/notifications/deliveryConfirmationState";
import {
  buildNotificationDedupeKey,
  dateKey,
  formatJobName,
} from "../lib/notifications/helpers";
import { QueueErpClient } from "../lib/erp/queueErpClient";
import { prisma } from "../lib/prisma";

const TEST_ORDER_TYPE = "SO";
const TEST_ORDER_NUMBER = "SO37860";

type Args = {
  prepareLink: boolean;
  checkQueueRead: boolean;
  deliveryDate?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prepareLink: false,
    checkQueueRead: false,
  };

  for (const arg of argv) {
    if (arg === "--prepare-link") args.prepareLink = true;
    else if (arg === "--check-queue-read") args.checkQueueRead = true;
    else if (arg.startsWith("--delivery-date=")) {
      args.deliveryDate = dateKey(arg.slice("--delivery-date=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function redactPhone(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 4) return `***-***-${digits.slice(-4)}`;
  return "***";
}

function redactEmail(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const [local, domain] = trimmed.split("@");
  if (!domain) return "***";
  const prefix = local ? `${local.slice(0, 1)}***` : "***";
  return `${prefix}@${domain}`;
}

function customAttribute(row: Record<string, unknown> | null, attributeName: string) {
  if (!row) return { exposed: false, value: null as string | null };
  const custom = row.custom;
  if (custom && typeof custom === "object" && "Document" in custom) {
    const document = (custom as { Document?: unknown }).Document;
    if (document && typeof document === "object" && attributeName in document) {
      const raw = (document as Record<string, unknown>)[attributeName];
      if (raw == null) return { exposed: true, value: null };
      if (typeof raw === "object" && raw !== null && "value" in raw) {
        const value = (raw as { value?: unknown }).value;
        return { exposed: true, value: value == null ? null : String(value) };
      }
      return { exposed: true, value: String(raw) };
    }
  }

  for (const key of [attributeName, `Document.${attributeName}`]) {
    if (key in row) {
      const raw = row[key];
      if (raw == null) return { exposed: true, value: null };
      if (typeof raw === "object" && raw !== null && "value" in raw) {
        const value = (raw as { value?: unknown }).value;
        return { exposed: true, value: value == null ? null : String(value) };
      }
      return { exposed: true, value: String(raw) };
    }
  }

  return { exposed: false, value: null };
}

async function safetyCounts() {
  const [notificationEvents, notificationAttempts, deliveryConfirmations] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
    prisma.deliveryConfirmation.count(),
  ]);

  return { notificationEvents, notificationAttempts, deliveryConfirmations };
}

async function fetchQueueReadState() {
  const client = new QueueErpClient();
  const rows = (await client.fetchDeliverySalesOrderByOrderNumber(
    TEST_ORDER_NUMBER,
    TEST_ORDER_TYPE
  )) as Record<string, unknown>[];
  const row = rows[0] ?? null;

  return {
    fetched: rows.length > 0,
    rows: rows.length,
    confirmationAttributes: {
      CONFIRMVIA: customAttribute(row, "AttributeCONFIRMVIA"),
      CONFIRMWTH: customAttribute(row, "AttributeCONFIRMWTH"),
    },
  };
}

async function buildSnapshot() {
  const order = await prisma.order.findFirst({
    where: { orderType: TEST_ORDER_TYPE, orderNumber: TEST_ORDER_NUMBER },
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      status: true,
      internalLifecycleStatus: true,
      customerDescription: true,
      locationDescription: true,
      contactId: true,
      contact: {
        select: {
          contactId: true,
          displayName: true,
          companyName: true,
          firstName: true,
          lastName: true,
          email: true,
          phone1: true,
          phone2: true,
          smsOptIn: true,
          emailOptIn: true,
          smsOptOuts: {
            where: { isActive: true },
            select: { phone: true },
          },
          emailOptOuts: {
            where: { isActive: true },
            select: { email: true },
          },
        },
      },
      deliveryGroups: {
        orderBy: [{ isActive: "desc" }, { deliveryDate: "asc" }],
        select: {
          id: true,
          deliveryDate: true,
          isActive: true,
          status: true,
          lineCount: true,
          deliveryConfirmations: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              status: true,
              deliveryDate: true,
              linkToken: true,
              confirmedAt: true,
            },
          },
        },
      },
    },
  });

  const events = await prisma.notificationEvent.findMany({
    where: {
      orderType: TEST_ORDER_TYPE,
      orderNumber: TEST_ORDER_NUMBER,
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    },
    orderBy: [{ deliveryDate: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      deliveryGroupId: true,
      deliveryDate: true,
      status: true,
      selectedChannel: true,
      recipientEmail: true,
      recipientPhone: true,
      reasonSkipped: true,
      dedupeKey: true,
    },
  });

  return { order, events };
}

function selectedDeliveryGroup(
  order: NonNullable<Awaited<ReturnType<typeof buildSnapshot>>["order"]>,
  deliveryDate?: string
) {
  const activeGroups = order.deliveryGroups.filter((group) => group.isActive);
  if (deliveryDate) {
    return activeGroups.find((group) => dateKey(group.deliveryDate) === deliveryDate) ?? null;
  }
  return activeGroups[0] ?? null;
}

async function prepareLink(deliveryDate?: string) {
  const baseUrl = getDeliveryAppBaseUrlConfig();
  if (baseUrl.isLocalhost) {
    throw new Error(
      `Delivery app base URL is local (${baseUrl.baseUrl}); set DELIVERY_APP_BASE_URL to a reachable URL before preparing the test link`
    );
  }

  const testPhone = process.env.NOTIFICATIONS_TEST_PHONE?.trim() || null;
  const testEmail = process.env.NOTIFICATIONS_TEST_EMAIL?.trim() || null;
  if (!testPhone && !testEmail) {
    throw new Error("NOTIFICATIONS_TEST_PHONE or NOTIFICATIONS_TEST_EMAIL is required for test-recipient setup");
  }

  const { order } = await buildSnapshot();
  if (!order) {
    return { prepared: false, reason: "order_not_found" };
  }

  const selected = selectedDeliveryGroup(order, deliveryDate);
  if (!selected) {
    return { prepared: false, reason: "no_active_delivery_group_for_requested_date" };
  }

  const targetGroups = await find42DayDeliveryConfirmationTargetGroups(selected.deliveryDate);
  const targetGroup = targetGroups.find(
    (group) => group.id === selected.id && group.orderNumber === TEST_ORDER_NUMBER
  );
  if (!targetGroup) {
    return { prepared: false, reason: "selected_group_not_returned_by_42_day_target_query" };
  }

  const eligible = is42DayDeliveryGroupEligible(targetGroup);
  const alreadyConfirmedForDeliveryDate = await isDeliveryGroupDateConfirmed({
    deliveryGroupId: targetGroup.id,
    deliveryDate: targetGroup.deliveryDate,
  });

  if (!eligible) {
    return { prepared: false, reason: "selected_group_not_eligible_for_42_day" };
  }
  if (alreadyConfirmedForDeliveryDate) {
    return {
      prepared: false,
      reason: DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
    };
  }

  const finalConfirmation = selected.deliveryConfirmations.find(
    (confirmation) =>
      confirmation.status === DeliveryConfirmationStatus.NEW_DATE_REQUESTED ||
      confirmation.status === DeliveryConfirmationStatus.CONFIRMED
  );
  if (finalConfirmation) {
    return {
      prepared: false,
      reason: `delivery_confirmation_already_final_${finalConfirmation.status}`,
    };
  }

  const dedupeKey = buildNotificationDedupeKey({
    orderType: targetGroup.order.orderType,
    orderNumber: targetGroup.order.orderNumber,
    deliveryDate: targetGroup.deliveryDate,
    intervalType: NotificationIntervalType.DAY_42,
    actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
  });

  const selectedChannel = testPhone ? NotificationChannel.SMS : NotificationChannel.EMAIL;
  const channelReason = testPhone ? "test_recipient_override_sms" : "test_recipient_override_email";
  const eventData = {
    orderId: targetGroup.order.id,
    deliveryGroupId: targetGroup.id,
    contactId: targetGroup.order.contact.contactId,
    orderType: targetGroup.order.orderType,
    orderNumber: targetGroup.order.orderNumber,
    deliveryDate: targetGroup.deliveryDate,
    intervalType: NotificationIntervalType.DAY_42,
    actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    selectedChannel,
    channelReason,
    recipientEmail: selectedChannel === NotificationChannel.EMAIL ? testEmail : null,
    recipientPhone: selectedChannel === NotificationChannel.SMS ? testPhone : null,
    status: NotificationEventStatus.SCHEDULED,
    reasonSkipped: null,
    scheduledAt: new Date(),
  };

  const existingEvent = await prisma.notificationEvent.findUnique({
    where: { dedupeKey },
    select: { id: true, status: true },
  });

  const mutableStatuses = new Set<NotificationEventStatus>([
    NotificationEventStatus.PENDING,
    NotificationEventStatus.SCHEDULED,
    NotificationEventStatus.SKIPPED,
    NotificationEventStatus.DEDUPED,
  ]);
  if (existingEvent && !mutableStatuses.has(existingEvent.status)) {
    return {
      prepared: false,
      reason: `existing_42_day_event_is_terminal_${existingEvent.status}`,
      eventId: existingEvent.id,
    };
  }

  const event = existingEvent
    ? await prisma.notificationEvent.update({
        where: { id: existingEvent.id },
        data: eventData,
        select: {
          id: true,
          status: true,
          selectedChannel: true,
          recipientEmail: true,
          recipientPhone: true,
        },
      })
    : await prisma.notificationEvent.create({
        data: { ...eventData, dedupeKey },
        select: {
          id: true,
          status: true,
          selectedChannel: true,
          recipientEmail: true,
          recipientPhone: true,
        },
      });

  const existingConfirmation = await prisma.deliveryConfirmation.findUnique({
    where: {
      deliveryGroupId_deliveryDate: {
        deliveryGroupId: targetGroup.id,
        deliveryDate: targetGroup.deliveryDate,
      },
    },
    select: { id: true, linkToken: true, status: true },
  });

  const linkToken = existingConfirmation?.linkToken ?? newDeliveryConfirmationLinkToken();
  const confirmation = await ensurePendingDeliveryConfirmation({
    orderId: targetGroup.order.id,
    deliveryGroupId: targetGroup.id,
    notificationEventId: event.id,
    orderType: targetGroup.order.orderType,
    orderNumber: targetGroup.order.orderNumber,
    deliveryDate: targetGroup.deliveryDate,
    contactId: targetGroup.order.contact.contactId,
    linkToken,
    linkCreatedAt: new Date(),
    linkExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  return {
    prepared: true,
    event: {
      ...event,
      recipientPhone: redactPhone(event.recipientPhone),
      recipientEmail: redactEmail(event.recipientEmail),
    },
    confirmation: {
      id: confirmation.id,
      status: confirmation.status,
      reused: Boolean(existingConfirmation),
      linkTokenPresent: Boolean(confirmation.linkToken),
    },
    confirmationLink: confirmation.linkToken ? buildDeliveryConfirmationLink(confirmation.linkToken) : null,
    deliveryGroupId: targetGroup.id,
    deliveryDate: dateKey(targetGroup.deliveryDate),
    testRecipientOverride: {
      phone: redactPhone(testPhone),
      email: redactEmail(testEmail),
      realCustomerRecipientUsed: false,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const before = await safetyCounts();
  const snapshot = await buildSnapshot();
  const baseUrl = getDeliveryAppBaseUrlConfig();
  const selected = snapshot.order ? selectedDeliveryGroup(snapshot.order, args.deliveryDate) : null;
  const sameDateAlreadyConfirmed = selected
    ? await isDeliveryGroupDateConfirmed({
        deliveryGroupId: selected.id,
        deliveryDate: selected.deliveryDate,
      })
    : false;

  const queueRead = args.checkQueueRead
    ? await fetchQueueReadState().catch((error) => ({
        fetched: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    : { skipped: true, reason: "run with --check-queue-read to perform read-only mld-queue fetch" };

  const prepared = args.prepareLink ? await prepareLink(args.deliveryDate) : null;
  const after = await safetyCounts();

  const output = {
    order: snapshot.order
      ? {
          exists: true,
          orderType: snapshot.order.orderType,
          orderNumber: snapshot.order.orderNumber,
          status: snapshot.order.status,
          internalLifecycleStatus: snapshot.order.internalLifecycleStatus,
          contactId: snapshot.order.contactId,
          customerDescription: snapshot.order.customerDescription,
          locationDescription: snapshot.order.locationDescription,
          jobName: formatJobName({
            customerDescription: snapshot.order.customerDescription,
            locationDescription: snapshot.order.locationDescription,
          }),
          contact: {
            contactId: snapshot.order.contact.contactId,
            displayName: snapshot.order.contact.displayName,
            companyName: snapshot.order.contact.companyName,
            email: redactEmail(snapshot.order.contact.email),
            phone1: redactPhone(snapshot.order.contact.phone1),
            phone2: redactPhone(snapshot.order.contact.phone2),
            smsOptIn: snapshot.order.contact.smsOptIn,
            emailOptIn: snapshot.order.contact.emailOptIn,
            activeSmsOptOuts: snapshot.order.contact.smsOptOuts.length,
            activeEmailOptOuts: snapshot.order.contact.emailOptOuts.length,
          },
          activeDeliveryGroups: snapshot.order.deliveryGroups
            .filter((group) => group.isActive)
            .map((group) => ({
              id: group.id,
              deliveryDate: dateKey(group.deliveryDate),
              status: group.status,
              lineCount: group.lineCount,
              confirmations: group.deliveryConfirmations.map((confirmation) => ({
                id: confirmation.id,
                status: confirmation.status,
                deliveryDate: dateKey(confirmation.deliveryDate),
                confirmedAtSet: Boolean(confirmation.confirmedAt),
                linkTokenPresent: Boolean(confirmation.linkToken),
              })),
            })),
        }
      : { exists: false, orderType: TEST_ORDER_TYPE, orderNumber: TEST_ORDER_NUMBER },
    selectedDeliveryGroup: selected
      ? {
          id: selected.id,
          deliveryDate: dateKey(selected.deliveryDate),
          sameDateAlreadyConfirmed,
          wouldSkip42DayBecauseAlreadyConfirmed: sameDateAlreadyConfirmed,
        }
      : null,
    existing42DayEvents: snapshot.events.map((event) => ({
      ...event,
      deliveryDate: dateKey(event.deliveryDate),
      recipientPhone: redactPhone(event.recipientPhone),
      recipientEmail: redactEmail(event.recipientEmail),
    })),
    deliveryAppBaseUrl: baseUrl,
    queueRead,
    prepared,
    safetyCounts: {
      before,
      after,
      notificationAttemptsUnchanged: before.notificationAttempts === after.notificationAttempts,
      noSmsOrEmailSent: true,
      noAcumaticaWritebackPerformed: true,
    },
    stopPoint: {
      didNotConfirmSO37860: true,
      didNotPerformLiveAcumaticaWriteback: true,
      didNotSendNotifications: true,
    },
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
