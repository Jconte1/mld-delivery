CREATE TYPE "DeliveryIntervalSchedulerRunStatus" AS ENUM ('running', 'success', 'failed');

CREATE TABLE "delivery_interval_scheduler_runs" (
  "id" TEXT NOT NULL,
  "lockKey" VARCHAR(256) NOT NULL,
  "interval" VARCHAR(16) NOT NULL,
  "runDate" DATE NOT NULL,
  "timezone" VARCHAR(64) NOT NULL,
  "expectedLocalTime" VARCHAR(5) NOT NULL,
  "actualLocalTime" VARCHAR(5) NOT NULL,
  "status" "DeliveryIntervalSchedulerRunStatus" NOT NULL DEFAULT 'running',
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "delegatedArgs" JSONB,
  "resultSummary" JSONB,
  "errorMessage" VARCHAR(1024),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "delivery_interval_scheduler_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_interval_scheduler_runs_lockKey_key" ON "delivery_interval_scheduler_runs"("lockKey");
CREATE INDEX "delivery_interval_scheduler_runs_interval_idx" ON "delivery_interval_scheduler_runs"("interval");
CREATE INDEX "delivery_interval_scheduler_runs_runDate_idx" ON "delivery_interval_scheduler_runs"("runDate");
CREATE INDEX "delivery_interval_scheduler_runs_status_idx" ON "delivery_interval_scheduler_runs"("status");
CREATE INDEX "delivery_interval_scheduler_runs_startedAt_idx" ON "delivery_interval_scheduler_runs"("startedAt");
