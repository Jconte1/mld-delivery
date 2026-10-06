# Multi-order delivery notifications

## Implementation status

The production interval runner and 41/40/39 no-response runner now call the shared
current-run dispatcher. This is implemented locally, not deployed or live-verified.
No production migrations, provider sends, queue jobs, or ERP writes were performed
during the isolated implementation validation.

## Compatibility and eligibility

Members must share contact, production-selected recipient/channel, delivery date,
interval, action, touch stage, and complete normalized delivery address. Unit
differences are preserved. Missing addresses remain singletons.

Qualification, fresh import, contact opt-ins, local/global opt-outs, payment rules,
and touch-history decisions remain per order. No pooling deposits or balances.
Only exact event IDs created by the current invocation are dispatched. Imported
failures, changed contacts/dates, stale lines, and existing claims fail closed.
Controlled routing and forced eligibility are rejected in this production path.
Singletons retain the original dispatcher, including its fallback behavior.

## Persistence and callbacks

A serializable transaction claims all members and creates one
DeliveryNotificationGroupAttempt. No per-order NotificationAttempt is fabricated.
Reruns cannot reclaim the members. Uncertain provider outcomes require reconciliation,
not automatic resend. Grouped Twilio callbacks use groupAttemptId and normal signature
validation; recipient/SID identity and status downgrade protections apply.

Four additive migrations are required before deploying both app and worker:

- 20261001150000_add_delivery_notification_groups
- 20261001153000_add_delivery_notification_group_attempts
- 20261002120000_add_group_attempt_callback_link
- 20261002150000_add_group_customer_response

All 34 repository migrations were applied successfully ONLY to disposable local
PostgreSQL 17. Production migration status has not been changed in this work.

## Customer experience

The public route is /delivery/group/[token] with the normal /delivery base path.
The summary lists all orders; each order retains separate items, salesperson, and
payment display. Payment remains absent from 42/41/40 and 2-day views/copy.
Existing single-order links remain unchanged.

A grouped 42 confirmation or date request refreshes all members from ERP and
revalidates before accepting the response. One local transaction records all member
responses; each order receives its own queue job and writeback tracking fields.
Date writes contain only that order's delivery-group lines. SMS Y, N, and date
responses use the same grouped service when the active confirmations match exactly.

If a member changes delivery date/contact/address, the old grouped action is blocked;
it does not silently apply to a reduced set of orders. A later qualified run may
form a new group. Duplicate responses do not enqueue duplicate jobs.

Queue failure for one member is surfaced independently and does not imply ERP
success. enqueue_pending/ enqueue_failed requires operator review: a crash between
the response transaction and queue submission is NOT automatically replayed.
Verify existing queue state before any corrective replay.

## Follow-ups, payment and reports

Each member's 41/40/39 state machine consumes the actual shared attempt evidence.
Different touch stages cannot be grouped together. Failed/uncertain sends do not
count as completed customer touches.

14/12/10/8 clearance still requires opt-in and accepted send evidence, followed by
independent payment evaluation. A cleared member cannot clear an unpaid sibling.
The recap lists each order and shared attempt ID while counting one physical send
only once. Runner reports distinguish individual and shared attempt counts.

## Validation

Pure/stub suites and isolated database tests cover:

- Matching, address/unit differences, moved dates, stage separation and singleton rules.
- Concurrent claim winner, transaction rollback, unique membership and rerun protection.
- SMS/email dispatcher stubs; failed imports, opt-outs and changed dates.
- Early/duplicate/unmatched callbacks, signature query tampering and downgrade protection.
- Web confirmation/date fanout, duplicate responses and partial queue failure.
- SMS Y and N followed by a requested date.
- Shared initial/reminder-1/final-reminder evidence followed by escalation eligibility.
- Three mixed-payment orders: two cleared, one unpaid; only cleared members may write.
- Recap: two order rows, one accepted shared send.
- Existing 42 lifecycle, 52 payment-lifecycle scenarios and 17 payment calculations.
- Desktop/mobile group page rendering without horizontal overflow.

Run database suites only against an isolated migrated database:

```powershell
$env:TEST_DELIVERY_GROUP_DATABASE_URL = "postgresql://delivery_group_test@127.0.0.1:55439/delivery_group_validation"
npm.cmd run validate:delivery-notification-group-database
npm.cmd run validate:delivery-notification-group-workflows
```

The workflow script blocks fetch and uses injected provider/queue stubs.
Its fixture records and simulated outcomes exist only in the local test database.
It refuses non-loopback databases or names outside delivery_group_validation.

## Release gate

Before real grouped sends:

1. Review/commit the grouping changes separately from unrelated recap work.
2. Apply the four additive migrations and deploy compatible delivery app AND worker.
3. Confirm the main website proxy forwards /delivery/group/* and grouped callback queries.
4. Run exact James-only scoped SMS/email tests with final-recipient assertions,
   real callback verification, and per-order ERP GET verification of approved writebacks.
5. Review partial-writeback recovery and uncertain-send handling before broad activation.

Do not treat local stub outcomes as provider delivery or verified Acumatica writes.
The already-running Azure containers do not contain these local changes.
