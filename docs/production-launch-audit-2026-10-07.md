# Delivery launch audit - October 7, 2026

## Verdict

**Not approved for unrestricted production launch.** The core implementation and many isolated scenarios work, but several presentation promises are not implemented end to end. Passing a build or validation does not establish that a deployed worker sends, reconciles, and writes ERP correctly.

Scope: all 24 slides of `Delivery Notifications Presentation.pptx`, delivery scheduling/creation/dispatch, grouped notifications, customer responses, payment/readiness, contacts, regional stock, reports, queue writeback handlers, migrations, and build/test tooling. This is a source/read-only database audit plus isolated tests, not a live acceptance test or an exhaustive security certification.

No application logic was changed. No provider messages, ERP writes, writeback jobs, production fixtures, deployments, or cleanup were performed. Temporary local test guards were used; database integration tests used a dedicated loopback PostgreSQL database only. Production database inspection used an explicit READ ONLY transaction.

## Findings requiring action

### 1. P1 - Temporary Conte-only restriction still blocks real customers

`lib/notifications/deliveryNotificationDispatcher.ts:104,1157,1174,1916` restricts attempts to last name `conte`. Both single-order and grouped paths enforce it. Group preloading throws on a blocked member, so a non-Conte candidate can abort the batch, not merely skip that contact. The normal environment validator does not detect this restriction.

Remove only after approving real-recipient launch; replace with tests proving normal opt-in/opt-out and recipient selection still apply. Do not remove eligibility, freshness, or idempotency protections.

### 2. P1 - 39-day and 8-day salesperson emails are not dispatched

`scripts/run-42-day-confirmation-no-response.ts:607` explicitly returns `senderIntegrated: false`. Only customer reminder event IDs enter `dispatchCurrentRunGroups`. `lib/notifications/create8DayPaymentEnforcementEvents.ts:801` creates internal records with PENDING/SKIPPED status, but the production interval runner does not dispatch those internal records. No production internal-event sender was found in the inspected delivery runtime.

Read-only DB evidence: 9 PAYMENT_ENFORCEMENT_HOLD_SUCCEEDED records are PENDING, 3 SKIPPED; 1 DELIVERY_CONFIRMATION_NO_RESPONSE record is PENDING. There were no other internal-event status groups in this database snapshot. A created internal record is not an email sent to a salesperson.

Implement an idempotent internal sender with claims, recipient resolution, provider evidence, failure/retry handling, and daily-report coverage. Slides 11 and 17 currently overstate live behavior.

### 3. P1 - Exact-minute sequential scheduling can lose intervals

`scripts/delivery-notification-worker.ts:209-217` selects work only when HH:mm exactly equals its schedule. `runDeliveryNotificationWorkerTick` awaits each interval, and the main loop awaits the tick and ancillary work before sleeping another minute (`:434-535`). A 42 run lasting past 15:35 can prevent the 39 lifecycle run from ever being selected that day. Restarting after a due minute has the same consequence. Locks prevent duplication but do not recover missed minutes.

Use due-at-or-before scheduling with date-scoped lock checks and an explicit catch-up policy. Keep failed/uncertain-send recovery distinct from automatic retry. Test slow imports, process restarts, overlapping replicas, midnight, and DST.

### 4. P1 - Primary-contact freshness still has holes

`lib/erp/importSalesOrders.ts:543` resolves a contact lookup to a matching row or null. A null/empty result does not throw or necessarily create a failed-order exclusion. Existing primary-contact update fields (`:729-741`) use `undefined` for missing values, preserving old phone/email/opt-ins while stamping a new `lastSyncedAt`. The order can subsequently enter `successfullyRefreshedOrders` (`:1287`).

`lib/notifications/deliveryRecipient.ts:21-44` requires `primaryContactFetchSucceeded` only for DAY_2 fallback, not primary-contact intervals generally. Thus a fresh order does not by itself prove a fresh primary recipient. Separately, even a successful contact fetch with a now-blank phone/email leaves the old value in place because null becomes undefined.

Fail closed on unresolved primary contact for applicable intervals, and distinguish an explicitly cleared field from an unexposed field. Add import-to-dispatch tests for empty contact responses, wrong IDs, removed email/phone, and changed opt-ins. Existing contact-routing tests cover delivery-contact failures/removal, but do not establish these primary-contact guarantees.

### 5. P1 - 42 confirmation writeback reports success without readback

