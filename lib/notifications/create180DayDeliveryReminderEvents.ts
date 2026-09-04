import { NotificationIntervalType } from "@/lib/generated/prisma/client";
import {
  createDeliveryReminderEvents,
  type CreateDeliveryReminderEventsSummary,
} from "@/lib/notifications/createDeliveryReminderEvents";
import type { DeliveryOrderScope } from "@/lib/notifications/orderScope";

const INTERVAL_DAYS = 180;

export type Create180DayDeliveryReminderEventsSummary = CreateDeliveryReminderEventsSummary;

export type Create180DayDeliveryReminderEventsOptions = {
  runDate?: Date | string;
  dryRun?: boolean;
  orderScope?: DeliveryOrderScope | null;
};

export async function create180DayDeliveryReminderEvents(
  options: Create180DayDeliveryReminderEventsOptions = {}
): Promise<Create180DayDeliveryReminderEventsSummary> {
  return createDeliveryReminderEvents({
    runDate: options.runDate,
    dryRun: options.dryRun,
    intervalType: NotificationIntervalType.DAY_180,
    intervalDays: INTERVAL_DAYS,
    orderScope: options.orderScope,
  });
}
