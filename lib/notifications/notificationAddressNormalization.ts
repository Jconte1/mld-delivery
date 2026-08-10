export function normalizeSmsPhoneForOptOut(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  const digits = String(value).trim().replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }

  return digits;
}

export function normalizeEmailForOptOut(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}
