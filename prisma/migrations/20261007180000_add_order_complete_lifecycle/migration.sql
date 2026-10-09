CREATE TYPE "OrderCompleteAttemptStatus" AS ENUM ('CLAIMED', 'SUBMITTED', 'REVIEW');

CREATE TABLE "order_complete_events" (
    "id" TEXT NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "discoveryJobId" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_complete_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_complete_attempts" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "contactId" VARCHAR(64) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" VARCHAR(256) NOT NULL,
    "status" "OrderCompleteAttemptStatus" NOT NULL DEFAULT 'CLAIMED',
    "realSmsOptIn" BOOLEAN NOT NULL,
    "realEmailOptIn" BOOLEAN NOT NULL,
    "optOutCheckedAt" TIMESTAMP(3) NOT NULL,
    "freshErpCheckedAt" TIMESTAMP(3) NOT NULL,
    "provider" VARCHAR(64),
    "externalMessageId" VARCHAR(256),
    "providerRequestId" VARCHAR(256),
    "providerCode" VARCHAR(128),
    "httpStatus" INTEGER,
    "reason" VARCHAR(1024),
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_complete_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_complete_events_orderType_orderNumber_key" ON "order_complete_events"("orderType", "orderNumber");
CREATE UNIQUE INDEX "order_complete_attempts_eventId_key" ON "order_complete_attempts"("eventId");
CREATE INDEX "order_complete_attempts_status_idx" ON "order_complete_attempts"("status");
CREATE INDEX "order_complete_attempts_externalMessageId_idx" ON "order_complete_attempts"("externalMessageId");
CREATE INDEX "order_complete_attempts_providerRequestId_idx" ON "order_complete_attempts"("providerRequestId");
ALTER TABLE "order_complete_attempts" ADD CONSTRAINT "order_complete_attempts_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "order_complete_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
