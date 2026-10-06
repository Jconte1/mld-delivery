ALTER TABLE "delivery_notification_groups" ADD COLUMN "linkToken" VARCHAR(128),
ADD COLUMN "responseAction" VARCHAR(32), ADD COLUMN "responseDate" DATE, ADD COLUMN "responseAt" TIMESTAMP(3);
UPDATE "delivery_notification_groups" SET "linkToken" = gen_random_uuid()::text;
ALTER TABLE "delivery_notification_groups" ALTER COLUMN "linkToken" SET NOT NULL;
CREATE UNIQUE INDEX "delivery_notification_groups_linkToken_key" ON "delivery_notification_groups"("linkToken");
ALTER TABLE "delivery_notification_group_members" ADD COLUMN "deliveryConfirmationId" TEXT;
ALTER TABLE "delivery_notification_group_attempts" ADD COLUMN "productionEligibilityVerified" BOOLEAN NOT NULL DEFAULT false;
