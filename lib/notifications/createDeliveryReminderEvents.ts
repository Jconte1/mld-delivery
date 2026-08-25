import {
  InternalOrderLifecycleStatus,
  NotificationActionType,
  NotificationEventStatus,
  NotificationIntervalType,
  Prisma,
} from "@/lib/generated/prisma/client";
import {
  buildDeliveryReminderEmailSubject,
  buildNotificationDedupeKey,
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getDeliveryDateCustomerNotificationSkipReason,
  getNotificationTargetDate,
  renderDeliveryReminderEmailSubject,
  renderDeliveryReminderMessage,
  shouldSkipNotificationRunForWeekend,
} from "@/lib/notifications/helpers";
import {
  FRESH_IMPORT_FAILED_SKIP_REASON,
  isFreshImportFailedOrder,
  prepareFreshDeliveryIntervalImport,
  type FreshImportFailedOrder,
  type DeliveryIntervalFreshImportLoader,
  type DeliveryIntervalFreshImportResult,
} from "@/lib/notifications/freshDeliveryIntervalImport";
import { selectNotificationChannelWithOptOutRepair } from "@/lib/notifications/contactOptInWritebackActions";
import {
  loadActiveNotificationOptOutAddresses,
  mergeNotificationOptOutAddresses,
} from "@/lib/notifications/notificationOptOutLookup";
import { renderDeliveryReminderEmailBody } from "@/lib/notifications/deliveryReminderEmail";
import { getActiveSalespersonContactMap } from "@/lib/notifications/salespersonContactCache";
import { prisma } from "@/lib/prisma";

export type DeliveryReminderIntervalType =
  | typeof NotificationIntervalType.DAY_180
  | typeof NotificationIntervalType.DAY_90
  | typeof NotificationIntervalType.DAY_60;

type DeliveryReminderEventsClient = Pick<
  typeof prisma,
  "orderDeliveryGroup" | "notificationEvent"
> &
  Partial<Pick<typeof prisma, "salespersonContact">>;

export type MessagePreview = {
  orderNumber: string;
  deliveryDate: string;
  subject: string;
  body: string;
};

export type CreateDeliveryReminderEventsSummary = {
  runDate: string;
  targetDeliveryDate: string;
  eligibleDeliveryGroups: number;
  eventsCreated: number;
  eventsSkipped: number;
  eventsDeduped: number;
  weekendSkipped: boolean;
  deliveryGroupsSkippedWeekendDeliveryDate: number;
  targetDeliveryGroups: number;
  deliveryGroupsSkippedIneligible: number;
  deliveryGroupsSkippedFailedImport: number;
  deliveryGroupsSkippedNoChannel: number;
  skippedReasons: Record<string, number>;
  dryRun: boolean;
  freshImport: DeliveryIntervalFreshImportResult;
  failedImportExclusions: FreshImportFailedOrder[];
  eventsWouldCreate: number;
  messagePreviews: MessagePreview[];
};

export type CreateDeliveryReminderEventsOptions = {
  runDate?: Date | string;
  dryRun?: boolean;
  intervalType: DeliveryReminderIntervalType;
  intervalDays: number;
  useLegacy180Subject?: boolean;
  freshImport?: boolean;
  requireQueueBackedImport?: boolean;
  importSalesOrders?: DeliveryIntervalFreshImportLoader;
  prismaClient?: DeliveryReminderEventsClient;
};

