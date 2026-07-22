import { cleanNotificationText } from "@/lib/notifications/helpers";

export const DELIVERY_MANUAL_REVIEW_REASONS = {
  NO_CUSTOMER_RESPONSE: "NO_CUSTOMER_RESPONSE",
  AWAITING_NEW_DATE_NO_RESPONSE: "AWAITING_NEW_DATE_NO_RESPONSE",
  TOO_MANY_UNRECOGNIZED_RESPONSES: "TOO_MANY_UNRECOGNIZED_RESPONSES",
  AMBIGUOUS_SMS_REPLY: "AMBIGUOUS_SMS_REPLY",
  UNMATCHED_SMS_REPLY: "UNMATCHED_SMS_REPLY",
  SMS_DELIVERY_FAILED: "SMS_DELIVERY_FAILED",
  NEW_DATE_REQUESTED: "NEW_DATE_REQUESTED",
} as const;

export type DeliveryManualReviewReason =
  (typeof DELIVERY_MANUAL_REVIEW_REASONS)[keyof typeof DELIVERY_MANUAL_REVIEW_REASONS];

export function formatManualReviewNote(params: {
  reason: DeliveryManualReviewReason;
  body?: string | null;
  phone?: string | null;
}) {
  const body = cleanNotificationText(params.body);
  const phone = cleanNotificationText(params.phone);
  const pieces = [`Reason: ${params.reason}`];
  if (phone) pieces.push(`Phone: ${phone}`);
  if (body) pieces.push(`Message: ${body}`);
  return pieces.join("; ");
}
