import {
  cleanNotificationText,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
} from "@/lib/notifications/helpers";

const NO_REPLY_NOTICE =
  "This is an automated no-reply email. Please do not reply directly to this message.";
export const DELIVERY_CONFIRMATION_PAYMENT_REMINDER_TEXT =
  "Our records show a balance will be due before delivery. You can view payment details using the link below.";

function safeEmailJobName(value: string | null | undefined) {
  const cleaned = cleanNotificationText(value);
  if (!cleaned || cleaned.toUpperCase() === "MAIN") return "your delivery";
  return cleaned;
}

function safeEmailJobAddress(value: string | null | undefined) {
  const cleaned = cleanNotificationText(value);
  if (!cleaned || cleaned.toUpperCase() === "MAIN") return "the job site";
  return cleaned;
}

export function render42DayEmailConfirmationSubject(params: {
  buyerGroup?: string | null;
  jobName?: string | null;
  deliveryDate: Date | string;
}) {
  const buyerGroup = cleanNotificationText(params.buyerGroup);
  const jobName = safeEmailJobName(params.jobName);
  const hasJobName = jobName !== "your delivery";
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);

  if (buyerGroup && hasJobName) {
    return `ACTION REQUIRED: ${buyerGroup} delivery confirmation: ${jobName} - ${deliveryDate}`;
  }

  if (!buyerGroup && hasJobName) {
    return `ACTION REQUIRED: Delivery confirmation: ${jobName} - ${deliveryDate}`;
  }

  if (buyerGroup) {
    return `ACTION REQUIRED: ${buyerGroup} delivery confirmation - ${deliveryDate}`;
  }

  return `ACTION REQUIRED: Delivery confirmation - ${deliveryDate}`;
}

export function render42DayEmailConfirmationBody(params: {
  contactName: string;
  buyerGroup?: string | null;
  jobName?: string | null;
  jobAddress?: string | null;
  deliveryDate: Date | string;
  link: string;
  paymentReminderApplies?: boolean;
}) {
  const contactName = cleanNotificationText(params.contactName) ?? "there";
  const jobName = safeEmailJobName(params.jobName);
  const jobAddress = safeEmailJobAddress(params.jobAddress);
  const link = cleanNotificationText(params.link) ?? "";
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);

  return [
    `Hello ${contactName},`,
    "",
    `We are 6 weeks out! Your ${deliveryDescription} for ${jobName} is scheduled for ${deliveryDate}.`,
    "",
    `Delivery address: ${jobAddress}`,
    "",
    params.paymentReminderApplies ? DELIVERY_CONFIRMATION_PAYMENT_REMINDER_TEXT : null,
    params.paymentReminderApplies ? "" : null,
    "Please confirm if this delivery date still works or request a different date using the link below.",
    "",
    "To confirm/change delivery and view delivery details, click here:",
    link,
    "",
    NO_REPLY_NOTICE,
    "",
    "Thank you.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function render42DayEmailConfirmationMessage(params: {
  contactName: string;
  buyerGroup?: string | null;
  jobName?: string | null;
  jobAddress?: string | null;
  deliveryDate: Date | string;
  link: string;
  paymentReminderApplies?: boolean;
}) {
  return {
    subject: render42DayEmailConfirmationSubject(params),
    body: render42DayEmailConfirmationBody(params),
  };
}

export function get42DayEmailNoReplyNotice() {
  return NO_REPLY_NOTICE;
}