function emptySummary(params: {
  runDate: string;
  targetDeliveryDate: string;
  dryRun: boolean;
}): CreateDeliveryReminderEventsSummary {
  return {
    runDate: params.runDate,
    targetDeliveryDate: params.targetDeliveryDate,
    eligibleDeliveryGroups: 0,
    eventsCreated: 0,
    eventsSkipped: 0,
    eventsDeduped: 0,
    weekendSkipped: false,
    deliveryGroupsSkippedWeekendDeliveryDate: 0,
    targetDeliveryGroups: 0,
    deliveryGroupsSkippedIneligible: 0,
    deliveryGroupsSkippedFailedImport: 0,
    deliveryGroupsSkippedNoChannel: 0,
    skippedReasons: {},
    dryRun: params.dryRun,
    freshImport: {
      required: false,
      performed: false,
      targetDate: params.targetDeliveryDate,
      requestedOn: "",
      skippedReason: null,
      importResult: null,
      failedOrders: [],
      failedOrderLookup: { keys: [], orderNumbers: [] },
      globalFailed: false,
      perOrderFailed: false,
      errorMessage: null,
    },
    failedImportExclusions: [],
    eventsWouldCreate: 0,
    messagePreviews: [],
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

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function addSkippedReason(summary: CreateDeliveryReminderEventsSummary, reason: string) {
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

function renderSubject(params: {
  useLegacy180Subject?: boolean;
  buyerGroup?: string | null;
  jobName: string;
  deliveryDate: Date | string;
}) {
  if (params.useLegacy180Subject) {
    return buildDeliveryReminderEmailSubject(params.deliveryDate);
  }

  return renderDeliveryReminderEmailSubject({
    buyerGroup: params.buyerGroup,
    jobName: params.jobName,
    deliveryDate: params.deliveryDate,
  });
}

export async function createDeliveryReminderEvents(
  options: CreateDeliveryReminderEventsOptions
): Promise<CreateDeliveryReminderEventsSummary> {
  const client = options.prismaClient ?? prisma;
  const runDate = dateKey(options.runDate ?? new Date());
  const targetDeliveryDate = getNotificationTargetDate(runDate, options.intervalDays);
  const targetDeliveryDateKey = dateKey(targetDeliveryDate);
  const dryRun = options.dryRun ?? false;
  const summary = emptySummary({
    runDate,
    targetDeliveryDate: targetDeliveryDateKey,
    dryRun,
  });

  if (shouldSkipNotificationRunForWeekend(runDate)) {
    summary.weekendSkipped = true;
    return summary;
  }

  const deliveryDateSkipReason = getDeliveryDateCustomerNotificationSkipReason(
    targetDeliveryDate
  );
  summary.freshImport = await prepareFreshDeliveryIntervalImport({
    targetDeliveryDate,
    dryRun,
    deliveryDateSkipReason,
    freshImport: options.freshImport,
    requireQueueBackedImport: options.requireQueueBackedImport,
    importSalesOrders: options.importSalesOrders,
  });
  summary.failedImportExclusions = summary.freshImport.failedOrders;
  if (summary.freshImport.globalFailed) {
    addSkippedReason(summary, FRESH_IMPORT_FAILED_SKIP_REASON);
    return summary;
  }

  const deliveryGroups = await client.orderDeliveryGroup.findMany({
    where: {
      deliveryDate: targetDeliveryDate,
      isActive: true,
      deliveryGroupLines: { some: { isActive: true } },
    },
    orderBy: [{ orderNumber: "asc" }, { id: "asc" }],
    select: {
      id: true,
      orderId: true,
      orderType: true,
      orderNumber: true,
      deliveryDate: true,
      status: true,
      order: {
        select: {
          id: true,
          orderType: true,
          orderNumber: true,
          status: true,
          internalLifecycleStatus: true,
          customerDescription: true,
          locationDescription: true,
          buyerGroup: true,
          salespersonNumber: true,
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
  summary.targetDeliveryGroups = deliveryGroups.length;
  const activeOptOutAddresses = await loadActiveNotificationOptOutAddresses(client);
  const salespersonContactsByNumber = await getActiveSalespersonContactMap(
    deliveryGroups.map((deliveryGroup) => deliveryGroup.order.salespersonNumber),
    client
  );

  for (const deliveryGroup of deliveryGroups) {
    const order = deliveryGroup.order;
    if (
      isCompletedOrCancelledStatus(order.status) ||
      isCompletedOrCancelledStatus(deliveryGroup.status) ||
      isBlockedLifecycleStatus(order.internalLifecycleStatus)
    ) {
      summary.deliveryGroupsSkippedIneligible += 1;
      continue;
    }

    if (
      isFreshImportFailedOrder({
        failedOrderLookup: summary.freshImport.failedOrderLookup,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
      })
    ) {
      summary.deliveryGroupsSkippedFailedImport += 1;
      summary.eventsSkipped += 1;
      addSkippedReason(summary, FRESH_IMPORT_FAILED_SKIP_REASON);
      continue;
    }

    const dedupeKey = buildNotificationDedupeKey({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: deliveryGroup.deliveryDate,
      intervalType: options.intervalType,
      actionType: NotificationActionType.DELIVERY_REMINDER,
    });

    const existingEvent = await client.notificationEvent.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });
    if (existingEvent) {
      summary.eventsDeduped += 1;
      if (deliveryDateSkipReason) {
        summary.deliveryGroupsSkippedWeekendDeliveryDate += 1;
        summary.eventsSkipped += 1;
        addSkippedReason(summary, deliveryDateSkipReason);

        if (!dryRun) {
          await client.notificationEvent.update({
            where: { id: existingEvent.id },
            data: {
              selectedChannel: null,
              channelReason: deliveryDateSkipReason,
              recipientEmail: null,
              recipientPhone: null,
              status: NotificationEventStatus.SKIPPED,
              reasonSkipped: deliveryDateSkipReason,
              scheduledAt: null,
            },
          });
        }
      }
      continue;
    }

    if (deliveryDateSkipReason) {
      summary.deliveryGroupsSkippedWeekendDeliveryDate += 1;
      summary.eventsSkipped += 1;
      summary.eventsWouldCreate += dryRun ? 1 : 0;
      addSkippedReason(summary, deliveryDateSkipReason);

      if (!dryRun) {
        try {
          await client.notificationEvent.create({
            data: {
              orderId: order.id,
              deliveryGroupId: deliveryGroup.id,
              contactId: order.contact.contactId,
              orderType: order.orderType,
              orderNumber: order.orderNumber,
              deliveryDate: deliveryGroup.deliveryDate,
              intervalType: options.intervalType,
              actionType: NotificationActionType.DELIVERY_REMINDER,
              dedupeKey,
              selectedChannel: null,
              channelReason: deliveryDateSkipReason,
              recipientEmail: null,
              recipientPhone: null,
              status: NotificationEventStatus.SKIPPED,
              reasonSkipped: deliveryDateSkipReason,
              scheduledAt: null,
            },
          });
          summary.eventsCreated += 1;
        } catch (error) {
          if (!isUniqueConstraintError(error)) {
            throw error;
          }
          summary.eventsDeduped += 1;
        }
      }

      continue;
    }

    summary.eligibleDeliveryGroups += 1;

    const channelRepair = await selectNotificationChannelWithOptOutRepair({
      client,
      contact: order.contact,
      optOutState: mergeNotificationOptOutAddresses(activeOptOutAddresses, {
        activeSmsOptOutPhones: order.contact.smsOptOuts.map((optOut) => optOut.phone),
        activeEmailOptOutEmails: order.contact.emailOptOuts.map((optOut) => optOut.email),
      }),
    });
    const channel = channelRepair.channel;

    const contactName = formatContactName(order.contact);
    const jobName = formatJobName({
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
    });
    const jobAddress = safeJobAddress(order.address ?? {});
    const salespersonContact = order.salespersonNumber
      ? salespersonContactsByNumber.get(order.salespersonNumber) ?? null
      : null;
    const subject = renderSubject({
      useLegacy180Subject: options.useLegacy180Subject,
      buyerGroup: order.buyerGroup,
      jobName,
      deliveryDate: deliveryGroup.deliveryDate,
    });
    const smsBody = renderDeliveryReminderMessage({
      intervalType: options.intervalType,
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: deliveryGroup.deliveryDate,
    });
    const emailBody = renderDeliveryReminderEmailBody({
      intervalType: options.intervalType,
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: deliveryGroup.deliveryDate,
      salespersonContact,
    });
    const body = channel.selectedChannel === "EMAIL" ? emailBody : smsBody;

    if (summary.messagePreviews.length < 3) {
      summary.messagePreviews.push({
        orderNumber: order.orderNumber,
        deliveryDate: targetDeliveryDateKey,
        subject,
        body,
      });
    }

    const shouldSkipForNoChannel = channel.selectedChannel === null;
    if (shouldSkipForNoChannel) {
      summary.deliveryGroupsSkippedNoChannel += 1;
    }

    if (dryRun) {
      summary.eventsWouldCreate += 1;
      if (shouldSkipForNoChannel) summary.eventsSkipped += 1;
      continue;
    }

    try {
      await client.notificationEvent.create({
        data: {
          orderId: order.id,
          deliveryGroupId: deliveryGroup.id,
          contactId: order.contact.contactId,
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          deliveryDate: deliveryGroup.deliveryDate,
          intervalType: options.intervalType,
          actionType: NotificationActionType.DELIVERY_REMINDER,
          dedupeKey,
          selectedChannel: channel.selectedChannel,
          channelReason: channel.channelReason,
          recipientEmail:
            channel.selectedChannel === "EMAIL" ? channel.recipientEmail : null,
          recipientPhone:
            channel.selectedChannel === "SMS" ? channel.recipientPhone : null,
          status: shouldSkipForNoChannel
            ? NotificationEventStatus.SKIPPED
            : NotificationEventStatus.SCHEDULED,
          reasonSkipped: shouldSkipForNoChannel ? channel.channelReason : null,
          scheduledAt: shouldSkipForNoChannel ? null : dateFromKey(runDate),
        },
      });

      if (shouldSkipForNoChannel) {
        summary.eventsSkipped += 1;
      } else {
        summary.eventsCreated += 1;
      }
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      summary.eventsDeduped += 1;
    }
  }

  return summary;
}
