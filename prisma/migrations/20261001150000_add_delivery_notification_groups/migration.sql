CREATE TABLE "delivery_notification_groups" (
  "id" TEXT NOT NULL,
  "membershipKey" VARCHAR(64) NOT NULL,
  "compatibilityKey" VARCHAR(64) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "deliveryDate" DATE NOT NULL,
  "intervalType" "NotificationIntervalType" NOT NULL,
  "actionType" "NotificationActionType" NOT NULL,
  "stage" VARCHAR(64) NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "contactId" VARCHAR(64) NOT NULL,
  "addressKey" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_notification_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_notification_groups_membershipKey_key" ON "delivery_notification_groups"("membershipKey");
CREATE INDEX "delivery_notification_groups_runId_idx" ON "delivery_notification_groups"("runId");
CREATE INDEX "delivery_notification_groups_compatibilityKey_idx" ON "delivery_notification_groups"("compatibilityKey");
CREATE TABLE "delivery_notification_group_members" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "notificationEventId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_notification_group_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_notification_group_members_notificationEventId_key" ON "delivery_notification_group_members"("notificationEventId");
CREATE INDEX "delivery_notification_group_members_groupId_idx" ON "delivery_notification_group_members"("groupId");
ALTER TABLE "delivery_notification_group_members" ADD CONSTRAINT "delivery_notification_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "delivery_notification_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_notification_group_members" ADD CONSTRAINT "delivery_notification_group_members_notificationEventId_fkey" FOREIGN KEY ("notificationEventId") REFERENCES "notification_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
