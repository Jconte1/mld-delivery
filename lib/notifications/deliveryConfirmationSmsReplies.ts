import {
  parseMmDdYyyyDate,
  validateRequestedDeliveryDateEligibility,
  type DeliveryDateEligibilityAddress,
  type RequestedDeliveryDateReasonCode,
} from "@/lib/notifications/deliveryDateEligibility";
import { cleanNotificationText, dateFromKey } from "./helpers";

export const DELIVERY_SMS_CONFIRMED_RESPONSES = new Set(["Y", "YES", "CONFIRM", "CONFIRMED"]);
export const DELIVERY_SMS_CHANGE_RESPONSES = new Set(["N", "NO", "CHANGE", "RESCHEDULE"]);
export const DELIVERY_SMS_STOP_RESPONSES = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
export const DELIVERY_SMS_START_RESPONSES = new Set(["START", "UNSTOP", "YESSTART"]);

export type DeliverySmsReplyIntent =
  | "CONFIRM"
  | "CHANGE_REQUEST"
  | "REQUESTED_DATE"
  | "STOP"
  | "START"
  | "HELP"
  | "UNRECOGNIZED";

export type RequestedDeliveryDateValidation =
  | {
      valid: true;
      date: Date;
      rawValue: string;
      dateKey: string;
      responseMessage: string;
    }
  | {
      valid: false;
      reason: RequestedDeliveryDateReasonCode;
      rawValue: string;
      responseMessage: string;
    };

export function normalizeDeliverySmsBody(value: string | null | undefined) {
  return cleanNotificationText(value)?.toUpperCase() ?? "";
}

export function parseDeliverySmsReplyIntent(value: string | null | undefined): DeliverySmsReplyIntent {
  const normalized = normalizeDeliverySmsBody(value);

  if (DELIVERY_SMS_STOP_RESPONSES.has(normalized)) return "STOP";
  if (DELIVERY_SMS_START_RESPONSES.has(normalized)) return "START";
  if (normalized === "HELP") return "HELP";
  if (DELIVERY_SMS_CONFIRMED_RESPONSES.has(normalized)) return "CONFIRM";
  if (DELIVERY_SMS_CHANGE_RESPONSES.has(normalized)) return "CHANGE_REQUEST";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(normalized)) return "REQUESTED_DATE";
  return "UNRECOGNIZED";
}

export function normalizePhoneToE164(value: string | null | undefined) {
  const cleaned = cleanNotificationText(value);
  if (!cleaned) return null;

  const digits = cleaned.replace(/\D/g, "");
  if (!digits) return null;

  if (cleaned.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

export function phonesMatch(left: string | null | undefined, right: string | null | undefined) {
  const normalizedLeft = normalizePhoneToE164(left);
  const normalizedRight = normalizePhoneToE164(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function validateRequestedDeliveryDate(params: {
  rawValue: string;
  currentDeliveryDate: Date | string;
  address?: DeliveryDateEligibilityAddress | null;
  now?: Date;
}): RequestedDeliveryDateValidation {
  const parsed = parseMmDdYyyyDate(params.rawValue);
  const rawValue = params.rawValue;

  if (!parsed.valid) {
    const validation = validateRequestedDeliveryDateEligibility({
      requestedDate: null,
      currentDeliveryDate: params.currentDeliveryDate,
      address: params.address,
      now: params.now,
    });
    return {
      valid: false,
      reason: validation.allowed ? "INVALID_DATE_FORMAT" : validation.reason,
      rawValue,
      responseMessage: validation.allowed ? getSmsInvalidDateFormatMessage() : validation.customerMessage,
    };
  }

  const validation = validateRequestedDeliveryDateEligibility({
    requestedDate: parsed.date,
    currentDeliveryDate: params.currentDeliveryDate,
    address: params.address,
    now: params.now,
  });
  if (!validation.allowed) {
    return {
      valid: false,
      reason: validation.reason,
      rawValue,
      responseMessage: validation.customerMessage,
    };
  }

  return {
    valid: true,
    date: validation.date,
    rawValue,
    dateKey: validation.dateKey,
    responseMessage: getSmsNewDateReceivedMessage(validation.date),
  };
}

export function getSmsConfirmedMessage() {
  return "MLD: Thanks, your delivery date has been confirmed. Reply STOP to opt out.";
}

export function getSmsChangeRequestedNextStepMessage() {
  return "MLD: No problem. Please reply with your preferred delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
}

export function getSmsInvalidDateFormatMessage() {
  return "MLD: Please send the date as MM/DD/YYYY, for example 08/31/2026. Reply STOP to opt out.";
}

export function getSmsWeekendDateMessage() {
  return "MLD: That date falls on a weekend. Please reply with a weekday delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
}

export function getSmsPastDateMessage() {
  return "MLD: That date has already passed. Please reply with a future delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
}

export function getSmsSameDateMessage() {
  return "MLD: That is already your current scheduled delivery date. Please reply Y to confirm or send a different allowed delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
}

export function getSmsNewDateReceivedMessage(date: Date | string) {
  return `MLD: Thanks. We received your requested delivery date of ${formatMmDdYyyy(
    date
  )}. Our team will review and follow up. Reply STOP to opt out.`;
}

export function getSmsUnrecognizedClarificationMessage() {
  return "MLD: Sorry, we did not understand that response. Please reply Y to confirm your delivery date or N to request a different date. Reply STOP to opt out.";
}

export function getSmsUnrecognizedFinalMessage() {
  return "MLD: Thanks. We are having trouble understanding your response, so our team will follow up. Reply STOP to opt out.";
}

export function getSmsAmbiguousReplyMessage() {
  return "MLD: We found more than one active delivery confirmation for this phone number. Our team will follow up. Reply STOP to opt out.";
}

export function getSmsOptInMessage() {
  return "MLD: You are now opted in to receive delivery notification text messages from MLD. Reply HELP for help. Reply STOP to opt out.";
}

export function getSmsHelpMessage() {
  return "MLD: Reply Y to confirm your delivery date or N to request a different date. For help, contact MLD. Reply STOP to opt out.";
}

export function getSmsUnmatchedReplyMessage() {
  return "MLD: We could not match your reply to an active delivery confirmation. Our team will follow up if needed. Reply STOP to opt out.";
}

export function formatMmDdYyyy(value: Date | string) {
  const date = dateFromKey(value);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${date.getUTCFullYear()}`;
}
