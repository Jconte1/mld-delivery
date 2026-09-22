ALTER TABLE "delivery_confirmations"
  ADD COLUMN "confirmationWritebackJobId" VARCHAR(128),
  ADD COLUMN "confirmationWritebackStatus" VARCHAR(64),
  ADD COLUMN "confirmationWritebackPayload" JSONB,
  ADD COLUMN "confirmationWritebackResult" JSONB,
  ADD COLUMN "confirmationWritebackError" VARCHAR(2048),
  ADD COLUMN "confirmationWritebackQueuedAt" TIMESTAMP(3),
  ADD COLUMN "confirmationWritebackCheckedAt" TIMESTAMP(3),
  ADD COLUMN "confirmationWritebackCompletedAt" TIMESTAMP(3),
  ADD COLUMN "requestedDateWritebackJobId" VARCHAR(128),
  ADD COLUMN "requestedDateWritebackStatus" VARCHAR(64),
  ADD COLUMN "requestedDateWritebackPayload" JSONB,
  ADD COLUMN "requestedDateWritebackResult" JSONB,
  ADD COLUMN "requestedDateWritebackError" VARCHAR(2048),
  ADD COLUMN "requestedDateWritebackQueuedAt" TIMESTAMP(3),
  ADD COLUMN "requestedDateWritebackCheckedAt" TIMESTAMP(3),
  ADD COLUMN "requestedDateWritebackCompletedAt" TIMESTAMP(3);

CREATE INDEX "delivery_confirmations_confirmationWritebackJobId_idx"
  ON "delivery_confirmations"("confirmationWritebackJobId");
CREATE INDEX "delivery_confirmations_confirmationWritebackStatus_idx"
  ON "delivery_confirmations"("confirmationWritebackStatus");
CREATE INDEX "delivery_confirmations_requestedDateWritebackJobId_idx"
  ON "delivery_confirmations"("requestedDateWritebackJobId");
CREATE INDEX "delivery_confirmations_requestedDateWritebackStatus_idx"
  ON "delivery_confirmations"("requestedDateWritebackStatus");
