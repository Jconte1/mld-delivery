import type { OrderLineReadinessSummary } from "@/lib/delivery-readiness/orderLineReadiness";
import {
  formatCurrencyAmount,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
  renderDeliveryReminderEmailSubject,
} from "@/lib/notifications/helpers";
import {
  renderSalespersonEmailFooterText,
  type SalespersonContactInput,
} from "@/lib/notifications/salespersonContactDisplay";

export type Render30DayDeliveryReminderParams = {
  orderNumber: string;
  contactName: string;
  buyerGroup?: string | null;
  jobName: string;
  jobAddress: string;
  deliveryDate: Date | string;
  detailsLink: string;
  paymentDue: boolean;
  amountDueNowRounded?: string | null;
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

function paymentDueText(amountDueNowRounded?: string | null) {
  return `Balance owed prior to scheduling Delivery: ${formatCurrencyAmount(amountDueNowRounded)}`;
}

export function render30DayDeliveryReminderSms(params: Render30DayDeliveryReminderParams) {
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);

  if (params.paymentDue) {
    return `MLD: Order ${params.orderNumber}: Your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}. Payment may be needed before delivery. Please review details here: ${params.detailsLink}. Reply STOP to opt out.`;
  }

  return `MLD: Order ${params.orderNumber}: Your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}. Review delivery details here: ${params.detailsLink}. Reply STOP to opt out.`;
}

export function render30DayDeliveryReminderEmail(params: Render30DayDeliveryReminderParams) {
  const subject = renderDeliveryReminderEmailSubject({
    buyerGroup: params.buyerGroup,
    jobName: params.jobName,
    deliveryDate: params.deliveryDate,
  });
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const salespersonFooter = renderSalespersonEmailFooterText(params.salespersonContact);
  const paymentLine = params.paymentDue ? paymentDueText(params.amountDueNowRounded) : null;

  const bodyParts = [
    `Hello ${params.contactName},`,
    "",
    `Your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}.`,
    `Job address: ${params.jobAddress}`,
    `Order: ${params.orderNumber}`,
    "",
    `Review delivery details here: ${params.detailsLink}`,
  ];

  if (paymentLine) {
    bodyParts.push("", "Payment", paymentLine);
  }

  if (salespersonFooter) {
    bodyParts.push("", salespersonFooter);
  }

  const escapedLink = escapeHtml(params.detailsLink);
  const htmlParts = [
    `<p>Hello ${escapeHtml(params.contactName)},</p>`,
    `<p>Your ${escapeHtml(deliveryDescription)} for <strong>${escapeHtml(params.jobName)}</strong> is scheduled for <strong>${escapeHtml(deliveryDate)}</strong>.</p>`,
    `<p><strong>Job address:</strong> ${escapeHtml(params.jobAddress)}</p>`,
    `<p><strong>Order:</strong> ${escapeHtml(params.orderNumber)}</p>`,
    `<p><a href="${escapedLink}" style="display:inline-block;background:#18181b;color:#ffffff;padding:10px 14px;border-radius:6px;text-decoration:none;">View Delivery Details</a></p>`,
  ];

  if (paymentLine) {
    htmlParts.push(
      `<h2 style="font-size:18px;margin:24px 0 8px;">Payment</h2>`,
      `<p><strong>${escapeHtml(paymentDueText(params.amountDueNowRounded))}</strong></p>`
    );
  }

  if (salespersonFooter) {
    htmlParts.push(`<p style="margin-top:24px;color:#334155;">${escapeHtml(salespersonFooter)}</p>`);
  }

  return {
    subject,
    body: bodyParts.join("\n"),
    htmlBody: htmlParts.join("\n"),
  };
}
