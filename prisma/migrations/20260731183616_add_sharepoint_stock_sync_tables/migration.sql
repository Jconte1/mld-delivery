-- CreateEnum
CREATE TYPE "SharePointStockSyncRunStatus" AS ENUM ('running', 'success', 'failed');

-- CreateTable
CREATE TABLE "sharepoint_stock_sync_runs" (
    "id" TEXT NOT NULL,
    "status" "SharePointStockSyncRunStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "workbookSiteId" VARCHAR(256),
    "workbookDriveId" VARCHAR(256),
    "workbookFileId" VARCHAR(256),
    "workbookName" VARCHAR(512),
    "workbookETag" VARCHAR(512),
    "workbookLastModifiedAt" TIMESTAMP(3),
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "itemsCreated" INTEGER NOT NULL DEFAULT 0,
    "itemsUpdated" INTEGER NOT NULL DEFAULT 0,
    "itemsDeactivated" INTEGER NOT NULL DEFAULT 0,
    "itemsSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sharepoint_stock_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_stock_items" (
    "id" TEXT NOT NULL,
    "inventoryId" VARCHAR(128) NOT NULL,
    "normalizedInventoryId" VARCHAR(128) NOT NULL,
    "source" VARCHAR(64) NOT NULL DEFAULT 'sharepoint_stock_list',
    "sourceRowNumber" INTEGER,
    "sourceWorkbookId" VARCHAR(256),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sharepoint_stock_sync_runs_status_completedAt_idx" ON "sharepoint_stock_sync_runs"("status", "completedAt");

-- CreateIndex
CREATE INDEX "external_stock_items_normalizedInventoryId_idx" ON "external_stock_items"("normalizedInventoryId");

-- CreateIndex
CREATE INDEX "external_stock_items_source_isActive_idx" ON "external_stock_items"("source", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "external_stock_items_source_normalizedInventoryId_key" ON "external_stock_items"("source", "normalizedInventoryId");

-- RenameForeignKey
ALTER TABLE "delivery_group_payment_charge_allocations" RENAME CONSTRAINT "delivery_group_payment_charge_allocations_orderDeliveryGroupId_" TO "delivery_group_payment_charge_allocations_orderDeliveryGro_fkey";

-- RenameIndex
ALTER INDEX "delivery_group_payment_charge_allocations_orderDeliveryGroupId_" RENAME TO "delivery_group_payment_charge_allocations_orderDeliveryGrou_idx";

-- RenameIndex
ALTER INDEX "delivery_group_payment_charge_allocations_orderType_orderNumber" RENAME TO "delivery_group_payment_charge_allocations_orderType_orderNu_idx";

-- RenameIndex
ALTER INDEX "delivery_group_ten_day_confirmations_acumaticaWritebackStatus_i" RENAME TO "delivery_group_ten_day_confirmations_acumaticaWritebackStat_idx";

-- RenameIndex
ALTER INDEX "delivery_group_ten_day_confirmations_localConfirmed_deliveryDat" RENAME TO "delivery_group_ten_day_confirmations_localConfirmed_deliver_idx";

-- RenameIndex
ALTER INDEX "delivery_order_hold_actions_orderDeliveryGroupId_deliveryDate_r" RENAME TO "delivery_order_hold_actions_orderDeliveryGroupId_deliveryDa_key";
