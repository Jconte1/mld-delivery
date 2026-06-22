-- CreateTable
CREATE TABLE "erp_change_events" (
    "id" TEXT NOT NULL,
    "changeType" VARCHAR(64) NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(128),
    "entityKey" VARCHAR(256) NOT NULL,
    "fieldName" VARCHAR(128),
    "orderId" VARCHAR(128),
    "orderType" VARCHAR(16),
    "orderNumber" VARCHAR(64),
    "orderLineId" VARCHAR(128),
    "orderDeliveryGroupId" VARCHAR(128),
    "orderLineAllocationId" VARCHAR(128),
    "lineNbr" INTEGER,
    "splitLineNbr" INTEGER,
    "deliveryDate" DATE,
    "oldValue" JSONB,
    "newValue" JSONB,
    "summary" VARCHAR(1024),
    "severity" VARCHAR(32),
    "changeKey" VARCHAR(512) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'detected',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "ignoredAt" TIMESTAMP(3),
    "source" VARCHAR(64) DEFAULT 'acumatica',
    "importRunId" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erp_change_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "erp_change_events_changeKey_key" ON "erp_change_events"("changeKey");

-- CreateIndex
CREATE INDEX "erp_change_events_changeType_idx" ON "erp_change_events"("changeType");

-- CreateIndex
CREATE INDEX "erp_change_events_entityType_idx" ON "erp_change_events"("entityType");

-- CreateIndex
CREATE INDEX "erp_change_events_entityKey_idx" ON "erp_change_events"("entityKey");

-- CreateIndex
CREATE INDEX "erp_change_events_orderId_idx" ON "erp_change_events"("orderId");

-- CreateIndex
CREATE INDEX "erp_change_events_orderNumber_idx" ON "erp_change_events"("orderNumber");

-- CreateIndex
CREATE INDEX "erp_change_events_orderType_orderNumber_idx" ON "erp_change_events"("orderType", "orderNumber");

-- CreateIndex
CREATE INDEX "erp_change_events_orderLineId_idx" ON "erp_change_events"("orderLineId");

-- CreateIndex
CREATE INDEX "erp_change_events_orderDeliveryGroupId_idx" ON "erp_change_events"("orderDeliveryGroupId");

-- CreateIndex
CREATE INDEX "erp_change_events_orderLineAllocationId_idx" ON "erp_change_events"("orderLineAllocationId");

-- CreateIndex
CREATE INDEX "erp_change_events_status_idx" ON "erp_change_events"("status");

-- CreateIndex
CREATE INDEX "erp_change_events_detectedAt_idx" ON "erp_change_events"("detectedAt");

-- CreateIndex
CREATE INDEX "erp_change_events_importRunId_idx" ON "erp_change_events"("importRunId");