Queue repo: `worker/src/lib/deliveryConfirmationAttributes.ts:231-249` returns `status: written` immediately after PUT. `worker/src/lib/acumaticaClient.ts:1308-1360` verifies HTTP success only. It does not GET the persisted CONFIRMVIA/CONFIRMWTH values afterward. An HTTP 200 with ignored fields can still be labeled written, the same class of problem previously experienced.

Requested-date, ten-day, contact-opt-in, and hold handlers do have readback verification paths. Add equivalent field-level verification to confirmation writeback, including partial existing attributes, unchanged-after-200, wrong-order response, and retry-after-success cases. Daily recap must distinguish accepted PUT from verified ERP state.

### 6. P1 - Failed-run retry does not recover already-created unsent events

`scripts/run-delivery-interval.ts:669-680` can abort for one failed import after successful candidates have created events. Dispatch is limited to current-run-created IDs (`:683-696`). Creators dedupe existing events, e.g. `lib/notifications/createDeliveryReminderEvents.ts:363-394`, and do not add those old rows to the new run's dispatch list.

Therefore retrying a failed scheduler lock is not enough to recover stranded SCHEDULED events. The next run may report no dispatchable events despite unsent eligible orders. Do not solve this by broad-dispatching old rows or deleting evidence; add an explicit, freshly revalidated recovery claim for never-attempted events.

DB evidence: October 5 runs for 30/14/10/8 failed with `fresh_import_failed; refusing to dispatch this run`. Similar failures exist October 2. This proves actual failed runs, not that each run necessarily stranded an event; that requires an event-by-event recovery inventory.

### 7. P2 - Presentation's two-field confirmation rule differs from code

Slides 9/13/15 describe BOTH CONFIRMVIA and CONFIRMWTH. `create42DayDeliveryConfirmationEvents.ts:179-180` uses CONFIRMVIA only. `create30DayDeliveryReminderEvents.ts:680-681` (also used by 14) requires CONFIRMVIA only; 2-day uses it at `create2DayDeliveryReminderEvents.ts:674`. Partial ERP confirmation therefore behaves differently from the presentation. Decide whether the code or slide is authoritative before changing this rule.

### 8. P2 - Regional stock cache is stale in the inspected database

All three latest syncs were September 21, 2026: Utah/Wyoming 117 rows, Idaho 144, Southwest 144. `lib/sharepoint-stock/externalStockReadiness.ts:37-75,110-111` defaults to a 10-day freshness cutoff and ignores stale sources. On October 7 those syncs exceed the default window. Actual deployed override values could not be verified.

Warehouse routing is implemented in `regionalStockLists.ts`: nine Utah/Wyoming warehouses, five Idaho, two Southwest, with no cross-region fallback for unknown warehouses. Weekly Sunday sync exists in the worker. Verify the deployed worker's regional credentials/configuration and obtain successful fresh sync evidence before launch. Do not disable freshness to hide failed imports.

### 9. P2 - Single-order 2-day webpage still displays payment

2-day SMS/email rendering omits payment, and grouped pages gate payment to DAY_30/14/12/10/8 (`app/group/[token]/page.tsx:42`). But the single-order details page always evaluates and renders payment (`app/details/[token]/page.tsx:96,154`), including when linked by a 2-day reminder. This is inconsistent across grouped/single customer journeys. The details token is group/date based, so define interval context deliberately rather than hiding payment globally.

42 confirmation and reminder copy remains payment-free; the confirmation page does not evaluate payment. Existing 42 and 2-day renderer validations pass.

### 10. P2 - Thank-you has a different send gate and incomplete success semantics

`lib/notifications/orderThankYou.ts:430` requires DELIVERY_REAL_CUSTOMER_SEND_ENABLED exactly true, unlike the main worker's default-live posture. The worker environment validator accepts that flag being unset, so it can pass while thank-you fails.

`runScheduledOrderThankYou` (`:742-745`) marks its scheduler row SUCCESS when `runOrderThankYou` returns even if its summary contains failed orders. Review per-order failures in the report; SUCCESS alone is not proof every thank-you was sent. Provider submission and DB/writeback work share a catch boundary (`:661-709`), unlike the separate writeback boundary in the interval dispatcher; ambiguous post-provider errors need explicit reconciliation rather than being treated as clean provider failures.

### 11. Scope decision - Order Complete is not an implemented delivery flow

No order-complete event creator, renderer, or worker task was found in delivery. Slides 22/23 present this feature, but slide 23 explicitly labels its example proposed/unverified. Thank-you is implemented; it is not an order-complete substitute. Either implement and accept-test completion messaging or explicitly remove it from launch scope.

