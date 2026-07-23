import type { OrderLineReadinessSummary } from "@/lib/delivery-readiness/orderLineReadiness";
import {
  cleanNotificationText,
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

function quantity(value: number | string | { toString(): string } | null | undefined) {
  if (value === null || value === undefined) return "";
  const numeric = Number(value.toString());
  if (!Number.isFinite(numeric)) return value.toString();
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
}

function paymentDueText(amountDueNowRounded?: string | null) {
  return `Balance owed prior to scheduling Delivery: ${formatCurrencyAmount(amountDueNowRounded)}`;
}

function itemTextLines(lines: OrderLineReadinessSummary[]) {
  if (lines.length === 0) return ["No item lines are currently listed for this delivery."];

  return lines.map((line) => {
    const item = cleanNotificationText(line.inventoryId) ?? "Item";
    const description = cleanNotificationText(line.lineDescription);
    const status = cleanNotificationText(line.displayStatus) ?? "Not calculated";
    const qty = quantity(line.orderQty);
    const eta = line.eta ? `, ETA ${line.eta}` : "";
    const descriptionText = description ? ` - ${description}` : "";
    const qtyText = qty ? `, qty ${qty}` : "";
    return `Line ${line.lineNbr}: ${item}${descriptionText}${qtyText}${eta}, status ${status}`;
  });
}

function itemRowsHtml(lines: OrderLineReadinessSummary[]) {
  if (lines.length === 0) {
    return `<p style="margin:0;color:#52525b;">No item lines are currently listed for this delivery.</p>`;
  }

  const rows = lines
    .map((line) => {
      const item = escapeHtml(cleanNotificationText(line.inventoryId) ?? "Item");
      const description = escapeHtml(cleanNotificationText(line.lineDescription) ?? "");
      const status = escapeHtml(cleanNotificationText(line.displayStatus) ?? "Not calculated");
      const eta = line.eta ? escapeHtml(line.eta) : "Pending";
      return `
        <tr>
          <td style="padding:8px;border-top:1px solid #e4e4e7;">${line.lineNbr}</td>
          <td style="padding:8px;border-top:1px solid #e4e4e7;">
            <strong>${item}</strong>${description ? `<br><span style="color:#52525b;">${description}</span>` : ""}
          </td>
          <td style="padding:8px;border-top:1px solid #e4e4e7;">${escapeHtml(quantity(line.orderQty))}</td>
          <td style="padding:8px;border-top:1px solid #e4e4e7;">${escapeHtml(quantity(line.openQty))}</td>
          <td style="padding:8px;border-top:1px solid #e4e4e7;">${eta}</td>
          <td style="padding:8px;border-top:1px solid #e4e4e7;">${status}</td>
        </tr>`;
    })
    .join("");

  return `
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead>
        <tr style="text-align:left;color:#52525b;">
          <th style="padding:8px;">Line</th>
          <th style="padding:8px;">Item</th>
          <th style="padding:8px;">Qty</th>
          <th style="padding:8px;">Open</th>
          <th style="padding:8px;">ETA</th>
          <th style="padding:8px;">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function render30DayDeliveryReminderSms(params: Render30DayDeliveryReminderParams) {
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);

  if (params.paymentDue) {
    return `MLD: Your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}. Payment may be needed before delivery. Please review details here: ${params.detailsLink}. Reply STOP to opt out.`;
  }

  return `MLD: Your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}. Review delivery details here: ${params.detailsLink}. Reply STOP to opt out.`;
}

export function render30DayDeliveryReminderEmail(params: Render30DayDeliveryReminderParams) {
  const subject = renderDeliveryReminderEmailSubject({
    buyerGroup: params.buyerGroup,
    jobName: params.jobName,
    deliveryDate: params.deliveryDate,
  });
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const lines = params.lines ?? [];
  const salespersonFooter = renderSalespersonEmailFooterText(params.salespersonContact);
  const paymentLine = params.paymentDue ? paymentDueText(params.amountDueNowRounded) : null;

  const bodyParts = [
    `Hello ${params.contactName},`,
    "",
    `Your ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}.`,
    `Job address: ${params.jobAddress}`,
    "",
    `Review delivery details here: ${params.detailsLink}`,
    "",
    "Items For This Delivery",
    ...itemTextLines(lines),
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
    `<p><a href="${escapedLink}" style="display:inline-block;background:#18181b;color:#ffffff;padding:10px 14px;border-radius:6px;text-decoration:none;">View Delivery Details</a></p>`,
    `<h2 style="font-size:18px;margin:24px 0 8px;">Items For This Delivery</h2>`,
    itemRowsHtml(lines),
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
