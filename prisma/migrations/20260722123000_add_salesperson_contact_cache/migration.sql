-- Existing migration 20260722120000_add_acumatica_confirmation_fields_to_orders must run first.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "salespersonNumber" VARCHAR(16);

-- CreateTable
CREATE TABLE "salesperson_contacts" (
    "id" TEXT NOT NULL,
    "salespersonNumber" VARCHAR(16) NOT NULL,
    "salespersonName" VARCHAR(128),
    "salespersonEmail" VARCHAR(256),
    "salespersonPhone" VARCHAR(32),
    "sourceStaffUserId" VARCHAR(128),
    "sourceRole" VARCHAR(32),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesperson_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salesperson_contacts_salespersonNumber_key" ON "salesperson_contacts"("salespersonNumber");

-- CreateIndex
CREATE INDEX "salesperson_contacts_isActive_idx" ON "salesperson_contacts"("isActive");

-- CreateIndex
CREATE INDEX "orders_salespersonNumber_idx" ON "orders"("salespersonNumber");
