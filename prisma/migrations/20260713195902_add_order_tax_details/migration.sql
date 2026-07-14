-- AlterTable
ALTER TABLE "order_lines" ADD COLUMN     "taxCategory" VARCHAR(64);

-- CreateTable
CREATE TABLE "order_tax_details" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "rowNumber" INTEGER,
    "taxId" VARCHAR(128),
    "taxCategory" VARCHAR(64),
    "customerTaxZone" VARCHAR(128),
    "taxRate" DECIMAL(18,6),
    "taxableAmount" DECIMAL(18,2),
    "taxAmount" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "order_tax_details_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_tax_details_orderNumber_idx" ON "order_tax_details"("orderNumber");

-- CreateIndex
CREATE INDEX "order_tax_details_orderType_orderNumber_idx" ON "order_tax_details"("orderType", "orderNumber");

-- CreateIndex
CREATE INDEX "order_tax_details_taxId_idx" ON "order_tax_details"("taxId");

-- CreateIndex
CREATE INDEX "order_tax_details_taxCategory_idx" ON "order_tax_details"("taxCategory");

-- CreateIndex
CREATE INDEX "order_tax_details_customerTaxZone_idx" ON "order_tax_details"("customerTaxZone");

-- CreateIndex
CREATE INDEX "order_lines_taxCategory_idx" ON "order_lines"("taxCategory");

-- AddForeignKey
ALTER TABLE "order_tax_details" ADD CONSTRAINT "order_tax_details_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
