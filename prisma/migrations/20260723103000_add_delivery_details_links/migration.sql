CREATE TABLE "delivery_details_links" (
    "id" TEXT NOT NULL,
    "token" VARCHAR(128) NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderDeliveryGroupId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "createdFromNotificationEventId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_details_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_details_links_token_key" ON "delivery_details_links"("token");
CREATE UNIQUE INDEX "delivery_details_links_orderDeliveryGroupId_deliveryDate_key" ON "delivery_details_links"("orderDeliveryGroupId", "deliveryDate");
CREATE INDEX "delivery_details_links_orderId_idx" ON "delivery_details_links"("orderId");
CREATE INDEX "delivery_details_links_orderDeliveryGroupId_idx" ON "delivery_details_links"("orderDeliveryGroupId");
CREATE INDEX "delivery_details_links_deliveryDate_idx" ON "delivery_details_links"("deliveryDate");

ALTER TABLE "notification_events" ADD COLUMN "detailsLinkId" TEXT;

CREATE INDEX "notification_events_detailsLinkId_idx" ON "notification_events"("detailsLinkId");

ALTER TABLE "notification_events"
ADD CONSTRAINT "notification_events_detailsLinkId_fkey"
FOREIGN KEY ("detailsLinkId") REFERENCES "delivery_details_links"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
