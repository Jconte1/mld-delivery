import { NotificationIntervalType } from "@/lib/generated/prisma/client";
import {
  createDeliveryReminderEvents,
  type CreateDeliveryReminderEventsSummary,
} from "@/lib/notifications/createDeliveryReminderEvents";

const INTERVAL_DAYS = 90;

export type Create90DayDeliveryReminderEventsSummary = CreateDeliveryReminderEventsSummary;

export type Create90DayDeliveryReminderEventsOptions = {
  runDate?: Date | string;
  dryRun?: boolean;
};

export async function create90DayDeliveryReminderEvents(
  options: Create90DayDeliveryReminderEventsOptions = {}
): Promise<Create90DayDeliveryReminderEventsSummary> {
  return createDeliveryReminderEvents({
    runDate: options.runDate,
    dryRun: options.dryRun,
    intervalType: NotificationIntervalType.DAY_90,
    intervalDays: INTERVAL_DAYS,
  });
}
