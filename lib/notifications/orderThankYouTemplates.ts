import { getSalespersonContactDisplay, appendSalespersonSmsContact, renderSalespersonContactText, type SalespersonContactInput } from "./salespersonContactDisplay";
import { formatJobName, formatOrderGroup } from "./helpers";

const BRAND_COLOR = "#111827";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatThankYouDate(value: Date | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(value);
}

function emailShell(params: { title: string; preheader: string; content: string; cta?: string; contactText?: string }) {
  const logoBase = (process.env.DELIVERY_APP_BASE_URL || "https://mld.com/delivery").replace(/\/+$/, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:${BRAND_COLOR}"><span style="display:none;max-height:0;overflow:hidden">${escapeHtml(params.preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #e5e7eb"><tr><td style="padding:24px 28px;border-bottom:1px solid #e5e7eb;text-align:center"><img src="${logoBase}/brand/MLD-logo-gold.png" alt="MLD" style="height:32px"></td></tr><tr><td style="padding:28px"><h1 style="font-size:22px;margin:0 0 16px">${escapeHtml(params.title)}</h1>${params.content}${params.cta ?? ""}<p style="font-size:12px;color:#6b7280;margin:24px 0 0">${escapeHtml(params.contactText ?? "If you have questions, please contact your salesperson.")}</p></td></tr><tr><td style="padding:18px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">This is an automated message from MLD.</td></tr></table></td></tr></table></body></html>`;
}

export function renderDeliveryThankYou(params: {
  orderNumber: string;
  orderType?: string | null;
  buyerGroup?: string | null;
  customerName?: string | null;
  locationName?: string | null;
  requestedDeliveryDate: Date | null;
  salespersonContact?: SalespersonContactInput | null;
}) {
  const date = formatThankYouDate(params.requestedDeliveryDate);
  const orderType = String(params.orderType || "").trim().toUpperCase();
  const category = formatOrderGroup(params.buyerGroup, orderType);
  const jobName = params.customerName?.trim() || params.locationName?.trim()
    ? formatJobName({ customerDescription: params.customerName, locationDescription: params.locationName }) : null;
  const orderDescription = `${category ? `${category} order` : "order"} #${params.orderNumber}${jobName ? ` for ${jobName}` : ""}`;
  const nextStep = "We will send reminders as your delivery approaches.";
  const salesperson = getSalespersonContactDisplay(params.salespersonContact);
  const contactText = salesperson
    ? `If you have questions, please contact ${salesperson.targetText}.`
    : "If you have questions, please contact your salesperson.";
  const dateLine = date ? `\n\nCurrent requested delivery date: ${date}.` : "";
  const text = `MLD: Thank you for your purchase!\n\nYour ${orderDescription} has been received.${dateLine}\n\n${nextStep}\n\nReply STOP to opt out.`;
  const dateHtml = date
    ? `<p style="font-size:14px"><strong>Current requested delivery date</strong><br>${escapeHtml(date)}</p>`
    : "";
  return {
    subject: `MLD | ${category ? `${category} ` : ""}Order ${params.orderNumber} | Thank you for your purchase!`,
    textBody: appendSalespersonSmsContact(text, renderSalespersonContactText(params.salespersonContact)),
    emailTextBody: ["Thank you for your purchase!", "", `We have received your ${orderDescription}.`, "",
      ...(date ? ["Current requested delivery date", date, ""] : []),
      "What happens next", nextStep, "", contactText, "", "This is an automated message from MLD."].join("\n"),
    htmlBody: emailShell({
      title: "Thank you for your purchase!",
      preheader: `Order ${params.orderNumber} has been received.`,
      contactText,
      content: `<p style="font-size:15px;line-height:1.6">We have received your ${escapeHtml(orderDescription)}.</p>${dateHtml}<h2 style="font-size:16px;margin:22px 0 8px">What happens next</h2><p style="font-size:15px;line-height:1.6">${escapeHtml(nextStep)}</p>`,
    }),
  };
}

export function renderWillCallThankYou(params: {
  orderNumber: string;
  orderType?: string | null;
  buyerGroup?: string | null;
  customerName?: string | null;
  locationName?: string | null;
  salespersonContact?: SalespersonContactInput | null;
}) {
  const orderType = String(params.orderType || "").trim().toUpperCase();
  const orderGroup = formatOrderGroup(params.buyerGroup, orderType) || "Order";
  const customer = String(params.customerName || "Customer").trim();
  const location = String(params.locationName || "").trim();
  const includeLocation = location && !["MAIN", "PRIMARY LOCATION"].includes(location.toUpperCase());
  const orderDescription = `${orderGroup} order #${params.orderNumber} for ${customer}${includeLocation ? ` / ${location}` : ""}`;
  const nextStep = "We will let you know when your order is ready for pickup.";
  const text = `MLD: Thank you for your purchase!\n\nYour ${orderDescription} has been received.\n\n${nextStep}\n\nReply STOP to opt out.`;
  const subject = [orderGroup, params.orderNumber, customer, includeLocation ? location : null]
    .filter(Boolean)
    .join(" | ");
  return {
    subject,
    textBody: appendSalespersonSmsContact(text, renderSalespersonContactText(params.salespersonContact)),
    emailTextBody: ["Thank you for your purchase!", "", `Your ${orderDescription} has been received.`, "", nextStep, "",
      renderSalespersonContactText(params.salespersonContact), "", "This is an automated message from MLD."].join("\n"),
    htmlBody: emailShell({
      title: "Thank you for your purchase!",
      preheader: `Order ${params.orderNumber} has been received.`,
      contactText: renderSalespersonContactText(params.salespersonContact),
      content: `<p style="font-size:15px;line-height:1.6">Your ${escapeHtml(orderDescription)} has been received.</p><p style="font-size:15px;line-height:1.6">${nextStep}</p>`,
    }),
  };
}
