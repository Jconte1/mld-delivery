import { createErpClientFromEnv } from "../lib/erp/erpClient";
import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import {
  DeliveryConfirmationStatus,
  NotificationChannel,
  type Prisma,
} from "../lib/generated/prisma/client";
import {
  REQUESTED_DELIVERY_DATE_RULES,
  determineRequestedDeliveryDateRule,
  getRequestedDeliveryDateWebInstruction,
  validateRequestedDeliveryDateEligibility,
  type DeliveryDateEligibilityAddress,
} from "../lib/notifications/deliveryDateEligibility";
import { render42DayEmailConfirmationMessage } from "../lib/notifications/deliveryConfirmationEmail";
import {
  buildDeliveryConfirmationLink,
  getDeliveryAppBaseUrlConfig,
  newDeliveryConfirmationLinkToken,
} from "../lib/notifications/deliveryConfirmationLinks";
import { render42DaySmsConfirmationMessage } from "../lib/notifications/deliveryConfirmationSms";
import {
  formatMmDdYyyy,
} from "../lib/notifications/deliveryConfirmationSmsReplies";
import { ensurePendingDeliveryConfirmation } from "../lib/notifications/deliveryConfirmationState";
import { handleTwilioInboundSms } from "../lib/notifications/handleTwilioInboundSms";
import {
  dateFromKey,
  dateKey,
  formatContactName,
  formatJobAddress,
  formatJobName,
} from "../lib/notifications/helpers";
import { sendDemoEmail } from "./manual-demo/demoNotificationDispatch";
import { prisma } from "../lib/prisma";

const TARGET_ORDERS = [
  {
    label: "McCall, Idaho",
    orderType: "PG",
    orderNumber: "PG03275",
    expectedRuleName: REQUESTED_DELIVERY_DATE_RULES.MCCALL_MONDAY_ONLY,
    validWeekdayIndex: 1,
    wrongWeekdayIndex: 2,
    expectedSmsRouteText: "McCall deliveries are available on Mondays only.",
    expectedSmsRejectionText: "We deliver to McCall, Idaho on Mondays only",
    expectedWebRouteText: "McCall, Idaho deliveries are available on Mondays only.",
  },
  {
    label: "Wyoming",
    orderType: "PL",
    orderNumber: "PL01736",
    expectedRuleName: REQUESTED_DELIVERY_DATE_RULES.WYOMING_TUESDAY_ONLY,
    validWeekdayIndex: 2,
    wrongWeekdayIndex: 1,
    expectedSmsRouteText: "Wyoming deliveries are available on Tuesdays only.",
    expectedSmsRejectionText: "We deliver to Wyoming on Tuesdays only",
    expectedWebRouteText: "Wyoming deliveries are available on Tuesdays only.",
  },
] as const;

const NOW = new Date("2026-08-10T12:00:00.000Z");
const TEST_SMS_FROM = "+18015550123";
const TEST_SMS_TO = "+13855550100";

type TargetOrder = (typeof TARGET_ORDERS)[number];
type LocalOrder = NonNullable<Awaited<ReturnType<typeof loadLocalOrder>>>;
type LocalDeliveryGroup = LocalOrder["deliveryGroups"][number];

type TableCounts = {
  notification_events: number;
  notification_attempts: number;
  delivery_confirmations: number;
  delivery_order_hold_actions: number;
  delivery_group_ten_day_confirmations: number;
  twilio_inbound_messages: number;
  sms_opt_outs: number;
  email_opt_outs: number;
};

type ContactRecord = {
  contactId: string;
  displayName: string | null;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone1: string | null;
  phone2: string | null;
};

type DeliveryConfirmationRecord = {
  id: string;
  orderId: string;
  deliveryGroupId: string;
  notificationEventId: string | null;
  orderType: string;
  orderNumber: string;
  deliveryDate: Date;
  contactId: string;
  status: DeliveryConfirmationStatus;
  responseChannel: NotificationChannel | null;
  rawResponse: string | null;
  normalizedResponse: string | null;
  confirmedAt: Date | null;
  changeRequestedAt: Date | null;
  requestedNewDate: Date | null;
  requestedNewDateRaw: string | null;
  requestedNewDateAt: Date | null;
  reminderSentAt: Date | null;
  noResponseAt: Date | null;
  manualReviewRequired: boolean;
  manualReviewReason: string | null;
  manualReviewMarkedAt: Date | null;
  manualReviewNotes: string | null;
  unrecognizedResponseCount: number;
  confirmationFollowUpCount: number;
  lastSmsResponseAt: Date | null;
  lastSmsResponseBody: string | null;
  linkToken: string | null;
  linkCreatedAt: Date | null;
  linkExpiresAt: Date | null;
  linkExpiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  address: DeliveryDateEligibilityAddress;
};

type TwilioInboundRecord = {
  id: string;
  messageSid: string | null;
  parsedIntent: string;
  matchStatus: string;
  deliveryConfirmationId: string | null;
  notificationEventId: string | null;
  rawPayload: Prisma.InputJsonObject;
  processedAt: Date | null;
  responseMessage: string | null;
  responseSent: boolean;
  error: string | null;
};

