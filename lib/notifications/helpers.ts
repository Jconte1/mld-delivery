export const NOTIFICATION_INTERVAL_TYPES = [
  "DAY_180",
  "DAY_90",
  "DAY_60",
  "DAY_42",
  "DAY_30",
  "DAY_14",
  "DAY_12",
  "DAY_10",
  "DAY_8",
  "DAY_2",
] as const;

export const NOTIFICATION_ACTION_TYPES = [
  "DELIVERY_REMINDER",
  "DELIVERY_CONFIRMATION_REQUEST",
  "PAYMENT_REQUEST",
  "PAYMENT_ENFORCEMENT",
  "BACKORDER_REPORT",
  "INTERNAL_EMAIL",
  "MANUAL_REVIEW",
] as const;

export type NotificationIntervalType = (typeof NOTIFICATION_INTERVAL_TYPES)[number];
export type NotificationActionType = (typeof NOTIFICATION_ACTION_TYPES)[number];
export type NotificationChannel = "SMS" | "EMAIL";

export type NotificationContactInput = {
  smsOptIn?: boolean | null;
  emailOptIn?: boolean | null;
  phone1?: string | null;
  phone2?: string | null;
  email?: string | null;
};

export type NotificationOptOutState = {
  activeSmsOptOut?: boolean;
  activeEmailOptOut?: boolean;
  activeSmsOptOutPhones?: string[];
  activeEmailOptOutEmails?: string[];
};

export type SelectedNotificationChannel =
  | {
      selectedChannel: "SMS";
      channelReason: string;
      recipientPhone: string;
      recipientEmail?: undefined;
    }
  | {
      selectedChannel: "EMAIL";
      channelReason: string;
      recipientEmail: string;
      recipientPhone?: undefined;
    }
  | {
      selectedChannel: null;
      channelReason: string;
      recipientEmail?: undefined;
      recipientPhone?: undefined;
    };

export function cleanNotificationText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function normalizePhone(value: string | null | undefined) {
  const cleaned = cleanNotificationText(value);
  if (!cleaned) return null;

  const digits = cleaned.replace(/\D/g, "");
  return digits || cleaned.toLowerCase();
}

function normalizeEmail(value: string | null | undefined) {
  return cleanNotificationText(value)?.toLowerCase() ?? null;
}

export function dateKey(value: Date | string) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const trimmed = value.trim();
  const dateOnly = trimmed.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  return dateOnly ?? trimmed;
}

export function dateFromKey(value: Date | string) {
  const key = dateKey(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error(`Invalid date value: ${String(value)}`);
  }

  return new Date(`${key}T00:00:00.000Z`);
}

export function addDays(value: Date | string, days: number) {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export function isNotificationBusinessDay(runDate: Date | string) {
  const day = dateFromKey(runDate).getUTCDay();
  return day !== 0 && day !== 6;
}

export function shouldSkipNotificationRunForWeekend(runDate: Date | string) {
  return !isNotificationBusinessDay(runDate);
}

export function assertNotificationBusinessDay(runDate: Date | string) {
  if (shouldSkipNotificationRunForWeekend(runDate)) {
    throw new Error(`Notification run skipped because ${dateKey(runDate)} is a weekend`);
  }
}

export function selectNotificationChannel(
  contact: NotificationContactInput,
  optOutState: NotificationOptOutState = {}
): SelectedNotificationChannel {
  const optedOutPhones = new Set(
    optOutState.activeSmsOptOutPhones?.map(normalizePhone).filter(Boolean)
  );
  const optedOutEmails = new Set(
    optOutState.activeEmailOptOutEmails?.map(normalizeEmail).filter(Boolean)
  );

  const phone =
    [contact.phone1, contact.phone2]
      .map(cleanNotificationText)
      .find((candidate) => {
        const normalized = normalizePhone(candidate);
        return normalized && !optedOutPhones.has(normalized);
      }) ?? null;
  const email = cleanNotificationText(contact.email);
  const normalizedEmail = normalizeEmail(email);

  if (contact.smsOptIn === true && phone && !optOutState.activeSmsOptOut) {
    return {
      selectedChannel: "SMS",
      channelReason: "sms_opted_in_phone_available",
      recipientPhone: phone,
    };
  }

  if (
    email &&
    contact.emailOptIn !== false &&
    !optOutState.activeEmailOptOut &&
    (!normalizedEmail || !optedOutEmails.has(normalizedEmail))
  ) {
    return {
      selectedChannel: "EMAIL",
      channelReason: "email_available_sms_unavailable",
      recipientEmail: email,
    };
  }

  return {
    selectedChannel: null,
    channelReason: "no_automated_channel_available",
  };
}

export function buildNotificationDedupeKey(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
  intervalType: NotificationIntervalType;
  actionType: NotificationActionType;
}) {
  return [
    "delivery_notification",
    params.orderType.trim(),
    params.orderNumber.trim(),
    dateKey(params.deliveryDate),
    params.intervalType,
    params.actionType,
  ].join(":");
}

export function formatJobName(params: {
  customerDescription?: string | null;
  locationDescription?: string | null;
}) {
  const customerDescription = cleanNotificationText(params.customerDescription);
  const locationDescription = cleanNotificationText(params.locationDescription);

  if (!locationDescription || locationDescription.toUpperCase() === "MAIN") {
    return customerDescription ?? "your delivery";
  }

  if (!customerDescription) return locationDescription;
  return `${customerDescription} / ${locationDescription}`;
}

export function formatJobAddress(params: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}) {
  const cityStatePostal = [params.city, params.state, params.postalCode]
    .map(cleanNotificationText)
    .filter(Boolean);

  return [
    cleanNotificationText(params.addressLine1),
    cleanNotificationText(params.addressLine2),
    cityStatePostal.join(" "),
  ]
    .filter(Boolean)
    .join(", ");
}

export function formatCustomerFriendlyDate(value: Date | string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(dateFromKey(value));
}

export function formatContactName(params: {
  companyName?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  const fullName = [params.firstName, params.lastName]
    .map(cleanNotificationText)
    .filter(Boolean)
    .join(" ");

  return (
    cleanNotificationText(params.firstName) ??
    cleanNotificationText(params.displayName) ??
    cleanNotificationText(fullName) ??
    cleanNotificationText(params.companyName) ??
    "there"
  );
}

export function buildDeliveryReminderMessage(params: {
  contactName: string;
  buyerGroup?: string | null;
  jobName: string;
  jobAddress: string;
  deliveryDate: Date | string;
}) {
  const buyerGroup = cleanNotificationText(params.buyerGroup);
  const deliveryDescription = buyerGroup ? `${buyerGroup} delivery` : "delivery";

  return `Hello ${params.contactName}, we are still a ways out, but wanted to remind you that your ${deliveryDescription} for ${params.jobName} at ${params.jobAddress} is scheduled for ${formatCustomerFriendlyDate(params.deliveryDate)}.`;
}

export function buildDeliveryReminderEmailSubject(deliveryDate: Date | string) {
  return `Delivery reminder for ${formatCustomerFriendlyDate(deliveryDate)}`;
}
