import { addDays, dateFromKey, dateKey, formatCustomerFriendlyDate } from "@/lib/notifications/helpers";

export const PAYMENT_DEADLINE_INTERVAL_DAYS = 8;

export function getPaymentDeadlineDate(deliveryDate: Date | string) {
  const rawDeadline = addDays(deliveryDate, -PAYMENT_DEADLINE_INTERVAL_DAYS);
  const day = dateFromKey(rawDeadline).getUTCDay();

  if (day === 6) return dateKey(addDays(rawDeadline, -1));
  if (day === 0) return dateKey(addDays(rawDeadline, -2));

  return dateKey(rawDeadline);
}

export function formatPaymentDeadlineDate(deliveryDate: Date | string) {
  return formatCustomerFriendlyDate(getPaymentDeadlineDate(deliveryDate));
}
