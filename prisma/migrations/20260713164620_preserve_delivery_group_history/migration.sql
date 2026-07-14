-- AlterTable
ALTER TABLE "order_delivery_groups" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "lineCount" INTEGER,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededReason" VARCHAR(256);

-- CreateIndex
CREATE INDEX "order_delivery_groups_isActive_deliveryDate_idx" ON "order_delivery_groups"("isActive", "deliveryDate");
