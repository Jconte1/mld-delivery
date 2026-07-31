-- Track one-time freight/delivery non-stock charges included in delivery-group
-- payment basis calculations.
CREATE TABLE "delivery_group_payment_charge_allocations" (
  "id" TEXT NOT NULL,
  "orderDeliveryGroupId" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderType" VARCHAR(16) NOT NULL,
  "orderNumber" VARCHAR(64) NOT NULL,
  "deliveryDate" DATE NOT NULL,
  "lineNbr" INTEGER NOT NULL,
  "inventoryId" VARCHAR(128),
  "lineDescription" VARCHAR(512),
  "chargeType" VARCHAR(64) NOT NULL,
  "amountIncluded" DECIMAL(18,2) NOT NULL,
  "sourceInterval" "NotificationIntervalType" NOT NULL,
  "includedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "delivery_group_payment_charge_allocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_group_payment_charge_allocations_orderLineId_key"
ON "delivery_group_payment_charge_allocations"("orderLineId");

CREATE INDEX "delivery_group_payment_charge_allocations_orderDeliveryGroupId_idx"
ON "delivery_group_payment_charge_allocations"("orderDeliveryGroupId");

CREATE INDEX "delivery_group_payment_charge_allocations_orderId_idx"
ON "delivery_group_payment_charge_allocations"("orderId");

CREATE INDEX "delivery_group_payment_charge_allocations_orderType_orderNumber_idx"
ON "delivery_group_payment_charge_allocations"("orderType", "orderNumber");

CREATE INDEX "delivery_group_payment_charge_allocations_sourceInterval_idx"
ON "delivery_group_payment_charge_allocations"("sourceInterval");

CREATE INDEX "delivery_group_payment_charge_allocations_includedAt_idx"
ON "delivery_group_payment_charge_allocations"("includedAt");

ALTER TABLE "delivery_group_payment_charge_allocations"
ADD CONSTRAINT "delivery_group_payment_charge_allocations_orderDeliveryGroupId_fkey"
FOREIGN KEY ("orderDeliveryGroupId") REFERENCES "order_delivery_groups"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_group_payment_charge_allocations"
ADD CONSTRAINT "delivery_group_payment_charge_allocations_orderLineId_fkey"
FOREIGN KEY ("orderLineId") REFERENCES "order_lines"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_group_payment_charge_allocations"
ADD CONSTRAINT "delivery_group_payment_charge_allocations_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "orders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
