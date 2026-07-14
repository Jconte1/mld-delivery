-- CreateEnum
CREATE TYPE "DeliveryConfirmationStatus" AS ENUM ('pending', 'confirmed', 'change_requested', 'awaiting_new_date', 'new_date_requested', 'incomplete', 'unrecognized', 'expired');

-- CreateTable
CREATE TABLE "delivery_confirmations" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderDeliveryGroupId" TEXT NOT NULL,
    "notificationEventId" TEXT,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "contactId" VARCHAR(64) NOT NULL,
    "status" "DeliveryConfirmationStatus" NOT NULL DEFAULT 'pending',
    "responseChannel" "NotificationChannel",
    "rawResponse" VARCHAR(1024),
    "normalizedResponse" VARCHAR(128),
    "confirmedAt" TIMESTAMP(3),
    "changeRequestedAt" TIMESTAMP(3),
    "requestedNewDate" DATE,
    "requestedNewDateRaw" VARCHAR(64),
    "requestedNewDateAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "noResponseAt" TIMESTAMP(3),
    "linkToken" VARCHAR(128),
    "linkCreatedAt" TIMESTAMP(3),
    "linkExpiresAt" TIMESTAMP(3),
    "linkExpiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_confirmations_linkToken_key" ON "delivery_confirmations"("linkToken");

-- CreateIndex
CREATE INDEX "delivery_confirmations_orderId_idx" ON "delivery_confirmations"("orderId");

-- CreateIndex
CREATE INDEX "delivery_confirmations_orderDeliveryGroupId_idx" ON "delivery_confirmations"("orderDeliveryGroupId");

-- CreateIndex
CREATE INDEX "delivery_confirmations_notificationEventId_idx" ON "delivery_confirmations"("notificationEventId");

-- CreateIndex
CREATE INDEX "delivery_confirmations_contactId_idx" ON "delivery_confirmations"("contactId");

-- CreateIndex
CREATE INDEX "delivery_confirmations_orderType_orderNumber_idx" ON "delivery_confirmations"("orderType", "orderNumber");

-- CreateIndex
CREATE INDEX "delivery_confirmations_deliveryDate_idx" ON "delivery_confirmations"("deliveryDate");

-- CreateIndex
CREATE INDEX "delivery_confirmations_status_idx" ON "delivery_confirmations"("status");

-- CreateIndex
CREATE INDEX "delivery_confirmations_responseChannel_idx" ON "delivery_confirmations"("responseChannel");

-- CreateIndex
CREATE INDEX "delivery_confirmations_requestedNewDate_idx" ON "delivery_confirmations"("requestedNewDate");

-- CreateIndex
CREATE INDEX "delivery_confirmations_reminderSentAt_idx" ON "delivery_confirmations"("reminderSentAt");

-- CreateIndex
CREATE INDEX "delivery_confirmations_noResponseAt_idx" ON "delivery_confirmations"("noResponseAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_confirmations_orderDeliveryGroupId_deliveryDate_key" ON "delivery_confirmations"("orderDeliveryGroupId", "deliveryDate");

-- AddForeignKey
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_orderDeliveryGroupId_fkey" FOREIGN KEY ("orderDeliveryGroupId") REFERENCES "order_delivery_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_notificationEventId_fkey" FOREIGN KEY ("notificationEventId") REFERENCES "notification_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("contactId") ON DELETE RESTRICT ON UPDATE CASCADE;
