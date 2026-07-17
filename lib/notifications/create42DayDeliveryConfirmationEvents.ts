import {
  getDeliveryGroupPaymentEvaluation,
  type DeliveryGroupPaymentEvaluation,
} from "@/lib/delivery-payment/deliveryGroupPayment";
import {
  InternalOrderLifecycleStatus,
  NotificationActionType,
  NotificationEventStatus,
  NotificationIntervalType,
} from "@/lib/generated/prisma/client";
import { render42DayEmailConfirmationMessage } from "@/lib/notifications/deliveryConfirmationEmail";
import {
  buildDeliveryConfirmationScopeKey,
  render42DaySmsConfirmationMessage,
} from "@/lib/notifications/deliveryConfirmationSms";
import {
  buildDeliveryConfirmationLink,
  newDeliveryConfirmationLinkToken,
} from "@/lib/notifications/deliveryConfirmationLinks";
import {
  ensurePendingDeliveryConfirmation,
  isDeliveryGroupDateConfirmed,
} from "@/lib/notifications/deliveryConfirmationState";
import {
  buildNotificationDedupeKey,
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getNotificationTargetDate,
  selectNotificationChannel,
} from "@/lib/notifications/helpers";
import { prisma } from "@/lib/prisma";

export const DELIVERY_CONFIRMATION_42_DAY_INTERVAL_DAYS = 42;
export const DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON =
  "already_confirmed_for_delivery_date";

export type DeliveryConfirmation42DayClient = Pick<
  typeof prisma,
  "orderDeliveryGroup" | "notificationEvent" | "deliveryConfirmation"
>;

export type DeliveryConfirmation42DayEventReport = {
  orderType: string;
  orderNumber: string;
  deliveryGroupId: string;
  deliveryDate: string;
  eventId: string;
  dedupeKey: string;
  intervalType: string;
  actionType: string;
  status: string;
  selectedChannel: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  reasonSkipped: string | null;
  alreadyConfirmedForDeliveryDate: boolean;
  subject: string | null;
  renderedMessagePreview: string;
  linkTokenPresent: boolean;
  linkScopeKey: string | null;
  confirmationState: string | null;
  paymentTerms: string | null;
  unpaidBalance: string | null;
  orderTotal: string | null;
  paidToDate: string | null;
  paymentApplicabilityStatus: string | null;
  paymentStatus: string | null;
  amountDueNow: string | null;
  amountDueNowRounded: string | null;
  currentDeliveryGroupValue: string | null;
  currentDeliveryGroupMerchandiseValue: string | null;
  currentDeliveryGroupTaxAmount: string | null;
  remainingUndeliveredValueAfterCurrentDelivery: string | null;
  requiredDownOnRemaining: string | null;
  paymentReminderApplies: boolean;
  emailPaymentReminderIncluded: boolean;
  paymentCalculationWarnings: string[];
};

export type Create42DayDeliveryConfirmationEventsSummary = {
  runDate: string;
  targetDeliveryDate: string;
  targetDeliveryGroups: number;
  eligibleDeliveryGroups: number;
  deliveryGroupsSkippedIneligible: number;
  eventsCreated: number;
  eventsDeduped: number;
  eventsSkipped: number;
  scheduledEvents: number;
  scheduledByChannel: {
    SMS: number;
    EMAIL: number;
  };
  skippedReasons: Record<string, number>;
  confirmationsCreatedOrReused: number;
  confirmationsCreated: number;
  confirmationsReused: number;
  eventReports: DeliveryConfirmation42DayEventReport[];
};

export type Create42DayDeliveryConfirmationEventsOptions = {
  runDate?: Date | string;
  now?: Date;
  prismaClient?: DeliveryConfirmation42DayClient;
};

export type DeliveryConfirmation42DayTargetGroup = Awaited<
  ReturnType<typeof find42DayDeliveryConfirmationTargetGroups>
>[number];

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

function emptySummary(params: {
  runDate: string;
  targetDeliveryDate: string;
}): Create42DayDeliveryConfirmationEventsSummary {
  return {
    runDate: params.runDate,
    targetDeliveryDate: params.targetDeliveryDate,
    targetDeliveryGroups: 0,
    eligibleDeliveryGroups: 0,
    deliveryGroupsSkippedIneligible: 0,
    eventsCreated: 0,
    eventsDeduped: 0,
    eventsSkipped: 0,
    scheduledEvents: 0,
    scheduledByChannel: {
      SMS: 0,
      EMAIL: 0,
    },
    skippedReasons: {},
    confirmationsCreatedOrReused: 0,
    confirmationsCreated: 0,
    confirmationsReused: 0,
    eventReports: [],
  };
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

function addSkippedReason(summary: Create42DayDeliveryConfirmationEventsSummary, reason: string) {
  summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
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
      `Rendered 42-day message contains placeholder text order=${params.orderType} ${params.orderNumber}`
    );
  }
}

