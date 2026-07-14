import {
  cleanNotificationText,
  dateKey,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
} from "@/lib/notifications/helpers";

const CONFIRMED_RESPONSES = new Set(["Y", "YES", "CONFIRM", "CONFIRMED"]);
const CHANGE_REQUESTED_RESPONSES = new Set(["N", "NO", "CHANGE", "RESCHEDULE"]);

export type SmsConfirmationResponseKind = "confirmed" | "change_requested" | "unrecognized";

export type SmsConfirmationResponseParseResult = {
  kind: SmsConfirmationResponseKind;
  rawResponse: string;
  normalizedResponse: string;
};

export type RequestedDeliveryDateParseResult =
  | {
      valid: true;
      rawValue: string;
      date: Date;
      dateKey: string;
    }
  | {
      valid: false;
      rawValue: string;
      reason: "invalid_format";
    };

export function normalizeSmsConfirmationResponse(input: string | null | undefined) {
  return cleanNotificationText(input)?.toUpperCase() ?? "";
}

export function parseSmsConfirmationResponse(
  input: string | null | undefined
): SmsConfirmationResponseParseResult {
  const rawResponse = input ?? "";
  const normalizedResponse = normalizeSmsConfirmationResponse(input);

  if (CONFIRMED_RESPONSES.has(normalizedResponse)) {
    return { kind: "confirmed", rawResponse, normalizedResponse };
  }

  if (CHANGE_REQUESTED_RESPONSES.has(normalizedResponse)) {
    return { kind: "change_requested", rawResponse, normalizedResponse };
  }

  return { kind: "unrecognized", rawResponse, normalizedResponse };
}

export function parseRequestedDeliveryDate(
  input: string | null | undefined
): RequestedDeliveryDateParseResult {
  const rawValue = input ?? "";
  const trimmed = cleanNotificationText(input) ?? "";
  const match = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (!match) {
    return { valid: false, rawValue, reason: "invalid_format" };
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { valid: false, rawValue, reason: "invalid_format" };
  }

  return {
    valid: true,
    rawValue,
    date,
    dateKey: dateKey(date),
  };
}

export function getSmsInvalidDateFormatMessage() {
  return "We could not read that date. Please reply with the new delivery date in MM/DD/YYYY format.";
}

export function getSmsUnrecognizedResponseMessage() {
  return "Sorry, we did not understand that. Reply Y to confirm or N to change your delivery date.";
}

export function getSmsChangeRequestedNextStepMessage() {
  return "Please provide the new delivery date in MM/DD/YYYY format.";
}

export function render42DaySmsConfirmationMessage(params: {
  contactName: string;
  buyerGroup?: string | null;
  jobName: string;
  deliveryDate: Date | string;
  link: string;
}) {
  const contactName = cleanNotificationText(params.contactName) ?? "there";
  const jobName = cleanNotificationText(params.jobName) ?? "your delivery";
  const link = cleanNotificationText(params.link) ?? "";
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);

  return `Hello ${contactName}, we are 6 weeks out! Your ${deliveryDescription} for ${jobName} is scheduled for ${formatCustomerFriendlyDate(params.deliveryDate)}. Reply Y to confirm or N to change your delivery date. For ETAs and delivery details: ${link}`;
}

export function buildDeliveryConfirmationScopeKey(params: {
  orderType: string;
  orderNumber: string;
  deliveryDate: Date | string;
  deliveryGroupId: string;
}) {
  return [
    "delivery_confirmation",
    params.orderType.trim(),
    params.orderNumber.trim(),
    dateKey(params.deliveryDate),
    params.deliveryGroupId.trim(),
  ].join(":");
}
