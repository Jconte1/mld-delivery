-- Prevent duplicate internal escalation events for the same delivery group/date/purpose.
CREATE UNIQUE INDEX "internal_notification_events_orderDeliveryGroupId_deliveryDate_purpose_key"
ON "internal_notification_events"("orderDeliveryGroupId", "deliveryDate", "purpose");