type DeliveryConfirmation42DayPaymentReport = Pick<
  DeliveryConfirmation42DayEventReport,
  | "paymentTerms"
  | "unpaidBalance"
  | "orderTotal"
  | "paidToDate"
  | "paymentApplicabilityStatus"
  | "paymentStatus"
  | "amountDueNow"
  | "amountDueNowRounded"
  | "currentDeliveryGroupValue"
  | "currentDeliveryGroupMerchandiseValue"
  | "currentDeliveryGroupTaxAmount"
  | "remainingUndeliveredValueAfterCurrentDelivery"
  | "requiredDownOnRemaining"
  | "paymentCalculationWarnings"
>;

function amountIsMeaningful(value: string | null | undefined) {
  if (!value) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 2;
}

function paymentReminderApplies(payment: DeliveryConfirmation42DayPaymentReport) {
  return (
    payment.paymentStatus === "balance_due" &&
    amountIsMeaningful(payment.amountDueNowRounded) &&
    payment.paymentCalculationWarnings.length === 0
  );
}

function paymentReportFromEvaluation(
  payment: DeliveryGroupPaymentEvaluation
): DeliveryConfirmation42DayPaymentReport {
  return {
    paymentTerms: payment.paymentTerms,
    unpaidBalance: payment.unpaidBalance,
    orderTotal: payment.orderTotal,
    paidToDate: payment.paidToDate,
    paymentApplicabilityStatus: payment.paymentApplicabilityStatus,
    paymentStatus: payment.paymentStatus,
    amountDueNow: payment.amountDueNow,
    amountDueNowRounded: payment.amountDueNowRounded,
    currentDeliveryGroupValue: payment.currentDeliveryGroupValue,
    currentDeliveryGroupMerchandiseValue: payment.currentDeliveryGroupMerchandiseValue,
    currentDeliveryGroupTaxAmount: payment.currentDeliveryGroupTaxAmount,
    remainingUndeliveredValueAfterCurrentDelivery:
      payment.remainingUndeliveredValueAfterCurrentDelivery,
    requiredDownOnRemaining: payment.requiredDownOnRemaining,
    paymentCalculationWarnings: payment.calculationWarnings,
  };
}

function paymentReportFromError(error: unknown): DeliveryConfirmation42DayPaymentReport {
  const message = error instanceof Error ? error.message : String(error);
  return {
    paymentTerms: null,
    unpaidBalance: null,
    orderTotal: null,
    paidToDate: null,
    paymentApplicabilityStatus: "applicable",
    paymentStatus: "calculation_blocked",
    amountDueNow: null,
    amountDueNowRounded: null,
    currentDeliveryGroupValue: null,
    currentDeliveryGroupMerchandiseValue: null,
    currentDeliveryGroupTaxAmount: null,
    remainingUndeliveredValueAfterCurrentDelivery: null,
    requiredDownOnRemaining: null,
    paymentCalculationWarnings: [`Payment evaluation failed: ${message}`],
  };
}

async function evaluate42DayDeliveryGroupPayment(deliveryGroupId: string) {
  try {
    return paymentReportFromEvaluation(await getDeliveryGroupPaymentEvaluation(deliveryGroupId));
  } catch (error) {
    return paymentReportFromError(error);
  }
}

const notificationEventSelect = {
  id: true,
  dedupeKey: true,
  intervalType: true,
  actionType: true,
  status: true,
  selectedChannel: true,
  recipientEmail: true,
  recipientPhone: true,
  reasonSkipped: true,
} as const;