### 12. P2 - Remaining TODOs and link policy

`lib/notifications/deliveryDetailsLinks.ts:116` leaves details-link expiry undecided. Active single-order details links have no date-expiry check in the page; grouped links do. Decide retention/expiry and test old, moved, completed, and reassigned-contact links.

Queue `worker/src/lib/deliveryPrepaymentHold.ts:143` retains a TODO for a future configured Prepayment Hold status/action. Current code writes ordinary `Hold=true`. This is functional behavior, but not a completed dedicated prepayment-hold implementation. Confirm it matches the operational promise before removing the TODO.

## Presentation-to-implementation matrix

| Area / slides | Current evidence | Launch status |
| --- | --- | --- |
| Global eligibility (4) | Line-level dates, queue import, opt-outs, exclusions present. Code also excludes RA/RC/RM/RR, allows DEL ST GEORGE, fetches Awaiting Payment and completed/cancelled rows for downstream evaluation. | Update slide distinctions between fetched and notification-eligible orders; fix primary-contact hole. |
| Thank-you (5-6) | Delivery/Will Call classification, contact fetch, real provider path, THANKYOU queue writeback/reconciliation present. 17 pure cases pass. | Gate and failure semantics need alignment; deployed/live acceptance unverified. |
| 180/90/60 (7-8) | Shared fresh import/creator, real opt-ins, current-run grouping and dispatch; renderer/dispatcher tests pass. | Blocked by Conte restriction, missed-minute and retry recovery risks. |
| 42 (9-10) | Confirmation creation, Y/N/date and web actions, queue writes, signature checks; no payment copy. | Confirmation rule mismatch, primary-contact risk, readback gap; live acceptance unverified. |
| 41/40 reminders (11) | Actual completed-touch history; created-only and failed attempts do not complete a touch; missing touches catch up. | Isolated scenarios pass; scheduler and sender blockers still apply. |
| 39 escalation (11) | Internal event created after sequence; dedupe and report evidence. | FAIL: salesperson sender not integrated. |
| Prepayment (12) | Deposit less completed value first, then 45% remaining when coverage exhausted; per-order money stays separate. | Core payment and mixed-group tests pass; legacy validators need repair. |
| 30 (13-14) | Confirmation-gated reminder, payment-aware details, production renderer. | Confirmation rule mismatch and common blockers. |
| 14 (15-16) | Terms/cleared prepay ONEWEEKCON now requires qualifying real opted-in send evidence. Unpaid prepay receives amount. | Core scenarios pass; live ERP readback and receipt canary still required. |
| 12/10 (17-18) | Recompute payable basis, suppress when paid/manually confirmed, amount in message. | Core scenarios pass; five failing package validators overall must be reconciled. |
| 8 (17/19) | Hold queue result must succeed before hold customer notice creation; amount in copy; internal records created. | FAIL for salesperson email; ordinary-hold policy and recovery need acceptance. |
| 2 (20-21) | Delivery contact first, fresh primary fallback, sixweek/oneweek gates, no payment in message. | Contact routing tests pass; webpage payment inconsistency. |
| Complete (22-23) | Proposed example only. | Not implemented; explicit launch scope decision needed. |
| Multiorder (24) | Matching contact/channel/recipient/date/address/stage; per-order payment and writebacks; changed member rejected. | Isolated DB tests pass; deployment/provider/ERP acceptance not verified. |

## Validation results

58 delivery validation package entries exercised (aliases included): **53 pass, 5 fail**. Network was blocked for pure tests. Four DB-dependent suites were run against `delivery_group_validation_contacts` on loopback port 25439, with external connections blocked. The initial network-blocked attempt of the payment DB suite was rerun successfully there.

Passing DB suites: grouped database claims (5 competing claimants, 1 winner); grouped workflows (12 simulated sends, 9 simulated jobs, zero actual external calls); contact routing/import; 17 payment scenarios with rollback verified. These are simulations, not customer/ERP acceptance evidence.

Five failures:

