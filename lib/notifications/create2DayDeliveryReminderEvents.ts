import { importSalesOrdersForLineRequestedOn, type ImportSalesOrdersResult } from "@/lib/erp/importSalesOrders";
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
  DELIVERY_DATE_WEEKEND_SKIP_REASON,
  formatContactName,
  formatJobAddress,
  formatJobName,
  getDeliveryDateCustomerNotificationSkipReason,
  getNotificationTargetDate,
  shouldSkipNotificationRunForWeekend,
} from "@/lib/notifications/helpers";
import { selectNotificationChannelWithOptOutRepair } from "@/lib/notifications/contactOptInWritebackActions";
import {
  loadActiveNotificationOptOutAddresses,
  mergeNotificationOptOutAddresses,
} from "@/lib/notifications/notificationOptOutLookup";
import {
  render2DayDeliveryReminderEmail,
  render2DayDeliveryReminderSms,
} from "@/lib/notifications/deliveryReminder2Day";
import {
  DELIVERY_TEN_DAY_CONFIRMATION_REASONS,
  isCompleteTenDayConfirmationWritebackStatus,
} from "@/lib/notifications/deliveryTenDayConfirmation";
import { getActiveSalespersonContactMap } from "@/lib/notifications/salespersonContactCache";
import { prisma } from "@/lib/prisma";

export const DELIVERY_REMINDER_2_DAY_INTERVAL_DAYS = 2;
export const DELIVERY_REMINDER_2_DAY_REQUESTED_ON_TIME = "09:19:00.000Z";

export const DELIVERY_REMINDER_2_DAY_SKIP_REASONS = {
  deliveryDateWeekend: DELIVERY_DATE_WEEKEND_SKIP_REASON,
  notConfirmedInAcumatica: "not_confirmed_in_acumatica",
  oneWeekConfirmationMissing: "one_week_confirmation_missing",
  noAutomatedChannelAvailable: "no_automated_channel_available",
} as const;

export type DeliveryReminder2DaySkipReason =
  (typeof DELIVERY_REMINDER_2_DAY_SKIP_REASONS)[keyof typeof DELIVERY_REMINDER_2_DAY_SKIP_REASONS];

type DeliveryReminder2DayClient = Pick<
  typeof prisma,
  "orderDeliveryGroup" | "notificationEvent" | "deliveryDetailsLink"
> &
  Partial<Pick<typeof prisma, "salespersonContact">>;

type DeliveryReminder2DayTargetGroup = Awaited<
  ReturnType<typeof find2DayDeliveryReminderTargetGroups>
>[number];

type ImportSalesOrdersLoader = typeof importSalesOrdersForLineRequestedOn;
type SalespersonContactMapLoader = typeof getActiveSalespersonContactMap;

export type DeliveryReminder2DayEventReport = {
  orderType: string;
  orderNumber: string;
  deliveryGroupId: string;
  deliveryDate: string;
  eventId: string | null;
  dedupeKey: string | null;
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
  acumaticaOneWeekConfirmed?: boolean | null;
  tenDayConfirmationStatus?: string | null;
  tenDayConfirmationMismatchReason?: string | null;
  tenDayConfirmationLocalConfirmed?: boolean | null;
};

export type Create2DayDeliveryReminderEventsSummary = {
  runDate: string;
  targetDeliveryDate: string;
  importRequestedOn: string;
  importResult: ImportSalesOrdersResult | null;
  targetDeliveryGroups: number;
  eligibleDeliveryGroups: number;
  deliveryGroupsSkippedWeekendDeliveryDate: number;
  deliveryGroupsSkippedIneligible: number;
  deliveryGroupsSkippedFailedImport: number;
  deliveryGroupsSkippedNotConfirmedInAcumatica: number;
  deliveryGroupsSkippedTenDayConfirmationMissing: number;
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
  weekendSkipped: boolean;
  dryRun: boolean;
  skippedReasons: Record<string, number>;
  failedImportExclusions: Array<{
    orderType: string | null;
    orderNumber: string;
    reason: string;
  }>;
  eventReports: DeliveryReminder2DayEventReport[];
};

