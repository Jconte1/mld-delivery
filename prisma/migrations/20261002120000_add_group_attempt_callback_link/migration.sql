ALTER TABLE "twilio_message_status_callbacks" ADD COLUMN "groupAttemptId" TEXT;
CREATE INDEX "twilio_message_status_callbacks_groupAttemptId_idx" ON "twilio_message_status_callbacks"("groupAttemptId");
ALTER TABLE "twilio_message_status_callbacks" ADD CONSTRAINT "twilio_message_status_callbacks_groupAttemptId_fkey" FOREIGN KEY ("groupAttemptId") REFERENCES "delivery_notification_group_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
