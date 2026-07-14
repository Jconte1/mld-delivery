-- AlterTable
ALTER TABLE "order_tax_details" ADD COLUMN     "lineNbr" INTEGER,
ADD COLUMN     "recordId" VARCHAR(64),
ADD COLUMN     "taxType" VARCHAR(64);

-- CreateIndex
CREATE INDEX "order_tax_details_taxType_idx" ON "order_tax_details"("taxType");
