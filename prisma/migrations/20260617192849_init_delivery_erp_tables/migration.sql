-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "contactId" VARCHAR(64) NOT NULL,
    "status" VARCHAR(64),
    "displayName" VARCHAR(256),
    "firstName" VARCHAR(128),
    "lastName" VARCHAR(128),
    "email" VARCHAR(256),
    "phone1" VARCHAR(32),
    "phone2" VARCHAR(32),
    "smsOptIn" BOOLEAN NOT NULL DEFAULT false,
    "emailOptIn" BOOLEAN NOT NULL DEFAULT true,
    "phoneCallOptIn" BOOLEAN NOT NULL DEFAULT false,
    "preferredContactMethod" VARCHAR(32),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "shipVia" VARCHAR(64),
    "status" VARCHAR(64),
    "headerRequestedOn" DATE,
    "customerId" VARCHAR(64),
    "customerDescription" VARCHAR(256),
    "contactId" VARCHAR(64) NOT NULL,
    "locationId" VARCHAR(64),
    "locationDescription" VARCHAR(256),
    "turnInDate" DATE,
    "noteId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_totals" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "unpaidBalance" DECIMAL(18,2),
    "orderTotal" DECIMAL(18,2),
    "taxTotal" DECIMAL(18,2),
    "lineTotalAmount" DECIMAL(18,2),
    "unbilledAmount" DECIMAL(18,2),
    "unbilledQty" DECIMAL(18,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "order_totals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "requestedOn" DATE,
    "lineNbr" INTEGER NOT NULL,
    "inventoryId" VARCHAR(128),
    "lineDescription" VARCHAR(512),
    "orderQty" DECIMAL(18,4),
    "openQty" DECIMAL(18,4),
    "discountedUnitPrice" DECIMAL(18,2),
    "warehouseId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line_allocations" (
    "id" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "lineNbr" INTEGER NOT NULL,
    "splitLineNbr" INTEGER NOT NULL,
    "inventoryId" VARCHAR(128),
    "allocated" BOOLEAN NOT NULL DEFAULT false,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "qty" DECIMAL(18,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "order_line_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_addresses" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "addressLine1" VARCHAR(256),
    "addressLine2" VARCHAR(256),
    "city" VARCHAR(128),
    "country" VARCHAR(64),
    "postalCode" VARCHAR(32),
    "state" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "order_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_delivery_groups" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "status" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "order_delivery_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_events" (
    "id" TEXT NOT NULL,
    "orderDeliveryGroupId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "contactId" VARCHAR(64) NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "channel" VARCHAR(32) NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "subject" VARCHAR(256),
    "messagePreview" VARCHAR(1024),
    "lastAttemptedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failureReason" VARCHAR(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_attempts" (
    "id" TEXT NOT NULL,
    "notificationEventId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "channel" VARCHAR(32) NOT NULL,
    "provider" VARCHAR(64),
    "recipient" VARCHAR(256) NOT NULL,
    "recipientContactId" VARCHAR(64),
    "status" VARCHAR(32) NOT NULL,
    "providerMessageId" VARCHAR(256),
    "subject" VARCHAR(256),
    "messageBody" TEXT,
    "errorCode" VARCHAR(128),
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contacts_contactId_key" ON "contacts"("contactId");

-- CreateIndex
CREATE INDEX "contacts_contactId_idx" ON "contacts"("contactId");

-- CreateIndex
CREATE INDEX "contacts_email_idx" ON "contacts"("email");

-- CreateIndex
CREATE INDEX "contacts_status_idx" ON "contacts"("status");

-- CreateIndex
CREATE INDEX "orders_orderNumber_idx" ON "orders"("orderNumber");

-- CreateIndex
CREATE INDEX "orders_contactId_idx" ON "orders"("contactId");

-- CreateIndex
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");

-- CreateIndex
CREATE INDEX "orders_headerRequestedOn_idx" ON "orders"("headerRequestedOn");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderType_orderNumber_key" ON "orders"("orderType", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "order_totals_orderId_key" ON "order_totals"("orderId");

-- CreateIndex
CREATE INDEX "order_totals_orderNumber_idx" ON "order_totals"("orderNumber");

-- CreateIndex
CREATE INDEX "order_lines_orderNumber_idx" ON "order_lines"("orderNumber");

-- CreateIndex
CREATE INDEX "order_lines_orderType_orderNumber_idx" ON "order_lines"("orderType", "orderNumber");

-- CreateIndex
CREATE INDEX "order_lines_inventoryId_idx" ON "order_lines"("inventoryId");

-- CreateIndex
CREATE INDEX "order_lines_requestedOn_idx" ON "order_lines"("requestedOn");

-- CreateIndex
CREATE INDEX "order_lines_orderId_requestedOn_idx" ON "order_lines"("orderId", "requestedOn");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_orderId_lineNbr_key" ON "order_lines"("orderId", "lineNbr");

-- CreateIndex
CREATE INDEX "order_line_allocations_orderNumber_idx" ON "order_line_allocations"("orderNumber");

-- CreateIndex
CREATE INDEX "order_line_allocations_orderType_orderNumber_idx" ON "order_line_allocations"("orderType", "orderNumber");

-- CreateIndex
CREATE INDEX "order_line_allocations_inventoryId_idx" ON "order_line_allocations"("inventoryId");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_allocations_orderLineId_splitLineNbr_key" ON "order_line_allocations"("orderLineId", "splitLineNbr");

-- CreateIndex
CREATE UNIQUE INDEX "order_addresses_orderId_key" ON "order_addresses"("orderId");

-- CreateIndex
CREATE INDEX "order_delivery_groups_orderNumber_idx" ON "order_delivery_groups"("orderNumber");

-- CreateIndex
CREATE INDEX "order_delivery_groups_orderType_orderNumber_idx" ON "order_delivery_groups"("orderType", "orderNumber");

-- CreateIndex
CREATE INDEX "order_delivery_groups_deliveryDate_idx" ON "order_delivery_groups"("deliveryDate");

-- CreateIndex
CREATE INDEX "order_delivery_groups_status_idx" ON "order_delivery_groups"("status");

-- CreateIndex
CREATE UNIQUE INDEX "order_delivery_groups_orderId_deliveryDate_key" ON "order_delivery_groups"("orderId", "deliveryDate");

-- CreateIndex
CREATE INDEX "notification_events_orderDeliveryGroupId_idx" ON "notification_events"("orderDeliveryGroupId");

-- CreateIndex
CREATE INDEX "notification_events_orderId_idx" ON "notification_events"("orderId");

-- CreateIndex
CREATE INDEX "notification_events_contactId_idx" ON "notification_events"("contactId");

-- CreateIndex
CREATE INDEX "notification_events_eventType_idx" ON "notification_events"("eventType");

-- CreateIndex
CREATE INDEX "notification_events_channel_idx" ON "notification_events"("channel");

-- CreateIndex
CREATE INDEX "notification_events_scheduledFor_idx" ON "notification_events"("scheduledFor");

-- CreateIndex
CREATE INDEX "notification_events_status_idx" ON "notification_events"("status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_events_orderDeliveryGroupId_eventType_channel_key" ON "notification_events"("orderDeliveryGroupId", "eventType", "channel");

-- CreateIndex
CREATE INDEX "notification_attempts_notificationEventId_idx" ON "notification_attempts"("notificationEventId");

-- CreateIndex
CREATE INDEX "notification_attempts_channel_idx" ON "notification_attempts"("channel");

-- CreateIndex
CREATE INDEX "notification_attempts_provider_idx" ON "notification_attempts"("provider");

-- CreateIndex
CREATE INDEX "notification_attempts_recipient_idx" ON "notification_attempts"("recipient");

-- CreateIndex
CREATE INDEX "notification_attempts_recipientContactId_idx" ON "notification_attempts"("recipientContactId");

-- CreateIndex
CREATE INDEX "notification_attempts_status_idx" ON "notification_attempts"("status");

-- CreateIndex
CREATE INDEX "notification_attempts_providerMessageId_idx" ON "notification_attempts"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_attempts_notificationEventId_attemptNumber_key" ON "notification_attempts"("notificationEventId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("contactId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_totals" ADD CONSTRAINT "order_totals_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_allocations" ADD CONSTRAINT "order_line_allocations_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_addresses" ADD CONSTRAINT "order_addresses_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_delivery_groups" ADD CONSTRAINT "order_delivery_groups_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_orderDeliveryGroupId_fkey" FOREIGN KEY ("orderDeliveryGroupId") REFERENCES "order_delivery_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("contactId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_notificationEventId_fkey" FOREIGN KEY ("notificationEventId") REFERENCES "notification_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
