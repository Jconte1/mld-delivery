ALTER TABLE "delivery_notification_groups"
  ADD COLUMN "status" VARCHAR(32) NOT NULL DEFAULT 'PREPARED',
  ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE TABLE "delivery_notification_group_attempts" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "recipient" VARCHAR(256) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'SUBMITTING',
  "provider" VARCHAR(64) NOT NULL,
  "externalMessageId" VARCHAR(256),
  "providerCode" VARCHAR(128),
  "errorMessage" VARCHAR(1024),
  "submittedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "delivery_notification_group_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_notification_group_attempts_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "delivery_notification_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "delivery_notification_group_attempts_groupId_attemptNumber_key" ON "delivery_notification_group_attempts"("groupId", "attemptNumber");
CREATE UNIQUE INDEX "delivery_group_attempt_provider_message_key" ON "delivery_notification_group_attempts"("provider", "externalMessageId");