type QueueRequest = {
  url: string;
  payload: Record<string, unknown>;
};

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function requireEnv(name: string) {
  const value = envValue(name);
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function parseArgs(argv: string[]) {
  const skipEmailOrderNumbers = new Set<string>();

  for (const arg of argv) {
    if (arg.startsWith("--skip-email-order=")) {
      const orderNumber = arg.slice("--skip-email-order=".length).trim().toUpperCase();
      if (orderNumber) skipEmailOrderNumbers.add(orderNumber);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { skipEmailOrderNumbers };
}

function ensureQueueReadMode() {
  process.env.USE_QUEUE_ERP = "true";
  process.env.MLD_QUEUE_JOB_POLL_TIMEOUT_MS ||= "120000";
  process.env.MLD_QUEUE_JOB_POLL_INTERVAL_MS ||= "1000";
  process.env.MLD_QUEUE_STEP2_TIMEOUT_MS ||= "120000";
  process.env.MLD_QUEUE_CONTACT_TIMEOUT_MS ||= "120000";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function redactedEmail(value: string) {
  const [local, domain] = value.split("@");
  if (!domain) return "<redacted>";
  return `${local.slice(0, 1)}***@${domain}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function fieldValue(value: unknown): unknown {
  const record = asRecord(value);
  if (record && "value" in record) return record.value;
  return value;
}

function field(record: unknown, key: string) {
  const obj = asRecord(record);
  return obj ? fieldValue(obj[key]) : null;
}

function stringField(record: unknown, key: string) {
  const value = field(record, key);
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function firstRecord(value: unknown) {
  const normalized = fieldValue(value);
  if (Array.isArray(normalized)) return asRecord(normalized[0]);
  return asRecord(normalized);
}

function orderMatches(row: unknown, target: TargetOrder) {
  return (
    stringField(row, "OrderNbr")?.toUpperCase() === target.orderNumber &&
    stringField(row, "OrderType")?.toUpperCase() === target.orderType
  );
}

function erpAddress(row: unknown): DeliveryDateEligibilityAddress {
  const shipToAddress = firstRecord(field(row, "ShipToAddress"));
  return {
    state: stringField(shipToAddress, "State"),
    postalCode: stringField(shipToAddress, "PostalCode"),
  };
}

function applyData(record: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === "object" &&
      "increment" in value &&
      typeof value.increment === "number"
    ) {
      record[key] = Number(record[key] ?? 0) + value.increment;
      continue;
    }
    record[key] = value;
  }
}

function selectFields(record: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return record;
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, include]) => include)
      .map(([key]) => [key, record[key]])
  );
}

function matchesConfirmationWhere(
  record: DeliveryConfirmationRecord,
  where: Record<string, unknown> | undefined
) {
  if (!where) return true;

  const idWhere = where.id as { in?: string[] } | undefined;
  if (idWhere?.in && !idWhere.in.includes(record.id)) return false;

  const statusWhere = where.status as { in?: DeliveryConfirmationStatus[] } | undefined;
  if (statusWhere?.in && !statusWhere.in.includes(record.status)) return false;

  const deliveryDateWhere = where.deliveryDate as { gte?: Date } | Date | undefined;
  if (deliveryDateWhere instanceof Date && dateKey(record.deliveryDate) !== dateKey(deliveryDateWhere)) {
    return false;
  }
  if (
    deliveryDateWhere &&
    !(deliveryDateWhere instanceof Date) &&
    deliveryDateWhere.gte &&
    record.deliveryDate.getTime() < deliveryDateWhere.gte.getTime()
  ) {
    return false;
  }

  if (where.confirmedAt === null && record.confirmedAt !== null) return false;
  if (where.requestedNewDate === null && record.requestedNewDate !== null) return false;
  if (
    typeof where.manualReviewRequired === "boolean" &&
    record.manualReviewRequired !== where.manualReviewRequired
  ) {
    return false;
  }

  const followUpWhere = where.confirmationFollowUpCount as { lte?: number } | undefined;
  if (typeof followUpWhere?.lte === "number" && record.confirmationFollowUpCount > followUpWhere.lte) {
    return false;
  }

  return true;
}

class InMemorySmsStore {
  contacts: ContactRecord[] = [];
  deliveryConfirmations: DeliveryConfirmationRecord[] = [];
  inboundMessages: TwilioInboundRecord[] = [];
  private sequence = 1;

  readonly client = {
    contact: {
      findMany: async () => this.contacts,
      updateMany: async () => ({ count: 0 }),
    },
    smsOptOut: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async () => {
        throw new Error("STOP scenario is intentionally not executed by this controlled test");
      },
      update: async () => {
        throw new Error("START scenario is intentionally not executed by this controlled test");
      },
      updateMany: async () => ({ count: 0 }),
    },
    twilioInboundMessage: {
      findUnique: async (args: {
        where: { messageSid?: string | null; id?: string };
        select?: Record<string, boolean>;
      }) => {
        const record = args.where.id
          ? this.inboundMessages.find((row) => row.id === args.where.id)
          : this.inboundMessages.find((row) => row.messageSid === args.where.messageSid);
        return record
          ? selectFields(record as unknown as Record<string, unknown>, args.select)
          : null;
      },
      create: async (args: {
        data: Partial<TwilioInboundRecord>;
        select?: Record<string, boolean>;
      }) => {
        const record: TwilioInboundRecord = {
          id: this.id("twilio_inbound"),
          messageSid: args.data.messageSid ?? null,
          parsedIntent: String(args.data.parsedIntent ?? "UNRECOGNIZED"),
          matchStatus: String(args.data.matchStatus ?? "UNPROCESSED"),
          deliveryConfirmationId: args.data.deliveryConfirmationId ?? null,
          notificationEventId: args.data.notificationEventId ?? null,
          rawPayload: args.data.rawPayload ?? {},
          processedAt: args.data.processedAt ?? null,
          responseMessage: args.data.responseMessage ?? null,
          responseSent: args.data.responseSent ?? false,
          error: args.data.error ?? null,
        };
        this.inboundMessages.push(record);
        return selectFields(record as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<TwilioInboundRecord> }) => {
        const record = this.inboundMessages.find((row) => row.id === args.where.id);
        if (!record) throw new Error(`Missing TwilioInboundMessage ${args.where.id}`);
        applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
        return record;
      },
    },
    deliveryConfirmation: {
      findMany: async (args: { where?: Record<string, unknown> }) =>
        this.deliveryConfirmations
          .filter((record) => matchesConfirmationWhere(record, args.where))
          .map((record) => this.decorateConfirmation(record)),
      update: async (args: {
        where: { id: string };
        data: Partial<DeliveryConfirmationRecord>;
        select?: Record<string, boolean>;
      }) => {
        const record = this.deliveryConfirmations.find((row) => row.id === args.where.id);
        if (!record) throw new Error(`Missing DeliveryConfirmation ${args.where.id}`);
        applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
        record.updatedAt = NOW;
        return selectFields(record as unknown as Record<string, unknown>, args.select);
      },
      updateMany: async (args: {
        where?: Record<string, unknown>;
        data: Partial<DeliveryConfirmationRecord>;
      }) => {
        let count = 0;
        for (const record of this.deliveryConfirmations) {
          if (!matchesConfirmationWhere(record, args.where)) continue;
          applyData(record as unknown as Record<string, unknown>, args.data as Record<string, unknown>);
          record.updatedAt = NOW;
          count += 1;
        }
        return { count };
      },
    },
  } as never;

  seedConfirmation(params: {
    target: TargetOrder;
    deliveryDate: Date;
    address: DeliveryDateEligibilityAddress;
    status?: DeliveryConfirmationStatus;
    unrecognizedResponseCount?: number;
  }) {
    const contactId = this.id("contact");
    const orderId = this.id("order");
    const deliveryGroupId = this.id("delivery_group");
    const notificationEventId = this.id("event");
    const now = NOW;

    this.contacts.push({
      contactId,
      displayName: "SMS Fixture",
      companyName: null,
      firstName: "SMS",
      lastName: "Fixture",
      email: "sms-fixture@example.test",
      phone1: TEST_SMS_FROM,
      phone2: null,
    });

    const confirmation: DeliveryConfirmationRecord = {
      id: this.id("confirmation"),
      orderId,
      deliveryGroupId,
      notificationEventId,
      orderType: params.target.orderType,
      orderNumber: params.target.orderNumber,
      deliveryDate: params.deliveryDate,
      contactId,
      status: params.status ?? DeliveryConfirmationStatus.PENDING,
      responseChannel: null,
      rawResponse: null,
      normalizedResponse: null,
      confirmedAt: null,
      changeRequestedAt: null,
      requestedNewDate: null,
      requestedNewDateRaw: null,
      requestedNewDateAt: null,
      reminderSentAt: null,
      noResponseAt: null,
      manualReviewRequired: false,
      manualReviewReason: null,
      manualReviewMarkedAt: null,
      manualReviewNotes: null,
      unrecognizedResponseCount: params.unrecognizedResponseCount ?? 0,
      confirmationFollowUpCount: 0,
      lastSmsResponseAt: null,
      lastSmsResponseBody: null,
      linkToken: this.id("token"),
      linkCreatedAt: now,
      linkExpiresAt: addDays(now, 30),
      linkExpiredAt: null,
      createdAt: now,
      updatedAt: now,
      address: params.address,
    };
    this.deliveryConfirmations.push(confirmation);
    return confirmation;
  }

  private id(prefix: string) {
    const value = `${prefix}_${this.sequence}`;
    this.sequence += 1;
    return value;
  }

  private decorateConfirmation(record: DeliveryConfirmationRecord) {
    return {
      ...record,
      contact: this.contacts.find((contact) => contact.contactId === record.contactId),
      notificationEvent: {
        id: record.notificationEventId,
        createdAt: NOW,
        scheduledAt: NOW,
        triggeredAt: NOW,
        sentAt: NOW,
      },
      order: {
        address: record.address,
      },
    };
  }
}

function addDays(value: Date, days: number) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function inboundPayload(body: string, messageSid: string) {
  return {
    AccountSid: "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    MessagingServiceSid: "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    From: TEST_SMS_FROM,
    To: TEST_SMS_TO,
    Body: body,
    MessageSid: messageSid,
  };
}

function mockQueueFetch(requests: QueueRequest[]) {
  return async (input: string | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    requests.push({
      url: String(input),
      payload: body,
    });
    return new Response(JSON.stringify({ jobId: `mock-job-${requests.length}` }), { status: 202 });
  };
}

function nextWeekdayAfter(params: {
  weekdayIndex: number;
  after: Date;
  notSameAs?: Date;
}) {
  const date = dateFromKey(dateKey(params.after));
  date.setUTCDate(date.getUTCDate() + 1);
  for (let index = 0; index < 400; index += 1) {
    if (
      date.getUTCDay() === params.weekdayIndex &&
      (!params.notSameAs || dateKey(date) !== dateKey(params.notSameAs))
    ) {
      return new Date(date);
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  throw new Error(`Unable to find weekday ${params.weekdayIndex}`);
}

function nextWeekendAfter(params: { after: Date; notSameAs?: Date }) {
  const date = dateFromKey(dateKey(params.after));
  date.setUTCDate(date.getUTCDate() + 1);
  for (let index = 0; index < 400; index += 1) {
    const day = date.getUTCDay();
    if ((day === 0 || day === 6) && (!params.notSameAs || dateKey(date) !== dateKey(params.notSameAs))) {
      return new Date(date);
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  throw new Error("Unable to find weekend date");
}

async function tableCounts(): Promise<TableCounts> {
  return {
    notification_events: await prisma.notificationEvent.count(),
    notification_attempts: await prisma.notificationAttempt.count(),
    delivery_confirmations: await prisma.deliveryConfirmation.count(),
    delivery_order_hold_actions: await prisma.deliveryOrderHoldAction.count(),
    delivery_group_ten_day_confirmations: await prisma.deliveryGroupTenDayConfirmation.count(),
    twilio_inbound_messages: await prisma.twilioInboundMessage.count(),
    sms_opt_outs: await prisma.smsOptOut.count(),
    email_opt_outs: await prisma.emailOptOut.count(),
  };
}

function countDiff(before: TableCounts, after: TableCounts) {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      value - before[key as keyof TableCounts],
    ])
  );
}

async function loadLocalOrder(target: TargetOrder) {
  return prisma.order.findUnique({
    where: {
      orderType_orderNumber: {
        orderType: target.orderType,
        orderNumber: target.orderNumber,
      },
    },
    include: {
      contact: true,
      address: true,
      deliveryGroups: {
        where: { isActive: true },
        orderBy: { deliveryDate: "asc" },
        include: {
          deliveryGroupLines: {
            where: { isActive: true },
            select: { id: true },
          },
        },
      },
    },
  });
}

async function importTargetOrder(target: TargetOrder) {
  const requestedOn = dateKey(NOW);
  const result = await importSalesOrdersForLineRequestedOn(requestedOn, {
    orderLookups: [{ orderType: target.orderType, orderNumber: target.orderNumber }],
    includeUnqualifiedOrderLookups: true,
  });

  return {
    requestedOn,
    result,
  };
}

async function loadLocalOrderWithTargetedImport(target: TargetOrder) {
  let order = await loadLocalOrder(target);
  let importResult: Awaited<ReturnType<typeof importTargetOrder>> | null = null;

  if (!order || !selectDeliveryGroup(order)) {
    importResult = await importTargetOrder(target);
    order = await loadLocalOrder(target);
  }

  return {
    order,
    importResult,
  };
}

function selectDeliveryGroup(order: LocalOrder) {
  const today = dateFromKey(dateKey(NOW));
  return (
    order.deliveryGroups.find((group) => {
      const weekday = group.deliveryDate.getUTCDay();
      return (
        group.deliveryDate.getTime() >= today.getTime() &&
        weekday >= 1 &&
        weekday <= 5 &&
        ((group.lineCount ?? 0) > 0 || group.deliveryGroupLines.length > 0)
      );
    }) ?? null
  );
}

async function verifyQueueErpOrder(target: TargetOrder) {
  const client = createErpClientFromEnv();
  const rows = await client.fetchDeliverySalesOrderByOrderNumber(
    target.orderNumber,
    target.orderType
  );
  const matchingRow = rows.find((row) => orderMatches(row, target));
  const address = matchingRow ? erpAddress(matchingRow) : null;
  const rule = determineRequestedDeliveryDateRule(address);

  return {
    fetchedRows: rows.length,
    matchingRowFound: Boolean(matchingRow),
    routeRuleName: rule.ruleName,
    routeMatchesExpected: rule.ruleName === target.expectedRuleName,
    addressStatePresent: Boolean(address?.state),
    postalCodePresent: Boolean(address?.postalCode),
  };
}

async function ensureConfirmationLink(order: LocalOrder, group: LocalDeliveryGroup) {
  const existing = await prisma.deliveryConfirmation.findUnique({
    where: {
      deliveryGroupId_deliveryDate: {
        deliveryGroupId: group.id,
        deliveryDate: group.deliveryDate,
      },
    },
    select: { linkToken: true, linkExpiresAt: true },
  });
  const tokenStillValid = Boolean(
    existing?.linkToken &&
      (!existing.linkExpiresAt || existing.linkExpiresAt.getTime() > Date.now())
  );
  const linkToken = tokenStillValid && existing?.linkToken
    ? existing.linkToken
    : newDeliveryConfirmationLinkToken();
  const now = new Date();

  const confirmation = await ensurePendingDeliveryConfirmation({
    orderId: order.id,
    deliveryGroupId: group.id,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
    deliveryDate: group.deliveryDate,
    contactId: order.contact.contactId,
    linkToken,
    linkCreatedAt: now,
    linkExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  });

  return {
    confirmationId: confirmation.id,
    confirmationStatus: confirmation.status,
    confirmationUrl: buildDeliveryConfirmationLink(linkToken),
    reusedExistingToken: Boolean(tokenStillValid),
  };
}

function buildMessages(params: {
  target: TargetOrder;
  order: LocalOrder;
  group: LocalDeliveryGroup;
  confirmationUrl: string;
}) {
  const contactName = formatContactName(params.order.contact);
  const jobName = formatJobName({
    customerDescription: params.order.customerDescription,
    locationDescription: params.order.locationDescription,
  });
  const jobAddress = formatJobAddress(params.order.address ?? {}) || "the job site";
  const email = render42DayEmailConfirmationMessage({
    orderNumber: params.group.orderNumber,
    contactName,
    buyerGroup: params.order.buyerGroup,
    customerDescription: params.order.customerDescription,
    locationDescription: params.order.locationDescription,
    jobName,
    jobAddress,
    deliveryDate: params.group.deliveryDate,
    link: params.confirmationUrl,
    paymentReminderApplies: false,
  });
  const sms = render42DaySmsConfirmationMessage({
    orderNumber: params.group.orderNumber,
    contactName,
    buyerGroup: params.order.buyerGroup,
    jobName,
    deliveryDate: params.group.deliveryDate,
    link: params.confirmationUrl,
    deliveryAddress: params.order.address,
  });

  return {
    email,
    sms,
    emailBodyIncludesRouteNote:
      email.body.includes(params.target.expectedSmsRouteText) ||
      email.body.includes(params.target.expectedWebRouteText),
    smsBodyIncludesRouteNote: sms.includes(params.target.expectedSmsRouteText),
    webRequestedDateInstruction: getRequestedDeliveryDateWebInstruction(params.order.address),
  };
}

async function sendTestEmail(params: {
  target: TargetOrder;
  subject: string;
  body: string;
  htmlBody: string;
}) {
  const testEmail = requireEnv("NOTIFICATIONS_TEST_EMAIL");
  const result = await sendDemoEmail({
    toOverride: testEmail,
    subject: `[CONTROLLED ${params.target.label} special-date-rule test] ${params.subject}`,
    textBody: `Controlled ${params.target.label} special-date-rule test.\n\n${params.body}`,
    htmlBody: `<p>Controlled ${params.target.label} special-date-rule test.</p>\n${params.htmlBody}`,
  });

  return {
    recipientEnvVar: "NOTIFICATIONS_TEST_EMAIL",
    provider: result.provider,
    ok: result.ok,
  };
}

async function runInbound(params: {
  target: TargetOrder;
  body: string;
  sidSuffix: string;
  store: InMemorySmsStore;
  queueRequests: QueueRequest[];
}) {
  return handleTwilioInboundSms({
    payload: inboundPayload(params.body, `SM-${params.target.orderType}-${params.sidSuffix}`),
    prismaClient: params.store.client,
    now: NOW,
    queueOptions: {
      baseUrl: "http://mld-queue.local.test",
      token: "test-token",
      fetchImpl: mockQueueFetch(params.queueRequests),
    },
  });
}

function newSmsStore(params: {
  target: TargetOrder;
  group: LocalDeliveryGroup;
  address: DeliveryDateEligibilityAddress;
  status?: DeliveryConfirmationStatus;
  unrecognizedResponseCount?: number;
}) {
  const store = new InMemorySmsStore();
  const confirmation = store.seedConfirmation({
    target: params.target,
    deliveryDate: params.group.deliveryDate,
    address: params.address,
    status: params.status,
    unrecognizedResponseCount: params.unrecognizedResponseCount,
  });
  return { store, confirmation };
}

async function runSmsMatrix(params: {
  target: TargetOrder;
  group: LocalDeliveryGroup;
  address: DeliveryDateEligibilityAddress;
}) {
  const baseAfter = params.group.deliveryDate.getTime() > NOW.getTime() ? params.group.deliveryDate : NOW;
  const validDate = nextWeekdayAfter({
    weekdayIndex: params.target.validWeekdayIndex,
    after: baseAfter,
    notSameAs: params.group.deliveryDate,
  });
  const wrongRouteDate = nextWeekdayAfter({
    weekdayIndex: params.target.wrongWeekdayIndex,
    after: baseAfter,
    notSameAs: params.group.deliveryDate,
  });
  const weekendDate = nextWeekendAfter({ after: baseAfter, notSameAs: params.group.deliveryDate });
  const pastDate = new Date("2026-08-01T00:00:00.000Z");
  const sameCurrentDate = params.group.deliveryDate;
  const scenarios: Array<Record<string, unknown>> = [];

  for (const input of ["Y", "YES"]) {
    const { store, confirmation } = newSmsStore(params);
    const queueRequests: QueueRequest[] = [];
    const result = await runInbound({
      target: params.target,
      body: input,
      sidSuffix: `CONFIRM-${input}`,
      store,
      queueRequests,
    });
    assert(result.matchStatus === "MATCHED", `${params.target.label} ${input} should match`);
    assert(
      confirmation.status === DeliveryConfirmationStatus.CONFIRMED,
      `${params.target.label} ${input} should confirm`
    );
    assert(queueRequests.length === 1, `${params.target.label} ${input} should enqueue one mock writeback`);
    assert(
      queueRequests[0].payload.confirmedVia === "AUTOTXT",
      `${params.target.label} ${input} confirmedVia should be AUTOTXT`
    );
    assert(queueRequests[0].payload.source === "SMS", `${params.target.label} ${input} source should be SMS`);
    assert(queueRequests[0].payload.dryRun === true, `${params.target.label} ${input} writeback should be dry-run`);
    assert(
      !/acumatica/i.test(queueRequests[0].url),
      `${params.target.label} ${input} mock writeback must not call Acumatica`
    );
    scenarios.push({
      scenario: input,
      matchStatus: result.matchStatus,
      finalStatus: confirmation.status,
      mockWritebackRequests: queueRequests.length,
      dryRun: queueRequests[0].payload.dryRun,
    });
  }

  {
    const { store, confirmation } = newSmsStore(params);
    const queueRequests: QueueRequest[] = [];
    const result = await runInbound({
      target: params.target,
      body: "N",
      sidSuffix: "CHANGE",
      store,
      queueRequests,
    });
    assert(result.matchStatus === "MATCHED", `${params.target.label} N should match`);
    assert(
      confirmation.status === DeliveryConfirmationStatus.AWAITING_NEW_DATE,
      `${params.target.label} N should wait for new date`
    );
    scenarios.push({
      scenario: "N",
      matchStatus: result.matchStatus,
      finalStatus: confirmation.status,
      mockWritebackRequests: queueRequests.length,
    });
  }

  {
    const { store, confirmation } = newSmsStore(params);
    const queueRequests: QueueRequest[] = [];
    await runInbound({
      target: params.target,
      body: "N",
      sidSuffix: "VALID-AFTER-N-1",
      store,
      queueRequests,
    });
    const result = await runInbound({
      target: params.target,
      body: formatMmDdYyyy(validDate),
      sidSuffix: "VALID-AFTER-N-2",
      store,
      queueRequests,
    });
    assert(result.matchStatus === "MATCHED", `${params.target.label} valid date after N should match`);
    assert(
      confirmation.status === DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
      `${params.target.label} valid date after N should request new date`
    );
    assert(
      dateKey(confirmation.requestedNewDate as Date) === dateKey(validDate),
      `${params.target.label} valid date after N should store expected date`
    );
    scenarios.push({
      scenario: "valid date after N",
      requestedDate: dateKey(validDate),
      matchStatus: result.matchStatus,
      finalStatus: confirmation.status,
      manualReviewRequired: confirmation.manualReviewRequired,
    });
  }

  {
    const { store, confirmation } = newSmsStore(params);
    const queueRequests: QueueRequest[] = [];
    const result = await runInbound({
      target: params.target,
      body: formatMmDdYyyy(validDate),
      sidSuffix: "VALID-DIRECT",
      store,
      queueRequests,
    });
    assert(result.matchStatus === "MATCHED", `${params.target.label} direct valid date should match`);
    assert(
      confirmation.status === DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
      `${params.target.label} direct valid date should request new date`
    );
    scenarios.push({
      scenario: "valid date direct",
      requestedDate: dateKey(validDate),
      matchStatus: result.matchStatus,
      finalStatus: confirmation.status,
      manualReviewRequired: confirmation.manualReviewRequired,
    });
  }

  for (const invalid of [
    {
      scenario: "wrong route weekday",
      body: formatMmDdYyyy(wrongRouteDate),
      expectedText: params.target.expectedSmsRejectionText,
    },
    {
      scenario: "weekend requested date",
      body: formatMmDdYyyy(weekendDate),
      expectedText: "weekend",
    },
    {
      scenario: "past requested date",
      body: formatMmDdYyyy(pastDate),
      expectedText: "already passed",
    },
    {
      scenario: "same current delivery date",
      body: formatMmDdYyyy(sameCurrentDate),
      expectedText: "already your current",
    },
  ]) {
    const { store, confirmation } = newSmsStore(params);
    const queueRequests: QueueRequest[] = [];
    const result = await runInbound({
      target: params.target,
      body: invalid.body,
      sidSuffix: invalid.scenario.toUpperCase().replace(/\W+/g, "-"),
      store,
      queueRequests,
    });
    assert(result.matchStatus === "MATCHED", `${params.target.label} ${invalid.scenario} should match`);
    assert(
      confirmation.status !== DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
      `${params.target.label} ${invalid.scenario} should not request a new date`
    );
    assert(
      result.responseMessage?.includes(invalid.expectedText),
      `${params.target.label} ${invalid.scenario} should include expected rejection text`
    );
    scenarios.push({
      scenario: invalid.scenario,
      attemptedDate: invalid.body,
      matchStatus: result.matchStatus,
      finalStatus: confirmation.status,
      rejectionTextMatched: true,
    });
  }

  for (const invalidBody of ["tomorrow", "13/40/2026", "asdf"]) {
    const { store, confirmation } = newSmsStore({
      ...params,
      status: DeliveryConfirmationStatus.AWAITING_NEW_DATE,
    });
    const queueRequests: QueueRequest[] = [];
    const result = await runInbound({
      target: params.target,
      body: invalidBody,
      sidSuffix: `INVALID-${invalidBody.replace(/\W+/g, "-")}`,
      store,
      queueRequests,
    });
    assert(result.matchStatus === "MATCHED", `${params.target.label} invalid format should match`);
    assert(
      confirmation.status === DeliveryConfirmationStatus.AWAITING_NEW_DATE,
      `${params.target.label} invalid format should stay awaiting`
    );
    assert(
      result.responseMessage?.includes("MM/DD/YYYY"),
      `${params.target.label} invalid format should ask for MM/DD/YYYY`
    );
    scenarios.push({
      scenario: `invalid date format: ${invalidBody}`,
      matchStatus: result.matchStatus,
      finalStatus: confirmation.status,
      rejectionTextMatched: true,
    });
  }

  {
    const { store, confirmation } = newSmsStore(params);
    const queueRequests: QueueRequest[] = [];
    const result = await runInbound({
      target: params.target,
      body: "maybe",
      sidSuffix: "UNRECOGNIZED-MAYBE",
      store,
      queueRequests,
    });
    assert(result.matchStatus === "MATCHED", `${params.target.label} maybe should match active confirmation`);
    assert(
      confirmation.status === DeliveryConfirmationStatus.UNRECOGNIZED,
      `${params.target.label} maybe should mark unrecognized`
    );
    scenarios.push({
      scenario: "unrecognized message",
      matchStatus: result.matchStatus,
      finalStatus: confirmation.status,
      unrecognizedResponseCount: confirmation.unrecognizedResponseCount,
    });
  }

  {
    const { store, confirmation } = newSmsStore(params);
    const queueRequests: QueueRequest[] = [];
    for (const [index, body] of ["maybe", "who is this", "later"].entries()) {
      await runInbound({
        target: params.target,
        body,
        sidSuffix: `TOO-MANY-UNRECOGNIZED-${index + 1}`,
        store,
        queueRequests,
      });
    }
    assert(
      confirmation.unrecognizedResponseCount === 3,
      `${params.target.label} too many unrecognized should increment to 3`
    );
    assert(
      confirmation.manualReviewRequired === true,
      `${params.target.label} too many unrecognized should require manual review`
    );
    scenarios.push({
      scenario: "too many unrecognized replies",
      finalStatus: confirmation.status,
      unrecognizedResponseCount: confirmation.unrecognizedResponseCount,
      manualReviewRequired: confirmation.manualReviewRequired,
      manualReviewReason: confirmation.manualReviewReason,
    });
  }

  {
    const { store } = newSmsStore(params);
    const queueRequests: QueueRequest[] = [];
    const result = await runInbound({
      target: params.target,
      body: "HELP",
      sidSuffix: "HELP",
      store,
      queueRequests,
    });
    assert(result.matchStatus === "HELP", `${params.target.label} HELP should return HELP`);
    assert(result.responseMessage?.includes("Reply Y"), `${params.target.label} HELP should explain replies`);
    scenarios.push({
      scenario: "HELP",
      matchStatus: result.matchStatus,
      responseTextMatched: true,
    });
  }

  scenarios.push({
    scenario: "STOP",
    skipped: true,
    reason: "Skipped by design to avoid exercising opt-out/writeback lifecycle in this route-date test.",
  });

  return {
    validDate: dateKey(validDate),
    wrongRouteDate: dateKey(wrongRouteDate),
    weekendDate: dateKey(weekendDate),
    pastDate: dateKey(pastDate),
    sameCurrentDate: dateKey(sameCurrentDate),
    scenarios,
  };
}

function runWebValidationMatrix(params: {
  target: TargetOrder;
  group: LocalDeliveryGroup;
  address: DeliveryDateEligibilityAddress;
  validDate: string;
  wrongRouteDate: string;
  weekendDate: string;
  pastDate: string;
}) {
  const cases = [
    { scenario: "valid", requestedDate: params.validDate, expectedAllowed: true },
    {
      scenario: "wrong route weekday",
      requestedDate: params.wrongRouteDate,
      expectedAllowed: false,
      expectedReason: params.target.expectedRuleName,
    },
    {
      scenario: "weekend",
      requestedDate: params.weekendDate,
      expectedAllowed: false,
      expectedReason: "WEEKEND_NOT_ALLOWED",
    },
    {
      scenario: "past",
      requestedDate: params.pastDate,
      expectedAllowed: false,
      expectedReason: "DATE_IN_PAST",
    },
    {
      scenario: "same current delivery date",
      requestedDate: dateKey(params.group.deliveryDate),
      expectedAllowed: false,
      expectedReason: "SAME_AS_CURRENT_DELIVERY_DATE",
    },
  ] as const;

  return cases.map((testCase) => {
    const validation = validateRequestedDeliveryDateEligibility({
      requestedDate: testCase.requestedDate,
      currentDeliveryDate: params.group.deliveryDate,
      address: params.address,
      now: NOW,
    });
    assert(
      validation.allowed === testCase.expectedAllowed,
      `${params.target.label} web ${testCase.scenario} allowed mismatch`
    );
    if (!testCase.expectedAllowed) {
      assert(
        validation.reason === testCase.expectedReason,
        `${params.target.label} web ${testCase.scenario} reason mismatch`
      );
    }
    return {
      scenario: testCase.scenario,
      requestedDate: testCase.requestedDate,
      allowed: validation.allowed,
      reason: validation.reason,
      routeRuleName: validation.ruleName,
    };
  });
}

function preflight() {
  const baseUrl = getDeliveryAppBaseUrlConfig();
  const testEmail = requireEnv("NOTIFICATIONS_TEST_EMAIL");
  requireEnv("MLD_QUEUE_BASE_URL");
  requireEnv("MLD_QUEUE_TOKEN");
  requireEnv("MS_GRAPH_TENANT_ID");
  requireEnv("MS_GRAPH_CLIENT_ID");
  requireEnv("MS_GRAPH_CLIENT_SECRET");
  requireEnv("MS_GRAPH_FROM_EMAIL");
  if (envValue("DEMO_NOTIFICATION_SEND_ENABLED").toLowerCase() !== "true") {
    throw new Error("DEMO_NOTIFICATION_SEND_ENABLED must be true for controlled test email sends");
  }
  if (baseUrl.isLocalhost || baseUrl.isDefault) {
    throw new Error(
      "Delivery confirmation links must use a configured non-localhost delivery app base URL"
    );
  }

  process.env.DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN = "true";

  return {
    deliveryAppBaseUrl: baseUrl.baseUrl,
    deliveryAppBaseUrlEnvVar: baseUrl.envVar,
    queueBaseUrlConfigured: true,
    queueTokenConfigured: true,
    notificationsTestEmail: redactedEmail(testEmail),
    demoNotificationSendEnabled: true,
    smsWritebackSimulation: "mock fetch with DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN=true",
  };
}

async function runTarget(params: {
  target: TargetOrder;
  skipEmailOrderNumbers: Set<string>;
}) {
  const { target } = params;
  const erpVerification = await verifyQueueErpOrder(target);
  assert(erpVerification.matchingRowFound, `${target.label} ERP fetch did not return target order`);
  assert(
    erpVerification.routeMatchesExpected,
    `${target.label} ERP route rule did not match expected ${target.expectedRuleName}`
  );

  const { order, importResult } = await loadLocalOrderWithTargetedImport(target);
  assert(order, `${target.label} local order ${target.orderNumber} was not found after targeted import`);
  const localRule = determineRequestedDeliveryDateRule(order.address);
  assert(
    localRule.ruleName === target.expectedRuleName,
    `${target.label} local route rule did not match expected ${target.expectedRuleName}`
  );
  const group = selectDeliveryGroup(order);
  assert(group, `${target.label} has no active future weekday delivery group with active lines`);

  const link = await ensureConfirmationLink(order, group);
  const messages = buildMessages({
    target,
    order,
    group,
    confirmationUrl: link.confirmationUrl,
  });
  const emailSkipped = params.skipEmailOrderNumbers.has(target.orderNumber);
  const emailSend = emailSkipped
    ? {
        recipientEnvVar: "NOTIFICATIONS_TEST_EMAIL" as const,
        provider: null,
        ok: false,
        skipped: true,
        skippedReason: "Skipped to avoid resending an email already sent by a prior failed run.",
      }
    : {
        ...(await sendTestEmail({
          target,
          subject: messages.email.subject,
          body: messages.email.body,
          htmlBody: messages.email.htmlBody,
        })),
        skipped: false,
        skippedReason: null,
      };
  const smsMatrix = await runSmsMatrix({
    target,
    group,
    address: order.address ?? {},
  });
  const webMatrix = runWebValidationMatrix({
    target,
    group,
    address: order.address ?? {},
    validDate: smsMatrix.validDate,
    wrongRouteDate: smsMatrix.wrongRouteDate,
    weekendDate: smsMatrix.weekendDate,
    pastDate: smsMatrix.pastDate,
  });
  const renderOnlySms = render42DaySmsConfirmationMessage({
    orderNumber: target.orderNumber,
    contactName: "Test",
    jobName: "test delivery",
    deliveryDate: group.deliveryDate,
    link: link.confirmationUrl,
    deliveryAddress: order.address,
  });

  return {
    orderType: target.orderType,
    orderNumber: target.orderNumber,
    label: target.label,
    queueErpVerification: erpVerification,
    targetedLocalImport: importResult,
    localRouteRuleName: localRule.ruleName,
    selectedDeliveryGroupId: group.id,
    selectedDeliveryDate: dateKey(group.deliveryDate),
    activeLineCount: group.deliveryGroupLines.length || group.lineCount || 0,
    confirmation: link,
    email: {
      recipient: "NOTIFICATIONS_TEST_EMAIL",
      sent: emailSend.ok,
      provider: emailSend.provider,
      skipped: emailSend.skipped,
      skippedReason: emailSend.skippedReason,
      bodyIncludesRouteNote: messages.emailBodyIncludesRouteNote,
      webRequestedDateInstruction: messages.webRequestedDateInstruction,
    },
    renderOnlySms: {
      includesRouteNote: messages.smsBodyIncludesRouteNote,
      routeNoteText: localRule.smsRouteNoteText,
      freshRenderIncludesRouteNote: renderOnlySms.includes(target.expectedSmsRouteText),
    },
    smsMatrix,
    webMatrix,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureQueueReadMode();
  const preflightResult = preflight();
  const before = await tableCounts();
  const results = [];

  for (const target of TARGET_ORDERS) {
    results.push(await runTarget({ target, skipEmailOrderNumbers: args.skipEmailOrderNumbers }));
  }

  const after = await tableCounts();
  const diff = countDiff(before, after);
  const unexpectedDurableChanges = {
    notification_events: diff.notification_events,
    notification_attempts: diff.notification_attempts,
    delivery_order_hold_actions: diff.delivery_order_hold_actions,
    delivery_group_ten_day_confirmations: diff.delivery_group_ten_day_confirmations,
    twilio_inbound_messages: diff.twilio_inbound_messages,
    sms_opt_outs: diff.sms_opt_outs,
    email_opt_outs: diff.email_opt_outs,
  };

  for (const [table, delta] of Object.entries(unexpectedDurableChanges)) {
    assert(delta === 0, `Unexpected durable change in ${table}: ${delta}`);
  }

  console.log(
    JSON.stringify(
      {
        preflight: preflightResult,
        beforeCounts: before,
        results,
        afterCounts: after,
        countDiff: diff,
        safetyConfirmations: {
          notificationJobsRun: false,
          notificationEventsCreated: diff.notification_events,
          notificationAttemptsCreated: diff.notification_attempts,
          smsProviderSends: 0,
          emailProviderSendsToRealCustomers: 0,
          emailProviderSendsToNotificationsTestEmail: results.filter((row) => row.email.sent).length,
          acumaticaWrites: 0,
          oneWeekConWrites: 0,
          holdWrites: diff.delivery_order_hold_actions,
          targetedLocalImportsRun: results.filter((row) => row.targetedLocalImport).length,
          targetedLocalImportCanTouchLocalOrderData: true,
          deliveryDateOrOrderLineWritesOutsideTargetedImport: 0,
          twilioInboundRowsCreated: diff.twilio_inbound_messages,
          smsOptOutRowsCreated: diff.sms_opt_outs,
        },
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