| Validation | Failure | Interpretation |
| --- | --- | --- |
| validate:salesperson-import | Schema literal whitespace assertion | Field/model exist; brittle test (`:89`). |
| validate:salesperson-rendering | Missing scripts/manual-demo/test-interval-emails-with-salesperson.ts | Validator depends on removed demo script (`:167`). |
| validate:delivery-payment-payable-basis | 12/10/8 no-balance branches expected ONEWEEKCON dry-run | Tests need reconciliation with successful-notification prerequisite; do not relax prerequisite to pass. |
| validate:delivery-payment-interval-scenarios | Scenarios 17/18/19 expect ONEWEEKCON dry-run | Same evidence/fixture mismatch. |
| validate:8-day-hold-lifecycle | Expects dry-run default true | Old test conflicts with production-default code (`:87`). |

The 52-case 14/12/10/8 lifecycle suite passed, but some assertions are source-string checks, not end-to-end integration. Its labels also contain historical wording. Do not interpret that suite's `productionBlockers: 0` as a launch verdict.

Other checks:

- Delivery Prisma validate: PASS.
- Delivery migrate status: PASS, 35 migrations current in configured delivery DB.
- Queue migrate status: PASS, 14 migrations current in configured queue DB.
- Delivery TypeScript, lint, production build: PASS.
- Queue worker TypeScript build: PASS.
- Six queue delivery validators: PASS (confirmation, requested-date, hold, contact fetch, contact writeback, ten-day confirmation), with external network blocked.
- Local worker env validator: PASS; does not establish Azure/Vercel env state or thank-you gate readiness.
- Isolated PostgreSQL was stopped after tests. Initial old test port could not bind; alternate loopback port succeeded.

## Runtime evidence and limits

- DB read-only snapshot contains pending internal emails described above.
- Latest inspected failures include October 5 30/14/10/8 import-abort runs.
- OPS_REPORT/THANK_YOU scheduler query returned only successful OPS_REPORT rows for September 23/24; no THANK_YOU run rows. This does not prove email receipt or current worker uptime.
- No DeliveryConfirmation or grouped-attempt rows were returned by the corresponding aggregate snapshot. Prior history, deletes, or a different runtime target cannot be reconstructed from those absent records.
- Recap code targets `DELIVERY_OPERATIONS_REPORT_EMAIL` or james@mld.com after 17:00 Denver. It includes per-order sends, grouped membership/attempt evidence, customer responses, writebacks, failed/pending carryover, import results, and missing scheduled runs. No new recap was sent during this audit.
- Graph acceptance is not mailbox delivery. Current Graph code stores request-id, not an independently verified delivered message ID. SMS callback promotion is tested, but provider acceptance alone can authorize ONEWEEKCON under current rules. Decide whether verified delivery, rather than accepted submission, is required operationally.
- Azure CLI failed before querying with permission denied for `C:\Users\james\.azure\az.sess`. Image revisions, active replicas, deployed envs, and runtime logs therefore remain UNVERIFIED. No Azure settings changed.
- Actual SharePoint access, real ERP endpoint field mappings/PUT persistence, Twilio/Graph receipt, main-site rewrites, deployed base URL, browser form round-trips and callback signatures through the public proxy were not live-tested. Local subpath/signature/renderer tests passed, but they are not deployed proof.
- Existing uncommitted queue-repo customer-state work was preserved. Delivery code was clean before audit. No code fixes or production data edits were made.

## Recommended closure sequence

1. Approve fixes for internal email delivery, scheduler catch-up, primary-contact freshness, confirmation readback, and targeted unsent-event recovery. Retain fail-closed and dedupe protections.
2. Agree the exact two-field confirmation rule, 2-day page payment policy, dedicated versus ordinary hold, and whether Order Complete is in launch scope.
3. Repair the five stale validators and add behavioral regressions for each finding. Re-run all suites, including isolated grouped/contact/payment integration.
4. Refresh and verify all three stock sources. Investigate the actual import errors without retrying or deleting production events blindly.
5. Restore read-only Azure inspection; compare deployed commit/image/schema/envs for delivery worker, queue worker and Vercel. Verify no second scheduler path or replica configuration can unexpectedly duplicate work.
6. With separate send/write authorization, run a small named-contact acceptance matrix: singleton and grouped SMS/email; 42 Y/web/date; 41/40 progression; 39 salesperson receipt; terms/paid/unpaid 14/12/10; successful/failed 8 hold and internal email; 2-day delivery contact/fallback; thank-you and THANKYOU readback. Verify every affected ERP field/line by GET, not just queue success.
7. Verify same-day and next-day report receipts, missing-run warnings, late callbacks/writebacks and partial grouped failures. Remove the Conte restriction only as part of the approved broad go-live change.

No unrestricted launch approval should be inferred from this report. The remaining work is specific and testable, but deployed/live verification is still required after fixes.
