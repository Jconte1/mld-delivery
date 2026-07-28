CREATE TYPE "DeliveryOrderHoldActionStatus" AS ENUM ('PENDING', 'QUEUED', 'SUCCEEDED', 'FAILED', 'SKIPPED');

CREATE TYPE "DeliveryOrderHoldActionReason" AS ENUM ('PAYMENT_NOT_RECEIVED_BY_DEADLINE');

CREATE TYPE "InternalNotificationAudienceType" AS ENUM ('SALESPERSON', 'FALLBACK', 'INTERNAL');

CREATE TYPE "InternalNotificationStatus" AS ENUM ('PENDING', 'SCHEDULED', 'SENT', 'FAILED', 'SKIPPED');

CREATE TYPE "InternalNotificationPurpose" AS ENUM ('PAYMENT_ENFORCEMENT_HOLD_SUCCEEDED', 'PAYMENT_ENFORCEMENT_HOLD_FAILED');

CREATE TABLE "delivery_order_hold_actions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderDeliveryGroupId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "customerId" VARCHAR(64),
    "customerDescription" VARCHAR(256),
    "salespersonNumber" VARCHAR(16),
    "amountDueAtTrigger" DECIMAL(18,2) NOT NULL,
    "paymentDeadline" DATE NOT NULL,
    "reason" "DeliveryOrderHoldActionReason" NOT NULL,
    "status" "DeliveryOrderHoldActionStatus" NOT NULL DEFAULT 'PENDING',
    "queueJobId" VARCHAR(64),
    "errorMessage" VARCHAR(2048),
    "acumaticaResponseSummary" JSONB,
    "customerNotificationEventId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_order_hold_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "internal_notification_events" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "orderDeliveryGroupId" TEXT,
    "deliveryOrderHoldActionId" TEXT,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "purpose" "InternalNotificationPurpose" NOT NULL,
    "audienceType" "InternalNotificationAudienceType" NOT NULL,
    "recipientEmail" VARCHAR(256),
    "recipientName" VARCHAR(128),
    "subject" VARCHAR(512),
    "bodyPreview" VARCHAR(2048),
    "messageSummary" VARCHAR(1024),
    "status" "InternalNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "reasonSkipped" VARCHAR(1024),
    "reasonFailed" VARCHAR(1024),
    "providerName" VARCHAR(64),
    "providerMessageId" VARCHAR(256),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_notification_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_order_hold_actions_orderDeliveryGroupId_deliveryDate_reason_key" ON "delivery_order_hold_actions"("orderDeliveryGroupId", "deliveryDate", "reason");
CREATE INDEX "delivery_order_hold_actions_status_idx" ON "delivery_order_hold_actions"("status");
CREATE INDEX "delivery_order_hold_actions_deliveryDate_idx" ON "delivery_order_hold_actions"("deliveryDate");
CREATE INDEX "delivery_order_hold_actions_orderType_orderNumber_idx" ON "delivery_order_hold_actions"("orderType", "orderNumber");
CREATE INDEX "delivery_order_hold_actions_queueJobId_idx" ON "delivery_order_hold_actions"("queueJobId");
CREATE INDEX "delivery_order_hold_actions_customerNotificationEventId_idx" ON "delivery_order_hold_actions"("customerNotificationEventId");

CREATE INDEX "internal_notification_events_orderId_idx" ON "internal_notification_events"("orderId");
CREATE INDEX "internal_notification_events_orderDeliveryGroupId_idx" ON "internal_notification_events"("orderDeliveryGroupId");
CREATE INDEX "internal_notification_events_deliveryOrderHoldActionId_idx" ON "internal_notification_events"("deliveryOrderHoldActionId");
CREATE INDEX "internal_notification_events_orderType_orderNumber_idx" ON "internal_notification_events"("orderType", "orderNumber");
CREATE INDEX "internal_notification_events_deliveryDate_idx" ON "internal_notification_events"("deliveryDate");
CREATE INDEX "internal_notification_events_purpose_idx" ON "internal_notification_events"("purpose");
CREATE INDEX "internal_notification_events_audienceType_idx" ON "internal_notification_events"("audienceType");
CREATE INDEX "internal_notification_events_status_idx" ON "internal_notification_events"("status");
CREATE INDEX "internal_notification_events_recipientEmail_idx" ON "internal_notification_events"("recipientEmail");
CREATE INDEX "internal_notification_events_sentAt_idx" ON "internal_notification_events"("sentAt");

ALTER TABLE "delivery_order_hold_actions"
ADD CONSTRAINT "delivery_order_hold_actions_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "orders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_order_hold_actions"
ADD CONSTRAINT "delivery_order_hold_actions_orderDeliveryGroupId_fkey"
FOREIGN KEY ("orderDeliveryGroupId") REFERENCES "order_delivery_groups"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_order_hold_actions"
ADD CONSTRAINT "delivery_order_hold_actions_customerNotificationEventId_fkey"
FOREIGN KEY ("customerNotificationEventId") REFERENCES "notification_events"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "internal_notification_events"
ADD CONSTRAINT "internal_notification_events_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "orders"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "internal_notification_events"
ADD CONSTRAINT "internal_notification_events_orderDeliveryGroupId_fkey"
FOREIGN KEY ("orderDeliveryGroupId") REFERENCES "order_delivery_groups"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "internal_notification_events"
ADD CONSTRAINT "internal_notification_events_deliveryOrderHoldActionId_fkey"
FOREIGN KEY ("deliveryOrderHoldActionId") REFERENCES "delivery_order_hold_actions"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
