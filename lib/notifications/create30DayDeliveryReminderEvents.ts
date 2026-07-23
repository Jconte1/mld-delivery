import { getDeliveryGroupPaymentEvaluation } from "@/lib/delivery-payment/deliveryGroupPayment";
import { getDeliveryGroupReadiness } from "@/lib/delivery-readiness/orderLineReadiness";
import { importSalesOrdersForLineRequestedOn } from "@/lib/erp/importSalesOrders";
import {
  InternalOrderLifecycleStatus,
  NotificationActionType,
  NotificationEventStatus,
  NotificationIntervalType,
  Prisma,
} from "@/lib/generated/prisma/client";
import {
  attachDeliveryDetailsLinkToNotificationEvent,
  buildDeliveryDetailsLink,
  ensureDeliveryDetailsLink,
  markDeliveryDetailsLinkCreatedFromEvent,
} from "@/lib/notifications/deliveryDetailsLinks";
import {
  buildNotificationDedupeKey,
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getNotificationTargetDate,
  selectNotificationChannel,
  shouldSkipNotificationRunForWeekend,
} from "@/lib/notifications/helpers";
import {
  render30DayDeliveryReminderEmail,
  render30DayDeliveryReminderSms,
} from "@/lib/notifications/deliveryReminder30Day";
import { getActiveSalespersonContactMap } from "@/lib/notifications/salespersonContactCache";
import { prisma } from "@/lib/prisma";

export const DELIVERY_REMINDER_30_DAY_INTERVAL_DAYS = 30;
export const DELIVERY_REMINDER_30_DAY_REQUESTED_ON_TIME = "09:19:00.000Z";
export const DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON =
  "not_confirmed_in_acumatica";

type DeliveryReminder30DayClient = Pick<
  typeof prisma,
  "orderDeliveryGroup" | "notificationEvent" | "deliveryDetailsLink"
> &
  Partial<Pick<typeof prisma, "salespersonContact">>;

export type DeliveryReminder30DayEventReport = {
  orderType: string;
  orderNumber: string;
  deliveryGroupId: string;
  deliveryDate: string;
  eventId: string | null;
  dedupeKey: string;
  status: string;
  selectedChannel: string | null;
  reasonSkipped: string | null;
  acumaticaConfirmVia: string | null;
  detailsLinkCreated: boolean;
  detailsLinkReused: boolean;
  detailsLinkTokenPresent: boolean;
  detailsLinkUrl: string | null;
  subject: string | null;
  renderedMessagePreview: string;
  itemLineCount: number;
  paymentStatus: string | null;
  amountDueNowRounded: string | null;
  paymentReminderApplies: boolean;
};

export type Create30DayDeliveryReminderEventsSummary = {
  runDate: string;
  targetDeliveryDate: string;
  importRequestedOn: string;
  importResult: Awaited<ReturnType<typeof importSalesOrdersForLineRequestedOn>> | null;
  targetDeliveryGroups: number;
  eligibleDeliveryGroups: number;
  deliveryGroupsSkippedIneligible: number;
  deliveryGroupsSkippedNotConfirmedInAcumatica: number;
  deliveryGroupsSkippedNoChannel: number;
  eventsCreated: number;
  eventsDeduped: number;
  eventsSkipped: number;
  eventsWouldCreate: number;
  scheduledEvents: number;
  scheduledByChannel: {
    SMS: number;
    EMAIL: number;
  };
  detailsLinksCreated: number;
  detailsLinksReused: number;
  paymentDueCount: number;
  weekendSkipped: boolean;
  dryRun: boolean;
  skippedReasons: Record<string, number>;
  eventReports: DeliveryReminder30DayEventReport[];
};

export type Create30DayDeliveryReminderEventsOptions = {
  runDate?: Date | string;
  dryRun?: boolean;
  now?: Date;
  prismaClient?: DeliveryReminder30DayClient;
};

type DeliveryReminder30DayTargetGroup = Awaited<
  ReturnType<typeof find30DayDeliveryReminderTargetGroups>
>[number];

