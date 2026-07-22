import { cleanNotificationText, dateFromKey, dateKey } from "@/lib/notifications/helpers";

export const REQUESTED_DELIVERY_DATE_RULES = {
  WYOMING_TUESDAY_ONLY: "WYOMING_TUESDAY_ONLY",
  MCCALL_MONDAY_ONLY: "MCCALL_MONDAY_ONLY",
  STANDARD_WEEKDAY: "STANDARD_WEEKDAY",
} as const;

export const REQUESTED_DELIVERY_DATE_REASON_CODES = {
  INVALID_DATE_FORMAT: "INVALID_DATE_FORMAT",
  DATE_IN_PAST: "DATE_IN_PAST",
  SAME_AS_CURRENT_DELIVERY_DATE: "SAME_AS_CURRENT_DELIVERY_DATE",
  WEEKEND_NOT_ALLOWED: "WEEKEND_NOT_ALLOWED",
  WYOMING_TUESDAY_ONLY: "WYOMING_TUESDAY_ONLY",
  MCCALL_MONDAY_ONLY: "MCCALL_MONDAY_ONLY",
} as const;

export type RequestedDeliveryDateRuleName =
  (typeof REQUESTED_DELIVERY_DATE_RULES)[keyof typeof REQUESTED_DELIVERY_DATE_RULES];

export type RequestedDeliveryDateReasonCode =
  (typeof REQUESTED_DELIVERY_DATE_REASON_CODES)[keyof typeof REQUESTED_DELIVERY_DATE_REASON_CODES];

export type DeliveryDateEligibilityAddress = {
  state?: string | null;
  postalCode?: string | null;
};

export type RequestedDeliveryDateRule = {
  ruleName: RequestedDeliveryDateRuleName;
  allowedWeekdays: string[];
  allowedWeekdayIndexes: number[];
  routeNoteText: string | null;
  smsRouteNoteText: string | null;
};

export type RequestedDeliveryDateEligibilityResult =
  | {
      allowed: true;
      ruleName: RequestedDeliveryDateRuleName;
      allowedWeekdays: string[];
      routeNoteText: string | null;
      smsRouteNoteText: string | null;
      date: Date;
      dateKey: string;
      reason: null;
      customerMessage: null;
      webMessage: null;
    }
  | {
      allowed: false;
      ruleName: RequestedDeliveryDateRuleName;
      allowedWeekdays: string[];
      routeNoteText: string | null;
      smsRouteNoteText: string | null;
      date: Date | null;
      dateKey: string | null;
      reason: RequestedDeliveryDateReasonCode;
      customerMessage: string;
      webMessage: string;
    };

const MCCALL_ZIP_CODES = new Set(["83638", "83635"]);

const STANDARD_RULE: RequestedDeliveryDateRule = {
  ruleName: REQUESTED_DELIVERY_DATE_RULES.STANDARD_WEEKDAY,
  allowedWeekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  allowedWeekdayIndexes: [1, 2, 3, 4, 5],
  routeNoteText: null,
  smsRouteNoteText: null,
};

const WYOMING_RULE: RequestedDeliveryDateRule = {
  ruleName: REQUESTED_DELIVERY_DATE_RULES.WYOMING_TUESDAY_ONLY,
  allowedWeekdays: ["Tuesday"],
  allowedWeekdayIndexes: [2],
  routeNoteText: "Wyoming deliveries are available on Tuesdays only.",
  smsRouteNoteText: "Wyoming deliveries are available on Tuesdays only.",
};

const MCCALL_RULE: RequestedDeliveryDateRule = {
  ruleName: REQUESTED_DELIVERY_DATE_RULES.MCCALL_MONDAY_ONLY,
  allowedWeekdays: ["Monday"],
  allowedWeekdayIndexes: [1],
  routeNoteText: "McCall, Idaho deliveries are available on Mondays only.",
  smsRouteNoteText: "McCall deliveries are available on Mondays only.",
};

function normalizeState(value: string | null | undefined) {
  return cleanNotificationText(value)?.toUpperCase() ?? null;
}

function normalizePostalCode(value: string | null | undefined) {
  const cleaned = cleanNotificationText(value);
  if (!cleaned) return null;
  return cleaned.match(/\d{5}/)?.[0] ?? null;
}

function isWyomingState(value: string | null | undefined) {
  const normalized = normalizeState(value);
  return normalized === "WY" || normalized === "WYOMING";
}

function codeCustomerMessage(code: RequestedDeliveryDateReasonCode) {
  switch (code) {
    case REQUESTED_DELIVERY_DATE_REASON_CODES.WYOMING_TUESDAY_ONLY:
      return "MLD: We deliver to Wyoming on Tuesdays only. Please reply with a Tuesday delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.MCCALL_MONDAY_ONLY:
      return "MLD: We deliver to McCall, Idaho on Mondays only. Please reply with a Monday delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.WEEKEND_NOT_ALLOWED:
      return "MLD: That date falls on a weekend. Please reply with a weekday delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.DATE_IN_PAST:
      return "MLD: That date has already passed. Please reply with a future delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.SAME_AS_CURRENT_DELIVERY_DATE:
      return "MLD: That is already your current scheduled delivery date. Please reply Y to confirm or send a different allowed delivery date in MM/DD/YYYY format. Reply STOP to opt out.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.INVALID_DATE_FORMAT:
      return "MLD: Please send the date as MM/DD/YYYY, for example 08/31/2026. Reply STOP to opt out.";
  }
}

