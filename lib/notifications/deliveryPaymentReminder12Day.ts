import type { OrderLineReadinessSummary } from "@/lib/delivery-readiness/orderLineReadiness";
import {
  formatCurrencyAmount,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
  renderDeliveryReminderEmailSubject,
} from "@/lib/notifications/helpers";
import { formatPaymentDeadlineDate } from "@/lib/notifications/paymentDeadlineBusinessDays";
import {
  renderSalespersonEmailFooterText,
  type SalespersonContactInput,
} from "@/lib/notifications/salespersonContactDisplay";

export type Render12DayDeliveryPaymentReminderParams = {
  contactName: string;
  buyerGroup?: string | null;
  jobName: string;
  jobAddress: string;
  deliveryDate: Date | string;
  detailsLink: string;
  amountDueNowRounded: string;
  paymentDeadlineDate?: Date | string;
  lines?: OrderLineReadinessSummary[];
  salespersonContact?: SalespersonContactInput | null;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paymentDueText(amountDueNowRounded: string) {
  return `Balance owed prior to scheduling Delivery: ${formatCurrencyAmount(amountDueNowRounded)}`;
}

function paymentDeadlineText(deliveryDate: Date | string, paymentDeadlineDate?: Date | string) {
  const deadline = paymentDeadlineDate
    ? formatCustomerFriendlyDate(paymentDeadlineDate)
    : formatPaymentDeadlineDate(deliveryDate);
  return `Your balance must be handled by ${deadline}.`;
}

export function render12DayDeliveryPaymentReminderSms(
  params: Render12DayDeliveryPaymentReminderParams
) {
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);

  return `MLD: Your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}. Balance may be due before delivery. Please review details here: ${params.detailsLink}. Reply STOP to opt out.`;
}

export function render12DayDeliveryPaymentReminderEmail(
  params: Render12DayDeliveryPaymentReminderParams
) {
  const subject = `Balance Reminder: ${renderDeliveryReminderEmailSubject({
    buyerGroup: params.buyerGroup,
    jobName: params.jobName,
    deliveryDate: params.deliveryDate,
  })}`;
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const salespersonFooter = renderSalespersonEmailFooterText(params.salespersonContact);
  const paymentLine = paymentDueText(params.amountDueNowRounded);
  const deadlineLine = paymentDeadlineText(params.deliveryDate, params.paymentDeadlineDate);

  const bodyParts = [
    `Hello ${params.contactName},`,
    "",
    "This is your second balance reminder.",
    "",
    `Your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}.`,
    `Job address: ${params.jobAddress}`,
    "",
    `Review delivery details here: ${params.detailsLink}`,
    "",
    "Payment",
    paymentLine,
    deadlineLine,
  ];

  if (salespersonFooter) {
    bodyParts.push("", salespersonFooter);
  }

  const escapedLink = escapeHtml(params.detailsLink);
  const htmlParts = [
    `<p>Hello ${escapeHtml(params.contactName)},</p>`,
    `<p>This is your second balance reminder.</p>`,
    `<p>Your ${escapeHtml(deliveryDescription)} for <strong>${escapeHtml(params.jobName)}</strong> is scheduled for <strong>${escapeHtml(deliveryDate)}</strong>.</p>`,
    `<p><strong>Job address:</strong> ${escapeHtml(params.jobAddress)}</p>`,
    `<p><a href="${escapedLink}" style="display:inline-block;background:#18181b;color:#ffffff;padding:10px 14px;border-radius:6px;text-decoration:none;">View Delivery Details</a></p>`,
    `<h2 style="font-size:18px;margin:24px 0 8px;">Payment</h2>`,
    `<p><strong>${escapeHtml(paymentLine)}</strong></p>`,
    `<p><strong>${escapeHtml(deadlineLine)}</strong></p>`,
  ];

  if (salespersonFooter) {
    htmlParts.push(`<p style="margin-top:24px;color:#334155;">${escapeHtml(salespersonFooter)}</p>`);
  }

  return {
    subject,
    body: bodyParts.join("\n"),
    htmlBody: htmlParts.join("\n"),
  };
}