function emptySummary(params: {
  runDate: string;
  targetDeliveryDate: string;
  importRequestedOn: string;
  dryRun: boolean;
}): Create30DayDeliveryReminderEventsSummary {
  return {
    runDate: params.runDate,
    targetDeliveryDate: params.targetDeliveryDate,
    importRequestedOn: params.importRequestedOn,
    importResult: null,
    targetDeliveryGroups: 0,
    eligibleDeliveryGroups: 0,
    deliveryGroupsSkippedIneligible: 0,
    deliveryGroupsSkippedNotConfirmedInAcumatica: 0,
    deliveryGroupsSkippedNoChannel: 0,
    eventsCreated: 0,
    eventsDeduped: 0,
    eventsSkipped: 0,
    eventsWouldCreate: 0,
    scheduledEvents: 0,
    scheduledByChannel: {
      SMS: 0,
      EMAIL: 0,
    },
    detailsLinksCreated: 0,
    detailsLinksReused: 0,
    paymentDueCount: 0,
    weekendSkipped: false,
    dryRun: params.dryRun,
    skippedReasons: {},
    eventReports: [],
  };
}

function normalizeStatus(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
}

function isCompletedOrCancelledStatus(value: string | null | undefined) {
  return ["cancelled", "canceled", "completed", "closed"].includes(normalizeStatus(value));
}

function isBlockedLifecycleStatus(value: string | null | undefined) {
  const blockedStatuses = new Set<string>([
    InternalOrderLifecycleStatus.BLOCKED,
    InternalOrderLifecycleStatus.MANUAL_REVIEW,
    InternalOrderLifecycleStatus.COMPLETED,
    InternalOrderLifecycleStatus.CANCELLED,
  ]);
  return blockedStatuses.has(value ?? "");
}

function addSkippedReason(summary: Create30DayDeliveryReminderEventsSummary, reason: string) {
  summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
}

function safeJobAddress(address: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}) {
  return formatJobAddress(address) || "the job site";
}

function amountIsMeaningful(value: string | null | undefined) {
  if (!value) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 2;
}

function paymentReminderApplies(
  payment: Awaited<ReturnType<typeof getDeliveryGroupPaymentEvaluation>>
) {
  return (
    payment.paymentStatus === "balance_due" &&
    amountIsMeaningful(payment.amountDueNowRounded) &&
    payment.calculationWarnings.length === 0
  );
}

