# Delivery Notification Production Scheduler Readiness

Status: delivery-owned worker path exists. Vercel Cron delivery interval routes have been retired.

The production scheduler path is the delivery notification worker. It follows the Will Call model: an always-running delivery-owned worker computes Denver local time, uses scheduler locks, and delegates to the existing interval runners.

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

Live scheduled sends are enabled by default. Set `DELIVERY_SCHEDULER_LIVE_SEND_ENABLED=false` only when scheduled worker sends need to be temporarily stopped.

The delegated `run:delivery-interval` command still enforces its normal production gates, fresh ERP import, fail-closed stale-data protection, opt-in/opt-out logic, dispatcher idempotency, and provider safeguards.

The scheduler wrapper CLI intentionally rejects direct `--interval 8` use from the old scheduled command. The delivery notification worker supports interval 8 through its worker path, while still relying on the underlying production interval runner gates.

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

This migration must be applied before worker live scheduling.

## Worker Run Order

The worker wakes on a timer and checks all configured interval times. When an interval is due, it calls the scheduler wrapper, which acquires the daily lock and delegates to the production interval logic.

Run continuously:

```powershell
npm.cmd run notifications:worker
```

Run one scoped dry-run:

```powershell
npm.cmd run notifications:worker -- --once --interval 42 --order-type SO --order-number SO38056 --bypass-local-time-gate --dry-run
```

## 42-Day Initial Confirmation Launch

Use the production interval runner for the initial 42-day customer confirmation request:

```powershell
npm.cmd run run:delivery-interval -- --interval 42 --run-date <YYYY-MM-DD> --send --confirm "RUN REAL 42 DAY CUSTOMER CONFIRMATION NOTIFICATIONS"
```

This command creates 42-day confirmation request events and dispatches only the exact event ids created by that run. Existing old `DAY_42` scheduled rows are reported but not dispatched by this runner.

## Timing

Use business-day execution in Mountain Time, highest interval first:

| Flow | Denver local time |
| --- | ---: |
| 180-day | 15:00 |
| 90-day | 15:10 |
| 60-day | 15:20 |
| 42-day initial confirmation | 15:30 |
| 41/40/39 no-response follow-up | 15:35 |
| 30-day | 15:40 |
| 14-day | 15:50 |
| 12-day | 16:00 |
| 10-day | 16:10 |
| 8-day payment enforcement | 16:20 |
| 2-day | 16:30 |

The worker computes time in `America/Denver`; it does not rely on server local time or UTC cron conversion.

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

Use the worker one-shot command with retry/rerun flags only after verifying:

- queue-backed ERP is reachable,
- no duplicate scheduled event exists for the same dedupe key,
- prior attempts for the same event are not in flight,
- writeback posture still matches the launch phase.
