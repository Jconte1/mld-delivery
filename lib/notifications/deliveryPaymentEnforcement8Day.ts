import {
  formatCurrencyAmount,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
} from "@/lib/notifications/helpers";
import {
  getSalespersonContactDisplay,
  type SalespersonContactInput,
} from "@/lib/notifications/salespersonContactDisplay";

export type Render8DayDeliveryPaymentEnforcementCustomerParams = {
  orderNumber: string;
  contactName: string;
  buyerGroup?: string | null;
  jobName: string;
  jobAddress: string;
  deliveryDate: Date | string;
  detailsLink: string;
  amountDueNowRounded: string;
  salespersonContact?: SalespersonContactInput | null;
};

export type Render8DayPaymentEnforcementInternalParams = {
  salespersonName?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  orderNumber: string;
  jobName: string;
  deliveryDate: Date | string;
  paymentDeadlineDate: Date | string;
  amountDueNowRounded: string;
  detailsLink: string;
  errorSummary?: string | null;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function customerContactLines(params: {
  customerEmail?: string | null;
  customerPhone?: string | null;
}) {
  return [clean(params.customerEmail), clean(params.customerPhone)].filter(
    (value): value is string => Boolean(value)
  );
}

export function render8DayPaymentEnforcementCustomerSms(
  params: Render8DayDeliveryPaymentEnforcementCustomerParams
) {
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);

  return `MLD: Order ${params.orderNumber}: Your ${deliveryDescription} for ${params.jobName} is currently on hold because payment was not received by the required deadline. Review details here: ${params.detailsLink}. Reply STOP to opt out.`;
}

export function render8DayPaymentEnforcementCustomerEmail(
  params: Render8DayDeliveryPaymentEnforcementCustomerParams
) {
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const amountDue = formatCurrencyAmount(params.amountDueNowRounded);
  const salespersonDisplay = getSalespersonContactDisplay(params.salespersonContact);
  const salespersonFooter = salespersonDisplay?.emailFooterText ?? null;
  const subject = `Attention: Delivery Order On Hold - ${params.jobName} - ${deliveryDate}`;

  const bodyParts = [
    `Hello ${params.contactName},`,
    "",
    `Your ${deliveryDescription} for ${params.jobName} at ${params.jobAddress} was scheduled for ${deliveryDate}.`,
    `Order: ${params.orderNumber}`,
    "",
    "Your delivery is currently on hold because payment was not received by the required deadline.",
    "",
    `Balance owed prior to scheduling Delivery: ${amountDue}`,
    "",
    "Please use the link below to review your delivery details:",
    `View Delivery Details: ${params.detailsLink}`,
  ];

  if (salespersonFooter) {
    bodyParts.push("", salespersonFooter);
  }

  bodyParts.push("", "Thank you,", "MLD");

  const escapedLink = escapeHtml(params.detailsLink);
  const htmlParts = [
    `<p>Hello ${escapeHtml(params.contactName)},</p>`,
    `<p>Your ${escapeHtml(deliveryDescription)} for <strong>${escapeHtml(params.jobName)}</strong> at ${escapeHtml(params.jobAddress)} was scheduled for <strong>${escapeHtml(deliveryDate)}</strong>.</p>`,
    `<p><strong>Order:</strong> ${escapeHtml(params.orderNumber)}</p>`,
    `<p>Your delivery is currently on hold because payment was not received by the required deadline.</p>`,
    `<p><strong>Balance owed prior to scheduling Delivery: ${escapeHtml(amountDue)}</strong></p>`,
    `<p>Please use the link below to review your delivery details:</p>`,
    `<p><a href="${escapedLink}" style="display:inline-block;background:#18181b;color:#ffffff;padding:10px 14px;border-radius:6px;text-decoration:none;">View Delivery Details</a></p>`,
  ];

  if (salespersonFooter) {
    htmlParts.push(`<p style="margin-top:24px;color:#334155;">${escapeHtml(salespersonFooter)}</p>`);
  }

  htmlParts.push("<p>Thank you,<br />MLD</p>");

  return {
    subject,
    body: bodyParts.join("\n"),
    htmlBody: htmlParts.join("\n"),
  };
}

export function render8DayPaymentEnforcementInternalSuccess(
  params: Render8DayPaymentEnforcementInternalParams
) {
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const deadline = formatCustomerFriendlyDate(params.paymentDeadlineDate);
  const amountDue = formatCurrencyAmount(params.amountDueNowRounded);
  const greetingName = clean(params.salespersonName) ?? "there";
  const contacts = customerContactLines(params);
  const customerContact = contacts.length > 0 ? contacts.join("\n") : "No customer contact on file.";
  const subject = `Customer Payment Missed: ${params.orderNumber} - ${params.jobName} - ${deliveryDate}`;
  const body = [
    `Hello ${greetingName},`,
    "",
    `${params.customerName} did not complete the required payment by the deadline for their scheduled delivery.`,
    "",
    `Order: ${params.orderNumber}`,
    `Job: ${params.jobName}`,
    `Delivery Date: ${deliveryDate}`,
    `Payment Deadline: ${deadline}`,
    `Amount Due: ${amountDue}`,
    "",
    "The order has been placed on hold.",
    "",
    "Customer Contact:",
    customerContact,
    "",
    "Delivery Details:",
    `View Delivery Details: ${params.detailsLink}`,
    "",
    "Thank you,",
    "MLD Delivery Notifications",
  ].join("\n");

  return {
    subject,
    body,
    messageSummary: `${params.customerName} missed the payment deadline. Order ${params.orderNumber} was placed on hold.`,
  };
}

export function render8DayPaymentEnforcementInternalFailure(
  params: Render8DayPaymentEnforcementInternalParams
) {
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const deadline = formatCustomerFriendlyDate(params.paymentDeadlineDate);
  const amountDue = formatCurrencyAmount(params.amountDueNowRounded);
  const greetingName = clean(params.salespersonName) ?? "Internal Team";
  const errorSummary = clean(params.errorSummary) ?? "Unknown hold write failure.";
  const subject = `Action Needed: Automated Hold Failed - ${params.orderNumber} - ${params.jobName}`;
  const body = [
    `Hello ${greetingName},`,
    "",
    `${params.customerName} did not complete the required payment by the deadline for their scheduled delivery, but the automated hold write to Acumatica failed.`,
    "",
    "Please review this order manually.",
    "",
    `Order: ${params.orderNumber}`,
    `Job: ${params.jobName}`,
    `Delivery Date: ${deliveryDate}`,
    `Payment Deadline: ${deadline}`,
    `Amount Due: ${amountDue}`,
    "",
    "Error:",
    errorSummary,
    "",
    "Delivery Details:",
    `View Delivery Details: ${params.detailsLink}`,
    "",
    "Thank you,",
    "MLD Delivery Notifications",
  ].join("\n");

  return {
    subject,
    body,
    messageSummary: `Automated hold failed for order ${params.orderNumber}: ${errorSummary}`,
  };
}