function validateRenderedMessage(params: {
  orderType: string;
  orderNumber: string;
  subject: string | null;
  renderedMessagePreview: string;
}) {
  const combined = [params.subject, params.renderedMessagePreview].filter(Boolean).join("\n");
  if (/\b(null|undefined)\b/i.test(combined) || /:\s*MAIN\s*$/m.test(combined)) {
    throw new Error(
      `Rendered 30-day message contains placeholder text order=${params.orderType} ${params.orderNumber}`
    );
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function normalize30DayConfirmVia(value: unknown) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

export function requestedOnFor30DayTargetDate(targetDeliveryDate: Date | string) {
  return `${dateKey(targetDeliveryDate)}T${DELIVERY_REMINDER_30_DAY_REQUESTED_ON_TIME}`;
}

export function is30DayDeliveryGroupEligible(group: DeliveryReminder30DayTargetGroup) {
  return !(
    isCompletedOrCancelledStatus(group.order.status) ||
    isCompletedOrCancelledStatus(group.status) ||
    isBlockedLifecycleStatus(group.order.internalLifecycleStatus)
  );
}

export async function find30DayDeliveryReminderTargetGroups(
  targetDeliveryDate: Date | string,
  client: DeliveryReminder30DayClient = prisma
) {
  return client.orderDeliveryGroup.findMany({
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
      isActive: true,
      lineCount: true,
      lastSeenAt: true,
      status: true,
      order: {
        select: {
          id: true,
          orderType: true,
          orderNumber: true,
          status: true,
          internalLifecycleStatus: true,
          buyerGroup: true,
          confirmVia: true,
          salespersonNumber: true,
          customerDescription: true,
          locationDescription: true,
          address: {
            select: {
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              postalCode: true,
            },
          },
          contact: {
            select: {
              contactId: true,
              companyName: true,
              displayName: true,
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
        },
      },
    },
  });
}

async function createSkippedEvent(params: {
  client: DeliveryReminder30DayClient;
  deliveryGroup: DeliveryReminder30DayTargetGroup;
  dedupeKey: string;
  reason: string;
  dryRun: boolean;
}) {
  if (params.dryRun) {
    return null;
  }

  return params.client.notificationEvent.create({
    data: {
      orderId: params.deliveryGroup.order.id,
      deliveryGroupId: params.deliveryGroup.id,
      contactId: params.deliveryGroup.order.contact.contactId,
      orderType: params.deliveryGroup.order.orderType,
      orderNumber: params.deliveryGroup.order.orderNumber,
      deliveryDate: params.deliveryGroup.deliveryDate,
      intervalType: NotificationIntervalType.DAY_30,
      actionType: NotificationActionType.DELIVERY_REMINDER,
      dedupeKey: params.dedupeKey,
      selectedChannel: null,
      channelReason: params.reason,
      recipientEmail: null,
      recipientPhone: null,
      status: NotificationEventStatus.SKIPPED,
      reasonSkipped: params.reason,
      scheduledAt: null,
    },
    select: notificationEventSelect,
  });
}

const notificationEventSelect = {
  id: true,
  dedupeKey: true,
  intervalType: true,
  actionType: true,
  status: true,
  selectedChannel: true,
  reasonSkipped: true,
  detailsLinkId: true,
} as const;

export async function create30DayDeliveryReminderEvents(
  options: Create30DayDeliveryReminderEventsOptions = {}
): Promise<Create30DayDeliveryReminderEventsSummary> {
  const client = options.prismaClient ?? prisma;
  const runDate = dateKey(options.runDate ?? new Date());
  const dryRun = options.dryRun ?? false;
  const targetDeliveryDate = dateKey(
    getNotificationTargetDate(runDate, DELIVERY_REMINDER_30_DAY_INTERVAL_DAYS)
  );
  const importRequestedOn = requestedOnFor30DayTargetDate(targetDeliveryDate);
  const summary = emptySummary({
    runDate,
    targetDeliveryDate,
    importRequestedOn,
    dryRun,
  });

  if (shouldSkipNotificationRunForWeekend(runDate)) {
    summary.weekendSkipped = true;
    return summary;
  }

  summary.importResult = await importSalesOrdersForLineRequestedOn(importRequestedOn);

  const deliveryGroups = await find30DayDeliveryReminderTargetGroups(targetDeliveryDate, client);
  summary.targetDeliveryGroups = deliveryGroups.length;

  const salespersonContactsByNumber = await getActiveSalespersonContactMap(
    deliveryGroups.map((deliveryGroup) => deliveryGroup.order.salespersonNumber),
    client
  );

  for (const deliveryGroup of deliveryGroups) {
    const order = deliveryGroup.order;
    if (!is30DayDeliveryGroupEligible(deliveryGroup)) {
      summary.deliveryGroupsSkippedIneligible += 1;
      continue;
    }

    summary.eligibleDeliveryGroups += 1;

    const dedupeKey = buildNotificationDedupeKey({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: deliveryGroup.deliveryDate,
      intervalType: NotificationIntervalType.DAY_30,
      actionType: NotificationActionType.DELIVERY_REMINDER,
    });

    const existingEvent = await client.notificationEvent.findUnique({
      where: { dedupeKey },
      select: notificationEventSelect,
    });
    if (existingEvent) {
      summary.eventsDeduped += 1;
      summary.eventReports.push({
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryGroupId: deliveryGroup.id,
        deliveryDate: dateKey(deliveryGroup.deliveryDate),
        eventId: existingEvent.id,
        dedupeKey: existingEvent.dedupeKey,
        status: existingEvent.status,
        selectedChannel: existingEvent.selectedChannel,
        reasonSkipped: existingEvent.reasonSkipped,
        acumaticaConfirmVia: normalize30DayConfirmVia(order.confirmVia),
        detailsLinkCreated: false,
        detailsLinkReused: Boolean(existingEvent.detailsLinkId),
        detailsLinkTokenPresent: Boolean(existingEvent.detailsLinkId),
        detailsLinkUrl: null,
        subject: null,
        renderedMessagePreview: existingEvent.reasonSkipped ?? "Existing event deduped.",
        itemLineCount: 0,
        paymentStatus: null,
        amountDueNowRounded: null,
        paymentReminderApplies: false,
      });
      continue;
    }

    const acumaticaConfirmVia = normalize30DayConfirmVia(order.confirmVia);
    if (!acumaticaConfirmVia) {
      summary.deliveryGroupsSkippedNotConfirmedInAcumatica += 1;
      summary.eventsSkipped += 1;
      summary.eventsWouldCreate += dryRun ? 1 : 0;
      addSkippedReason(summary, DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON);

      try {
        const skippedEvent = await createSkippedEvent({
          client,
          deliveryGroup,
          dedupeKey,
          reason: DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON,
          dryRun,
        });
        if (skippedEvent) summary.eventsCreated += 1;

        summary.eventReports.push({
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          deliveryGroupId: deliveryGroup.id,
          deliveryDate: dateKey(deliveryGroup.deliveryDate),
          eventId: skippedEvent?.id ?? null,
          dedupeKey,
          status: NotificationEventStatus.SKIPPED,
          selectedChannel: null,
          reasonSkipped: DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON,
          acumaticaConfirmVia: null,
          detailsLinkCreated: false,
          detailsLinkReused: false,
          detailsLinkTokenPresent: false,
          detailsLinkUrl: null,
          subject: null,
          renderedMessagePreview: DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON,
          itemLineCount: 0,
          paymentStatus: null,
          amountDueNowRounded: null,
          paymentReminderApplies: false,
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        summary.eventsDeduped += 1;
      }

      continue;
    }

    const channel = selectNotificationChannel(order.contact, {
      activeSmsOptOutPhones: order.contact.smsOptOuts.map((optOut) => optOut.phone),
      activeEmailOptOutEmails: order.contact.emailOptOuts.map((optOut) => optOut.email),
    });
    const shouldSkipForNoChannel = channel.selectedChannel === null;
    if (shouldSkipForNoChannel) {
      summary.deliveryGroupsSkippedNoChannel += 1;
      summary.eventsSkipped += 1;
      summary.eventsWouldCreate += dryRun ? 1 : 0;
      addSkippedReason(summary, channel.channelReason);

      let skippedEventId: string | null = null;
      try {
        const skippedEvent = await createSkippedEvent({
          client,
          deliveryGroup,
          dedupeKey,
          reason: channel.channelReason,
          dryRun,
        });
        if (skippedEvent) {
          summary.eventsCreated += 1;
          skippedEventId = skippedEvent.id;
        }
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        summary.eventsDeduped += 1;
      }

      summary.eventReports.push({
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryGroupId: deliveryGroup.id,
        deliveryDate: dateKey(deliveryGroup.deliveryDate),
        eventId: skippedEventId,
        dedupeKey,
        status: NotificationEventStatus.SKIPPED,
        selectedChannel: null,
        reasonSkipped: channel.channelReason,
        acumaticaConfirmVia,
        detailsLinkCreated: false,
        detailsLinkReused: false,
        detailsLinkTokenPresent: false,
        detailsLinkUrl: null,
        subject: null,
        renderedMessagePreview: channel.channelReason,
        itemLineCount: 0,
        paymentStatus: null,
        amountDueNowRounded: null,
        paymentReminderApplies: false,
      });
      continue;
    }

    const contactName = formatContactName(order.contact);
    const jobName = formatJobName({
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
    });
    const jobAddress = safeJobAddress(order.address ?? {});
    const salespersonContact = order.salespersonNumber
      ? salespersonContactsByNumber.get(order.salespersonNumber) ?? null
      : null;
    const readiness = await getDeliveryGroupReadiness(deliveryGroup.id);
    const payment = await getDeliveryGroupPaymentEvaluation(deliveryGroup.id);
    const showPaymentReminder = paymentReminderApplies(payment);
    if (showPaymentReminder) summary.paymentDueCount += 1;

    let detailsLinkUrl = "https://mld-delivery.example.test/delivery/details/dry-run";
    let detailsLinkCreated = false;
    let detailsLinkId: string | null = null;
    if (!dryRun) {
      const detailsLink = await ensureDeliveryDetailsLink(
        {
          orderId: order.id,
          orderDeliveryGroupId: deliveryGroup.id,
          deliveryDate: deliveryGroup.deliveryDate,
        },
        client
      );
      detailsLinkCreated = detailsLink.created;
      detailsLinkId = detailsLink.link.id;
      detailsLinkUrl = buildDeliveryDetailsLink(detailsLink.link.token);
      if (detailsLink.created) summary.detailsLinksCreated += 1;
      else summary.detailsLinksReused += 1;
    }

    const smsMessage = render30DayDeliveryReminderSms({
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: deliveryGroup.deliveryDate,
      detailsLink: detailsLinkUrl,
      paymentDue: showPaymentReminder,
      amountDueNowRounded: payment.amountDueNowRounded,
      lines: readiness.lines,
      salespersonContact,
    });
    const emailMessage = render30DayDeliveryReminderEmail({
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: deliveryGroup.deliveryDate,
      detailsLink: detailsLinkUrl,
      paymentDue: showPaymentReminder,
      amountDueNowRounded: payment.amountDueNowRounded,
      lines: readiness.lines,
      salespersonContact,
    });
    const subject = channel.selectedChannel === "EMAIL" ? emailMessage.subject : null;
    const renderedMessagePreview =
      channel.selectedChannel === "EMAIL" ? emailMessage.body : smsMessage;

    validateRenderedMessage({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      subject,
      renderedMessagePreview,
    });

    if (dryRun) {
      summary.eventsWouldCreate += 1;
      summary.eventReports.push({
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryGroupId: deliveryGroup.id,
        deliveryDate: dateKey(deliveryGroup.deliveryDate),
        eventId: null,
        dedupeKey,
        status: NotificationEventStatus.SCHEDULED,
        selectedChannel: channel.selectedChannel,
        reasonSkipped: null,
        acumaticaConfirmVia,
        detailsLinkCreated: false,
        detailsLinkReused: false,
        detailsLinkTokenPresent: false,
        detailsLinkUrl,
        subject,
        renderedMessagePreview,
        itemLineCount: readiness.lines.length,
        paymentStatus: payment.paymentStatus,
        amountDueNowRounded: payment.amountDueNowRounded,
        paymentReminderApplies: showPaymentReminder,
      });
      continue;
    }

    try {
      const event = await client.notificationEvent.create({
        data: {
          orderId: order.id,
          deliveryGroupId: deliveryGroup.id,
          contactId: order.contact.contactId,
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          deliveryDate: deliveryGroup.deliveryDate,
          intervalType: NotificationIntervalType.DAY_30,
          actionType: NotificationActionType.DELIVERY_REMINDER,
          dedupeKey,
          selectedChannel: channel.selectedChannel,
          channelReason: channel.channelReason,
          recipientEmail: channel.selectedChannel === "EMAIL" ? channel.recipientEmail : null,
          recipientPhone: channel.selectedChannel === "SMS" ? channel.recipientPhone : null,
          status: NotificationEventStatus.SCHEDULED,
          reasonSkipped: null,
          scheduledAt: dateFromKey(runDate),
          detailsLinkId,
        },
        select: notificationEventSelect,
      });

      if (detailsLinkId) {
        await attachDeliveryDetailsLinkToNotificationEvent(
          { notificationEventId: event.id, detailsLinkId },
          client
        );
        await markDeliveryDetailsLinkCreatedFromEvent(
          { detailsLinkId, notificationEventId: event.id },
          client
        );
      }

      summary.eventsCreated += 1;
      summary.scheduledEvents += 1;
      if (event.selectedChannel === "SMS") summary.scheduledByChannel.SMS += 1;
      if (event.selectedChannel === "EMAIL") summary.scheduledByChannel.EMAIL += 1;

      summary.eventReports.push({
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryGroupId: deliveryGroup.id,
        deliveryDate: dateKey(deliveryGroup.deliveryDate),
        eventId: event.id,
        dedupeKey: event.dedupeKey,
        status: event.status,
        selectedChannel: event.selectedChannel,
        reasonSkipped: event.reasonSkipped,
        acumaticaConfirmVia,
        detailsLinkCreated,
        detailsLinkReused: !detailsLinkCreated,
        detailsLinkTokenPresent: Boolean(detailsLinkId),
        detailsLinkUrl,
        subject,
        renderedMessagePreview,
        itemLineCount: readiness.lines.length,
        paymentStatus: payment.paymentStatus,
        amountDueNowRounded: payment.amountDueNowRounded,
        paymentReminderApplies: showPaymentReminder,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      summary.eventsDeduped += 1;
    }
  }

  return summary;
}
