import {
  cleanNotificationText,
  normalizeNotificationName,
} from "@/lib/notifications/helpers";

export type SalespersonContactInput = {
  salespersonName?: string | null;
  salespersonEmail?: string | null;
  salespersonPhone?: string | null;
  isActive?: boolean | null;
};

export type SalespersonContactDisplay = {
  name: string | null;
  email: string | null;
  phone: string | null;
  phoneHref: string | null;
  targetText: string;
  emailFooterText: string;
  webpageText: string;
};

function normalizeEmail(value: string | null | undefined) {
  return cleanNotificationText(value)?.toLowerCase() ?? null;
}

function normalizePhone(value: string | null | undefined) {
  return cleanNotificationText(value) ?? null;
}

function phoneHref(value: string | null) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  return digits ? `tel:${digits}` : null;
}

function formatPhone(value: string | null) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return value;
}

function targetText(params: { name: string | null; phone: string | null; email: string | null }) {
  const contacts = [params.phone, params.email].filter((value): value is string => Boolean(value));
  if (contacts.length === 0) return null;

  const contactText = contacts.join(" or ");
  return params.name ? `${params.name} at ${contactText}` : contactText;
}

export function getSalespersonContactDisplay(
  contact: SalespersonContactInput | null | undefined
): SalespersonContactDisplay | null {
  if (!contact || contact.isActive !== true) return null;

  const name = normalizeNotificationName(contact.salespersonName);
  const email = normalizeEmail(contact.salespersonEmail);
  const phone = formatPhone(normalizePhone(contact.salespersonPhone));
  const target = targetText({ name, phone, email });

  if (!target) return null;

  return {
    name,
    email,
    phone,
    phoneHref: phoneHref(phone),
    targetText: target,
    emailFooterText:
      `To make a payment, for additional information, or to make changes to this order, please reach out to ${target}.`,
    webpageText: `Questions or changes? Contact ${target}.`,
  };
}

export function renderSalespersonEmailFooterText(
  contact: SalespersonContactInput | null | undefined
) {
  return getSalespersonContactDisplay(contact)?.emailFooterText ?? null;
}

export function renderSalespersonWebpageContactText(
  contact: SalespersonContactInput | null | undefined
) {
  return getSalespersonContactDisplay(contact)?.webpageText ?? null;
}

export function renderSalespersonContactText(contact: SalespersonContactInput | null | undefined) {
  const display = getSalespersonContactDisplay(contact);
  return display ? `Questions? Contact ${display.targetText}.` : "Questions? Contact your MLD salesperson.";
}

export function appendSalespersonSmsContact(body: string, contactText: string) {
  const optOut = "Reply STOP to opt out.";
  const content = body.trim().endsWith(optOut) ? body.trim().slice(0, -optOut.length).trimEnd() : body.trim();
  return `${content}\n\n${contactText}\n\n${optOut}`;
}

export function renderGroupedSalespersonContactText(orders: Array<{
  orderNumber: string;
  contact: SalespersonContactInput | null | undefined;
}>) {
  const groups = new Map<string, string[]>();
  for (const order of orders) {
    const text = renderSalespersonContactText(order.contact);
    groups.set(text, [...(groups.get(text) ?? []), order.orderNumber]);
  }
  if (groups.size === 1) return groups.keys().next().value!;
  return [...groups].map(([text, numbers]) => `Order ${numbers.join(", ")}: ${text}`).join("\n");
}