export async function find42DayDeliveryConfirmationTargetGroups(
  targetDeliveryDate: Date | string,
  client: DeliveryConfirmation42DayClient = prisma
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

export function is42DayDeliveryGroupEligible(group: DeliveryConfirmation42DayTargetGroup) {
  return !(
    isCompletedOrCancelledStatus(group.order.status) ||
    isCompletedOrCancelledStatus(group.status) ||
    isBlockedLifecycleStatus(group.order.internalLifecycleStatus)
  );
}

export async function create42DayDeliveryConfirmationEvents(
  options: Create42DayDeliveryConfirmationEventsOptions = {}
): Promise<Create42DayDeliveryConfirmationEventsSummary> {
  const client = options.prismaClient ?? prisma;
  const runDate = dateKey(options.runDate ?? new Date());
  const now = options.now ?? new Date();
  const targetDeliveryDate = dateKey(
    getNotificationTargetDate(runDate, DELIVERY_CONFIRMATION_42_DAY_INTERVAL_DAYS)
  );
  const summary = emptySummary({ runDate, targetDeliveryDate });
  const deliveryGroups = await find42DayDeliveryConfirmationTargetGroups(targetDeliveryDate, client);
  summary.targetDeliveryGroups = deliveryGroups.length;

  for (const deliveryGroup of deliveryGroups) {
    const order = deliveryGroup.order;
    if (!is42DayDeliveryGroupEligible(deliveryGroup)) {
      summary.deliveryGroupsSkippedIneligible += 1;
      continue;
    }

    summary.eligibleDeliveryGroups += 1;
    const paymentReport = await evaluate42DayDeliveryGroupPayment(deliveryGroup.id);
    const showPaymentReminder = paymentReminderApplies(paymentReport);
    const alreadyConfirmedForDeliveryDate = await isDeliveryGroupDateConfirmed({
      deliveryGroupId: deliveryGroup.id,
      deliveryDate: deliveryGroup.deliveryDate,
      client,
    });
    const dedupeKey = buildNotificationDedupeKey({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: deliveryGroup.deliveryDate,
      intervalType: NotificationIntervalType.DAY_42,
      actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
    });

    const channel = alreadyConfirmedForDeliveryDate
      ? null
      : selectNotificationChannel(order.contact, {
          activeSmsOptOutPhones: order.contact.smsOptOuts.map((optOut) => optOut.phone),
          activeEmailOptOutEmails: order.contact.emailOptOuts.map((optOut) => optOut.email),
        });
    const shouldSkipForNoChannel = channel?.selectedChannel === null;

    let event = await client.notificationEvent.findUnique({
      where: { dedupeKey },
      select: notificationEventSelect,
    });

    if (event) {
      summary.eventsDeduped += 1;
      if (alreadyConfirmedForDeliveryDate) {
        event = await client.notificationEvent.update({
          where: { id: event.id },
          data: {
            selectedChannel: null,
            channelReason: DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
            recipientEmail: null,
            recipientPhone: null,
            status: NotificationEventStatus.SKIPPED,
            reasonSkipped: DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON,
            scheduledAt: null,
          },
          select: notificationEventSelect,
        });
      }
    } else {
      event = await client.notificationEvent.create({
        data: {
          orderId: order.id,
          deliveryGroupId: deliveryGroup.id,
          contactId: order.contact.contactId,
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          deliveryDate: deliveryGroup.deliveryDate,
          intervalType: NotificationIntervalType.DAY_42,
          actionType: NotificationActionType.DELIVERY_CONFIRMATION_REQUEST,
          dedupeKey,
          selectedChannel: channel?.selectedChannel ?? null,
          channelReason: alreadyConfirmedForDeliveryDate
            ? DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON
            : channel?.channelReason,
          recipientEmail: channel?.selectedChannel === "EMAIL" ? channel.recipientEmail : null,
          recipientPhone: channel?.selectedChannel === "SMS" ? channel.recipientPhone : null,
          status:
            alreadyConfirmedForDeliveryDate || shouldSkipForNoChannel
              ? NotificationEventStatus.SKIPPED
              : NotificationEventStatus.SCHEDULED,
          reasonSkipped: alreadyConfirmedForDeliveryDate
            ? DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_REASON
            : shouldSkipForNoChannel
              ? channel?.channelReason
              : null,
          scheduledAt:
            alreadyConfirmedForDeliveryDate || shouldSkipForNoChannel ? null : dateFromKey(runDate),
        },
        select: notificationEventSelect,
      });

      summary.eventsCreated += 1;
      if (event.status === NotificationEventStatus.SKIPPED) {
        summary.eventsSkipped += 1;
      }
    }

    if (event.status === NotificationEventStatus.SKIPPED) {
      addSkippedReason(summary, event.reasonSkipped ?? "unknown");
    }

    if (event.status === NotificationEventStatus.SCHEDULED) {
      summary.scheduledEvents += 1;
      if (event.selectedChannel === "SMS") summary.scheduledByChannel.SMS += 1;
      if (event.selectedChannel === "EMAIL") summary.scheduledByChannel.EMAIL += 1;
    }

    const contactName = formatContactName(order.contact);
    const jobName = formatJobName({
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
    });
    const jobAddress = safeJobAddress(order.address ?? {});
    let linkToken: string | null = null;
    let linkScopeKey: string | null = null;
    let confirmationState: string | null = null;

    if (event.status === NotificationEventStatus.SCHEDULED) {
      const existingConfirmation = await client.deliveryConfirmation.findUnique({
        where: {
          deliveryGroupId_deliveryDate: {
            deliveryGroupId: deliveryGroup.id,
            deliveryDate: deliveryGroup.deliveryDate,
          },
        },
        select: { id: true, linkToken: true },
      });
      linkToken = existingConfirmation?.linkToken ?? newDeliveryConfirmationLinkToken();
      linkScopeKey = buildDeliveryConfirmationScopeKey({
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryDate: deliveryGroup.deliveryDate,
        deliveryGroupId: deliveryGroup.id,
      });
      const confirmation = await ensurePendingDeliveryConfirmation(
        {
          orderId: order.id,
          deliveryGroupId: deliveryGroup.id,
          notificationEventId: event.id,
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          deliveryDate: deliveryGroup.deliveryDate,
          contactId: order.contact.contactId,
          linkToken,
          linkCreatedAt: now,
          linkExpiresAt: new Date(dateFromKey(runDate).getTime() + 30 * 24 * 60 * 60 * 1000),
        },
        client
      );
      confirmationState = confirmation.status;
      summary.confirmationsCreatedOrReused += 1;
      if (existingConfirmation) {
        summary.confirmationsReused += 1;
      } else {
        summary.confirmationsCreated += 1;
      }
    }

    const link = linkToken ? buildDeliveryConfirmationLink(linkToken) : "";
    const smsMessage =
      event.status === NotificationEventStatus.SCHEDULED
        ? render42DaySmsConfirmationMessage({
            contactName,
            buyerGroup: order.buyerGroup,
            jobName,
            deliveryDate: deliveryGroup.deliveryDate,
            link,
          })
        : "";
    const emailMessage =
      event.status === NotificationEventStatus.SCHEDULED
        ? render42DayEmailConfirmationMessage({
            contactName,
            buyerGroup: order.buyerGroup,
            customerDescription: order.customerDescription,
            locationDescription: order.locationDescription,
            jobName,
            jobAddress,
            deliveryDate: deliveryGroup.deliveryDate,
            link,
            paymentReminderApplies: showPaymentReminder,
            amountDueNowRounded: paymentReport.amountDueNowRounded,
          })
        : null;
    const subject =
      event.status === NotificationEventStatus.SCHEDULED && event.selectedChannel === "EMAIL"
        ? emailMessage?.subject ?? null
        : null;
    const renderedMessagePreview =
      event.status !== NotificationEventStatus.SCHEDULED
        ? event.reasonSkipped ?? ""
        : event.selectedChannel === "EMAIL"
          ? emailMessage?.body ?? ""
          : smsMessage;

    validateRenderedMessage({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      subject,
      renderedMessagePreview,
    });

    summary.eventReports.push({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryGroupId: deliveryGroup.id,
      deliveryDate: dateKey(deliveryGroup.deliveryDate),
      eventId: event.id,
      dedupeKey: event.dedupeKey,
      intervalType: event.intervalType,
      actionType: event.actionType,
      status: event.status,
      selectedChannel: event.selectedChannel,
      recipientEmail: event.recipientEmail,
      recipientPhone: event.recipientPhone,
      reasonSkipped: event.reasonSkipped,
      alreadyConfirmedForDeliveryDate,
      subject,
      renderedMessagePreview,
      linkTokenPresent: Boolean(linkToken),
      linkScopeKey,
      confirmationState,
      paymentTerms: paymentReport.paymentTerms,
      unpaidBalance: paymentReport.unpaidBalance,
      orderTotal: paymentReport.orderTotal,
      paidToDate: paymentReport.paidToDate,
      paymentApplicabilityStatus: paymentReport.paymentApplicabilityStatus,
      paymentStatus: paymentReport.paymentStatus,
      amountDueNow: paymentReport.amountDueNow,
      amountDueNowRounded: paymentReport.amountDueNowRounded,
      currentDeliveryGroupValue: paymentReport.currentDeliveryGroupValue,
      currentDeliveryGroupMerchandiseValue: paymentReport.currentDeliveryGroupMerchandiseValue,
      currentDeliveryGroupTaxAmount: paymentReport.currentDeliveryGroupTaxAmount,
      remainingUndeliveredValueAfterCurrentDelivery:
        paymentReport.remainingUndeliveredValueAfterCurrentDelivery,
      requiredDownOnRemaining: paymentReport.requiredDownOnRemaining,
      paymentReminderApplies: showPaymentReminder,
      emailPaymentReminderIncluded:
        showPaymentReminder &&
        event.status === NotificationEventStatus.SCHEDULED &&
        event.selectedChannel === "EMAIL",
      paymentCalculationWarnings: paymentReport.paymentCalculationWarnings,
    });
  }

  return summary;
}
