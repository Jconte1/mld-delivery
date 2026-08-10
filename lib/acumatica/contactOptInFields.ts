export const DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS =
  "Contact.AttributeCONTEXT,Contact.AttributeCONPHONE,Contact.AttributeCONEMAIL";

export const CONTACT_SMS_OPT_IN_FIELD_PATH = [
  "custom",
  "Contact",
  "AttributeCONTEXT",
] as const;

export const CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH = [
  "custom",
  "Contact",
  "AttributeCONPHONE",
] as const;

export const CONTACT_EMAIL_OPT_IN_FIELD_PATH = [
  "custom",
  "Contact",
  "AttributeCONEMAIL",
] as const;

const TRUE_VALUES = new Set(["1", "true", "t", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "f", "no", "n", "off"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unwrapAcumaticaValue(value: unknown) {
  if (isRecord(value) && "value" in value) {
    return value.value ?? null;
  }
  return value ?? null;
}

export function getAcumaticaNestedField(record: unknown, path: readonly string[]) {
  let current = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function parseAcumaticaBoolean(value: unknown): boolean | null {
  const unwrapped = unwrapAcumaticaValue(value);
  if (typeof unwrapped === "boolean") return unwrapped;

  if (typeof unwrapped === "number") {
    if (unwrapped === 1) return true;
    if (unwrapped === 0) return false;
    return null;
  }

  if (typeof unwrapped !== "string") return null;

  const normalized = unwrapped.trim().toLowerCase();
  if (!normalized) return null;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

export function getAcumaticaCustomBoolean(record: unknown, path: readonly string[]) {
  return parseAcumaticaBoolean(getAcumaticaNestedField(record, path));
}

export function mapAcumaticaContactOptIns(contact: unknown) {
  const emailOptIn = getAcumaticaCustomBoolean(contact, CONTACT_EMAIL_OPT_IN_FIELD_PATH);

  return {
    smsOptIn: getAcumaticaCustomBoolean(contact, CONTACT_SMS_OPT_IN_FIELD_PATH) === true,
    emailOptIn: emailOptIn === true,
    phoneCallOptIn:
      getAcumaticaCustomBoolean(contact, CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH) === true,
  };
}
