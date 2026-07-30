CREATE TABLE "order_delivery_group_lines" (
    "id" TEXT NOT NULL,
    "orderDeliveryGroupId" TEXT NOT NULL,
    "orderLineId" TEXT,
    "orderId" TEXT NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "lineNbr" INTEGER NOT NULL,
    "inventoryId" VARCHAR(128),
    "deliveryDate" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedReason" VARCHAR(256),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_delivery_group_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_delivery_group_lines_orderDeliveryGroupId_orderLineId_key"
ON "order_delivery_group_lines"("orderDeliveryGroupId", "orderLineId");

CREATE INDEX "order_delivery_group_lines_orderDeliveryGroupId_isActive_idx"
ON "order_delivery_group_lines"("orderDeliveryGroupId", "isActive");

CREATE INDEX "order_delivery_group_lines_orderLineId_idx"
ON "order_delivery_group_lines"("orderLineId");

CREATE INDEX "order_delivery_group_lines_orderId_deliveryDate_idx"
ON "order_delivery_group_lines"("orderId", "deliveryDate");

CREATE INDEX "order_delivery_group_lines_orderType_orderNumber_lineNbr_idx"
ON "order_delivery_group_lines"("orderType", "orderNumber", "lineNbr");

CREATE INDEX "order_delivery_group_lines_isActive_deliveryDate_idx"
ON "order_delivery_group_lines"("isActive", "deliveryDate");

ALTER TABLE "order_delivery_group_lines"
ADD CONSTRAINT "order_delivery_group_lines_orderDeliveryGroupId_fkey"
FOREIGN KEY ("orderDeliveryGroupId") REFERENCES "order_delivery_groups"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_delivery_group_lines"
ADD CONSTRAINT "order_delivery_group_lines_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "orders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_delivery_group_lines"
ADD CONSTRAINT "order_delivery_group_lines_orderLineId_fkey"
FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
