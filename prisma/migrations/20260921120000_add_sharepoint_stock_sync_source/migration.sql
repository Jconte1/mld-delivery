ALTER TABLE "sharepoint_stock_sync_runs"
ADD COLUMN "source" VARCHAR(64) NOT NULL DEFAULT 'sharepoint_stock_list';

CREATE INDEX "sharepoint_stock_sync_runs_source_status_completedAt_idx"
ON "sharepoint_stock_sync_runs"("source", "status", "completedAt");
