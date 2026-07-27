import { NotificationIntervalType } from "@/lib/generated/prisma/client";
import {
  createConfirmedDeliveryReminderEvents,
  DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON,
  requestedOnForConfirmedDeliveryReminderTargetDate,
  normalize30DayConfirmVia,
  type Create30DayDeliveryReminderEventsOptions,
  type Create30DayDeliveryReminderEventsSummary,
} from "@/lib/notifications/create30DayDeliveryReminderEvents";

export const DELIVERY_REMINDER_14_DAY_INTERVAL_DAYS = 14;
export const DELIVERY_REMINDER_14_DAY_NOT_CONFIRMED_REASON =
  DELIVERY_REMINDER_30_DAY_NOT_CONFIRMED_REASON;

export type Create14DayDeliveryReminderEventsOptions =
  Create30DayDeliveryReminderEventsOptions;
export type Create14DayDeliveryReminderEventsSummary =
  Create30DayDeliveryReminderEventsSummary;

export const normalize14DayConfirmVia = normalize30DayConfirmVia;
export const requestedOnFor14DayTargetDate =
  requestedOnForConfirmedDeliveryReminderTargetDate;

export async function create14DayDeliveryReminderEvents(
  options: Create14DayDeliveryReminderEventsOptions = {}
): Promise<Create14DayDeliveryReminderEventsSummary> {
  return createConfirmedDeliveryReminderEvents({
    ...options,
    intervalType: NotificationIntervalType.DAY_14,
    intervalDays: DELIVERY_REMINDER_14_DAY_INTERVAL_DAYS,
  });
}