export type Create2DayDeliveryReminderEventsOptions = {
  runDate?: Date | string;
  dryRun?: boolean;
  prismaClient?: DeliveryReminder2DayClient;
  importSalesOrders?: ImportSalesOrdersLoader;
  getSalespersonContactMap?: SalespersonContactMapLoader;
};

function emptySummary(params: {
  runDate: string;
  targetDeliveryDate: string;
  importRequestedOn: string;
  dryRun: boolean;
}): Create2DayDeliveryReminderEventsSummary {
  return {
    runDate: params.runDate,
    targetDeliveryDate: params.targetDeliveryDate,
    importRequestedOn: params.importRequestedOn,
    importResult: null,
    targetDeliveryGroups: 0,
    eligibleDeliveryGroups: 0,
    deliveryGroupsSkippedWeekendDeliveryDate: 0,
    deliveryGroupsSkippedIneligible: 0,
    deliveryGroupsSkippedFailedImport: 0,
    deliveryGroupsSkippedNotConfirmedInAcumatica: 0,
    deliveryGroupsSkippedTenDayConfirmationMissing: 0,
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
    weekendSkipped: false,
    dryRun: params.dryRun,
    skippedReasons: {},
    failedImportExclusions: [],
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

function addSkippedReason(summary: Create2DayDeliveryReminderEventsSummary, reason: string) {
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

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function importErrorLooksLikeFailedOrder(error: ImportSalesOrdersResult["errors"][number]) {
  return /failed|did not return/i.test(error.reason);
}

function importErrorMatchesOrder(
  error: ImportSalesOrdersResult["errors"][number],
  order: { orderType: string; orderNumber: string }
) {
  if (!error.orderNumber || error.orderNumber !== order.orderNumber) return false;
  return !error.orderType || error.orderType === order.orderType;
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
      `Rendered 2-day final reminder contains placeholder text order=${params.orderType} ${params.orderNumber}`
    );
  }
}

export function normalize2DayConfirmVia(value: unknown) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

export function requestedOnFor2DayTargetDate(targetDeliveryDate: Date | string) {
  return `${dateKey(targetDeliveryDate)}T${DELIVERY_REMINDER_2_DAY_REQUESTED_ON_TIME}`;
}

export function get2DayFailedImportExclusions(importResult: ImportSalesOrdersResult) {
  return importResult.errors
    .filter((error) => error.orderNumber && importErrorLooksLikeFailedOrder(error))
    .map((error) => ({
      orderType: error.orderType ?? null,
      orderNumber: error.orderNumber as string,
      reason: error.reason,
    }));
}

export function isOrderExcludedBy2DayFailedImport(params: {
  importResult: ImportSalesOrdersResult;
  orderType: string;
  orderNumber: string;
}) {
  return params.importResult.errors.some(
    (error) => importErrorLooksLikeFailedOrder(error) && importErrorMatchesOrder(error, params)
  );
}

export function is2DayDeliveryGroupEligible(group: DeliveryReminder2DayTargetGroup) {
  return !(
    isCompletedOrCancelledStatus(group.order.status) ||
    isCompletedOrCancelledStatus(group.status) ||
    isBlockedLifecycleStatus(group.order.internalLifecycleStatus)
  );
}

export function hasRequired2DayOneWeekConfirmation(
  group: DeliveryReminder2DayTargetGroup
) {
  const confirmation = group.tenDayConfirmation;
  if (!confirmation?.localConfirmed) return false;
  if (
    confirmation.mismatchReason ===
    DELIVERY_TEN_DAY_CONFIRMATION_REASONS.mismatchPaymentNotCleared
  ) {
    return false;
  }

  return (
    isCompleteTenDayConfirmationWritebackStatus(confirmation.acumaticaWritebackStatus) ||
    group.order.acumaticaOneWeekConfirmed === true
  );
}

function tenDayConfirmationReport(group: DeliveryReminder2DayTargetGroup) {
  return {
    acumaticaOneWeekConfirmed: group.order.acumaticaOneWeekConfirmed ?? null,
    tenDayConfirmationStatus: group.tenDayConfirmation?.acumaticaWritebackStatus ?? null,
    tenDayConfirmationMismatchReason: group.tenDayConfirmation?.mismatchReason ?? null,
    tenDayConfirmationLocalConfirmed: group.tenDayConfirmation?.localConfirmed ?? null,
  };
}

export async function find2DayDeliveryReminderTargetGroups(
  targetDeliveryDate: Date | string,
  client: DeliveryReminder2DayClient = prisma
) {
  return client.orderDeliveryGroup.findMany({
    where: {
      deliveryDate: dateFromKey(targetDeliveryDate),
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
      isActive: true,
      lineCount: true,
      lastSeenAt: true,
      status: true,
      tenDayConfirmation: {
        select: {
          localConfirmed: true,
          acumaticaWritebackStatus: true,
          mismatchReason: true,
        },
      },
      order: {
        select: {
          id: true,
          orderType: true,
          orderNumber: true,
          status: true,
          internalLifecycleStatus: true,
          buyerGroup: true,
          confirmVia: true,
          acumaticaOneWeekConfirmed: true,
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

async function createSkippedEvent(params: {
  client: DeliveryReminder2DayClient;
  deliveryGroup: DeliveryReminder2DayTargetGroup;
  dedupeKey: string;
  reason: DeliveryReminder2DaySkipReason;
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
      intervalType: NotificationIntervalType.DAY_2,
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

async function skipDeliveryGroup(params: {
  summary: Create2DayDeliveryReminderEventsSummary;
  client: DeliveryReminder2DayClient;
  deliveryGroup: DeliveryReminder2DayTargetGroup;
  dedupeKey: string;
  reason: DeliveryReminder2DaySkipReason;
  dryRun: boolean;
  acumaticaConfirmVia: string | null;
  renderedMessagePreview: string;
}) {
  params.summary.eventsSkipped += 1;
  params.summary.eventsWouldCreate += params.dryRun ? 1 : 0;
  addSkippedReason(params.summary, params.reason);

  let skippedEventId: string | null = null;
  try {
    const skippedEvent = await createSkippedEvent({
      client: params.client,
      deliveryGroup: params.deliveryGroup,
      dedupeKey: params.dedupeKey,
      reason: params.reason,
      dryRun: params.dryRun,
    });
    if (skippedEvent) {
      params.summary.eventsCreated += 1;
      skippedEventId = skippedEvent.id;
    }
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    params.summary.eventsDeduped += 1;
  }

  const order = params.deliveryGroup.order;
  params.summary.eventReports.push({
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryGroupId: params.deliveryGroup.id,
    deliveryDate: dateKey(params.deliveryGroup.deliveryDate),
    eventId: skippedEventId,
    dedupeKey: params.dedupeKey,
    status: NotificationEventStatus.SKIPPED,
    selectedChannel: null,
    reasonSkipped: params.reason,
    acumaticaConfirmVia: params.acumaticaConfirmVia,
    detailsLinkCreated: false,
    detailsLinkReused: false,
    detailsLinkTokenPresent: false,
    detailsLinkUrl: null,
    subject: null,
    renderedMessagePreview: params.renderedMessagePreview,
    ...tenDayConfirmationReport(params.deliveryGroup),
  });
}

export async function create2DayDeliveryReminderEvents(
  options: Create2DayDeliveryReminderEventsOptions = {}
): Promise<Create2DayDeliveryReminderEventsSummary> {
  const client = options.prismaClient ?? prisma;
  const importSalesOrders = options.importSalesOrders ?? importSalesOrdersForLineRequestedOn;
  const loadSalespersonContactMap =
    options.getSalespersonContactMap ?? getActiveSalespersonContactMap;
  const runDate = dateKey(options.runDate ?? new Date());
  const dryRun = options.dryRun ?? false;
  const targetDeliveryDate = dateKey(
    getNotificationTargetDate(runDate, DELIVERY_REMINDER_2_DAY_INTERVAL_DAYS)
  );
  const importRequestedOn = requestedOnFor2DayTargetDate(targetDeliveryDate);
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

  const deliveryDateSkipReason = getDeliveryDateCustomerNotificationSkipReason(targetDeliveryDate);
  if (!deliveryDateSkipReason) {
    summary.importResult = await importSalesOrders(importRequestedOn);
    summary.failedImportExclusions = get2DayFailedImportExclusions(summary.importResult);
  }

  const deliveryGroups = await find2DayDeliveryReminderTargetGroups(targetDeliveryDate, client);
  summary.targetDeliveryGroups = deliveryGroups.length;
  const activeOptOutAddresses = await loadActiveNotificationOptOutAddresses(client);

  const salespersonContactsByNumber = deliveryDateSkipReason
    ? new Map()
    : await loadSalespersonContactMap(
        deliveryGroups.map((deliveryGroup) => deliveryGroup.order.salespersonNumber),
        client
      );

  for (const deliveryGroup of deliveryGroups) {
    const order = deliveryGroup.order;
    if (!is2DayDeliveryGroupEligible(deliveryGroup)) {
      summary.deliveryGroupsSkippedIneligible += 1;
      continue;
    }

    if (
      summary.importResult &&
      isOrderExcludedBy2DayFailedImport({
        importResult: summary.importResult,
        orderType: order.orderType,
        orderNumber: order.orderNumber,
      })
    ) {
      summary.deliveryGroupsSkippedFailedImport += 1;
      summary.eventReports.push({
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryGroupId: deliveryGroup.id,
        deliveryDate: dateKey(deliveryGroup.deliveryDate),
        eventId: null,
        dedupeKey: null,
        status: "IMPORT_FAILED_EXCLUDED",
        selectedChannel: null,
        reasonSkipped: null,
        acumaticaConfirmVia: normalize2DayConfirmVia(order.confirmVia),
        detailsLinkCreated: false,
        detailsLinkReused: false,
        detailsLinkTokenPresent: false,
        detailsLinkUrl: null,
        subject: null,
        renderedMessagePreview: "Fresh import failed for this order; stale DB data was not evaluated.",
      });
      continue;
    }

    const dedupeKey = buildNotificationDedupeKey({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      deliveryDate: deliveryGroup.deliveryDate,
      intervalType: NotificationIntervalType.DAY_2,
      actionType: NotificationActionType.DELIVERY_REMINDER,
    });

    const existingEvent = await client.notificationEvent.findUnique({
      where: { dedupeKey },
      select: notificationEventSelect,
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
              detailsLinkId: null,
            },
          });
        }
      }
      summary.eventReports.push({
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        deliveryGroupId: deliveryGroup.id,
        deliveryDate: dateKey(deliveryGroup.deliveryDate),
        eventId: existingEvent.id,
        dedupeKey: existingEvent.dedupeKey,
        status: deliveryDateSkipReason ? NotificationEventStatus.SKIPPED : existingEvent.status,
        selectedChannel: deliveryDateSkipReason ? null : existingEvent.selectedChannel,
        reasonSkipped: deliveryDateSkipReason ?? existingEvent.reasonSkipped,
        acumaticaConfirmVia: normalize2DayConfirmVia(order.confirmVia),
        detailsLinkCreated: false,
        detailsLinkReused: deliveryDateSkipReason ? false : Boolean(existingEvent.detailsLinkId),
        detailsLinkTokenPresent: deliveryDateSkipReason ? false : Boolean(existingEvent.detailsLinkId),
        detailsLinkUrl: null,
        subject: null,
        renderedMessagePreview:
          deliveryDateSkipReason ?? existingEvent.reasonSkipped ?? "Existing event deduped.",
      });
      continue;
    }

    if (deliveryDateSkipReason) {
      summary.deliveryGroupsSkippedWeekendDeliveryDate += 1;
      await skipDeliveryGroup({
        summary,
        client,
        deliveryGroup,
        dedupeKey,
        reason: deliveryDateSkipReason,
        dryRun,
        acumaticaConfirmVia: normalize2DayConfirmVia(order.confirmVia),
        renderedMessagePreview: deliveryDateSkipReason,
      });
      continue;
    }

    const acumaticaConfirmVia = normalize2DayConfirmVia(order.confirmVia);
    if (!acumaticaConfirmVia) {
      summary.deliveryGroupsSkippedNotConfirmedInAcumatica += 1;
      await skipDeliveryGroup({
        summary,
        client,
        deliveryGroup,
        dedupeKey,
        reason: DELIVERY_REMINDER_2_DAY_SKIP_REASONS.notConfirmedInAcumatica,
        dryRun,
        acumaticaConfirmVia: null,
        renderedMessagePreview: DELIVERY_REMINDER_2_DAY_SKIP_REASONS.notConfirmedInAcumatica,
      });
      continue;
    }

    if (!hasRequired2DayOneWeekConfirmation(deliveryGroup)) {
      summary.deliveryGroupsSkippedTenDayConfirmationMissing += 1;
      await skipDeliveryGroup({
        summary,
        client,
        deliveryGroup,
        dedupeKey,
        reason: DELIVERY_REMINDER_2_DAY_SKIP_REASONS.oneWeekConfirmationMissing,
        dryRun,
        acumaticaConfirmVia,
        renderedMessagePreview:
          DELIVERY_REMINDER_2_DAY_SKIP_REASONS.oneWeekConfirmationMissing,
      });
      continue;
    }

    const channelRepair = await selectNotificationChannelWithOptOutRepair({
      client,
      contact: order.contact,
      optOutState: mergeNotificationOptOutAddresses(activeOptOutAddresses, {
        activeSmsOptOutPhones: order.contact.smsOptOuts.map((optOut) => optOut.phone),
        activeEmailOptOutEmails: order.contact.emailOptOuts.map((optOut) => optOut.email),
      }),
    });
    const channel = channelRepair.channel;

    if (channel.selectedChannel === null) {
      summary.deliveryGroupsSkippedNoChannel += 1;
      await skipDeliveryGroup({
        summary,
        client,
        deliveryGroup,
        dedupeKey,
        reason: DELIVERY_REMINDER_2_DAY_SKIP_REASONS.noAutomatedChannelAvailable,
        dryRun,
        acumaticaConfirmVia,
        renderedMessagePreview:
          DELIVERY_REMINDER_2_DAY_SKIP_REASONS.noAutomatedChannelAvailable,
      });
      continue;
    }

    summary.eligibleDeliveryGroups += 1;

    const contactName = formatContactName(order.contact);
    const jobName = formatJobName({
      customerDescription: order.customerDescription,
      locationDescription: order.locationDescription,
    });
    const jobAddress = safeJobAddress(order.address ?? {});
    const salespersonContact = order.salespersonNumber
      ? salespersonContactsByNumber.get(order.salespersonNumber) ?? null
      : null;
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

    const smsMessage = render2DayDeliveryReminderSms({
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: deliveryGroup.deliveryDate,
      detailsLink: detailsLinkUrl,
      salespersonContact,
    });
    const emailMessage = render2DayDeliveryReminderEmail({
      orderNumber: order.orderNumber,
      contactName,
      buyerGroup: order.buyerGroup,
      jobName,
      jobAddress,
      deliveryDate: deliveryGroup.deliveryDate,
      detailsLink: detailsLinkUrl,
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
        ...tenDayConfirmationReport(deliveryGroup),
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
          intervalType: NotificationIntervalType.DAY_2,
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
        ...tenDayConfirmationReport(deliveryGroup),
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      summary.eventsDeduped += 1;
    }
  }

  return summary;
}
