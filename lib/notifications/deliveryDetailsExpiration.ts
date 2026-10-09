import { dateKey } from "./helpers";

const denverDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit",
});

// Delivery dates are date-only values. Compare calendar dates in Denver rather
// than adding 720 hours, which would shift midnight across DST transitions.
export function deliveryDetailsExpired(
  deliveryDate: Date | string,
  expiresAt: Date | null = null,
  now = new Date(),
) {
  const key = dateKey(deliveryDate);
  const deadline = new Date(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(+deadline) || deadline.toISOString().slice(0, 10) !== key ||
      !Number.isFinite(+now) || (expiresAt && !Number.isFinite(+expiresAt))) return true;
  deadline.setUTCDate(deadline.getUTCDate() + 30);
  const parts = denverDate.formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return today >= deadline.toISOString().slice(0, 10) || Boolean(expiresAt && now >= expiresAt);
}
