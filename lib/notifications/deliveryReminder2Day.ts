import {
  cleanNotificationText,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
} from "@/lib/notifications/helpers";
import {
  getSalespersonContactDisplay,
  type SalespersonContactInput,
} from "@/lib/notifications/salespersonContactDisplay";

export type Render2DayDeliveryReminderParams = {
  contactName: string;
  buyerGroup?: string | null;
  jobName: string;
  jobAddress: string;
  deliveryDate: Date | string;
  detailsLink: string;
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

export function render2DayDeliveryReminderEmailSubject(params: {
  buyerGroup?: string | null;
  jobName?: string | null;
  deliveryDate: Date | string;
}) {
  const buyerGroup = cleanNotificationText(params.buyerGroup);
  const jobName = cleanNotificationText(params.jobName);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);

  if (buyerGroup && jobName && jobName !== "your delivery") {
    return `Final Delivery Reminder: ${buyerGroup} delivery - ${jobName} - ${deliveryDate}`;
  }

  if (!buyerGroup && jobName && jobName !== "your delivery") {
    return `Final Delivery Reminder: ${jobName} - ${deliveryDate}`;
  }

  if (buyerGroup) {
    return `Final Delivery Reminder: ${buyerGroup} delivery - ${deliveryDate}`;
  }

  return `Final Delivery Reminder - ${deliveryDate}`;
}

export function render2DayNoPaymentSalespersonFooterText(
  contact: SalespersonContactInput | null | undefined
) {
  const display = getSalespersonContactDisplay(contact);
  if (!display) return null;

  return `For additional information or to make changes to this order, please reach out to ${display.targetText}.`;
}

export function render2DayDeliveryReminderSms(params: Render2DayDeliveryReminderParams) {
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);

  return `MLD: Final reminder - your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}. Review delivery details here: ${params.detailsLink}. Reply STOP to opt out.`;
}

export function render2DayDeliveryReminderEmail(params: Render2DayDeliveryReminderParams) {
  const subject = render2DayDeliveryReminderEmailSubject({
    buyerGroup: params.buyerGroup,
    jobName: params.jobName,
    deliveryDate: params.deliveryDate,
  });
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const salespersonFooter = render2DayNoPaymentSalespersonFooterText(
    params.salespersonContact
  );

  const bodyParts = [
    `Hello ${params.contactName},`,
    "",
    `This is your final reminder that your ${deliveryDescription} for ${params.jobName} at ${params.jobAddress} is scheduled for ${deliveryDate}.`,
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
    `<p>This is your final reminder that your ${escapeHtml(deliveryDescription)} for <strong>${escapeHtml(params.jobName)}</strong> at ${escapeHtml(params.jobAddress)} is scheduled for <strong>${escapeHtml(deliveryDate)}</strong>.</p>`,
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
