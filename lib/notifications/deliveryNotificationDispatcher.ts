import {
  InternalOrderLifecycleStatus,
  NotificationAttemptStatus,
  NotificationChannel,
  NotificationEventStatus,
  NotificationIntervalType,
  Prisma,
} from "@/lib/generated/prisma/client";
import {
  getDeliveryGroupPaymentEvaluation,
  type DeliveryGroupPaymentEvaluation,
} from "@/lib/delivery-payment/deliveryGroupPayment";
import { buildDeliveryConfirmationLink } from "@/lib/notifications/deliveryConfirmationLinks";
import {
  deliveryConfirmationReminderTouchNumberFromDedupeKey,
  guardDeliveryConfirmationNoResponseDispatch,
  isDeliveryConfirmationNoResponseManagedEvent,
} from "@/lib/notifications/deliveryConfirmationNoResponse";
import {
  render42DayEmailConfirmationMessage,
  render42DayEmailConfirmationReminderMessage,
} from "@/lib/notifications/deliveryConfirmationEmail";
import {
  render42DaySmsConfirmationMessage,
  render42DaySmsConfirmationReminderMessage,
} from "@/lib/notifications/deliveryConfirmationSms";
import { buildDeliveryDetailsLink } from "@/lib/notifications/deliveryDetailsLinks";
import {
  createDeliveryNotificationProvider,
  DeliveryNotificationProviderError,
  type DeliveryNotificationProvider,
  type DeliveryNotificationProviderResult,
  buildTwilioStatusCallbackUrl,
} from "@/lib/notifications/deliveryNotificationProviders";
import {
  formatContactName,
  formatJobAddress,
  formatJobName,
  renderDeliveryReminderEmailSubject,
  renderDeliveryReminderMessage,
  selectNotificationChannel,
  type NotificationChannel as HelperNotificationChannel,
} from "@/lib/notifications/helpers";
import {
  loadActiveNotificationOptOutAddresses,
  mergeNotificationOptOutAddresses,
  type ActiveNotificationOptOutAddresses,
} from "@/lib/notifications/notificationOptOutLookup";
import {
  normalizeEmailForOptOut,
  normalizeSmsPhoneForOptOut,
} from "@/lib/notifications/notificationAddressNormalization";
import { getPaymentDeadlineDate } from "@/lib/notifications/paymentDeadlineBusinessDays";
import { getActiveSalespersonContact } from "@/lib/notifications/salespersonContactCache";
import { prisma } from "@/lib/prisma";
import {
  render30DayDeliveryReminderEmail,
  render30DayDeliveryReminderSms,
} from "@/lib/notifications/deliveryReminder30Day";
import {
  render14DayDeliveryReminderEmail,
  render14DayDeliveryReminderSms,
} from "@/lib/notifications/deliveryReminder14Day";
import {
  render12DayDeliveryPaymentReminderEmail,
  render12DayDeliveryPaymentReminderSms,
} from "@/lib/notifications/deliveryPaymentReminder12Day";
import {
  render10DayDeliveryPaymentReminderEmail,
  render10DayDeliveryPaymentReminderSms,
} from "@/lib/notifications/deliveryPaymentReminder10Day";
import {
  render8DayPaymentEnforcementCustomerEmail,
  render8DayPaymentEnforcementCustomerSms,
} from "@/lib/notifications/deliveryPaymentEnforcement8Day";
import {
  render2DayDeliveryReminderEmail,
  render2DayDeliveryReminderSms,
} from "@/lib/notifications/deliveryReminder2Day";
import { renderDeliveryReminderEmailBody } from "@/lib/notifications/deliveryReminderEmail";

export type DispatcherChannelFilter = "sms" | "email" | "both";
export type DeliveryDispatchMode =
  | "preview"
  | "controlled-recipient send"
  | "real-customer send";

const REAL_CUSTOMER_SEND_ENABLED_ENV = "DELIVERY_REAL_CUSTOMER_SEND_ENABLED";
const REAL_CUSTOMER_SEND_NON_PRODUCTION_ENV =
  "DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION";
const CONTROLLED_RECIPIENT_MODE_ENV = "DELIVERY_CONTROLLED_RECIPIENT_MODE";
const FORCE_CONTACT_ELIGIBILITY_FOR_TEST_ENV =
  "DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST";
const CONTROLLED_RECIPIENT_CONFIRM_PHRASE_ENV =
  "DELIVERY_CONTROLLED_RECIPIENT_CONFIRM_PHRASE";

export type DispatchDeliveryNotificationsOptions = {
  preview?: boolean;
  send?: boolean;
  controlledRecipientSend?: boolean;
  confirmPhrase?: string | null;
  testRunId?: string | null;
  interval?: NotificationIntervalType | null;
  limit?: number | null;
  channel?: DispatcherChannelFilter;
  eventId?: string | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  prismaClient?: typeof prisma;
  provider?: DeliveryNotificationProvider;
};

export type DeliveryDispatcherPreflightResult = {
  ok: boolean;
  failures: string[];
  preview: boolean;
  send: boolean;
  mode: DeliveryDispatchMode;
  controlledRecipientMode: boolean;
  realCustomerSendMode: boolean;
  realCustomerSendEnabled: boolean;
  allowRealCustomerSendInNonProduction: boolean;
  forceContactEligibilityForTest: boolean;
  testEmail: string | null;
  testPhone: string | null;
};

export type DeliveryDispatchEventReport = {
  eventId: string;
  orderType: string;
  orderNumber: string;
  intervalType: string;
  actionType: string;
  outcome: "previewed" | "submitted" | "failed" | "skipped";
  reason: string | null;
  selectedChannel: string | null;
  attemptId: string | null;
  fallbackAttemptId: string | null;
  controlledRecipientMode: boolean;
  forcedContactEligibility: boolean;
  realSmsOptIn: boolean | null;
  realEmailOptIn: boolean | null;
  localSmsOptOutActive: boolean;
  localEmailOptOutActive: boolean;
  globalSmsOptOutActive: boolean;
  globalEmailOptOutActive: boolean;
  realRecipientSuppressed: boolean;
  finalRecipientKind: "test" | "customer" | null;
  finalRecipientMasked: string | null;
  suppressedRecipientMasked: string | null;
  finalRecipientIsTestRecipient: boolean;
  externalMessageIdPresent: boolean;
  existingAttemptId: string | null;
  existingAttemptStatus: string | null;
};

export type DeliveryDispatchSummary = {
  testRunId: string | null;
  preview: boolean;
  send: boolean;
  mode: DeliveryDispatchMode;
  controlledRecipientMode: boolean;
  realCustomerSendMode: boolean;
  forceContactEligibilityForTest: boolean;
  eventsChecked: number;
  previewed: number;
  submitted: number;
  failed: number;
  skipped: number;
  attemptsCreated: number;
  providerCalls: number;
  reports: DeliveryDispatchEventReport[];
};

type RenderedMessage = {
  subject: string | null;
  textBody: string;
  htmlBody: string | null;
};

