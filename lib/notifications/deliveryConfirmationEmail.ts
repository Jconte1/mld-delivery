import {
  cleanNotificationText,
  formatCurrencyAmount,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
  normalizeCustomerDisplayText,
} from "@/lib/notifications/helpers";
import {
  renderSalespersonEmailFooterText,
  type SalespersonContactInput,
} from "@/lib/notifications/salespersonContactDisplay";

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
  const cleaned = normalizeCustomerDisplayText(value);
  if (!cleaned || cleaned.toUpperCase() === "MAIN") return "your delivery";
  return cleaned;
}

function safeEmailJobAddress(value: string | null | undefined) {
  const cleaned = normalizeCustomerDisplayText(value);
  if (!cleaned || cleaned.toUpperCase() === "MAIN") return "the job site";
  return cleaned;
}

function htmlJobName(params: {
  customerDescription?: string | null;
  locationDescription?: string | null;
  jobName: string;
}) {
  const customerDescription = normalizeCustomerDisplayText(params.customerDescription);
  const locationDescription = normalizeCustomerDisplayText(params.locationDescription);

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
  const buyerGroup = normalizeCustomerDisplayText(params.buyerGroup);
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
  orderNumber: string;
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
  salespersonContact?: SalespersonContactInput | null;
}) {
  const contactName = normalizeCustomerDisplayText(params.contactName) ?? "there";
  const jobName = safeEmailJobName(params.jobName);
  const jobAddress = safeEmailJobAddress(params.jobAddress);
  const link = cleanNotificationText(params.link) ?? "";
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const salespersonFooter = renderSalespersonEmailFooterText(params.salespersonContact);

  return [
    `Hello ${contactName},`,
    "",
    `We are 6 weeks out! Your ${deliveryDescription} for ${jobName} is scheduled for ${deliveryDate}.`,
    "",
    `Delivery address: ${jobAddress}`,
    `Order: ${params.orderNumber}`,
    "",
    params.paymentReminderApplies
      ? render42DayPaymentReminderText(params.amountDueNowRounded)
      : null,
    params.paymentReminderApplies ? "" : null,
    "To confirm/change delivery and view order details, click here:",
    link,
    "",
    salespersonFooter,
    salespersonFooter ? "" : null,
    NO_REPLY_NOTICE,
    "",
    "Thank you.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function render42DayEmailConfirmationHtmlBody(params: {
  orderNumber: string;
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
  salespersonContact?: SalespersonContactInput | null;
}) {
  const contactName = normalizeCustomerDisplayText(params.contactName) ?? "there";
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
  const salespersonFooter = renderSalespersonEmailFooterText(params.salespersonContact);

  return [
    paragraph(`Hello ${contactName},`),
    `<p>We are 6 weeks out! Your ${escapeHtml(deliveryDescription)} for ${htmlJobName({
      customerDescription: params.customerDescription,
      locationDescription: params.locationDescription,
      jobName,
    })} is scheduled for ${escapeHtml(deliveryDate)}.</p>`,
    `<p>Delivery address: <strong>${escapeHtml(jobAddress)}</strong></p>`,
    `<p>Order: <strong>${escapeHtml(params.orderNumber)}</strong></p>`,
    paymentText && paymentAmount
      ? `<p>Balance owed before delivery: <strong>${escapeHtml(paymentAmount)}</strong></p>`
      : paymentText
        ? paragraph(paymentText)
        : null,
    paragraph("To confirm/change delivery and view order details, click here:"),
    `<p><a href="${escapeHtml(
      link
    )}" style="display:inline-block;background-color:#1f2937;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600;">Confirm/ Change Delivery</a></p>`,
    salespersonFooter ? paragraph(salespersonFooter) : null,
    paragraph(NO_REPLY_NOTICE),
    paragraph("Thank you."),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function render42DayEmailConfirmationMessage(params: {
  orderNumber: string;
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
  salespersonContact?: SalespersonContactInput | null;
}) {
  return {
    subject: render42DayEmailConfirmationSubject(params),
    body: render42DayEmailConfirmationBody(params),
    htmlBody: render42DayEmailConfirmationHtmlBody(params),
  };
}

type DeliveryConfirmationReminderTouchNumber = 2 | 3;

function isFinalDeliveryConfirmationReminder(touchNumber?: DeliveryConfirmationReminderTouchNumber) {
  return touchNumber === 3;
}

export function render42DayEmailConfirmationReminderSubject(params: {
  orderNumber: string;
  touchNumber?: DeliveryConfirmationReminderTouchNumber;
}) {
  return isFinalDeliveryConfirmationReminder(params.touchNumber)
    ? `Final Reminder: Please Confirm Your Delivery for Order ${params.orderNumber}`
    : `Reminder: Please Confirm Your Delivery for Order ${params.orderNumber}`;
}

export function render42DayEmailConfirmationReminderBody(params: {
  orderNumber: string;
  contactName: string;
  deliveryDate: Date | string;
  link: string;
  touchNumber?: DeliveryConfirmationReminderTouchNumber;
}) {
  const contactName = normalizeCustomerDisplayText(params.contactName) ?? "there";
  const link = cleanNotificationText(params.link) ?? "";
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const finalReminder = isFinalDeliveryConfirmationReminder(params.touchNumber);

  return [
    `Hello ${contactName},`,
    "",
    `Order: ${params.orderNumber}`,
    finalReminder
      ? `This is the final reminder to confirm your upcoming delivery scheduled for ${deliveryDate}.`
      : `This is a reminder to confirm your upcoming delivery scheduled for ${deliveryDate}.`,
    "",
    "Please confirm your delivery or request a different date using the link below:",
    link,
    ...(finalReminder
      ? [
          "",
          "If we do not receive a response, our team will follow up directly.",
        ]
      : []),
    "",
    NO_REPLY_NOTICE,
    "",
    "Thank you.",
  ].join("\n");
}

export function render42DayEmailConfirmationReminderHtmlBody(params: {
  orderNumber: string;
  contactName: string;
  deliveryDate: Date | string;
  link: string;
  touchNumber?: DeliveryConfirmationReminderTouchNumber;
}) {
  const contactName = normalizeCustomerDisplayText(params.contactName) ?? "there";
  const link = cleanNotificationText(params.link) ?? "";
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const finalReminder = isFinalDeliveryConfirmationReminder(params.touchNumber);
  const paragraph = (value: string) => `<p>${escapeHtml(value)}</p>`;

  return [
    paragraph(`Hello ${contactName},`),
    `<p>Order: <strong>${escapeHtml(params.orderNumber)}</strong></p>`,
    paragraph(
      finalReminder
        ? `This is the final reminder to confirm your upcoming delivery scheduled for ${deliveryDate}.`
        : `This is a reminder to confirm your upcoming delivery scheduled for ${deliveryDate}.`
    ),
    paragraph("Please confirm your delivery or request a different date using the link below:"),
    `<p><a href="${escapeHtml(
      link
    )}" style="display:inline-block;background-color:#1f2937;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600;">Confirm/ Change Delivery</a></p>`,
    ...(finalReminder
      ? [paragraph("If we do not receive a response, our team will follow up directly.")]
      : []),
    paragraph(NO_REPLY_NOTICE),
    paragraph("Thank you."),
  ].join("\n");
}

export function render42DayEmailConfirmationReminderMessage(params: {
  orderNumber: string;
  contactName: string;
  deliveryDate: Date | string;
  link: string;
  touchNumber?: DeliveryConfirmationReminderTouchNumber;
}) {
  return {
    subject: render42DayEmailConfirmationReminderSubject(params),
    body: render42DayEmailConfirmationReminderBody(params),
    htmlBody: render42DayEmailConfirmationReminderHtmlBody(params),
  };
}

export function get42DayEmailNoReplyNotice() {
  return NO_REPLY_NOTICE;
}
