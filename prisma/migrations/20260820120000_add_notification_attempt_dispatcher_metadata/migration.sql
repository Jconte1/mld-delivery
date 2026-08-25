CREATE TYPE "NotificationAttemptStatus" AS ENUM ('created', 'submitted', 'delivered', 'failed');

ALTER TABLE "notification_attempts"
ADD COLUMN "status" "NotificationAttemptStatus" NOT NULL DEFAULT 'created',
ADD COLUMN "recipient" VARCHAR(256),
ADD COLUMN "suppressedRecipient" VARCHAR(256),
ADD COLUMN "controlledRecipientMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "forcedContactEligibility" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "realSmsOptIn" BOOLEAN,
ADD COLUMN "realEmailOptIn" BOOLEAN,
ADD COLUMN "localSmsOptOutActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "localEmailOptOutActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "globalSmsOptOutActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "globalEmailOptOutActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "testRunId" VARCHAR(128),
ADD COLUMN "fallbackFromAttemptId" TEXT,
ADD COLUMN "metadata" JSONB,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "notification_attempts_status_idx" ON "notification_attempts"("status");
CREATE INDEX "notification_attempts_recipient_idx" ON "notification_attempts"("recipient");
CREATE INDEX "notification_attempts_controlledRecipientMode_idx" ON "notification_attempts"("controlledRecipientMode");
CREATE INDEX "notification_attempts_testRunId_idx" ON "notification_attempts"("testRunId");
CREATE INDEX "notification_attempts_fallbackFromAttemptId_idx" ON "notification_attempts"("fallbackFromAttemptId");

ALTER TABLE "notification_attempts"
ADD CONSTRAINT "notification_attempts_fallbackFromAttemptId_fkey"
FOREIGN KEY ("fallbackFromAttemptId") REFERENCES "notification_attempts"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
