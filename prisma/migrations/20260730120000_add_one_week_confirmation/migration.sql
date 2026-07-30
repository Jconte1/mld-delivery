-- Add imported Acumatica ONEWEEKCON state to orders.
ALTER TABLE "orders"
ADD COLUMN "acumaticaOneWeekConfirmed" BOOLEAN;

CREATE INDEX "orders_acumaticaOneWeekConfirmed_idx"
ON "orders"("acumaticaOneWeekConfirmed");

-- Track local per-delivery-group 10-day confirmation clearance before writing
-- the order-level ONEWEEKCON flag in Acumatica.
CREATE TABLE "delivery_group_ten_day_confirmations" (
  "id" TEXT NOT NULL,
  "orderDeliveryGroupId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderType" VARCHAR(16) NOT NULL,
  "orderNumber" VARCHAR(64) NOT NULL,
  "deliveryDate" DATE NOT NULL,
  "localConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "acumaticaOneWeekConfirmed" BOOLEAN,
  "confirmedAt" TIMESTAMP(3),
  "confirmedReason" VARCHAR(128),
  "sourceInterval" "NotificationIntervalType",
  "paymentStatusAtEvaluation" VARCHAR(64),
  "amountDueAtEvaluation" DECIMAL(18,2),
  "acumaticaWritebackStatus" VARCHAR(64),
  "acumaticaWritebackJobId" VARCHAR(128),
  "acumaticaWritebackError" VARCHAR(2048),
  "mismatchReason" VARCHAR(256),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "delivery_group_ten_day_confirmations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_group_ten_day_confirmations_orderDeliveryGroupId_key"
ON "delivery_group_ten_day_confirmations"("orderDeliveryGroupId");

CREATE INDEX "delivery_group_ten_day_confirmations_localConfirmed_deliveryDate_idx"
ON "delivery_group_ten_day_confirmations"("localConfirmed", "deliveryDate");

CREATE INDEX "delivery_group_ten_day_confirmations_orderId_deliveryDate_idx"
ON "delivery_group_ten_day_confirmations"("orderId", "deliveryDate");

CREATE INDEX "delivery_group_ten_day_confirmations_orderType_orderNumber_idx"
ON "delivery_group_ten_day_confirmations"("orderType", "orderNumber");

CREATE INDEX "delivery_group_ten_day_confirmations_acumaticaWritebackStatus_idx"
ON "delivery_group_ten_day_confirmations"("acumaticaWritebackStatus");

CREATE INDEX "delivery_group_ten_day_confirmations_sourceInterval_idx"
ON "delivery_group_ten_day_confirmations"("sourceInterval");

ALTER TABLE "delivery_group_ten_day_confirmations"
ADD CONSTRAINT "delivery_group_ten_day_confirmations_orderDeliveryGroupId_fkey"
FOREIGN KEY ("orderDeliveryGroupId") REFERENCES "order_delivery_groups"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_group_ten_day_confirmations"
ADD CONSTRAINT "delivery_group_ten_day_confirmations_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "orders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
