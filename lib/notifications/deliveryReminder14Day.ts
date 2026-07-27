import {
  render30DayDeliveryReminderEmail,
  render30DayDeliveryReminderSms,
  type Render30DayDeliveryReminderParams,
} from "@/lib/notifications/deliveryReminder30Day";

export type Render14DayDeliveryReminderParams = Render30DayDeliveryReminderParams;

export function render14DayDeliveryReminderSms(params: Render14DayDeliveryReminderParams) {
  return render30DayDeliveryReminderSms(params);
}

export function render14DayDeliveryReminderEmail(params: Render14DayDeliveryReminderParams) {
  return render30DayDeliveryReminderEmail(params);
}
