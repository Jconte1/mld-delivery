SELECT column_name
FROM information_schema.columns
WHERE table_name = 'delivery_interval_scheduler_runs'
ORDER BY ordinal_position;