const notificationEventInclude = {
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
  order: {
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      status: true,
      internalLifecycleStatus: true,
      confirmVia: true,
      acumaticaOneWeekConfirmed: true,
      buyerGroup: true,
      customerDescription: true,
      locationDescription: true,
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
    },
  },
  orderDeliveryGroup: {
    select: {
      id: true,
      deliveryDate: true,
      status: true,
      isActive: true,
      deliveryGroupLines: {
        where: { isActive: true },
        select: {
          deliveryDate: true,
          orderLine: {
            select: {
              requestedOn: true,
              inventoryId: true,
              lineDescription: true,
              itemType: true,
              itemClass: true,
              eta: true,
              etaStatus: true,
              allocationStatus: true,
              readinessStatus: true,
              displayStatus: true,
              orderQty: true,
              openQty: true,
              activeAllocatedQty: true,
            },
          },
        },
      },
    },
  },
  detailsLink: {
    select: { token: true },
  },
  deliveryConfirmations: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true,
      linkToken: true,
      status: true,
      deliveryDate: true,
    },
  },
  paymentEnforcementHoldActions: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      amountDueAtTrigger: true,
      paymentDeadline: true,
    },
  },
  attempts: {
    orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
    take: 1,
    select: {
      id: true,
      attemptNumber: true,
      channel: true,
      status: true,
      externalMessageId: true,
    },
  },
} satisfies Prisma.NotificationEventInclude;

type DispatchNotificationEvent = Prisma.NotificationEventGetPayload<{
  include: typeof notificationEventInclude;
}>;

function flagIsTrue(env: NodeJS.ProcessEnv, name: string) {
  return env[name]?.trim().toLowerCase() === "true";
}

function flagIsFalseOrUnset(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim().toLowerCase();
  return !value || value === "false";
}

function envValue(env: NodeJS.ProcessEnv, name: string) {
  return env[name]?.trim() ?? "";
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function truncateError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 1000);
}

