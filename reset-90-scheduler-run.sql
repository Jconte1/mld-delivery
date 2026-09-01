UPDATE delivery_interval_scheduler_runs
SET
  status = 'failed',
  "completedAt" = now(),
  "updatedAt" = now()
WHERE id = '01fb6849-d25a-4f29-9801-7d463c2e8929'
  AND status = 'running';
