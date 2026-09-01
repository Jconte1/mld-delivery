# Delivery Notification Production Scheduler Readiness

Status: scheduler wrapper foundation exists, but actual cron jobs are not created or enabled.

Do not add Vercel cron routes or Azure Container Apps scheduled jobs until the live scheduler phase is explicitly approved. Current production-safe path is the scheduler wrapper command below, run manually or by a future external scheduler one interval at a time.

## Scheduler Wrapper

The wrapper computes the current date and time in `America/Denver`, uses the Denver date as `--run-date`, enforces the expected local run time, records a per-interval/day lock, and then delegates to `run:delivery-interval`.

```powershell
npm.cmd run scheduled:delivery-interval -- --interval 90 --send
```

The wrapper derives the required production confirmation phrase internally. Do not pass `--confirm` to the scheduler wrapper.

For local validation only, the time check can be bypassed:

```powershell
npm.cmd run scheduled:delivery-interval -- --interval 90 --send --force-local-time-check-bypass
```

Order-scoped canary runs can be passed through without bypassing eligibility:

```powershell
npm.cmd run scheduled:delivery-interval -- --interval 42 --send --order-type SO --order-number SO38056
```

Live scheduled sends require:

```text
DELIVERY_SCHEDULER_LIVE_SEND_ENABLED=true
```

The delegated `run:delivery-interval` command still enforces its normal production gates, fresh ERP import, fail-closed stale-data protection, opt-in/opt-out logic, dispatcher idempotency, and provider safeguards.

The wrapper intentionally rejects interval 8 with `interval_8_not_schedule_ready`. The 8-day hold/payment enforcement flow needs separate approval before it is schedule-ready.

## Scheduler Locking

Scheduler lock rows are stored in `delivery_interval_scheduler_runs`.

- Lock key: `delivery_interval_cron:<interval>:<Denver run date>`
- Active `running` lock exits success with `skipped_lock_active`.
- Completed `success` lock exits success with `skipped_already_completed`.
- Failed lock exits success with `skipped_failed_requires_retry_flag` unless `--allow-failed-retry` is passed.
- Completed lock can only be rerun with `--allow-completed-rerun`.
- Retry attempts increment `retryCount`.

The migration for this foundation is:

```text
prisma/migrations/20260901150000_add_delivery_interval_scheduler_runs/migration.sql
```

Apply it only during an approved migration/deploy step.

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

Use business-day execution in Mountain Time, highest interval first. These are proposed staggered run times for the future scheduler:

| Flow | Denver local time | Candidate UTC cron expression |
| --- | ---: | --- |
| 180-day | 15:00 | `0 21,22 * * 1-5` |
| 90-day | 15:10 | `10 21,22 * * 1-5` |
| 60-day | 15:20 | `20 21,22 * * 1-5` |
| 42-day initial confirmation | 15:30 | `30 21,22 * * 1-5` |
| 30-day | 15:40 | `40 21,22 * * 1-5` |
| 14-day | 15:50 | `50 21,22 * * 1-5` |
| 12-day | 16:00 | `0 22,23 * * 1-5` |
| 10-day | 16:10 | `10 22,23 * * 1-5` |
| 2-day | 16:30 | `30 22,23 * * 1-5` |
| 41/40/39 no-response follow-up | 15:35 | `35 21,22 * * 1-5` |

Vercel Cron Jobs and Azure Container Apps scheduled jobs evaluate cron expressions in UTC. A fixed single UTC hour is not acceptable for Denver-local scheduling because daylight saving time shifts Mountain Time between UTC-6 and UTC-7. The future scheduler should run at both candidate UTC hours and let `run-scheduled-delivery-interval.ts` execute only when the Denver local time exactly matches the interval's expected HH:mm.

Do not schedule interval 8 yet.

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