function maskedEmail(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return "<redacted-email>";
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskedPhone(value: string | null | undefined) {
  const normalized = normalizeSmsPhoneForOptOut(value);
  if (!normalized) return null;
  return `***${normalized.slice(-4)}`;
}

function maskedRecipient(channel: HelperNotificationChannel, value: string | null | undefined) {
  return channel === "SMS" ? maskedPhone(value) : maskedEmail(value);
}

function recipientMatchesConfiguredTestRecipient(params: {
  channel: HelperNotificationChannel;
  recipient: string;
  env: NodeJS.ProcessEnv;
}) {
  const expected =
    params.channel === "SMS"
      ? envValue(params.env, "NOTIFICATIONS_TEST_PHONE")
      : envValue(params.env, "NOTIFICATIONS_TEST_EMAIL");
  if (!expected) return false;

  if (params.channel === "SMS") {
    const actualPhone = normalizeSmsPhoneForOptOut(params.recipient);
    const expectedPhone = normalizeSmsPhoneForOptOut(expected);
    return Boolean(actualPhone && expectedPhone && actualPhone === expectedPhone);
  }

  const actualEmail = normalizeEmailForOptOut(params.recipient);
  const expectedEmail = normalizeEmailForOptOut(expected);
  return Boolean(actualEmail && expectedEmail && actualEmail === expectedEmail);
}

function recipientReport(params: {
  channel: HelperNotificationChannel;
  finalRecipient: string;
  suppressedRecipient: string | null;
  env: NodeJS.ProcessEnv;
}) {
  return {
    finalRecipientMasked: maskedRecipient(params.channel, params.finalRecipient),
    suppressedRecipientMasked: maskedRecipient(params.channel, params.suppressedRecipient),
    finalRecipientIsTestRecipient: recipientMatchesConfiguredTestRecipient({
      channel: params.channel,
      recipient: params.finalRecipient,
      env: params.env,
    }),
  };
}

function amountIsMeaningful(value: string | null | undefined) {
  if (!value) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 2;
}

function paymentReminderApplies(payment: DeliveryGroupPaymentEvaluation) {
  return (
    payment.paymentStatus === "balance_due" &&
    amountIsMeaningful(payment.amountDueNowRounded) &&
    payment.calculationWarnings.length === 0
  );
}

export function evaluateDeliveryDispatcherPreflight(
  options: DispatchDeliveryNotificationsOptions,
  env: NodeJS.ProcessEnv = process.env
): DeliveryDispatcherPreflightResult {
  const failures: string[] = [];
  const send = options.send === true;
  const preview = !send;
  const controlledRecipientMode = options.controlledRecipientSend === true;
  const realCustomerSendMode = send && !controlledRecipientMode;
  const realCustomerSendEnabled = flagIsTrue(env, REAL_CUSTOMER_SEND_ENABLED_ENV);
  const controlledRecipientEnvEnabled = flagIsTrue(env, CONTROLLED_RECIPIENT_MODE_ENV);
  const allowRealCustomerSendInNonProduction = flagIsTrue(
    env,
    REAL_CUSTOMER_SEND_NON_PRODUCTION_ENV
  );
  const mode: DeliveryDispatchMode = preview
    ? "preview"
    : controlledRecipientMode
      ? "controlled-recipient send"
      : "real-customer send";
  const testEmail = clean(envValue(env, "NOTIFICATIONS_TEST_EMAIL"));
  const testPhone = clean(envValue(env, "NOTIFICATIONS_TEST_PHONE"));
  const configuredConfirmPhrase = envValue(env, CONTROLLED_RECIPIENT_CONFIRM_PHRASE_ENV);

  if (realCustomerSendMode) {
    if (!realCustomerSendEnabled) {
      failures.push(`${REAL_CUSTOMER_SEND_ENABLED_ENV} must be exactly true for real customer sends.`);
    }
    if (controlledRecipientEnvEnabled) {
      failures.push(`${CONTROLLED_RECIPIENT_MODE_ENV} must be false or unset for real customer sends.`);
    }
    if (!flagIsFalseOrUnset(env, FORCE_CONTACT_ELIGIBILITY_FOR_TEST_ENV)) {
      failures.push(`${FORCE_CONTACT_ELIGIBILITY_FOR_TEST_ENV} must be false or unset for real customer sends.`);
    }
    if (!flagIsTrue(env, "USE_QUEUE_ERP")) {
      failures.push("USE_QUEUE_ERP must be exactly true for real customer sends.");
    }
    for (const name of ["MLD_QUEUE_BASE_URL", "MLD_QUEUE_TOKEN"]) {
      if (!envValue(env, name)) failures.push(`${name} is required for real customer sends.`);
    }
    if (!flagIsFalseOrUnset(env, "DEMO_NOTIFICATION_SEND_ENABLED")) {
      failures.push("DEMO_NOTIFICATION_SEND_ENABLED must be false or unset for real customer sends.");
    }
    if (!flagIsTrue(env, "TWILIO_WEBHOOK_VALIDATE_SIGNATURES")) {
      failures.push("TWILIO_WEBHOOK_VALIDATE_SIGNATURES must be exactly true for real customer sends.");
    }
    if (
      env.NODE_ENV !== "production" &&
      !allowRealCustomerSendInNonProduction
    ) {
      failures.push(
        `${REAL_CUSTOMER_SEND_NON_PRODUCTION_ENV} must be exactly true for real customer sends outside NODE_ENV=production.`
      );
    }
  }

  if (controlledRecipientMode) {
    if (realCustomerSendEnabled) {
      failures.push(`${REAL_CUSTOMER_SEND_ENABLED_ENV} must be false or unset for controlled-recipient sends.`);
    }
    if (!controlledRecipientEnvEnabled) {
      failures.push(`${CONTROLLED_RECIPIENT_MODE_ENV} must be exactly true.`);
    }
    if (!configuredConfirmPhrase) {
      failures.push(`${CONTROLLED_RECIPIENT_CONFIRM_PHRASE_ENV} must be configured.`);
    }
    if (options.confirmPhrase !== configuredConfirmPhrase) {
      failures.push("Controlled recipient confirmation phrase did not match.");
    }
    if (!testEmail) failures.push("NOTIFICATIONS_TEST_EMAIL is required.");
    if (!testPhone) failures.push("NOTIFICATIONS_TEST_PHONE is required.");
    if (!flagIsTrue(env, FORCE_CONTACT_ELIGIBILITY_FOR_TEST_ENV)) {
      failures.push(`${FORCE_CONTACT_ELIGIBILITY_FOR_TEST_ENV} must be exactly true.`);
    }
  }

  if (send) {
    for (const name of ["DELIVERY_APP_BASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) {
      if (!envValue(env, name)) failures.push(`${name} is required for dispatcher sends.`);
    }
    if (!envValue(env, "TWILIO_MESSAGING_SERVICE_SID") && !envValue(env, "TWILIO_FROM_NUMBER")) {
      failures.push("TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER is required.");
    }
    for (const name of [
      "MS_GRAPH_TENANT_ID",
      "MS_GRAPH_CLIENT_ID",
      "MS_GRAPH_CLIENT_SECRET",
      "MS_GRAPH_FROM_EMAIL",
    ]) {
      if (!envValue(env, name)) failures.push(`${name} is required for dispatcher sends.`);
    }
  }

  if (!clean(options.testRunId)) {
    failures.push("--test-run-id is required.");
  }

  return {
    ok: failures.length === 0,
    failures,
    preview,
    send,
    mode,
    controlledRecipientMode,
    realCustomerSendMode,
    realCustomerSendEnabled,
    allowRealCustomerSendInNonProduction,
    forceContactEligibilityForTest: flagIsTrue(env, FORCE_CONTACT_ELIGIBILITY_FOR_TEST_ENV),
    testEmail,
    testPhone,
  };
}

export function assertControlledFinalRecipient(params: {
  channel: HelperNotificationChannel;
  finalRecipient: string;
  env: NodeJS.ProcessEnv;
}) {
  const expected =
    params.channel === "SMS"
      ? envValue(params.env, "NOTIFICATIONS_TEST_PHONE")
      : envValue(params.env, "NOTIFICATIONS_TEST_EMAIL");
  if (!expected || params.finalRecipient !== expected) {
    throw new Error(`Controlled recipient assertion failed for ${params.channel}.`);
  }
}

export function resolveFinalRecipient(params: {
  channel: HelperNotificationChannel;
  productionRecipient: string;
  controlledRecipientMode: boolean;
  env: NodeJS.ProcessEnv;
}) {
  if (!params.controlledRecipientMode) {
    return {
      finalRecipient: params.productionRecipient,
      suppressedRecipient: null,
      finalRecipientKind: "customer" as const,
    };
  }

  // Controlled-recipient routing is only for final pre-live tests. Production
  // sends must use the customer recipient selected by normal opt-in policy.
  const finalRecipient =
    params.channel === "SMS"
      ? envValue(params.env, "NOTIFICATIONS_TEST_PHONE")
      : envValue(params.env, "NOTIFICATIONS_TEST_EMAIL");
  assertControlledFinalRecipient({
    channel: params.channel,
    finalRecipient,
    env: params.env,
  });

  return {
    finalRecipient,
    suppressedRecipient: params.productionRecipient,
    finalRecipientKind: "test" as const,
  };
}

function normalizedContactPhones(contact: DispatchNotificationEvent["contact"]) {
  return [contact.phone1, contact.phone2]
    .map(normalizeSmsPhoneForOptOut)
    .filter((value): value is string => Boolean(value));
}

function normalizedContactEmail(contact: DispatchNotificationEvent["contact"]) {
  return normalizeEmailForOptOut(contact.email);
}

function optOutSnapshot(
  event: DispatchNotificationEvent,
  globalOptOuts: ActiveNotificationOptOutAddresses
) {
  const phones = new Set(normalizedContactPhones(event.contact));
  const email = normalizedContactEmail(event.contact);
  const localSmsOptOutActive = event.contact.smsOptOuts.some((optOut) => {
    const normalized = normalizeSmsPhoneForOptOut(optOut.phone);
    return Boolean(normalized && phones.has(normalized));
  });
  const localEmailOptOutActive = event.contact.emailOptOuts.some((optOut) => {
    const normalized = normalizeEmailForOptOut(optOut.email);
    return Boolean(normalized && email && normalized === email);
  });
  const globalSmsOptOutActive = globalOptOuts.activeSmsOptOutPhones.some((phone) => {
    const normalized = normalizeSmsPhoneForOptOut(phone);
    return Boolean(normalized && phones.has(normalized));
  });
  const globalEmailOptOutActive = globalOptOuts.activeEmailOptOutEmails.some((optOutEmail) => {
    const normalized = normalizeEmailForOptOut(optOutEmail);
    return Boolean(normalized && email && normalized === email);
  });

  return {
    localSmsOptOutActive,
    localEmailOptOutActive,
    globalSmsOptOutActive,
    globalEmailOptOutActive,
  };
}

function selectChannelForEvent(params: {
  event: DispatchNotificationEvent;
  globalOptOuts: ActiveNotificationOptOutAddresses;
  forceContactEligibility: boolean;
}) {
  const contact = params.event.contact;
  const optOutState = mergeNotificationOptOutAddresses(params.globalOptOuts, {
    activeSmsOptOutPhones: contact.smsOptOuts.map((optOut) => optOut.phone),
    activeEmailOptOutEmails: contact.emailOptOuts.map((optOut) => optOut.email),
  });

  return selectNotificationChannel(
    {
      smsOptIn: params.forceContactEligibility ? true : contact.smsOptIn,
      emailOptIn: params.forceContactEligibility ? true : contact.emailOptIn,
      phone1: contact.phone1,
      phone2: contact.phone2,
      email: contact.email,
    },
    optOutState
  );
}

function selectEmailFallbackForEvent(params: {
  event: DispatchNotificationEvent;
  globalOptOuts: ActiveNotificationOptOutAddresses;
  forceContactEligibility: boolean;
}) {
  const contact = params.event.contact;
  const optOutState = mergeNotificationOptOutAddresses(params.globalOptOuts, {
    activeSmsOptOutPhones: contact.smsOptOuts.map((optOut) => optOut.phone),
    activeEmailOptOutEmails: contact.emailOptOuts.map((optOut) => optOut.email),
  });

  return selectNotificationChannel(
    {
      smsOptIn: false,
      emailOptIn: params.forceContactEligibility ? true : contact.emailOptIn,
      phone1: null,
      phone2: null,
      email: contact.email,
    },
    optOutState
  );
}

function channelMatchesFilter(
  channel: HelperNotificationChannel,
  filter: DispatcherChannelFilter | undefined
) {
  if (!filter || filter === "both") return true;
  return filter === "sms" ? channel === "SMS" : channel === "EMAIL";
}

function dateKey(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function statusKey(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function orderOrGroupStatusIsInactive(value: string | null | undefined) {
  const normalized = statusKey(value);
  return (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "closed" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "voided"
  );
}

function intervalRequiresOpenOneWeekConfirmation(intervalType: NotificationIntervalType) {
  return (
    intervalType === NotificationIntervalType.DAY_14 ||
    intervalType === NotificationIntervalType.DAY_12 ||
    intervalType === NotificationIntervalType.DAY_10 ||
    intervalType === NotificationIntervalType.DAY_8
  );
}

function deliveryConfirmationIsResolved(status: string | null | undefined) {
  const normalized = statusKey(status);
  return (
    normalized === "confirmed" ||
    normalized === "change_requested" ||
    normalized === "new_date_requested"
  );
}

function activeDeliveryLineDateMismatch(event: DispatchNotificationEvent) {
  const eventDateKey = dateKey(event.deliveryDate);
  if (!eventDateKey) return "event_delivery_date_missing";
  const groupDateKey = dateKey(event.orderDeliveryGroup.deliveryDate);
  if (groupDateKey !== eventDateKey) return "delivery_group_date_changed";
  if (event.orderDeliveryGroup.deliveryGroupLines.length === 0) {
    return "active_delivery_group_lines_missing";
  }
  const hasMismatchedLine = event.orderDeliveryGroup.deliveryGroupLines.some((line) => {
    const groupLineDateKey = dateKey(line.deliveryDate);
    const orderLineRequestedOnKey = dateKey(line.orderLine?.requestedOn);
    return groupLineDateKey !== eventDateKey || orderLineRequestedOnKey !== eventDateKey;
  });
  return hasMismatchedLine ? "active_line_delivery_date_changed" : null;
}

function currentDispatchSafetyBlockReason(params: {
  event: DispatchNotificationEvent;
  selectedChannel: HelperNotificationChannel;
  optOuts: ReturnType<typeof optOutSnapshot>;
  forceContactEligibility: boolean;
}) {
  const event = params.event;

  if (orderOrGroupStatusIsInactive(event.order.status)) {
    return "current_order_status_ineligible";
  }
  if (
    event.order.internalLifecycleStatus !== InternalOrderLifecycleStatus.ACTIVE &&
    event.order.internalLifecycleStatus !== InternalOrderLifecycleStatus.PAYMENT_PENDING
  ) {
    return "current_order_lifecycle_ineligible";
  }
  if (!event.orderDeliveryGroup.isActive) {
    return "current_delivery_group_inactive";
  }
  if (orderOrGroupStatusIsInactive(event.orderDeliveryGroup.status)) {
    return "current_delivery_group_status_ineligible";
  }

  const dateMismatchReason = activeDeliveryLineDateMismatch(event);
  if (dateMismatchReason) return dateMismatchReason;

  if (
    intervalRequiresOpenOneWeekConfirmation(event.intervalType) &&
    event.order.acumaticaOneWeekConfirmed === true
  ) {
    return "one_week_confirmation_already_true";
  }

  if (event.intervalType === NotificationIntervalType.DAY_42) {
    const confirmation = event.deliveryConfirmations[0];
    if (deliveryConfirmationIsResolved(String(confirmation?.status ?? ""))) {
      return "delivery_confirmation_already_resolved";
    }
  }

  if (!params.forceContactEligibility) {
    if (params.selectedChannel === "SMS" && event.contact.smsOptIn !== true) {
      return "current_sms_opt_in_false";
    }
    if (params.selectedChannel === "EMAIL" && event.contact.emailOptIn !== true) {
      return "current_email_opt_in_false";
    }
  }

  if (
    params.selectedChannel === "SMS" &&
    (params.optOuts.localSmsOptOutActive || params.optOuts.globalSmsOptOutActive)
  ) {
    return "current_sms_opt_out_active";
  }
  if (
    params.selectedChannel === "EMAIL" &&
    (params.optOuts.localEmailOptOutActive || params.optOuts.globalEmailOptOutActive)
  ) {
    return "current_email_opt_out_active";
  }

  return null;
}

function commonRenderParams(event: DispatchNotificationEvent) {
  const order = event.order;
  const contactName = formatContactName(event.contact);
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const jobAddress = formatJobAddress(order.address ?? {}) || "the job site";

  return {
    orderNumber: event.orderNumber,
    contactName,
    buyerGroup: order.buyerGroup,
    jobName,
    jobAddress,
    deliveryDate: event.deliveryDate,
  };
}

function requireDetailsLink(event: DispatchNotificationEvent) {
  if (!event.detailsLink?.token) {
    throw new Error("delivery_details_link_missing");
  }
  return buildDeliveryDetailsLink(event.detailsLink.token);
}

function requireConfirmationLink(event: DispatchNotificationEvent) {
  const confirmation = event.deliveryConfirmations[0];
  if (!confirmation?.linkToken) {
    throw new Error("delivery_confirmation_link_missing");
  }
  return buildDeliveryConfirmationLink(confirmation.linkToken);
}

async function paymentEvaluationForEvent(event: DispatchNotificationEvent) {
  return getDeliveryGroupPaymentEvaluation(event.deliveryGroupId);
}

async function renderForChannel(params: {
  event: DispatchNotificationEvent;
  channel: HelperNotificationChannel;
  client: typeof prisma;
}): Promise<RenderedMessage> {
  const { event, channel, client } = params;
  const common = commonRenderParams(event);
  const salespersonContact = await getActiveSalespersonContact(
    event.order.salespersonNumber,
    client
  );

  if (
    event.intervalType === NotificationIntervalType.DAY_180 ||
    event.intervalType === NotificationIntervalType.DAY_90 ||
    event.intervalType === NotificationIntervalType.DAY_60
  ) {
    if (event.actionType !== "DELIVERY_REMINDER") {
      throw new Error("unsupported_event_action_for_interval");
    }
    if (channel === "SMS") {
      return {
        subject: null,
        textBody: renderDeliveryReminderMessage({
          intervalType: event.intervalType,
          ...common,
        }),
        htmlBody: null,
      };
    }
    return {
      subject: renderDeliveryReminderEmailSubject({
        buyerGroup: common.buyerGroup,
        jobName: common.jobName,
        deliveryDate: common.deliveryDate,
      }),
      textBody: renderDeliveryReminderEmailBody({
        intervalType: event.intervalType,
        ...common,
        salespersonContact,
      }),
      htmlBody: null,
    };
  }

  if (event.intervalType === NotificationIntervalType.DAY_42) {
    const link = requireConfirmationLink(event);
    if (event.actionType === "DELIVERY_CONFIRMATION_REMINDER") {
      const touchNumber = deliveryConfirmationReminderTouchNumberFromDedupeKey(event.dedupeKey);
      if (channel === "SMS") {
        return {
          subject: null,
          textBody: render42DaySmsConfirmationReminderMessage({
            orderNumber: event.orderNumber,
            deliveryDate: event.deliveryDate,
            link,
            deliveryAddress: event.order.address,
            touchNumber: touchNumber ?? undefined,
          }),
          htmlBody: null,
        };
      }
      const rendered = render42DayEmailConfirmationReminderMessage({
        orderNumber: event.orderNumber,
        contactName: common.contactName,
        deliveryDate: event.deliveryDate,
        link,
        touchNumber: touchNumber ?? undefined,
      });
      return {
        subject: rendered.subject,
        textBody: rendered.body,
        htmlBody: rendered.htmlBody,
      };
    }

    if (event.actionType !== "DELIVERY_CONFIRMATION_REQUEST") {
      throw new Error("unsupported_event_action_for_interval");
    }
    const payment = await paymentEvaluationForEvent(event);
    const includePayment = paymentReminderApplies(payment);
    if (channel === "SMS") {
      return {
        subject: null,
        textBody: render42DaySmsConfirmationMessage({
          orderNumber: event.orderNumber,
          contactName: common.contactName,
          buyerGroup: common.buyerGroup,
          jobName: common.jobName,
          deliveryDate: event.deliveryDate,
          link,
          deliveryAddress: event.order.address,
        }),
        htmlBody: null,
      };
    }
    const rendered = render42DayEmailConfirmationMessage({
      ...common,
      customerDescription: event.order.customerDescription,
      locationDescription: event.order.locationDescription,
      link,
      paymentReminderApplies: includePayment,
      amountDueNowRounded: payment.amountDueNowRounded,
      salespersonContact,
    });
    return {
      subject: rendered.subject,
      textBody: rendered.body,
      htmlBody: rendered.htmlBody,
    };
  }

  if (
    event.intervalType === NotificationIntervalType.DAY_30 ||
    event.intervalType === NotificationIntervalType.DAY_14
  ) {
    if (event.actionType !== "DELIVERY_REMINDER") {
      throw new Error("unsupported_event_action_for_interval");
    }
    const detailsLink = requireDetailsLink(event);
    if (event.order.acumaticaOneWeekConfirmed === true) {
      throw new Error("one_week_confirmation_already_true");
    }
    const payment = await paymentEvaluationForEvent(event);
    const input = {
      ...common,
      detailsLink,
      paymentDue: paymentReminderApplies(payment),
      amountDueNowRounded: payment.amountDueNowRounded,
      salespersonContact,
    };
    if (channel === "SMS") {
      return {
        subject: null,
        textBody:
          event.intervalType === NotificationIntervalType.DAY_14
            ? render14DayDeliveryReminderSms(input)
            : render30DayDeliveryReminderSms(input),
        htmlBody: null,
      };
    }
    const rendered =
      event.intervalType === NotificationIntervalType.DAY_14
        ? render14DayDeliveryReminderEmail(input)
        : render30DayDeliveryReminderEmail(input);
    return {
      subject: rendered.subject,
      textBody: rendered.body,
      htmlBody: rendered.htmlBody,
    };
  }

  if (
    event.intervalType === NotificationIntervalType.DAY_12 ||
    event.intervalType === NotificationIntervalType.DAY_10
  ) {
    if (event.actionType !== "PAYMENT_REQUEST") {
      throw new Error("unsupported_event_action_for_interval");
    }
    const detailsLink = requireDetailsLink(event);
    const payment = await paymentEvaluationForEvent(event);
    const amountDueNowRounded = payment.amountDueNowRounded;
    if (!amountIsMeaningful(amountDueNowRounded)) {
      throw new Error("payment_amount_not_due");
    }
    const input = {
      ...common,
      detailsLink,
      amountDueNowRounded: amountDueNowRounded as string,
      paymentDeadlineDate: getPaymentDeadlineDate(event.deliveryDate),
      salespersonContact,
    };
    if (channel === "SMS") {
      return {
        subject: null,
        textBody:
          event.intervalType === NotificationIntervalType.DAY_10
            ? render10DayDeliveryPaymentReminderSms(input)
            : render12DayDeliveryPaymentReminderSms(input),
        htmlBody: null,
      };
    }
    const rendered =
      event.intervalType === NotificationIntervalType.DAY_10
        ? render10DayDeliveryPaymentReminderEmail(input)
        : render12DayDeliveryPaymentReminderEmail(input);
    return {
      subject: rendered.subject,
      textBody: rendered.body,
      htmlBody: rendered.htmlBody,
    };
  }

  if (event.intervalType === NotificationIntervalType.DAY_8) {
    if (event.actionType !== "PAYMENT_ENFORCEMENT") {
      throw new Error("unsupported_event_action_for_interval");
    }
    const detailsLink = requireDetailsLink(event);
    if (event.order.acumaticaOneWeekConfirmed === true) {
      throw new Error("one_week_confirmation_already_true");
    }
    const latestHold = event.paymentEnforcementHoldActions[0];
    const payment = latestHold ? null : await paymentEvaluationForEvent(event);
    const amountDueNowRounded =
      latestHold?.amountDueAtTrigger?.toString() ?? payment?.amountDueNowRounded ?? null;
    if (!amountIsMeaningful(amountDueNowRounded)) {
      throw new Error("payment_amount_not_due");
    }
    const input = {
      ...common,
      detailsLink,
      amountDueNowRounded,
      salespersonContact,
    };
    if (channel === "SMS") {
      return {
        subject: null,
        textBody: render8DayPaymentEnforcementCustomerSms(input),
        htmlBody: null,
      };
    }
    const rendered = render8DayPaymentEnforcementCustomerEmail(input);
    return {
      subject: rendered.subject,
      textBody: rendered.body,
      htmlBody: rendered.htmlBody,
    };
  }

  if (event.intervalType === NotificationIntervalType.DAY_2) {
    if (event.actionType !== "DELIVERY_REMINDER") {
      throw new Error("unsupported_event_action_for_interval");
    }
    const detailsLink = requireDetailsLink(event);
    const input = {
      ...common,
      detailsLink,
      salespersonContact,
    };
    if (channel === "SMS") {
      return {
        subject: null,
        textBody: render2DayDeliveryReminderSms(input),
        htmlBody: null,
      };
    }
    const rendered = render2DayDeliveryReminderEmail(input);
    return {
      subject: rendered.subject,
      textBody: rendered.body,
      htmlBody: rendered.htmlBody,
    };
  }

  throw new Error("unsupported_notification_interval");
}

async function nextAttemptNumber(client: typeof prisma, notificationEventId: string) {
  const latest = await client.notificationAttempt.findFirst({
    where: { notificationEventId },
    orderBy: { attemptNumber: "desc" },
    select: { attemptNumber: true },
  });
  return (latest?.attemptNumber ?? 0) + 1;
}

async function claimEventForDispatch(params: {
  client: typeof prisma;
  eventId: string;
  now: Date;
}) {
  // Idempotency boundary: only one dispatcher can move an event from SCHEDULED
  // to PENDING. PENDING is the existing transient "claimed/submitting" state;
  // reruns must not send claimed events without explicit retry logic.
  const result = await params.client.notificationEvent.updateMany({
    where: {
      id: params.eventId,
      status: NotificationEventStatus.SCHEDULED,
    },
    data: {
      status: NotificationEventStatus.PENDING,
      triggeredAt: params.now,
      reasonFailed: null,
    },
  });
  return result.count === 1;
}

async function reloadEventDispatchState(client: typeof prisma, eventId: string) {
  return client.notificationEvent.findUnique({
    where: { id: eventId },
    include: notificationEventInclude,
  });
}

function latestAttemptForReport(event: DispatchNotificationEvent | null | undefined) {
  return event?.attempts[0] ?? null;
}

function nonScheduledEventReason(event: DispatchNotificationEvent | null | undefined) {
  if (!event) return "event_not_found";
  const latestAttempt = latestAttemptForReport(event);
  if (event.status === NotificationEventStatus.PENDING) {
    return latestAttempt
      ? `event_already_claimed_in_flight_${String(latestAttempt.status).toLowerCase()}`
      : "event_claimed_without_attempt_explicit_retry_required";
  }
  if (event.status === NotificationEventStatus.SENT) return "event_already_sent";
  if (event.status === NotificationEventStatus.FAILED) return "event_failed_explicit_retry_required";
  if (event.status === NotificationEventStatus.SKIPPED) return "event_skipped";
  if (event.status === NotificationEventStatus.CANCELLED) return "event_cancelled";
  if (event.status === NotificationEventStatus.DEDUPED) return "event_deduped";
  if (event.status === NotificationEventStatus.ALREADY_SENT) return "event_already_sent";
  return `event_not_scheduled_${String(event.status).toLowerCase()}`;
}

async function createAttempt(params: {
  client: typeof prisma;
  event: DispatchNotificationEvent;
  channel: HelperNotificationChannel;
  finalRecipient: string;
  suppressedRecipient: string | null;
  preflight: DeliveryDispatcherPreflightResult;
  optOuts: ReturnType<typeof optOutSnapshot>;
  channelReason: string;
  testRunId: string | null;
  fallbackFromAttemptId?: string | null;
}) {
  return params.client.notificationAttempt.create({
    data: {
      notificationEventId: params.event.id,
      attemptNumber: await nextAttemptNumber(params.client, params.event.id),
      channel: params.channel as NotificationChannel,
      status: NotificationAttemptStatus.CREATED,
      recipient: params.finalRecipient,
      suppressedRecipient: params.suppressedRecipient,
      provider: params.channel === "SMS" ? "twilio" : "ms_graph",
      controlledRecipientMode: params.preflight.controlledRecipientMode,
      forcedContactEligibility: params.preflight.forceContactEligibilityForTest,
      realSmsOptIn: params.event.contact.smsOptIn,
      realEmailOptIn: params.event.contact.emailOptIn,
      localSmsOptOutActive: params.optOuts.localSmsOptOutActive,
      localEmailOptOutActive: params.optOuts.localEmailOptOutActive,
      globalSmsOptOutActive: params.optOuts.globalSmsOptOutActive,
      globalEmailOptOutActive: params.optOuts.globalEmailOptOutActive,
      testRunId: params.testRunId,
      fallbackFromAttemptId: params.fallbackFromAttemptId ?? null,
      metadata: {
        productionChannelReason: params.channelReason,
        controlledRecipientMode: params.preflight.controlledRecipientMode,
        realRecipientSuppressed: Boolean(params.suppressedRecipient),
      } satisfies Prisma.InputJsonObject,
    },
    select: {
      id: true,
      attemptNumber: true,
    },
  });
}

async function markAttemptSubmitted(params: {
  client: typeof prisma;
  attemptId: string;
  result: DeliveryNotificationProviderResult;
  now: Date;
}) {
  await params.client.notificationAttempt.update({
    where: { id: params.attemptId },
    data: {
      status: NotificationAttemptStatus.SUBMITTED,
      provider: params.result.provider,
      providerCode: params.result.providerCode,
      httpStatus: params.result.httpStatus,
      externalMessageId: params.result.externalMessageId,
      success: true,
      sentAt: params.now,
      metadata: params.result.raw
        ? ({ providerResponse: params.result.raw as Prisma.InputJsonObject } satisfies Prisma.InputJsonObject)
        : undefined,
    },
  });
}

async function markAttemptFailed(params: {
  client: typeof prisma;
  attemptId: string;
  error: unknown;
}) {
  const providerError =
    params.error instanceof DeliveryNotificationProviderError ? params.error : null;
  await params.client.notificationAttempt.update({
    where: { id: params.attemptId },
    data: {
      status: NotificationAttemptStatus.FAILED,
      provider: providerError?.provider,
      providerCode: providerError?.providerCode,
      httpStatus: providerError?.httpStatus,
      externalMessageId: providerError?.externalMessageId,
      success: false,
      errorMessage: truncateError(params.error),
    },
  });
}

async function markEventSubmitted(params: {
  client: typeof prisma;
  eventId: string;
  channel: HelperNotificationChannel;
  result: DeliveryNotificationProviderResult;
  now: Date;
}) {
  await params.client.notificationEvent.update({
    where: { id: params.eventId },
    data: {
      status: NotificationEventStatus.SENT,
      selectedChannel: params.channel as NotificationChannel,
      provider: params.result.provider,
      externalMessageId: params.result.externalMessageId,
      triggeredAt: params.now,
      sentAt: params.now,
      reasonFailed: null,
    },
  });
}

async function markEventFailed(params: {
  client: typeof prisma;
  eventId: string;
  error: unknown;
  now: Date;
}) {
  await params.client.notificationEvent.update({
    where: { id: params.eventId },
    data: {
      status: NotificationEventStatus.FAILED,
      triggeredAt: params.now,
      reasonFailed: truncateError(params.error),
    },
  });
}

async function markEventSkipped(params: {
  client: typeof prisma;
  eventId: string;
  reason: string;
}) {
  await params.client.notificationEvent.update({
    where: { id: params.eventId },
    data: {
      status: NotificationEventStatus.SKIPPED,
      reasonSkipped: params.reason.slice(0, 1000),
    },
  });
}

async function callProvider(params: {
  provider: DeliveryNotificationProvider;
  channel: HelperNotificationChannel;
  recipient: string;
  rendered: RenderedMessage;
  env: NodeJS.ProcessEnv;
}) {
  if (params.channel === "SMS") {
    return params.provider.sendSms({
      to: params.recipient,
      body: params.rendered.textBody,
      statusCallbackUrl: buildTwilioStatusCallbackUrl(params.env),
    });
  }

  return params.provider.sendEmail({
    to: params.recipient,
    subject: params.rendered.subject ?? "Delivery notification",
    textBody: params.rendered.textBody,
    htmlBody: params.rendered.htmlBody,
  });
}

function reportBase(params: {
  event: DispatchNotificationEvent;
  preflight: DeliveryDispatcherPreflightResult;
  optOuts: ReturnType<typeof optOutSnapshot>;
}): Omit<
  DeliveryDispatchEventReport,
  | "outcome"
  | "reason"
  | "selectedChannel"
  | "attemptId"
  | "fallbackAttemptId"
  | "realRecipientSuppressed"
  | "finalRecipientKind"
  | "externalMessageIdPresent"
> {
  return {
    eventId: params.event.id,
    orderType: params.event.orderType,
    orderNumber: params.event.orderNumber,
    intervalType: params.event.intervalType,
    actionType: params.event.actionType,
    controlledRecipientMode: params.preflight.controlledRecipientMode,
    forcedContactEligibility: params.preflight.forceContactEligibilityForTest,
    realSmsOptIn: params.event.contact.smsOptIn,
    realEmailOptIn: params.event.contact.emailOptIn,
    localSmsOptOutActive: params.optOuts.localSmsOptOutActive,
    localEmailOptOutActive: params.optOuts.localEmailOptOutActive,
    globalSmsOptOutActive: params.optOuts.globalSmsOptOutActive,
    globalEmailOptOutActive: params.optOuts.globalEmailOptOutActive,
    finalRecipientMasked: null,
    suppressedRecipientMasked: null,
    finalRecipientIsTestRecipient: false,
    existingAttemptId: null,
    existingAttemptStatus: null,
  };
}

async function dispatchOne(params: {
  event: DispatchNotificationEvent;
  client: typeof prisma;
  preflight: DeliveryDispatcherPreflightResult;
  options: DispatchDeliveryNotificationsOptions;
  provider: DeliveryNotificationProvider;
  globalOptOuts: ActiveNotificationOptOutAddresses;
  now: Date;
}) {
  const optOuts = optOutSnapshot(params.event, params.globalOptOuts);
  const base = reportBase({ event: params.event, preflight: params.preflight, optOuts });

  if (params.event.status !== NotificationEventStatus.SCHEDULED) {
    const latestAttempt = latestAttemptForReport(params.event);
    return {
      ...base,
      outcome: "skipped" as const,
      reason: nonScheduledEventReason(params.event),
      selectedChannel: params.event.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: Boolean(latestAttempt?.externalMessageId),
      finalRecipientKind: null,
      externalMessageIdPresent: Boolean(latestAttempt?.externalMessageId || params.event.externalMessageId),
      existingAttemptId: latestAttempt?.id ?? null,
      existingAttemptStatus: latestAttempt?.status ?? null,
    };
  }

  if (isDeliveryConfirmationNoResponseManagedEvent(params.event)) {
    const guard = await guardDeliveryConfirmationNoResponseDispatch({
      client: params.client as never,
      event: {
        id: params.event.id,
        dedupeKey: params.event.dedupeKey,
        intervalType: params.event.intervalType,
        actionType: params.event.actionType,
        deliveryGroupId: params.event.deliveryGroupId,
        deliveryDate: params.event.deliveryDate,
      },
      now: params.now,
    });
    if (!guard.ok) {
      const reason = `no_response_dispatch_guard_${guard.reason ?? "blocked"}`;
      if (params.preflight.send) {
        await markEventSkipped({
          client: params.client,
          eventId: params.event.id,
          reason,
        });
      }
      return {
        ...base,
        outcome: "skipped" as const,
        reason,
        selectedChannel: params.event.selectedChannel,
        attemptId: null,
        fallbackAttemptId: null,
        realRecipientSuppressed: false,
        finalRecipientKind: null,
        externalMessageIdPresent: false,
      };
    }
  }

  const selected = selectChannelForEvent({
    event: params.event,
    globalOptOuts: params.globalOptOuts,
    forceContactEligibility: params.preflight.forceContactEligibilityForTest,
  });

  if (!selected.selectedChannel) {
    return {
      ...base,
      outcome: "skipped" as const,
      reason: selected.channelReason,
      selectedChannel: null,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }

  if (!channelMatchesFilter(selected.selectedChannel, params.options.channel)) {
    return {
      ...base,
      outcome: "skipped" as const,
      reason: "channel_filter_mismatch",
      selectedChannel: selected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }

  const safetyBlockReason = currentDispatchSafetyBlockReason({
    event: params.event,
    selectedChannel: selected.selectedChannel,
    optOuts,
    forceContactEligibility: params.preflight.forceContactEligibilityForTest,
  });
  if (safetyBlockReason) {
    if (params.preflight.send) {
      await markEventSkipped({
        client: params.client,
        eventId: params.event.id,
        reason: safetyBlockReason,
      });
    }
    return {
      ...base,
      outcome: "skipped" as const,
      reason: safetyBlockReason,
      selectedChannel: selected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }

  let rendered: RenderedMessage;
  try {
    rendered = await renderForChannel({
      event: params.event,
      channel: selected.selectedChannel,
      client: params.client,
    });
  } catch (error) {
    return {
      ...base,
      outcome: "skipped" as const,
      reason: truncateError(error),
      selectedChannel: selected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }

  const productionRecipient =
    selected.selectedChannel === "SMS" ? selected.recipientPhone : selected.recipientEmail;
  const recipient = resolveFinalRecipient({
    channel: selected.selectedChannel,
    productionRecipient,
    controlledRecipientMode: params.preflight.controlledRecipientMode,
    env: params.options.env ?? process.env,
  });
  const selectedRecipientReport = recipientReport({
    channel: selected.selectedChannel,
    finalRecipient: recipient.finalRecipient,
    suppressedRecipient: recipient.suppressedRecipient,
    env: params.options.env ?? process.env,
  });

  if (params.preflight.preview) {
    return {
      ...base,
      outcome: "previewed" as const,
      reason: selected.channelReason,
      selectedChannel: selected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: Boolean(recipient.suppressedRecipient),
      finalRecipientKind: recipient.finalRecipientKind,
      ...selectedRecipientReport,
      externalMessageIdPresent: false,
    };
  }

  const claimed = await claimEventForDispatch({
    client: params.client,
    eventId: params.event.id,
    now: params.now,
  });
  if (!claimed) {
    const currentEvent = await reloadEventDispatchState(params.client, params.event.id);
    const latestAttempt = latestAttemptForReport(currentEvent);
    return {
      ...base,
      outcome: "skipped" as const,
      reason: nonScheduledEventReason(currentEvent),
      selectedChannel: currentEvent?.selectedChannel ?? selected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: Boolean(latestAttempt?.externalMessageId),
      finalRecipientKind: null,
      externalMessageIdPresent: Boolean(latestAttempt?.externalMessageId || currentEvent?.externalMessageId),
      existingAttemptId: latestAttempt?.id ?? null,
      existingAttemptStatus: latestAttempt?.status ?? null,
    };
  }

  let dispatchEvent = params.event;
  let dispatchSelected = selected;
  let dispatchOptOuts = optOuts;
  let dispatchRendered = rendered;
  let dispatchRecipient = recipient;
  let dispatchRecipientReport = selectedRecipientReport;

  const currentEvent = await reloadEventDispatchState(params.client, params.event.id);
  if (!currentEvent) {
    await markEventFailed({
      client: params.client,
      eventId: params.event.id,
      error: new Error("event_not_found_after_claim"),
      now: params.now,
    });
    return {
      ...base,
      outcome: "failed" as const,
      reason: "event_not_found_after_claim",
      selectedChannel: selected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }

  const currentOptOuts = optOutSnapshot(currentEvent, params.globalOptOuts);
  const currentSelected = selectChannelForEvent({
    event: currentEvent,
    globalOptOuts: params.globalOptOuts,
    forceContactEligibility: params.preflight.forceContactEligibilityForTest,
  });
  if (!currentSelected.selectedChannel) {
    await markEventSkipped({
      client: params.client,
      eventId: currentEvent.id,
      reason: currentSelected.channelReason,
    });
    return {
      ...base,
      outcome: "skipped" as const,
      reason: currentSelected.channelReason,
      selectedChannel: null,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }
  if (!channelMatchesFilter(currentSelected.selectedChannel, params.options.channel)) {
    await markEventSkipped({
      client: params.client,
      eventId: currentEvent.id,
      reason: "channel_filter_mismatch_after_claim",
    });
    return {
      ...base,
      outcome: "skipped" as const,
      reason: "channel_filter_mismatch_after_claim",
      selectedChannel: currentSelected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }
  const currentSafetyBlockReason = currentDispatchSafetyBlockReason({
    event: currentEvent,
    selectedChannel: currentSelected.selectedChannel,
    optOuts: currentOptOuts,
    forceContactEligibility: params.preflight.forceContactEligibilityForTest,
  });
  if (currentSafetyBlockReason) {
    await markEventSkipped({
      client: params.client,
      eventId: currentEvent.id,
      reason: currentSafetyBlockReason,
    });
    return {
      ...base,
      outcome: "skipped" as const,
      reason: currentSafetyBlockReason,
      selectedChannel: currentSelected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }
  try {
    dispatchRendered = await renderForChannel({
      event: currentEvent,
      channel: currentSelected.selectedChannel,
      client: params.client,
    });
  } catch (error) {
    await markEventSkipped({
      client: params.client,
      eventId: currentEvent.id,
      reason: truncateError(error),
    });
    return {
      ...base,
      outcome: "skipped" as const,
      reason: truncateError(error),
      selectedChannel: currentSelected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: false,
      finalRecipientKind: null,
      externalMessageIdPresent: false,
    };
  }

  dispatchEvent = currentEvent;
  dispatchSelected = currentSelected;
  dispatchOptOuts = currentOptOuts;
  const currentProductionRecipient =
    currentSelected.selectedChannel === "SMS"
      ? currentSelected.recipientPhone
      : currentSelected.recipientEmail;
  dispatchRecipient = resolveFinalRecipient({
    channel: currentSelected.selectedChannel,
    productionRecipient: currentProductionRecipient,
    controlledRecipientMode: params.preflight.controlledRecipientMode,
    env: params.options.env ?? process.env,
  });
  dispatchRecipientReport = recipientReport({
    channel: currentSelected.selectedChannel,
    finalRecipient: dispatchRecipient.finalRecipient,
    suppressedRecipient: dispatchRecipient.suppressedRecipient,
    env: params.options.env ?? process.env,
  });

  let attempt: Awaited<ReturnType<typeof createAttempt>>;
  try {
    attempt = await createAttempt({
      client: params.client,
      event: dispatchEvent,
      channel: dispatchSelected.selectedChannel,
      finalRecipient: dispatchRecipient.finalRecipient,
      suppressedRecipient: dispatchRecipient.suppressedRecipient,
      preflight: params.preflight,
      optOuts: dispatchOptOuts,
      channelReason: dispatchSelected.channelReason,
      testRunId: clean(params.options.testRunId),
    });
  } catch (error) {
    await markEventFailed({ client: params.client, eventId: params.event.id, error, now: params.now });
    return {
      ...base,
      outcome: "failed" as const,
      reason: `attempt_create_failed: ${truncateError(error)}`,
      selectedChannel: dispatchSelected.selectedChannel,
      attemptId: null,
      fallbackAttemptId: null,
      realRecipientSuppressed: Boolean(dispatchRecipient.suppressedRecipient),
      finalRecipientKind: dispatchRecipient.finalRecipientKind,
      ...dispatchRecipientReport,
      externalMessageIdPresent: false,
    };
  }

  try {
    const result = await callProvider({
      provider: params.provider,
      channel: dispatchSelected.selectedChannel,
      recipient: dispatchRecipient.finalRecipient,
      rendered: dispatchRendered,
      env: params.options.env ?? process.env,
    });
    await markAttemptSubmitted({ client: params.client, attemptId: attempt.id, result, now: params.now });
    await markEventSubmitted({
      client: params.client,
      eventId: params.event.id,
      channel: dispatchSelected.selectedChannel,
      result,
      now: params.now,
    });
    return {
      ...base,
      outcome: "submitted" as const,
      reason: dispatchSelected.channelReason,
      selectedChannel: dispatchSelected.selectedChannel,
      attemptId: attempt.id,
      fallbackAttemptId: null,
      realRecipientSuppressed: Boolean(dispatchRecipient.suppressedRecipient),
      finalRecipientKind: dispatchRecipient.finalRecipientKind,
      ...dispatchRecipientReport,
      externalMessageIdPresent: Boolean(result.externalMessageId),
    };
  } catch (error) {
    await markAttemptFailed({ client: params.client, attemptId: attempt.id, error });

    const fallback =
      dispatchSelected.selectedChannel === "SMS" && channelMatchesFilter("EMAIL", params.options.channel)
        ? selectEmailFallbackForEvent({
            event: dispatchEvent,
            globalOptOuts: params.globalOptOuts,
            forceContactEligibility: params.preflight.forceContactEligibilityForTest,
          })
        : { selectedChannel: null, channelReason: "email_fallback_not_available" };

    if (fallback.selectedChannel === "EMAIL") {
      const fallbackRendered = await renderForChannel({
        event: dispatchEvent,
        channel: "EMAIL",
        client: params.client,
      });
      const fallbackRecipient = resolveFinalRecipient({
        channel: "EMAIL",
        productionRecipient: fallback.recipientEmail,
        controlledRecipientMode: params.preflight.controlledRecipientMode,
        env: params.options.env ?? process.env,
      });
      const fallbackRecipientReport = recipientReport({
        channel: "EMAIL",
        finalRecipient: fallbackRecipient.finalRecipient,
        suppressedRecipient: fallbackRecipient.suppressedRecipient,
        env: params.options.env ?? process.env,
      });
      const fallbackAttempt = await createAttempt({
        client: params.client,
        event: dispatchEvent,
        channel: "EMAIL",
        finalRecipient: fallbackRecipient.finalRecipient,
        suppressedRecipient: fallbackRecipient.suppressedRecipient,
        preflight: params.preflight,
        optOuts: dispatchOptOuts,
        channelReason: fallback.channelReason,
        testRunId: clean(params.options.testRunId),
        fallbackFromAttemptId: attempt.id,
      });
      try {
        const fallbackResult = await callProvider({
          provider: params.provider,
          channel: "EMAIL",
          recipient: fallbackRecipient.finalRecipient,
          rendered: fallbackRendered,
          env: params.options.env ?? process.env,
        });
        await markAttemptSubmitted({
          client: params.client,
          attemptId: fallbackAttempt.id,
          result: fallbackResult,
          now: params.now,
        });
        await markEventSubmitted({
          client: params.client,
          eventId: params.event.id,
          channel: "EMAIL",
          result: fallbackResult,
          now: params.now,
        });
        return {
          ...base,
          outcome: "submitted" as const,
          reason: "sms_provider_failed_email_fallback_submitted",
          selectedChannel: "EMAIL",
          attemptId: attempt.id,
          fallbackAttemptId: fallbackAttempt.id,
          realRecipientSuppressed: Boolean(fallbackRecipient.suppressedRecipient),
          finalRecipientKind: fallbackRecipient.finalRecipientKind,
          ...fallbackRecipientReport,
          externalMessageIdPresent: Boolean(fallbackResult.externalMessageId),
        };
      } catch (fallbackError) {
        await markAttemptFailed({
          client: params.client,
          attemptId: fallbackAttempt.id,
          error: fallbackError,
        });
        await markEventFailed({ client: params.client, eventId: params.event.id, error: fallbackError, now: params.now });
        return {
          ...base,
          outcome: "failed" as const,
          reason: truncateError(fallbackError),
          selectedChannel: "EMAIL",
          attemptId: attempt.id,
          fallbackAttemptId: fallbackAttempt.id,
          realRecipientSuppressed: Boolean(fallbackRecipient.suppressedRecipient),
          finalRecipientKind: fallbackRecipient.finalRecipientKind,
          ...fallbackRecipientReport,
          externalMessageIdPresent: false,
        };
      }
    }

    await markEventFailed({ client: params.client, eventId: params.event.id, error, now: params.now });
    return {
      ...base,
      outcome: "failed" as const,
      reason: truncateError(error),
      selectedChannel: dispatchSelected.selectedChannel,
      attemptId: attempt.id,
      fallbackAttemptId: null,
      realRecipientSuppressed: Boolean(dispatchRecipient.suppressedRecipient),
      finalRecipientKind: dispatchRecipient.finalRecipientKind,
      ...dispatchRecipientReport,
      externalMessageIdPresent: false,
    };
  }
}

export async function dispatchDeliveryNotifications(
  options: DispatchDeliveryNotificationsOptions = {}
): Promise<DeliveryDispatchSummary> {
  const env = options.env ?? process.env;
  const preflight = evaluateDeliveryDispatcherPreflight(options, env);
  if (!preflight.ok) {
    throw new Error(`Delivery dispatcher preflight failed: ${preflight.failures.join("; ")}`);
  }

  const client = options.prismaClient ?? prisma;
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? (preflight.send ? 1 : 10), 100));
  const provider = options.provider ?? createDeliveryNotificationProvider(env);
  const where: Prisma.NotificationEventWhereInput = options.eventId
    ? {
        id: options.eventId,
        ...(options.interval ? { intervalType: options.interval } : {}),
      }
    : {
        status: NotificationEventStatus.SCHEDULED,
        ...(options.interval ? { intervalType: options.interval } : {}),
      };
  const events = await client.notificationEvent.findMany({
    where,
    include: notificationEventInclude,
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
  const globalOptOuts = await loadActiveNotificationOptOutAddresses(client);
  const reports: DeliveryDispatchEventReport[] = [];

  for (const event of events) {
    reports.push(
      await dispatchOne({
        event,
        client,
        preflight,
        options: { ...options, env },
        provider,
        globalOptOuts,
        now,
      })
    );
  }

  const attemptsCreated =
    reports.filter((report) => Boolean(report.attemptId)).length +
    reports.filter((report) => Boolean(report.fallbackAttemptId)).length;

  return {
    testRunId: clean(options.testRunId),
    preview: preflight.preview,
    send: preflight.send,
    mode: preflight.mode,
    controlledRecipientMode: preflight.controlledRecipientMode,
    realCustomerSendMode: preflight.realCustomerSendMode,
    forceContactEligibilityForTest: preflight.forceContactEligibilityForTest,
    eventsChecked: events.length,
    previewed: reports.filter((report) => report.outcome === "previewed").length,
    submitted: reports.filter((report) => report.outcome === "submitted").length,
    failed: reports.filter((report) => report.outcome === "failed").length,
    skipped: reports.filter((report) => report.outcome === "skipped").length,
    attemptsCreated,
    providerCalls: attemptsCreated,
    reports,
  };
}
