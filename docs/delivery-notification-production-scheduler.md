# Delivery Notification Production Scheduler Readiness

Status: scheduler not yet wired in this repo.

Do not add Vercel cron routes until route handlers exist. Current production-safe path is an external scheduler that runs package scripts in order against the production environment.

## Daily Run Order

1. Sync SharePoint stock.
   - `npm.cmd run sync:sharepoint-stock`
   - Run before interval qualification so stock/readiness uses the latest workbook.
2. Create customer notification events, one interval at a time.
   - `npm.cmd run create:180-day-delivery-reminder-events`
   - `npm.cmd run create:90-day-delivery-reminder-events`
   - `npm.cmd run create:60-day-delivery-reminder-events`
   - `npm.cmd run create:42-day-delivery-confirmation-events`
   - `npm.cmd run create:30-day-delivery-reminder-events`
   - `npm.cmd run create:14-day-delivery-reminder-events`
   - `npm.cmd run create:12-day-delivery-payment-request-events`
   - `npm.cmd run create:10-day-delivery-payment-request-events`
   - `npm.cmd run create:8-day-payment-enforcement-events`
   - `npm.cmd run create:2-day-delivery-reminder-events`
3. Dispatch scheduled events after creation succeeds.
   - Preview: `npm.cmd run dispatch:delivery-notifications -- --preview --test-run-id <run_id> --limit 100`
   - Live requires the real-customer gate and final approval.
4. Keep the 42-day no-response follow-up job as a separate, later approval phase.
   - Separate command only: `npm.cmd run run:42-day-confirmation-no-response`
   - Do not schedule this with the initial 42-day confirmation request launch unless separately approved.

## 42-Day Initial Confirmation Launch

Use the production interval runner for the initial 42-day customer confirmation request:

```powershell
npm.cmd run run:delivery-interval -- --interval 42 --run-date <YYYY-MM-DD> --send --confirm "RUN REAL 42 DAY CUSTOMER CONFIRMATION NOTIFICATIONS"
```

This command creates 42-day confirmation request events and dispatches only the exact event ids created by that run. Existing old `DAY_42` scheduled rows are reported but not dispatched by this runner.

## Timing

Use business-day morning execution in Mountain Time:

- 05:00: SharePoint stock sync.
- 05:30: interval event creation, highest interval first.
- 06:30: dispatcher preview/health check.
- Approved live dispatch window: after operations review, before customer-facing business hours.

## Fresh ERP Import

Intervals 180, 90, 60, and 42 now call the shared fresh-import preparation helper before live event creation. The helper requires queue-backed ERP for live creation.

Intervals 30, 14, 12, 10, 8, and 2 already import through their production creator paths.

## Weekend Behavior

Notification creation must keep the existing weekend send/date guards. If a run date or target delivery date is skipped, do not force creation unless a separate reviewed business exception is approved.

## Failure Handling

- If SharePoint sync fails, stop event creation and resolve stock freshness first.
- If ERP import fails, stop that interval and do not create events from stale data.
- If event creation partially fails, inspect dedupe keys and error summaries before rerun.
- If dispatch leaves an event `PENDING`, do not rerun broad dispatch until stale-claim recovery exists or the event is manually reviewed.
- If old `DAY_42` scheduled events exist, review/cancel or clean them before scheduler go-live. The `run:delivery-interval --interval 42` command will not broad-dispatch them.

## Manual Rerun

Use the same command with `--run-date=YYYY-MM-DD` only after verifying:

- queue-backed ERP is reachable,
- no duplicate scheduled event exists for the same dedupe key,
- prior attempts for the same event are not in flight,
- writeback dry-run posture still matches the launch phase.
