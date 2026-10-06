BEGIN;
ALTER TABLE "orders"
  ADD COLUMN "deliveryContactId" VARCHAR(64),
  ADD COLUMN "deliveryContactSyncStatus" VARCHAR(32) NOT NULL DEFAULT 'not_fetched',
  ADD COLUMN "primaryContactFetchSucceeded" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "orders_deliveryContactId_idx" ON "orders"("deliveryContactId");
ALTER TABLE "orders" ADD CONSTRAINT "orders_deliveryContactId_fkey"
  FOREIGN KEY ("deliveryContactId") REFERENCES "contacts"("contactId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_events"
  ADD COLUMN "recipientContactRole" VARCHAR(16) NOT NULL DEFAULT 'PRIMARY',
  ADD COLUMN "recipientFallbackReason" VARCHAR(128);
COMMIT;
