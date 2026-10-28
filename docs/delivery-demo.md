# Explicit-order live demo

Run from the delivery repo with the normal production database, queue and provider environment.
These commands SEND REAL NOTIFICATIONS and may queue real ERP writebacks/holds.
Use ERP contacts whose destinations you control. No test recipient override is applied.

```powershell
npm.cmd run demo -- 42 SO38056
npm.cmd run demo -- followup SO38056
npm.cmd run demo -- 14 SO38056
npm.cmd run demo -- 12 SO38056
npm.cmd run demo -- 10 SO38056
npm.cmd run demo -- 8 SO38056
npm.cmd run demo -- 42 SO38056 PL02718
npm.cmd run demo -- followup SO38056 PL02718
```

Configure dates, order status, delivery method, items, primary/delivery contact and
consent, terms, balances and confirmation fields in ERP first. The command resolves
the exact ERP identity, imports only the named orders and their contacts, then uses
normal creators/renderers/dispatchers/writebacks. ERP work remains queue-backed;
the queue worker must run, but the notification scheduler can stay paused.

Bare order numbers must resolve uniquely. Use `SO/SO38056` when a type is needed.
There is no date-wide ERP discovery, including nested fresh import calls. A
command-local AsyncLocalStorage scope constrains imports and candidate SQL queries;
outside this explicit command the scope is absent and production behavior is unchanged.

Today in America/Denver is the default run date. An optional explicit
`--run-date 2026-10-28` changes interval evaluation, NOT ERP dates or provider history.
For interval 42 the delivery must match run date + 42 days and normal delivery-day
rules. For `followup`, the existing production no-response state machine chooses
the next missing touch within its eligible window. No confirmation history is
manufactured. An order without a usable confirmation record may require an initial
42 run before the follow-up path can process it. Existing response/timing guards apply.

Multi-order demo supports **42 and followup**, with up to ten named orders. Before
event creation it checks refreshed contact/channel/address/date compatibility;
the dispatcher then requires all named orders in exactly one compatible customer
message group (including stage and current eligibility) before any customer send.
A mismatch never silently degrades to separate customer sends. Internal escalation
still uses the production internal-notification path. Payment/hold demos are single-order.
Failures may leave real unsent events; the command never deletes or resets them.

No scheduler lock is acquired: this is an explicit manual execution, not an automatic
scheduled run. Normal event dedupe, dispatcher claims and provider idempotency remain.
Repeating a sent order/date/stage does not force another message. No automatic cleanup
or reset is performed. New run IDs are for reporting, not dedupe bypass.

Existing production env gates still apply. For an approved local shell, if NODE_ENV
is not production, set the existing local-shell permission before running:

```powershell
$env:DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION = "true"
```

No new environment variables or migration are needed. This command does not resume,
pause or change Azure scheduled workers. Real customer replies are handled by the
deployed web/SMS endpoints and ERP writebacks by the deployed queue worker, so those
deployments still need the latest fixes. The terminal prints private confirmation/group
links for this run; do not publish them. Provider acceptance is not proof of delivery;
inspect callbacks and queue/ERP verification for final results.

Validation (no real sends or ERP/database access):

```powershell
npm.cmd run validate:delivery-demo
```
