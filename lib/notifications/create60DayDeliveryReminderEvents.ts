import { NotificationIntervalType } from "@/lib/generated/prisma/client";
import {
  createDeliveryReminderEvents,
  type CreateDeliveryReminderEventsSummary,
} from "@/lib/notifications/createDeliveryReminderEvents";

const INTERVAL_DAYS = 60;

export type Create60DayDeliveryReminderEventsSummary = CreateDeliveryReminderEventsSummary;

export type Create60DayDeliveryReminderEventsOptions = {
  runDate?: Date | string;
  dryRun?: boolean;
};

export async function create60DayDeliveryReminderEvents(
  options: Create60DayDeliveryReminderEventsOptions = {}
): Promise<Create60DayDeliveryReminderEventsSummary> {
  return createDeliveryReminderEvents({
    runDate: options.runDate,
    dryRun: options.dryRun,
    intervalType: NotificationIntervalType.DAY_60,
    intervalDays: INTERVAL_DAYS,
  });
}
