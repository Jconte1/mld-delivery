import {
  NotificationAttemptStatus,
  NotificationChannel,
  NotificationEventStatus,
  OrderThankYouClassification,
  Prisma,
} from "@/lib/generated/prisma/client";
import {
  DEFAULT_ALLOWED_SHIP_VIA,
  DEFAULT_ALLOWED_STATUSES,
} from "@/lib/acumatica/client/acumaticaClient";
import { mapAcumaticaContactOptIns } from "@/lib/acumatica/contactOptInFields";
import { QueueErpClient } from "@/lib/erp/queueErpClient";
import { selectNotificationChannel } from "@/lib/notifications/helpers";
import {
  loadActiveNotificationOptOutAddresses,
} from "@/lib/notifications/notificationOptOutLookup";
import {
  normalizeEmailForOptOut,
  normalizeSmsPhoneForOptOut,
} from "@/lib/notifications/notificationAddressNormalization";
import {
  buildTwilioStatusCallbackUrl,
  createDeliveryNotificationProvider,
  DeliveryNotificationProviderError,
  type DeliveryNotificationProvider,
} from "@/lib/notifications/deliveryNotificationProviders";
import {
  enqueueThankYouWriteback,
  fetchThankYouReportRows,
  getThankYouQueueJob,
} from "@/lib/notifications/orderThankYouQueue";
import {
  renderDeliveryThankYou,
  renderWillCallThankYou,
} from "@/lib/notifications/orderThankYouTemplates";
import { prisma } from "@/lib/prisma";

const ACTIVE_STATUSES = new Set(
  DEFAULT_ALLOWED_STATUSES
    .filter((status) => !["completed", "canceled", "cancelled"].includes(status.toLowerCase()))
    .map(normalize)
);
const DELIVERY_SHIP_VIAS = new Set(DEFAULT_ALLOWED_SHIP_VIA.map(normalize));
const DEFAULT_WILL_CALL_SHIP_VIAS = [
  "WILL CALL",
  "WILL CALL BO",
  "WILL CALL JX",
  "WILL CALL PR",
  "WILL CALL SLC",
  "TRANS BOISE",
  "TRANS JACKSON",
  "TRANS PROVO",
  "TRANS SLC",
];

type AnyRecord = Record<string, unknown>;

export type ThankYouCandidate = {
  orderType: string;
  orderNumber: string;
  status: string | null;
  shipVia: string | null;
  customerId: string | null;
  customerName: string | null;
  locationName: string | null;
  buyerGroup: string | null;
  billingZip: string | null;
  requestedDeliveryDate: Date | null;
  thankYouAlreadySent: boolean;
};

export type RunOrderThankYouOptions = {
  send: boolean;
  orderType?: string | null;
  orderNumber?: string | null;
  now?: Date;
  provider?: DeliveryNotificationProvider;
};