function codeWebMessage(code: RequestedDeliveryDateReasonCode) {
  switch (code) {
    case REQUESTED_DELIVERY_DATE_REASON_CODES.WYOMING_TUESDAY_ONLY:
      return "Wyoming deliveries are available on Tuesdays only. Please choose a Tuesday delivery date.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.MCCALL_MONDAY_ONLY:
      return "McCall, Idaho deliveries are available on Mondays only. Please choose a Monday delivery date.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.WEEKEND_NOT_ALLOWED:
      return "That date falls on a weekend. Please choose a weekday delivery date.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.DATE_IN_PAST:
      return "That date has already passed. Please choose a future delivery date.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.SAME_AS_CURRENT_DELIVERY_DATE:
      return "That is already your current scheduled delivery date. Please choose a different allowed delivery date.";
    case REQUESTED_DELIVERY_DATE_REASON_CODES.INVALID_DATE_FORMAT:
      return "Please choose a valid requested delivery date.";
  }
}

function invalidResult(
  rule: RequestedDeliveryDateRule,
  reason: RequestedDeliveryDateReasonCode,
  date: Date | null = null
): RequestedDeliveryDateEligibilityResult {
  return {
    allowed: false,
    ruleName: rule.ruleName,
    allowedWeekdays: rule.allowedWeekdays,
    routeNoteText: rule.routeNoteText,
    smsRouteNoteText: rule.smsRouteNoteText,
    date,
    dateKey: date ? dateKey(date) : null,
    reason,
    customerMessage: codeCustomerMessage(reason),
    webMessage: codeWebMessage(reason),
  };
}

export function determineRequestedDeliveryDateRule(
  address: DeliveryDateEligibilityAddress | null | undefined
): RequestedDeliveryDateRule {
  const postalCode = normalizePostalCode(address?.postalCode);
  if (postalCode && MCCALL_ZIP_CODES.has(postalCode)) return MCCALL_RULE;
  if (isWyomingState(address?.state)) return WYOMING_RULE;
  return STANDARD_RULE;
}

export function getRequestedDeliveryDateRouteNote(
  address: DeliveryDateEligibilityAddress | null | undefined,
  variant: "web" | "sms" = "web"
) {
  const rule = determineRequestedDeliveryDateRule(address);
  return variant === "sms" ? rule.smsRouteNoteText : rule.routeNoteText;
}

export function getRequestedDeliveryDateWebInstruction(
  address: DeliveryDateEligibilityAddress | null | undefined
) {
  return getRequestedDeliveryDateRouteNote(address, "web") ?? "Please choose a weekday delivery date.";
}

export function getRequestedDeliveryDateWebMessageForCode(
  code: string | null | undefined
) {
  const known = Object.values(REQUESTED_DELIVERY_DATE_REASON_CODES).find((value) => value === code);
  return known ? codeWebMessage(known) : null;
}

export function parseMmDdYyyyDate(value: string | null | undefined) {
  const rawValue = value ?? "";
  const trimmed = cleanNotificationText(value) ?? "";
  const match = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return { valid: false as const, rawValue, date: null };

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { valid: false as const, rawValue, date: null };
  }

  return { valid: true as const, rawValue, date };
}

export function parseDateInputValue(value: string | null | undefined) {
  const rawValue = value ?? "";
  const trimmed = cleanNotificationText(value) ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { valid: false as const, rawValue, date: null };
  }

  try {
    return { valid: true as const, rawValue, date: dateFromKey(trimmed) };
  } catch {
    return { valid: false as const, rawValue, date: null };
  }
}

export function validateRequestedDeliveryDateEligibility(params: {
  requestedDate: Date | string | null;
  currentDeliveryDate: Date | string;
  address?: DeliveryDateEligibilityAddress | null;
  now?: Date;
}): RequestedDeliveryDateEligibilityResult {
  const rule = determineRequestedDeliveryDateRule(params.address);
  let requestedDate: Date;
  try {
    if (!params.requestedDate) {
      return invalidResult(rule, REQUESTED_DELIVERY_DATE_REASON_CODES.INVALID_DATE_FORMAT);
    }
    requestedDate = dateFromKey(params.requestedDate);
  } catch {
    return invalidResult(rule, REQUESTED_DELIVERY_DATE_REASON_CODES.INVALID_DATE_FORMAT);
  }

  if (dateKey(requestedDate) === dateKey(params.currentDeliveryDate)) {
    return invalidResult(
      rule,
      REQUESTED_DELIVERY_DATE_REASON_CODES.SAME_AS_CURRENT_DELIVERY_DATE,
      requestedDate
    );
  }

  const today = dateFromKey(dateKey(params.now ?? new Date()));
  if (requestedDate.getTime() <= today.getTime()) {
    return invalidResult(rule, REQUESTED_DELIVERY_DATE_REASON_CODES.DATE_IN_PAST, requestedDate);
  }

  const weekday = requestedDate.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return invalidResult(
      rule,
      REQUESTED_DELIVERY_DATE_REASON_CODES.WEEKEND_NOT_ALLOWED,
      requestedDate
    );
  }

  if (!rule.allowedWeekdayIndexes.includes(weekday)) {
    const routeReason =
      rule.ruleName === REQUESTED_DELIVERY_DATE_RULES.MCCALL_MONDAY_ONLY
        ? REQUESTED_DELIVERY_DATE_REASON_CODES.MCCALL_MONDAY_ONLY
        : REQUESTED_DELIVERY_DATE_REASON_CODES.WYOMING_TUESDAY_ONLY;
    return invalidResult(rule, routeReason, requestedDate);
  }

  return {
    allowed: true,
    ruleName: rule.ruleName,
    allowedWeekdays: rule.allowedWeekdays,
    routeNoteText: rule.routeNoteText,
    smsRouteNoteText: rule.smsRouteNoteText,
    date: requestedDate,
    dateKey: dateKey(requestedDate),
    reason: null,
    customerMessage: null,
    webMessage: null,
  };
}
