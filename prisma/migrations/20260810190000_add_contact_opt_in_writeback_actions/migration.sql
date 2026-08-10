CREATE TYPE "ContactOptInWritebackChannel" AS ENUM ('SMS', 'EMAIL', 'PHONE_CALL');

CREATE TYPE "ContactOptInWritebackStatus" AS ENUM (
  'PENDING',
  'QUEUED',
  'DRY_RUN',
  'WRITTEN',
  'ALREADY_FALSE',
  'REFUSED',
  'FAILED'
);

CREATE TABLE "contact_opt_in_writeback_actions" (
  "id" TEXT NOT NULL,
  "dedupeKey" VARCHAR(256) NOT NULL,
  "contactId" VARCHAR(64) NOT NULL,
  "channel" "ContactOptInWritebackChannel" NOT NULL,
  "targetField" VARCHAR(64) NOT NULL,
  "targetValue" BOOLEAN NOT NULL,
  "source" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(128) NOT NULL,
  "status" "ContactOptInWritebackStatus" NOT NULL DEFAULT 'PENDING',
  "queueJobId" VARCHAR(128),
  "errorMessage" VARCHAR(2048),
  "resultSummary" JSONB,
  "relatedSmsOptOutId" VARCHAR(64),
  "relatedEmailOptOutId" VARCHAR(64),
  "queuedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "contact_opt_in_writeback_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_opt_in_writeback_actions_dedupeKey_key"
  ON "contact_opt_in_writeback_actions"("dedupeKey");

CREATE INDEX "contact_opt_in_writeback_actions_contactId_idx"
  ON "contact_opt_in_writeback_actions"("contactId");

CREATE INDEX "contact_opt_in_writeback_actions_channel_idx"
  ON "contact_opt_in_writeback_actions"("channel");

CREATE INDEX "contact_opt_in_writeback_actions_status_idx"
  ON "contact_opt_in_writeback_actions"("status");

CREATE INDEX "contact_opt_in_writeback_actions_targetField_targetValue_idx"
  ON "contact_opt_in_writeback_actions"("targetField", "targetValue");

CREATE INDEX "contact_opt_in_writeback_actions_queueJobId_idx"
  ON "contact_opt_in_writeback_actions"("queueJobId");

CREATE INDEX "contact_opt_in_writeback_actions_relatedSmsOptOutId_idx"
  ON "contact_opt_in_writeback_actions"("relatedSmsOptOutId");

CREATE INDEX "contact_opt_in_writeback_actions_relatedEmailOptOutId_idx"
  ON "contact_opt_in_writeback_actions"("relatedEmailOptOutId");
