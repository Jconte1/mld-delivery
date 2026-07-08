-- CreateEnum
CREATE TYPE "NotificationIntervalType" AS ENUM ('DAY_180', 'DAY_90', 'DAY_60', 'DAY_42', 'DAY_30', 'DAY_14', 'DAY_12', 'DAY_10', 'DAY_8', 'DAY_2');

-- CreateEnum
CREATE TYPE "NotificationActionType" AS ENUM ('DELIVERY_REMINDER', 'DELIVERY_CONFIRMATION_REQUEST', 'PAYMENT_REQUEST', 'PAYMENT_ENFORCEMENT', 'BACKORDER_REPORT', 'INTERNAL_EMAIL', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('sms', 'email');

-- CreateEnum
CREATE TYPE "NotificationEventStatus" AS ENUM ('pending', 'scheduled', 'skipped', 'sent', 'failed', 'cancelled', 'deduped', 'already_sent');

-- CreateEnum
CREATE TYPE "InternalOrderLifecycleStatus" AS ENUM ('active', 'payment_pending', 'delivery_bumped_unpaid', 'blocked', 'manual_review', 'completed', 'cancelled');

-- DropIndex
DROP INDEX "notification_attempts_providerMessageId_idx";

-- DropIndex
DROP INDEX "notification_attempts_recipientContactId_idx";

-- DropIndex
DROP INDEX "notification_attempts_recipient_idx";

-- DropIndex
DROP INDEX "notification_attempts_status_idx";

-- DropIndex
DROP INDEX "notification_events_channel_idx";

-- DropIndex
DROP INDEX "notification_events_eventType_idx";

-- DropIndex
DROP INDEX "notification_events_orderDeliveryGroupId_eventType_channel_key";

-- DropIndex
DROP INDEX "notification_events_scheduledFor_idx";

-- AlterTable
ALTER TABLE "notification_attempts" DROP COLUMN "deliveredAt",
DROP COLUMN "errorCode",
DROP COLUMN "failedAt",
DROP COLUMN "messageBody",
DROP COLUMN "providerMessageId",
DROP COLUMN "recipient",
DROP COLUMN "recipientContactId",
DROP COLUMN "status",
DROP COLUMN "subject",
DROP COLUMN "updatedAt",
ADD COLUMN     "externalMessageId" VARCHAR(256),
ADD COLUMN     "httpStatus" INTEGER,
ADD COLUMN     "providerCode" VARCHAR(128),
ADD COLUMN     "success" BOOLEAN NOT NULL DEFAULT false,
DROP COLUMN "channel",
ADD COLUMN     "channel" "NotificationChannel" NOT NULL,
ALTER COLUMN "errorMessage" SET DATA TYPE VARCHAR(1024);

-- AlterTable
ALTER TABLE "notification_events" DROP COLUMN "cancelledAt",
DROP COLUMN "channel",
DROP COLUMN "eventType",
DROP COLUMN "failureReason",
DROP COLUMN "lastAttemptedAt",
DROP COLUMN "messagePreview",
DROP COLUMN "scheduledFor",
DROP COLUMN "skippedAt",
DROP COLUMN "subject",
ADD COLUMN     "actionType" "NotificationActionType" NOT NULL,
ADD COLUMN     "channelReason" VARCHAR(256),
ADD COLUMN     "dedupeKey" VARCHAR(512) NOT NULL,
ADD COLUMN     "deliveryDate" DATE NOT NULL,
ADD COLUMN     "externalMessageId" VARCHAR(256),
ADD COLUMN     "intervalType" "NotificationIntervalType" NOT NULL,
ADD COLUMN     "orderNumber" VARCHAR(64) NOT NULL,
ADD COLUMN     "orderType" VARCHAR(16) NOT NULL,
ADD COLUMN     "provider" VARCHAR(64),
ADD COLUMN     "reasonFailed" VARCHAR(1024),
ADD COLUMN     "reasonSkipped" VARCHAR(1024),
ADD COLUMN     "recipientEmail" VARCHAR(256),
ADD COLUMN     "recipientPhone" VARCHAR(32),
ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "selectedChannel" "NotificationChannel",
ADD COLUMN     "triggeredAt" TIMESTAMP(3),
DROP COLUMN "status",
ADD COLUMN     "status" "NotificationEventStatus" NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "buyerGroup" VARCHAR(64),
ADD COLUMN     "internalLifecycleStatus" "InternalOrderLifecycleStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "lifecycleReason" VARCHAR(1024),
ADD COLUMN     "lifecycleUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "sms_opt_outs" (
    "id" TEXT NOT NULL,
    "contactId" VARCHAR(64),
    "phone" VARCHAR(32) NOT NULL,
    "source" VARCHAR(64),
    "reason" VARCHAR(1024),
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "optedBackInAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_opt_outs" (
    "id" TEXT NOT NULL,
    "contactId" VARCHAR(64),
    "email" VARCHAR(256) NOT NULL,
    "source" VARCHAR(64),
    "reason" VARCHAR(1024),
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "optedBackInAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_opt_outs_contactId_idx" ON "sms_opt_outs"("contactId");

-- CreateIndex
CREATE INDEX "sms_opt_outs_phone_idx" ON "sms_opt_outs"("phone");

-- CreateIndex
CREATE INDEX "sms_opt_outs_isActive_idx" ON "sms_opt_outs"("isActive");

-- CreateIndex
CREATE INDEX "sms_opt_outs_phone_isActive_idx" ON "sms_opt_outs"("phone", "isActive");

-- CreateIndex
CREATE INDEX "email_opt_outs_contactId_idx" ON "email_opt_outs"("contactId");

-- CreateIndex
CREATE INDEX "email_opt_outs_email_idx" ON "email_opt_outs"("email");

-- CreateIndex
CREATE INDEX "email_opt_outs_isActive_idx" ON "email_opt_outs"("isActive");

-- CreateIndex
CREATE INDEX "email_opt_outs_email_isActive_idx" ON "email_opt_outs"("email", "isActive");

-- CreateIndex
CREATE INDEX "notification_attempts_channel_idx" ON "notification_attempts"("channel");

-- CreateIndex
CREATE INDEX "notification_attempts_success_idx" ON "notification_attempts"("success");

-- CreateIndex
CREATE INDEX "notification_attempts_externalMessageId_idx" ON "notification_attempts"("externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_events_dedupeKey_key" ON "notification_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "notification_events_orderType_orderNumber_idx" ON "notification_events"("orderType", "orderNumber");

-- CreateIndex
CREATE INDEX "notification_events_deliveryDate_idx" ON "notification_events"("deliveryDate");

-- CreateIndex
CREATE INDEX "notification_events_intervalType_idx" ON "notification_events"("intervalType");

-- CreateIndex
CREATE INDEX "notification_events_actionType_idx" ON "notification_events"("actionType");

-- CreateIndex
CREATE INDEX "notification_events_selectedChannel_idx" ON "notification_events"("selectedChannel");

-- CreateIndex
CREATE INDEX "notification_events_status_idx" ON "notification_events"("status");

-- CreateIndex
CREATE INDEX "notification_events_scheduledAt_idx" ON "notification_events"("scheduledAt");

-- CreateIndex
CREATE INDEX "notification_events_triggeredAt_idx" ON "notification_events"("triggeredAt");

-- CreateIndex
CREATE INDEX "notification_events_sentAt_idx" ON "notification_events"("sentAt");

-- CreateIndex
CREATE INDEX "orders_internalLifecycleStatus_idx" ON "orders"("internalLifecycleStatus");

-- CreateIndex
CREATE INDEX "orders_buyerGroup_idx" ON "orders"("buyerGroup");

-- AddForeignKey
ALTER TABLE "sms_opt_outs" ADD CONSTRAINT "sms_opt_outs_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("contactId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_opt_outs" ADD CONSTRAINT "email_opt_outs_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("contactId") ON DELETE SET NULL ON UPDATE CASCADE;
