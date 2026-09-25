CREATE TYPE "OrderThankYouClassification" AS ENUM ('DELIVERY', 'WILL_CALL');

CREATE TABLE "order_thank_you_events" (
    "id" TEXT NOT NULL,
    "orderType" VARCHAR(16) NOT NULL,
    "orderNumber" VARCHAR(64) NOT NULL,
    "classification" "OrderThankYouClassification" NOT NULL,
    "contactId" VARCHAR(64),
    "customerId" VARCHAR(64),
    "billingZip" VARCHAR(16),
    "shipVia" VARCHAR(128),
    "requestedDeliveryDate" DATE,
    "selectedChannel" "NotificationChannel",
    "channelReason" VARCHAR(256),
    "recipientEmail" VARCHAR(256),
    "recipientPhone" VARCHAR(32),
    "status" "NotificationEventStatus" NOT NULL DEFAULT 'pending',
    "reasonSkipped" VARCHAR(1024),
    "reasonFailed" VARCHAR(1024),
    "provider" VARCHAR(64),
    "externalMessageId" VARCHAR(256),
    "reportFetchedAt" TIMESTAMP(3) NOT NULL,
    "fullOrderFetchedAt" TIMESTAMP(3),
    "contactFetchedAt" TIMESTAMP(3),
    "firstSentAt" TIMESTAMP(3),
    "willCallUrl" VARCHAR(2048),
    "acumaticaWritebackStatus" VARCHAR(64),
    "acumaticaWritebackJobId" VARCHAR(128),
    "acumaticaWritebackAttempts" INTEGER NOT NULL DEFAULT 0,
    "acumaticaWritebackError" VARCHAR(2048),
    "acumaticaWritebackQueuedAt" TIMESTAMP(3),
    "acumaticaWritebackCheckedAt" TIMESTAMP(3),
    "acumaticaWritebackCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_thank_you_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_thank_you_attempts" (
    "id" TEXT NOT NULL,
    "orderThankYouEventId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationAttemptStatus" NOT NULL DEFAULT 'created',
    "recipient" VARCHAR(256),
    "provider" VARCHAR(64),
    "success" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" VARCHAR(1024),
    "providerCode" VARCHAR(128),
    "httpStatus" INTEGER,
    "externalMessageId" VARCHAR(256),
    "realSmsOptIn" BOOLEAN,
    "realEmailOptIn" BOOLEAN,
    "localSmsOptOutActive" BOOLEAN NOT NULL DEFAULT false,
    "localEmailOptOutActive" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_thank_you_attempts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "twilio_message_status_callbacks" ADD COLUMN "orderThankYouEventId" TEXT;
ALTER TABLE "twilio_message_status_callbacks" ADD COLUMN "orderThankYouAttemptId" TEXT;

CREATE UNIQUE INDEX "order_thank_you_events_orderType_orderNumber_key" ON "order_thank_you_events"("orderType", "orderNumber");
CREATE INDEX "order_thank_you_events_classification_idx" ON "order_thank_you_events"("classification");
CREATE INDEX "order_thank_you_events_contactId_idx" ON "order_thank_you_events"("contactId");
CREATE INDEX "order_thank_you_events_status_idx" ON "order_thank_you_events"("status");
CREATE INDEX "order_thank_you_events_selectedChannel_idx" ON "order_thank_you_events"("selectedChannel");
CREATE INDEX "order_thank_you_events_firstSentAt_idx" ON "order_thank_you_events"("firstSentAt");
CREATE INDEX "order_thank_you_events_acumaticaWritebackStatus_idx" ON "order_thank_you_events"("acumaticaWritebackStatus");
CREATE INDEX "order_thank_you_events_acumaticaWritebackJobId_idx" ON "order_thank_you_events"("acumaticaWritebackJobId");
CREATE UNIQUE INDEX "order_thank_you_attempts_orderThankYouEventId_attemptNumber_key" ON "order_thank_you_attempts"("orderThankYouEventId", "attemptNumber");
CREATE INDEX "order_thank_you_attempts_orderThankYouEventId_idx" ON "order_thank_you_attempts"("orderThankYouEventId");
CREATE INDEX "order_thank_you_attempts_channel_idx" ON "order_thank_you_attempts"("channel");
CREATE INDEX "order_thank_you_attempts_status_idx" ON "order_thank_you_attempts"("status");
CREATE INDEX "order_thank_you_attempts_externalMessageId_idx" ON "order_thank_you_attempts"("externalMessageId");
CREATE INDEX "twilio_message_status_callbacks_orderThankYouEventId_idx" ON "twilio_message_status_callbacks"("orderThankYouEventId");
CREATE INDEX "twilio_message_status_callbacks_orderThankYouAttemptId_idx" ON "twilio_message_status_callbacks"("orderThankYouAttemptId");

ALTER TABLE "order_thank_you_events" ADD CONSTRAINT "order_thank_you_events_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("contactId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_thank_you_attempts" ADD CONSTRAINT "order_thank_you_attempts_orderThankYouEventId_fkey" FOREIGN KEY ("orderThankYouEventId") REFERENCES "order_thank_you_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "twilio_message_status_callbacks" ADD CONSTRAINT "twilio_message_status_callbacks_orderThankYouEventId_fkey" FOREIGN KEY ("orderThankYouEventId") REFERENCES "order_thank_you_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "twilio_message_status_callbacks" ADD CONSTRAINT "twilio_message_status_callbacks_orderThankYouAttemptId_fkey" FOREIGN KEY ("orderThankYouAttemptId") REFERENCES "order_thank_you_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
