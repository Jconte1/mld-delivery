ALTER TABLE "delivery_confirmations"
ADD COLUMN "manualReviewRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "manualReviewReason" VARCHAR(64),
ADD COLUMN "manualReviewMarkedAt" TIMESTAMP(3),
ADD COLUMN "manualReviewNotes" VARCHAR(1024),
ADD COLUMN "unrecognizedResponseCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "confirmationFollowUpCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastSmsResponseAt" TIMESTAMP(3),
ADD COLUMN "lastSmsResponseBody" VARCHAR(1024);

CREATE TABLE "twilio_inbound_messages" (
  "id" TEXT NOT NULL,
  "messageSid" VARCHAR(64),
  "accountSid" VARCHAR(64),
  "messagingServiceSid" VARCHAR(64),
  "fromPhone" VARCHAR(32),
  "toPhone" VARCHAR(32),
  "body" VARCHAR(1600),
  "normalizedBody" VARCHAR(256),
  "parsedIntent" VARCHAR(64) NOT NULL DEFAULT 'UNKNOWN',
  "matchStatus" VARCHAR(64) NOT NULL DEFAULT 'UNPROCESSED',
  "deliveryConfirmationId" TEXT,
  "notificationEventId" TEXT,
  "rawPayload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "responseSent" BOOLEAN NOT NULL DEFAULT false,
  "responseMessage" VARCHAR(1600),
  "error" VARCHAR(1024),

  CONSTRAINT "twilio_inbound_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "twilio_message_status_callbacks" (
  "id" TEXT NOT NULL,
  "callbackKey" VARCHAR(256) NOT NULL,
  "messageSid" VARCHAR(64) NOT NULL,
  "accountSid" VARCHAR(64),
  "messagingServiceSid" VARCHAR(64),
  "messageStatus" VARCHAR(64) NOT NULL,
  "errorCode" VARCHAR(64),
  "errorMessage" VARCHAR(1024),
  "fromPhone" VARCHAR(32),
  "toPhone" VARCHAR(32),
  "notificationEventId" TEXT,
  "notificationAttemptId" TEXT,
  "deliveryConfirmationId" TEXT,
  "matchStatus" VARCHAR(64) NOT NULL DEFAULT 'UNPROCESSED',
  "rawPayload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),

  CONSTRAINT "twilio_message_status_callbacks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "twilio_inbound_messages_messageSid_key" ON "twilio_inbound_messages"("messageSid");
CREATE UNIQUE INDEX "twilio_message_status_callbacks_callbackKey_key" ON "twilio_message_status_callbacks"("callbackKey");

CREATE INDEX "delivery_confirmations_manualReviewRequired_idx" ON "delivery_confirmations"("manualReviewRequired");
CREATE INDEX "delivery_confirmations_manualReviewReason_idx" ON "delivery_confirmations"("manualReviewReason");
CREATE INDEX "delivery_confirmations_lastSmsResponseAt_idx" ON "delivery_confirmations"("lastSmsResponseAt");

CREATE INDEX "twilio_inbound_messages_fromPhone_idx" ON "twilio_inbound_messages"("fromPhone");
CREATE INDEX "twilio_inbound_messages_toPhone_idx" ON "twilio_inbound_messages"("toPhone");
CREATE INDEX "twilio_inbound_messages_messagingServiceSid_idx" ON "twilio_inbound_messages"("messagingServiceSid");
CREATE INDEX "twilio_inbound_messages_parsedIntent_idx" ON "twilio_inbound_messages"("parsedIntent");
CREATE INDEX "twilio_inbound_messages_matchStatus_idx" ON "twilio_inbound_messages"("matchStatus");
CREATE INDEX "twilio_inbound_messages_deliveryConfirmationId_idx" ON "twilio_inbound_messages"("deliveryConfirmationId");
CREATE INDEX "twilio_inbound_messages_notificationEventId_idx" ON "twilio_inbound_messages"("notificationEventId");
CREATE INDEX "twilio_inbound_messages_receivedAt_idx" ON "twilio_inbound_messages"("receivedAt");

CREATE INDEX "twilio_message_status_callbacks_messageSid_idx" ON "twilio_message_status_callbacks"("messageSid");
CREATE INDEX "twilio_message_status_callbacks_messageStatus_idx" ON "twilio_message_status_callbacks"("messageStatus");
CREATE INDEX "twilio_message_status_callbacks_errorCode_idx" ON "twilio_message_status_callbacks"("errorCode");
CREATE INDEX "twilio_message_status_callbacks_toPhone_idx" ON "twilio_message_status_callbacks"("toPhone");
CREATE INDEX "twilio_message_status_callbacks_fromPhone_idx" ON "twilio_message_status_callbacks"("fromPhone");
CREATE INDEX "twilio_message_status_callbacks_notificationEventId_idx" ON "twilio_message_status_callbacks"("notificationEventId");
CREATE INDEX "twilio_message_status_callbacks_notificationAttemptId_idx" ON "twilio_message_status_callbacks"("notificationAttemptId");
CREATE INDEX "twilio_message_status_callbacks_deliveryConfirmationId_idx" ON "twilio_message_status_callbacks"("deliveryConfirmationId");
CREATE INDEX "twilio_message_status_callbacks_matchStatus_idx" ON "twilio_message_status_callbacks"("matchStatus");
CREATE INDEX "twilio_message_status_callbacks_receivedAt_idx" ON "twilio_message_status_callbacks"("receivedAt");

ALTER TABLE "twilio_inbound_messages"
ADD CONSTRAINT "twilio_inbound_messages_deliveryConfirmationId_fkey"
FOREIGN KEY ("deliveryConfirmationId") REFERENCES "delivery_confirmations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "twilio_inbound_messages"
ADD CONSTRAINT "twilio_inbound_messages_notificationEventId_fkey"
FOREIGN KEY ("notificationEventId") REFERENCES "notification_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "twilio_message_status_callbacks"
ADD CONSTRAINT "twilio_message_status_callbacks_notificationEventId_fkey"
FOREIGN KEY ("notificationEventId") REFERENCES "notification_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "twilio_message_status_callbacks"
ADD CONSTRAINT "twilio_message_status_callbacks_notificationAttemptId_fkey"
FOREIGN KEY ("notificationAttemptId") REFERENCES "notification_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "twilio_message_status_callbacks"
ADD CONSTRAINT "twilio_message_status_callbacks_deliveryConfirmationId_fkey"
FOREIGN KEY ("deliveryConfirmationId") REFERENCES "delivery_confirmations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