function normalize(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase();
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function field(record: unknown, ...keys: string[]) {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function value(input: unknown): unknown {
  return isRecord(input) && "value" in input ? input.value ?? null : input ?? null;
}

function text(input: unknown): string | null {
  const unwrapped = value(input);
  if (unwrapped === null || unwrapped === undefined) return null;
  const result = String(unwrapped).trim();
  return result || null;
}

function dateValue(input: unknown): Date | null {
  const unwrapped = value(input);
  if (!unwrapped) return null;
  const date = new Date(String(unwrapped));
  return Number.isNaN(date.getTime()) ? null : date;
}

function booleanValue(input: unknown) {
  const unwrapped = value(input);
  if (typeof unwrapped === "boolean") return unwrapped;
  const normalized = String(unwrapped ?? "").trim().toLowerCase();
  return ["true", "yes", "y", "1", "opt-in", "opt in", "optin"].includes(normalized);
}

export function parseThankYouCandidate(row: unknown): ThankYouCandidate | null {
  const orderNumber = normalize(text(field(row, "OrderNbr", "SOOrder_OrderNbr", "SOOrder.OrderNbr")));
  const orderType = normalize(text(field(row, "OrderType", "SOOrder_OrderType", "SOOrder.OrderType")));
  if (!orderNumber || !orderType) return null;
  return {
    orderType,
    orderNumber,
    status: text(field(row, "Status", "SOOrder_Status", "SOOrder.Status")),
    shipVia: text(field(row, "ShipVia", "SOOrder_ShipVia", "SOOrder.ShipVia")),
    customerId: text(field(row, "CustomerID", "Customer", "SOOrder_CustomerID", "SOOrder.CustomerID")),
    customerName: text(field(row, "CustomerName", "CustomerID_Description", "SOOrder_CustomerID_Description", "SOOrder.CustomerID_Description")),
    locationName: text(field(row, "LocationName", "CustomerLocationID_Description", "SOOrder_CustomerLocationID_Description", "SOOrder.CustomerLocationID_Description")),
    buyerGroup: text(field(row, "AttributeBUYERGROUP", "SOOrder_AttributeBUYERGROUP", "SOOrder.AttributeBUYERGROUP")),
    billingZip: text(field(row, "PostalCode", "BillingZip", "SOOrder_BillingZip", "SOOrder.BillingZip")),
    requestedDeliveryDate: dateValue(field(
      row,
      "DeliveryDate",
      "RequestedOn",
      "ShipDate",
      "SOOrder_DeliveryDate",
      "SOOrder.RequestedOn"
    )),
    thankYouAlreadySent: booleanValue(field(
      row,
      "ThankYou",
      "AttributeTHANKYOU",
      "SOOrder_AttributeTHANKYOU",
      "SOOrder.AttributeTHANKYOU"
    )),
  };
}

function configuredWillCallShipVias(env: NodeJS.ProcessEnv = process.env) {
  return new Set(
    (env.DELIVERY_THANK_YOU_WILL_CALL_SHIP_VIAS || DEFAULT_WILL_CALL_SHIP_VIAS.join(","))
      .split(",")
      .map(normalize)
      .filter(Boolean)
  );
}

export function classifyThankYouShipVia(
  shipVia: string | null,
  env: NodeJS.ProcessEnv = process.env
): OrderThankYouClassification | null {
  const normalized = normalize(shipVia);
  if (DELIVERY_SHIP_VIAS.has(normalized)) return OrderThankYouClassification.DELIVERY;
  if (configuredWillCallShipVias(env).has(normalized)) return OrderThankYouClassification.WILL_CALL;
  return null;
}

function fullOrderMatch(rows: unknown[], candidate: ThankYouCandidate) {
  return rows.find((row) => {
    return normalize(text(field(row, "OrderNbr"))) === candidate.orderNumber &&
      normalize(text(field(row, "OrderType"))) === candidate.orderType;
  }) ?? null;
}

function contactMatch(rows: unknown[], contactId: string) {
  return rows.find((row) => text(field(row, "ContactID")) === contactId) ?? rows[0] ?? null;
}

function fullOrderRequestedDate(order: unknown, fallback: Date | null) {
  return dateValue(field(order, "RequestedOn", "DeliveryDate", "ShipDate")) ?? fallback;
}

function denverDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function deliveryWithinSixWeeks(deliveryDate: Date | null, now: Date) {
  if (!deliveryDate) return false;
  const [year, month, day] = denverDateKey(now).split("-").map(Number);
  const threshold = new Date(Date.UTC(year, month - 1, day + 42)).toISOString().slice(0, 10);
  return deliveryDate.toISOString().slice(0, 10) < threshold;
}

function localOptOutSnapshot(contact: {
  phone1: string | null;
  phone2: string | null;
  email: string | null;
  smsOptOuts: Array<{ phone: string }>;
  emailOptOuts: Array<{ email: string }>;
}) {
  const phones = new Set(
    [contact.phone1, contact.phone2]
      .map(normalizeSmsPhoneForOptOut)
      .filter((item): item is string => Boolean(item))
  );
  const email = normalizeEmailForOptOut(contact.email);
  return {
    sms: contact.smsOptOuts.some((item) => {
      const phone = normalizeSmsPhoneForOptOut(item.phone);
      return Boolean(phone && phones.has(phone));
    }),
    email: contact.emailOptOuts.some((item) => {
      const candidate = normalizeEmailForOptOut(item.email);
      return Boolean(candidate && email && candidate === email);
    }),
  };
}

async function upsertFreshContact(contactId: string, contact: unknown, now: Date) {
  const data = freshContactData(contact);
  return prisma.contact.upsert({
    where: { contactId },
    create: {
      contactId,
      ...data,
      lastSyncedAt: now,
    },
    update: {
      status: data.status ?? undefined,
      companyName: data.companyName ?? undefined,
      displayName: data.displayName ?? undefined,
      firstName: data.firstName ?? undefined,
      lastName: data.lastName ?? undefined,
      email: data.email ?? undefined,
      phone1: data.phone1 ?? undefined,
      phone2: data.phone2 ?? undefined,
      smsOptIn: data.smsOptIn,
      emailOptIn: data.emailOptIn,
      phoneCallOptIn: data.phoneCallOptIn,
      lastSyncedAt: now,
    },
    include: {
      smsOptOuts: { where: { isActive: true }, select: { phone: true } },
      emailOptOuts: { where: { isActive: true }, select: { email: true } },
    },
  });
}

function freshContactData(contact: unknown) {
  return {
    status: text(field(contact, "Status")),
    companyName: text(field(contact, "CompanyName")),
    displayName: text(field(contact, "DisplayName")),
    firstName: text(field(contact, "FirstName")),
    lastName: text(field(contact, "LastName")),
    email: text(field(contact, "Email")),
    phone1: text(field(contact, "Phone1")),
    phone2: text(field(contact, "Phone2")),
    ...mapAcumaticaContactOptIns(contact),
  };
}

async function contactForRun(contactId: string, contact: unknown, now: Date, send: boolean) {
  if (send) return upsertFreshContact(contactId, contact, now);
  const [smsOptOuts, emailOptOuts] = await Promise.all([
    prisma.smsOptOut.findMany({ where: { contactId, isActive: true }, select: { phone: true } }),
    prisma.emailOptOut.findMany({ where: { contactId, isActive: true }, select: { email: true } }),
  ]);
  return { contactId, ...freshContactData(contact), smsOptOuts, emailOptOuts };
}

async function getWillCallUrl(params: {
  customerId: string;
  billingZip: string;
  email: string;
  orderNumber: string;
}) {
  const baseUrl = process.env.WILLCALL_BACKEND_URL?.trim().replace(/\/+$/, "");
  const token = process.env.WILLCALL_INVITE_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("Missing WILLCALL_BACKEND_URL or WILLCALL_INVITE_TOKEN");
  const response = await fetch(`${baseUrl}/api/internal/invites/dispatch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, sendEmail: false }),
  });
  const body = await response.text();
  const result = body ? JSON.parse(body) as {
    registrationUrl?: string;
    existingAccount?: boolean;
    message?: string;
  } : {};
  if (!response.ok || !result.registrationUrl) {
    throw new Error(`Will Call invite failed status=${response.status} error=${result.message || "registration URL missing"}`);
  }
  return {
    url: result.registrationUrl,
    existingAccount: result.existingAccount === true,
  };
}

function skippedReason(candidate: ThankYouCandidate, classification: OrderThankYouClassification | null) {
  if (!ACTIVE_STATUSES.has(normalize(candidate.status))) return "status_not_eligible";
  if (!classification) return "unsupported_ship_via";
  if (candidate.thankYouAlreadySent) return "thank_you_already_true";
  return null;
}

function cleanError(error: unknown, max = 1024) {
  return (error instanceof Error ? error.message : String(error)).slice(0, max);
}

async function enqueueEventWriteback(eventId: string) {
  const event = await prisma.orderThankYouEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (!event.firstSentAt || event.acumaticaWritebackCompletedAt) return false;
  try {
    const queued = await enqueueThankYouWriteback(event.orderType, event.orderNumber);
    await prisma.orderThankYouEvent.update({
      where: { id: event.id },
      data: {
        acumaticaWritebackStatus: "queued",
        acumaticaWritebackJobId: queued.jobId,
        acumaticaWritebackAttempts: { increment: 1 },
        acumaticaWritebackQueuedAt: new Date(),
        acumaticaWritebackCheckedAt: null,
        acumaticaWritebackError: null,
      },
    });
    return true;
  } catch (error) {
    await prisma.orderThankYouEvent.update({
      where: { id: event.id },
      data: {
        acumaticaWritebackStatus: "enqueue_failed",
        acumaticaWritebackAttempts: { increment: 1 },
        acumaticaWritebackCheckedAt: new Date(),
        acumaticaWritebackError: cleanError(error, 2048),
      },
    });
    return false;
  }
}

export async function reconcileOrderThankYouWritebacks(now = new Date()) {
  const retryBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const maxAttempts = Math.max(1, Number(process.env.DELIVERY_THANK_YOU_WRITEBACK_MAX_ATTEMPTS || 10));
  const events = await prisma.orderThankYouEvent.findMany({
    where: {
      firstSentAt: { not: null },
      acumaticaWritebackCompletedAt: null,
      acumaticaWritebackAttempts: { lt: maxAttempts },
      OR: [
        { acumaticaWritebackCheckedAt: null },
        { acumaticaWritebackCheckedAt: { lte: retryBefore } },
      ],
    },
    orderBy: { firstSentAt: "asc" },
    take: 100,
  });
  let completed = 0;
  let pending = 0;
  let failed = 0;
  let requeued = 0;
  for (const event of events) {
    if (!event.acumaticaWritebackJobId) {
      await enqueueEventWriteback(event.id);
      requeued += 1;
      continue;
    }
    try {
      const job = await getThankYouQueueJob(event.acumaticaWritebackJobId);
      if (job.status === "succeeded") {
        await prisma.orderThankYouEvent.update({
          where: { id: event.id },
          data: {
            acumaticaWritebackStatus: "written",
            acumaticaWritebackCheckedAt: now,
            acumaticaWritebackCompletedAt: now,
            acumaticaWritebackError: null,
          },
        });
        completed += 1;
      } else if (job.status === "failed") {
        await prisma.orderThankYouEvent.update({
          where: { id: event.id },
          data: {
            acumaticaWritebackStatus: "failed",
            acumaticaWritebackJobId: null,
            acumaticaWritebackCheckedAt: now,
            acumaticaWritebackError: (job.error || "Queue worker marked the job failed").slice(0, 2048),
          },
        });
        failed += 1;
      } else {
        await prisma.orderThankYouEvent.update({
          where: { id: event.id },
          data: { acumaticaWritebackStatus: job.status || "unknown", acumaticaWritebackCheckedAt: now },
        });
        pending += 1;
      }
    } catch (error) {
      await prisma.orderThankYouEvent.update({
        where: { id: event.id },
        data: {
          acumaticaWritebackStatus: "status_check_failed",
          acumaticaWritebackCheckedAt: now,
          acumaticaWritebackError: cleanError(error, 2048),
        },
      });
      failed += 1;
    }
  }
  return { checked: events.length, completed, pending, failed, requeued };
}

export async function runOrderThankYou(options: RunOrderThankYouOptions) {
  const now = options.now ?? new Date();
  if (options.send && process.env.DELIVERY_REAL_CUSTOMER_SEND_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("DELIVERY_REAL_CUSTOMER_SEND_ENABLED must be exactly true for thank-you sends");
  }
  const report = await fetchThankYouReportRows();
  const parsed = report.rows.map(parseThankYouCandidate).filter((row): row is ThankYouCandidate => Boolean(row));
  const orderType = normalize(options.orderType);
  const orderNumber = normalize(options.orderNumber);
  if ((orderType && !orderNumber) || (!orderType && orderNumber)) {
    throw new Error("orderType and orderNumber must be supplied together");
  }
  const candidates = parsed.filter((candidate) =>
    !orderType || (candidate.orderType === orderType && candidate.orderNumber === orderNumber)
  );
  const erp = new QueueErpClient();
  const provider = options.provider ?? createDeliveryNotificationProvider();
  const globalOptOuts = await loadActiveNotificationOptOutAddresses(prisma);
  const summary = {
    reportJobId: report.jobId,
    fetched: report.rows.length,
    parsed: parsed.length,
    scoped: candidates.length,
    eligible: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    attemptsCreated: 0,
    writebacksQueued: 0,
    skipReasons: {} as Record<string, number>,
    reports: [] as Array<Record<string, unknown>>,
  };
  const noteSkip = (reason: string) => {
    summary.skipped += 1;
    summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
  };

  for (const candidate of candidates) {
    const classification = classifyThankYouShipVia(candidate.shipVia);
    const initialSkip = skippedReason(candidate, classification);
    if (initialSkip || !classification) {
      noteSkip(initialSkip || "unsupported_ship_via");
      summary.reports.push({ orderType: candidate.orderType, orderNumber: candidate.orderNumber, outcome: "skipped", reason: initialSkip || "unsupported_ship_via" });
      continue;
    }

    const existing = await prisma.orderThankYouEvent.findUnique({
      where: { orderType_orderNumber: { orderType: candidate.orderType, orderNumber: candidate.orderNumber } },
      include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
    });
    if (existing?.firstSentAt) {
      noteSkip("already_sent");
      summary.reports.push({ orderType: candidate.orderType, orderNumber: candidate.orderNumber, outcome: "skipped", reason: "already_sent", eventId: existing.id });
      continue;
    }
    const nonRetryableAttemptStatuses = new Set<NotificationAttemptStatus>([
      NotificationAttemptStatus.CREATED,
      NotificationAttemptStatus.SUBMITTED,
      NotificationAttemptStatus.DELIVERED,
    ]);
    if (existing?.attempts[0] && nonRetryableAttemptStatuses.has(existing.attempts[0].status)) {
      noteSkip("attempt_already_in_flight_or_completed");
      summary.reports.push({ orderType: candidate.orderType, orderNumber: candidate.orderNumber, outcome: "skipped", reason: "attempt_already_in_flight_or_completed", eventId: existing.id });
      continue;
    }

    try {
      const fullRows = await erp.fetchDeliverySalesOrderByOrderNumber(candidate.orderNumber, candidate.orderType);
      const fullOrder = fullOrderMatch(fullRows, candidate);
      if (!fullOrder) throw new Error("fresh_full_order_not_found");
      const contactId = text(field(fullOrder, "ContactID"));
      if (!contactId) throw new Error("fresh_order_contact_id_missing");
      const contactRows = await erp.fetchDeliveryContactByContactId(contactId);
      const freshContact = contactMatch(contactRows, contactId);
      if (!freshContact) throw new Error("fresh_contact_not_found");
      const contact = await contactForRun(contactId, freshContact, now, options.send);
      const selected = selectNotificationChannel(contact, globalOptOuts);
      const localOptOuts = localOptOutSnapshot(contact);
      if (!selected.selectedChannel) {
        noteSkip(selected.channelReason);
        if (options.send) {
          await prisma.orderThankYouEvent.upsert({
            where: { orderType_orderNumber: { orderType: candidate.orderType, orderNumber: candidate.orderNumber } },
            create: {
              orderType: candidate.orderType,
              orderNumber: candidate.orderNumber,
              classification,
              contactId,
              customerId: candidate.customerId,
              billingZip: candidate.billingZip,
              shipVia: candidate.shipVia,
              requestedDeliveryDate: fullOrderRequestedDate(fullOrder, candidate.requestedDeliveryDate),
              channelReason: selected.channelReason,
              status: NotificationEventStatus.SKIPPED,
              reasonSkipped: selected.channelReason,
              reportFetchedAt: now,
              fullOrderFetchedAt: now,
              contactFetchedAt: now,
            },
            update: {
              contactId,
              channelReason: selected.channelReason,
              status: NotificationEventStatus.SKIPPED,
              reasonSkipped: selected.channelReason,
              reportFetchedAt: now,
              fullOrderFetchedAt: now,
              contactFetchedAt: now,
            },
          });
        }
        summary.reports.push({ orderType: candidate.orderType, orderNumber: candidate.orderNumber, outcome: "skipped", reason: selected.channelReason });
        continue;
      }

      const deliveryDate = fullOrderRequestedDate(fullOrder, candidate.requestedDeliveryDate);
      let willCall: { url: string; existingAccount: boolean } | null = null;
      if (classification === OrderThankYouClassification.WILL_CALL) {
        const email = contact.email?.trim();
        if (!candidate.customerId || !candidate.billingZip || !email) {
          throw new Error("will_call_customer_id_billing_zip_or_email_missing");
        }
        willCall = options.send
          ? await getWillCallUrl({
              customerId: candidate.customerId,
              billingZip: candidate.billingZip,
              email,
              orderNumber: candidate.orderNumber,
            })
          : {
              url: (process.env.WILLCALL_FRONTEND_URL || "https://mld.com/willcall").replace(/\/+$/, ""),
              existingAccount: false,
            };
      }
      const rendered = classification === OrderThankYouClassification.DELIVERY
        ? renderDeliveryThankYou({
            orderNumber: candidate.orderNumber,
            requestedDeliveryDate: deliveryDate,
            withinSixWeeks: deliveryWithinSixWeeks(deliveryDate, now),
          })
        : renderWillCallThankYou({
            orderNumber: candidate.orderNumber,
            orderType: candidate.orderType,
            buyerGroup: candidate.buyerGroup,
            customerName: candidate.customerName,
            locationName: candidate.locationName,
            url: willCall!.url,
            existingAccount: willCall!.existingAccount,
          });
      summary.eligible += 1;
      if (!options.send) {
        summary.reports.push({
          orderType: candidate.orderType,
          orderNumber: candidate.orderNumber,
          outcome: "previewed",
          classification,
          selectedChannel: selected.selectedChannel,
          channelReason: selected.channelReason,
          subject: rendered.subject,
          textBody: rendered.textBody,
        });
        continue;
      }

      const event = await prisma.orderThankYouEvent.upsert({
        where: { orderType_orderNumber: { orderType: candidate.orderType, orderNumber: candidate.orderNumber } },
        create: {
          orderType: candidate.orderType,
          orderNumber: candidate.orderNumber,
          classification,
          contactId,
          customerId: candidate.customerId,
          billingZip: candidate.billingZip,
          shipVia: candidate.shipVia,
          requestedDeliveryDate: deliveryDate,
          selectedChannel: selected.selectedChannel as NotificationChannel,
          channelReason: selected.channelReason,
          recipientEmail: selected.recipientEmail ?? null,
          recipientPhone: selected.recipientPhone ?? null,
          status: NotificationEventStatus.SCHEDULED,
          reportFetchedAt: now,
          fullOrderFetchedAt: now,
          contactFetchedAt: now,
          willCallUrl: willCall?.url ?? null,
        },
        update: {
          classification,
          contactId,
          customerId: candidate.customerId,
          billingZip: candidate.billingZip,
          shipVia: candidate.shipVia,
          requestedDeliveryDate: deliveryDate,
          selectedChannel: selected.selectedChannel as NotificationChannel,
          channelReason: selected.channelReason,
          recipientEmail: selected.recipientEmail ?? null,
          recipientPhone: selected.recipientPhone ?? null,
          status: NotificationEventStatus.SCHEDULED,
          reasonSkipped: null,
          reasonFailed: null,
          reportFetchedAt: now,
          fullOrderFetchedAt: now,
          contactFetchedAt: now,
          willCallUrl: willCall?.url ?? null,
        },
      });
      const claimed = await prisma.orderThankYouEvent.updateMany({
        where: { id: event.id, status: NotificationEventStatus.SCHEDULED, firstSentAt: null },
        data: { status: NotificationEventStatus.PENDING },
      });
      if (claimed.count !== 1) {
        noteSkip("event_not_claimable");
        continue;
      }
      const latest = await prisma.orderThankYouAttempt.findFirst({
        where: { orderThankYouEventId: event.id },
        orderBy: { attemptNumber: "desc" },
        select: { attemptNumber: true },
      });
      const channel = selected.selectedChannel as NotificationChannel;
      const recipient = channel === NotificationChannel.SMS ? selected.recipientPhone : selected.recipientEmail;
      if (!recipient) throw new Error("selected_recipient_missing");
      const attempt = await prisma.orderThankYouAttempt.create({
        data: {
          orderThankYouEventId: event.id,
          attemptNumber: (latest?.attemptNumber ?? 0) + 1,
          channel,
          recipient,
          realSmsOptIn: contact.smsOptIn,
          realEmailOptIn: contact.emailOptIn,
          localSmsOptOutActive: localOptOuts.sms,
          localEmailOptOutActive: localOptOuts.email,
        },
      });
      summary.attemptsCreated += 1;
      try {
        const result = channel === NotificationChannel.SMS
          ? await provider.sendSms({ to: recipient, body: rendered.textBody, statusCallbackUrl: buildTwilioStatusCallbackUrl() })
          : await provider.sendEmail({ to: recipient, subject: rendered.subject, textBody: rendered.textBody, htmlBody: rendered.htmlBody });
        await prisma.$transaction([
          prisma.orderThankYouAttempt.update({
            where: { id: attempt.id },
            data: {
              status: NotificationAttemptStatus.SUBMITTED,
              provider: result.provider,
              success: true,
              providerCode: result.providerCode,
              httpStatus: result.httpStatus,
              externalMessageId: result.externalMessageId,
              sentAt: now,
            },
          }),
          prisma.orderThankYouEvent.update({
            where: { id: event.id },
            data: {
              status: NotificationEventStatus.SENT,
              provider: result.provider,
              externalMessageId: result.externalMessageId,
              firstSentAt: now,
              reasonFailed: null,
            },
          }),
        ]);
        summary.sent += 1;
        if (await enqueueEventWriteback(event.id)) summary.writebacksQueued += 1;
        summary.reports.push({ orderType: candidate.orderType, orderNumber: candidate.orderNumber, outcome: "submitted", classification, selectedChannel: channel, eventId: event.id, attemptId: attempt.id, provider: result.provider, externalMessageIdPresent: Boolean(result.externalMessageId) });
      } catch (error) {
        const providerError = error instanceof DeliveryNotificationProviderError ? error : null;
        const message = cleanError(error);
        await prisma.$transaction([
          prisma.orderThankYouAttempt.update({
            where: { id: attempt.id },
            data: {
              status: NotificationAttemptStatus.FAILED,
              provider: providerError?.provider,
              providerCode: providerError?.providerCode,
              httpStatus: providerError?.httpStatus,
              externalMessageId: providerError?.externalMessageId,
              errorMessage: message,
            },
          }),
          prisma.orderThankYouEvent.update({
            where: { id: event.id },
            data: { status: NotificationEventStatus.FAILED, reasonFailed: message },
          }),
        ]);
        summary.failed += 1;
        summary.reports.push({ orderType: candidate.orderType, orderNumber: candidate.orderNumber, outcome: "failed", reason: message, eventId: event.id, attemptId: attempt.id });
      }
    } catch (error) {
      const reason = cleanError(error);
      summary.failed += 1;
      summary.reports.push({ orderType: candidate.orderType, orderNumber: candidate.orderNumber, outcome: "failed_closed", reason });
    }
  }
  return summary;
}

export async function runScheduledOrderThankYou(params: { now?: Date; send?: boolean } = {}) {
  const now = params.now ?? new Date();
  const date = denverDateKey(now);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const lockKey = `order_thank_you:${date}`;
  const existing = await prisma.deliveryIntervalSchedulerRun.findUnique({ where: { lockKey } });
  if (existing?.status === "SUCCESS") return { ok: true, phase: "skipped_already_completed", lockKey };
  if (existing?.status === "RUNNING" && now.getTime() - existing.updatedAt.getTime() < 30 * 60 * 1000) {
    return { ok: true, phase: "skipped_already_running", lockKey };
  }
  const row = existing
    ? await prisma.deliveryIntervalSchedulerRun.update({
        where: { id: existing.id },
        data: { status: "RUNNING", retryCount: { increment: 1 }, startedAt: now, completedAt: null, failedAt: null, errorMessage: null },
      })
    : await prisma.deliveryIntervalSchedulerRun.create({
        data: { lockKey, interval: "THANK_YOU", runDate: new Date(`${date}T00:00:00.000Z`), timezone: "America/Denver", expectedLocalTime: "10:00", actualLocalTime: time, delegatedArgs: { task: "order-thank-you", send: params.send !== false } },
      });
  try {
    const result = await runOrderThankYou({ send: params.send !== false, now });
    await prisma.deliveryIntervalSchedulerRun.update({ where: { id: row.id }, data: { status: "SUCCESS", completedAt: new Date(), resultSummary: result as unknown as Prisma.InputJsonObject } });
    return { ok: true, phase: "completed", lockKey, schedulerRunId: row.id, result };
  } catch (error) {
    const message = cleanError(error);
    await prisma.deliveryIntervalSchedulerRun.update({ where: { id: row.id }, data: { status: "FAILED", failedAt: new Date(), errorMessage: message } });
    throw error;
  }
}

export function orderThankYouIsDue(params: { localTime: string; enabled?: string }) {
  return params.enabled?.trim().toLowerCase() === "true" && params.localTime === "10:00";
}
