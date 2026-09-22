import { addDays, dateKey, formatCustomerFriendlyDate } from "@/lib/notifications/helpers";

export const PAYMENT_DEADLINE_INTERVAL_DAYS = 8;

export function getPaymentDeadlineDate(deliveryDate: Date | string) {
  return dateKey(addDays(deliveryDate, -PAYMENT_DEADLINE_INTERVAL_DAYS));
}

export function formatPaymentDeadlineDate(deliveryDate: Date | string) {
  return formatCustomerFriendlyDate(getPaymentDeadlineDate(deliveryDate));
}
