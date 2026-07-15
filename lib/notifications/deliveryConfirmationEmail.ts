import {
  cleanNotificationText,
  formatCurrencyAmount,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
} from "@/lib/notifications/helpers";

const NO_REPLY_NOTICE =
  "This is an automated no-reply email. Please do not reply directly to this message.";
export const DELIVERY_CONFIRMATION_PAYMENT_REMINDER_TEXT =
  "Our records show a balance will be due before delivery.";

function formatBalanceOwedAmount(value: string | null | undefined) {
  if (!value) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 2) return null;

  return formatCurrencyAmount(amount);
}

export function render42DayPaymentReminderText(amountDueNowRounded?: string | null) {
  const amount = formatBalanceOwedAmount(amountDueNowRounded);
  if (!amount) return DELIVERY_CONFIRMATION_PAYMENT_REMINDER_TEXT;

  return `Balance owed before delivery: ${amount}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

function htmlJobName(params: {
  customerDescription?: string | null;
  locationDescription?: string | null;
  jobName: string;
}) {
  const customerDescription = cleanNotificationText(params.customerDescription);
  const locationDescription = cleanNotificationText(params.locationDescription);

  if (!locationDescription || locationDescription.toUpperCase() === "MAIN") {
    return `<strong>${escapeHtml(customerDescription ?? params.jobName)}</strong>`;
  }

  if (!customerDescription) return `<strong>${escapeHtml(locationDescription)}</strong>`;

  return `<strong>${escapeHtml(customerDescription)}</strong> / <strong>${escapeHtml(
    locationDescription
  )}</strong>`;
}

export function render42DayEmailConfirmationSubject(params: {
  buyerGroup?: string | null;
  customerDescription?: string | null;
  locationDescription?: string | null;
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
  customerDescription?: string | null;
  locationDescription?: string | null;
  jobName?: string | null;
  jobAddress?: string | null;
  deliveryDate: Date | string;
  link: string;
  paymentReminderApplies?: boolean;
  amountDueNowRounded?: string | null;
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
    params.paymentReminderApplies
      ? render42DayPaymentReminderText(params.amountDueNowRounded)
      : null,
    params.paymentReminderApplies ? "" : null,
    "To confirm/change delivery and view order details, click here:",
    link,
    "",
    NO_REPLY_NOTICE,
    "",
    "Thank you.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function render42DayEmailConfirmationHtmlBody(params: {
  contactName: string;
  buyerGroup?: string | null;
  customerDescription?: string | null;
  locationDescription?: string | null;
  jobName?: string | null;
  jobAddress?: string | null;
  deliveryDate: Date | string;
  link: string;
  paymentReminderApplies?: boolean;
  amountDueNowRounded?: string | null;
}) {
  const contactName = cleanNotificationText(params.contactName) ?? "there";
  const jobName = safeEmailJobName(params.jobName);
  const jobAddress = safeEmailJobAddress(params.jobAddress);
  const link = cleanNotificationText(params.link) ?? "";
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const paymentText = params.paymentReminderApplies
    ? render42DayPaymentReminderText(params.amountDueNowRounded)
    : null;
  const paragraph = (value: string) => `<p>${escapeHtml(value)}</p>`;
  const paymentAmount = formatBalanceOwedAmount(params.amountDueNowRounded);

  return [
    paragraph(`Hello ${contactName},`),
    `<p>We are 6 weeks out! Your ${escapeHtml(deliveryDescription)} for ${htmlJobName({
      customerDescription: params.customerDescription,
      locationDescription: params.locationDescription,
      jobName,
    })} is scheduled for ${escapeHtml(deliveryDate)}.</p>`,
    `<p>Delivery address: <strong>${escapeHtml(jobAddress)}</strong></p>`,
    paymentText && paymentAmount
      ? `<p>Balance owed before delivery: <strong>${escapeHtml(paymentAmount)}</strong></p>`
      : paymentText
        ? paragraph(paymentText)
        : null,
    paragraph("To confirm/change delivery and view order details, click here:"),
    `<p><a href="${escapeHtml(
      link
    )}" style="display:inline-block;background-color:#1f2937;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600;">Confirm/ Change Delivery</a></p>`,
    paragraph(NO_REPLY_NOTICE),
    paragraph("Thank you."),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function render42DayEmailConfirmationMessage(params: {
  contactName: string;
  buyerGroup?: string | null;
  customerDescription?: string | null;
  locationDescription?: string | null;
  jobName?: string | null;
  jobAddress?: string | null;
  deliveryDate: Date | string;
  link: string;
  paymentReminderApplies?: boolean;
  amountDueNowRounded?: string | null;
}) {
  return {
    subject: render42DayEmailConfirmationSubject(params),
    body: render42DayEmailConfirmationBody(params),
    htmlBody: render42DayEmailConfirmationHtmlBody(params),
  };
}

export function get42DayEmailNoReplyNotice() {
  return NO_REPLY_NOTICE;
}
