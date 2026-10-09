# Isolated delivery scenario validation - October 9, 2026

## Verdict

58 selected validation suites passed after the test/report fixes below. Prisma validation, TypeScript, ESLint and the production build also passed.

This is an isolated code/database validation result, not an unconditional production go-live approval. These suites mix behavioral tests, actual PostgreSQL integration tests, renderer tests and source-code assertions. They are not 58 live end-to-end tests.

No live SMS/email, external queue submissions, ERP writes, holds, deployments, Azure worker changes or production database mutations were performed. Workers were not required or started.

## What the scenarios mean

1. **Money already paid:** Start with the customer's deposit, subtract value already shipped/completed, then see whether what remains covers this delivery. Coverage means no additional payment request; insufficient coverage invokes the remaining-open-value calculation. Separate cases exercise taxes, partial shipments and invalid/ambiguous inputs.
2. **Same balance everywhere:** 14/12/10/8 copy uses the evaluated current amount. The 8-day message must not repeat a stale amount saved when the hold was created. Zero/invalid amounts must not be rendered as valid demands. Renderer/component tests passed; this was not a deployed-browser comparison.
3. **No premature payment content:** 42/41/40 confirmation content and 2-day final reminders omit payment content. The agreed 30-day copy remains separate and unchanged.
4. **No confirmation without notification evidence:** A paid or non-prepay order does not earn ONEWEEKCON merely because its payment calculation passes. An eligible accepted notification is also required. Acceptance is not proof a person read the message.
5. **One message, several orders:** Matching orders can share a notification. Each order keeps its own payment decision and writeback. If two are paid and one owes money, the third does not inherit the others' clearance.
6. **An order moves after grouping:** Old membership/date validation rejects stale group actions. Tests also check differing contacts, addresses and reminder stages so unrelated orders are not merged.
7. **Nobody responds:** The initial request, first reminder and final reminder are counted using send history. Missing touches catch up before ordinary internal escalation. Replies, ERP confirmation or a changed delivery date stop inappropriate follow-ups.
8. **Fresh contacts only:** Missing/failed/mismatched primary-contact fetches block stale sends. Two-day reminders prefer the delivery contact and fall back to a freshly fetched primary contact when required. Removed recipients are not silently retained.
9. **STOP and email opt-out:** 40 simulated STOPs and 40 email opt-outs blocked the corresponding channel. Five SMS and five email opted-in controls remained eligible. Global opt-outs and shared-address contacts were also exercised.
10. **Two workers act at once:** Five grouped-send claimants produced one winning attempt. Eight internal-email claimants produced one simulated send. The database, not timing assumptions, arbitrates the claim.
11. **Provider outcomes arrive out of order:** Queued/sent are not delivered; delivered promotes status; late queued/sent callbacks cannot downgrade it. Failure, duplicate and unmatched callback paths were exercised with fake requests.
12. **A stock refresh fails midway:** The old list remains consistent because partial updates roll back. Same-region concurrent refreshes are blocked; different regions can proceed independently. Freshness and warehouse mapping still control use of a stock list.
13. **An old link is opened:** Expiration follows the delivery date in Denver, including daylight-saving boundaries and legacy blank expiresAt values. Changed/inactive membership is rejected separately; expiration does not grant extra confirmation permissions.
14. **The recap must be believable:** It retains order-level detail for shared sends, later-day responses and writeback outcomes, and does not label a failed internal email accepted merely because Graph returned a diagnostic request ID.

## Changes made in this pass

- `scripts/validate-contact-opt-in-mapping.ts`: replaced stale assertions expecting missing contact fields to preserve older recipient/opt-in data. Assertions now match authoritative fresh Contact updates and failed-primary-fetch exclusion.
- `scripts/validate-opt-out-volume-and-send-gating.ts`: added `--isolated-fixtures`, restricted to the explicitly named local validation database. Supplies 100 synthetic contacts with an unused fictional telephone block and example.invalid emails. Missing controls/global cohorts or incomplete cleanup now fail the command instead of returning apparent success.
- `lib/notifications/deliveryOperationsAudit.ts`: internal-email acceptance now requires SENT status and sentAt, not merely a Graph request ID.
- `scripts/validate-delivery-operations-report.ts`: rejected and uncertain Graph requests are not accepted; a successful send need not include a request ID.
- `scripts/validation-network-guard.cjs`: validation-only preload blocks fetch by default and non-test-database socket connections. Tests explicitly substitute fake provider/queue responses where needed.
- This report. Existing unrelated/prior implementation work was preserved.

The first opt-out pass lacked enough email/control fixtures. The first fixture retest collided with pre-existing local test phone data. The final isolated fixture run selected a noncolliding fictional block and exercised all requested cohorts successfully. These were test-data issues, not evidence of production opt-outs being bypassed.

## How tests were executed

Validation scripts were executed directly with `node --import tsx`, without dotenv preloading, against:
`127.0.0.1:25439/delivery_group_validation_contacts`.

`DATABASE_URL` and `TEST_DELIVERY_GROUP_DATABASE_URL` both pointed there. `NODE_OPTIONS` preloaded `scripts/validation-network-guard.cjs`. Direct Node execution avoided a Windows tsx-launcher IPC problem with the network guard; the underlying registered validation scripts were unchanged except for the fixes above.

The volume test was run with `--isolated-fixtures`. The final pass removed its fixture contacts, opt-outs, inbound rows and writeback actions, and left notification event/attempt counts unchanged. Other database suites use their own rollback/cleanup mechanisms; the grouped workflow suite retains local page fixtures intentionally. This is not a claim that the local database is empty.

## Test-by-test results

The command names identify the package scripts whose underlying validation files were executed.

| # | Validation | Scenario and expected behavior | Evidence type | Result |
| --- | --- | --- | --- | --- |
| 1 | `validate:delivery-notification-grouping` | Grouping: Same contact, date, address, channel and notification purpose can share a message; incompatible orders remain separate. | Pure rules | PASS |
| 2 | `validate:delivery-notification-group-lifecycle` | Grouped send lifecycle: Changed membership and in-flight/uncertain sends cannot silently create a second send. | In-memory scenarios | PASS |
| 3 | `validate:delivery-notification-group-store` | Grouped storage: Two member events share one attempt; partial claims roll back and callbacks update members without downgrading delivered status. | Transactional fake | PASS |
| 4 | `validate:delivery-notification-group-use-cases` | Grouped use cases: Two paid orders and one unpaid order retain separate payment decisions; moving a date or changing reminder stage separates orders. | Pure rules | PASS |
| 5 | `validate:delivery-notification-group-database` | Grouped database concurrency: Five callers compete for the same group: only one claims its attempt. Callback-before-response and rollback constraints also pass. | Isolated PostgreSQL; fake providers | PASS |
| 6 | `validate:delivery-notification-group-workflows` | Grouped customer workflows: One web/SMS action fans out to each valid member; duplicate responses do not repeat jobs; moved members block stale actions; partial writeback outcomes remain visible. | Isolated PostgreSQL; fake queue/providers | PASS |
| 7 | `validate:delivery-contact-routing` | Primary/delivery contacts: 2-day uses delivery contact with fresh-primary fallback; other intervals use primary. Missing/mismatched primary fetch fails closed and removed recipients clear stale values. | Isolated PostgreSQL; fake ERP | PASS |
| 8 | `validate:delivery-scheduler-wrapper` | Scheduler: Denver date/time, DST, lock, retry and delegation rules are exercised without running real intervals. | Mocks and source checks | PASS |
| 9 | `validate:delivery-notification-worker` | Worker: Due intervals, once/scoped behavior, catch-up, 39 routing and failure isolation are checked. | Mocks and source checks | PASS |
| 10 | `validate:internal-notification-dispatcher` | Internal email dispatcher: Valid pending internal emails are claimed once; invalid recipients, ambiguous outcomes and explicit retry rules are handled. | Fake DB/provider | PASS |
| 11 | `validate:internal-notification-dispatcher-database` | Internal database concurrency: Eight callers compete for one internal email: one simulated send wins, unrelated backlog is untouched. | Isolated PostgreSQL; fake provider | PASS |
| 12 | `validate:unsent-event-recovery` | Unsent event recovery: An untouched scheduled event can be recovered in place; attempted, stale or changed-date events cannot be broadly resent. | Isolated PostgreSQL; injected creator/provider | PASS |
| 13 | `validate:order-thank-you` | Thank-you basics: Report parsing, delivery/will-call classification, wording and exact-minute enablement are tested. This does not exercise the full send/writeback lifecycle. | Pure rules/renderers | PASS |
| 14 | `validate:delivery-operations-report` | Daily recap: Late replies, grouped sends, queue outcomes, masked recipients, failures, DST cutoffs and Excel attachment generation are checked. A rejected Graph request ID is not acceptance. | Pure aggregation; mocked Graph | PASS |
| 15 | `validate:delivery-subpath-routing` | Public links: Public /delivery links avoid doubled prefixes and preserve supported routes. | URL helpers/source checks | PASS |
| 16 | `validate:delivery-interval-fresh-import-fail-closed` | Fresh-import protection: Global import failure stops work; per-order failures exclude stale orders across all ten intervals. | Mock ERP/creators; source checks | PASS |
| 17 | `validate:delivery-interval-limited-apply` | Limited event apply: Only selected qualified candidates can create the limited current-run event set. | Mocks | PASS |
| 18 | `validate:delivery-notification-dispatcher` | Dispatcher: Real-contact eligibility, opt-outs, claims, provider status handling and callback promotion are checked without real sends. | Mocks/source checks | PASS |
| 19 | `validate:contact-opt-in-mapping` | Contact opt-in mapping: Opt-in, opt-out, blank and legacy values are interpreted consistently; fresh Contact data, not old order recipient fields, controls eligibility. | Pure mapping/source checks | PASS |
| 20 | `validate:opt-out-volume-and-send-gating` | Opt-out volume: 40 STOPs and 40 email opt-outs block sends; 5 SMS and 5 email controls remain eligible; global and duplicate-address opt-outs work. | Isolated PostgreSQL; 100 synthetic contacts; fake queue | PASS |
| 21 | `validate:contact-opt-out-writeback` | Contact opt-out writeback: STOP/email opt-out updates local flags, handles shared addresses and records writeback outcomes; queue failure does not remove local blocking. | Mocks | PASS |
| 22 | `validate:delivery-date-eligibility` | Delivery-date eligibility: Allowed route weekdays, later-date requirements and invalid date rejection are exercised. | Pure rules | PASS |
| 23 | `validate:delivery-requested-date-writeback` | Requested-date payload: Only the intended member line numbers and requested date enter the writeback payload; missing line identity is rejected. | Payload tests; no ERP PUT/GET | PASS |
| 24 | `validate:twilio-inbound-sms-foundation` | Twilio inbound: Y/N/date/STOP/START/HELP, invalid signatures, unmatched/ambiguous senders, duplicate messages and status callbacks are handled. | Fake requests/DB/queue | PASS |
| 25 | `validate:delivery-details-link-safety` | Details-link wiring: Details links are tied to the intended order/group and use the expiration guard. | Source/helper checks | PASS |
| 26 | `validate:delivery-details-expiration` | Details-link expiration: Delivery-date-based expiry, Denver midnight/DST, legacy null expiry and inactive/moved groups are exercised. | Pure rules/source checks | PASS |
| 27 | `validate:30-day-notification` | 30-day creation: Production qualification creates or skips the expected reminder without dispatching it. | Fake client | PASS |
| 28 | `validate:30-day-rendering` | 30-day rendering: The agreed 30-day wording and message structure remain intact. | Real renderers; fixture data | PASS |
| 29 | `validate:customer-rendering-rules` | Customer rendering: Customer-facing content follows item/readiness and interval copy rules. | Real renderers/helpers; fixture data | PASS |
| 30 | `validate:customer-payment-presentation` | Customer payment presentation: 14/12/10/8 expose the current balance consistently; 42/41/40 and 2 omit payment content; 8-day uses current evaluation rather than an old hold amount. | Real renderers/components plus source checks; not browser E2E | PASS |
| 31 | `validate:delivery-group-payment-scenarios` | Payment database scenarios: 17 rollback-only cases cover deposit coverage, shipped value, taxes, partial fulfillment and invalid payment bases. | Isolated PostgreSQL; rolled-back fixtures | PASS |
| 32 | `validate:delivery-payment-payable-basis` | Payable-basis calculation: Deposit covers the current delivery before 45% rules apply; completed/shipped value consumes coverage; uncovered orders use the remaining-open calculation. | Pure financial scenarios | PASS |
| 33 | `validate:delivery-payment-interval-scenarios` | Payment interval integration: Payment outcomes drive interval behavior using the shared payable result. | Mocks/helpers | PASS |
| 34 | `validate:14-12-10-8-lifecycle-scenarios` | 14/12/10/8 lifecycle: 52 scenarios check prepaid/non-prepaid, paid/unpaid, readiness and lifecycle integration. | Mixed mocked behavior/source assertions | PASS |
| 35 | `validate:one-week-confirmation-foundation` | ONEWEEKCON foundation: Confirmation state and writeback payload foundations are validated. | Helpers/source checks | PASS |
| 36 | `validate:one-week-confirmation-intervals` | ONEWEEKCON interval integration: Payment clearance alone is insufficient: eligible accepted customer-send evidence is required for confirmation writeback. | Mocks/integration checks | PASS |
| 37 | `validate:14-day-notification` | 14-day creation: 14-day qualification and event decisions are exercised without sending. | Fake client | PASS |
| 38 | `validate:14-day-rendering` | 14-day rendering: SMS/email wording and relevant balance presentation render from fixture data. | Real renderers | PASS |
| 39 | `validate:42-day-notification` | 42-day creation/attributes: CONFIRMVIA normalization, initial-request eligibility wiring and WEBPAGE/AUTOTXT writeback values are checked. | Helpers/source checks | PASS |
| 40 | `validate:42-day-confirmation-no-response` | No-response core: Initial request, reminder 1, final reminder and escalation follow the three-touch sequence. | Fake client | PASS |
| 41 | `validate:42-day-confirmation-no-response-scenarios` | No-response edge cases: Missing touches catch up; manual confirmation, replies, changed dates, no channel and duplicate runs suppress inappropriate follow-ups. | Fake ERP/DB; no real sends | PASS |
| 42 | `validate:payment-deadline-business-days` | Payment deadline dates: Payment deadlines use exact calendar-day offsets rather than silently moving notification timing for weekends. | Pure date rules | PASS |
| 43 | `validate:12-day-notification` | 12-day creation: 12-day payment reminder qualification and import failure exclusions are exercised. | Fake client | PASS |
| 44 | `validate:12-day-rendering` | 12-day rendering: 12-day payment SMS/email content is rendered from fixture data. | Real renderers | PASS |
| 45 | `validate:10-day-notification` | 10-day creation: 10-day payment reminder qualification and import failure exclusions are exercised. | Fake client | PASS |
| 46 | `validate:10-day-rendering` | 10-day rendering: 10-day payment SMS/email content is rendered from fixture data. | Real renderers | PASS |
| 47 | `validate:8-day-foundation` | 8-day foundation: Hold/internal-notification models, purposes and dedupe fields are checked. | Schema/source checks | PASS |
| 48 | `validate:8-day-notification` | 8-day creation: Unpaid enforcement creates customer hold copy only after the simulated hold succeeds; failed imports are excluded. | Fake ERP/DB/queue | PASS |
| 49 | `validate:8-day-rendering` | 8-day rendering: Customer hold wording and internal success/failure emails use the appropriate content. | Real renderers | PASS |
| 50 | `validate:8-day-hold-lifecycle` | 8-day hold lifecycle: Pending/queued/succeeded/failed/skipped hold outcomes are recorded without mutating dates or lines. | Mock queue/DB | PASS |
| 51 | `validate:2-day-notification` | 2-day creation: 2-day reminder qualification, fresh import and event creation are checked. | Fake client | PASS |
| 52 | `validate:2-day-one-week-qualification` | 2-day confirmation qualification: Required one-week confirmation evidence controls 2-day eligibility. | Helpers/integration checks | PASS |
| 53 | `validate:2-day-rendering` | 2-day rendering: Final reminder copy renders without customer payment content. | Real renderers | PASS |
| 54 | `validate:order-delivery-group-line-membership` | Delivery membership: Only explicit active deliverable item membership drives readiness, payment and targeting; non-stock/service lines are excluded. | Pure/source checks | PASS |
| 55 | `validate:weekend-delivery-date-notification` | Weekend notification runs: Saturday/Sunday notification runs proceed, while invalid weekend delivery dates remain ineligible. | Fake creators/date rules | PASS |
| 56 | `validate:sharepoint-stock-sync` | Regional stock import: Valid sheets upsert/deactivate the appropriate regional source; invalid sheets/columns fail safely. | Fake workbook/DB | PASS |
| 57 | `validate:sharepoint-stock-atomicity` | Stock transaction atomicity: Mid-import or success-log failure rolls back all rows; readers see a consistent list; same-region concurrency is excluded and different regions remain independent. | Isolated PostgreSQL; fake downloads | PASS |
| 58 | `validate:sharepoint-stock-readiness-integration` | Stock readiness: Only fresh stock lists for the item's mapped warehouse affect readiness/payment; stale or missing syncs do not. | Mock lookup; real evaluation helpers | PASS |

## Quality gates

| Check | Result |
| --- | --- |
| `npm.cmd exec -- prisma validate` | PASS |
| `npm.cmd exec -- tsc --noEmit` | PASS |
| `npm.cmd run lint` | PASS after documenting CommonJS preload import |
| `npm.cmd run build` | PASS; Prisma generation and Next production build |

No production migration status or deployed revision was verified during this isolated pass.

## Limits and remaining readiness work

- **Live integration remains unverified in this pass.** Confirm the deployed app/worker revision, migrations and settings before a scoped, approved test. Use only James's test contact for actual sends, then inspect provider callbacks and ERP GET readback.
- **Thank-you coverage is limited.** Its 17-case script covers parsing/classification/copy and schedule gating, not real database claims, uncertain provider outcomes or queue reconciliation. Code inspection found areas needing dedicated regression tests before approving that flow: eligibility is initially based on the report before the full-order read; the event upsert can reset status before claiming; failed attempts are retryable; reconciliation treats a top-level queue succeeded status as written without inspecting result verification. These are review concerns, not failures reproduced by the 58 selected suites. No thank-you production behavior was changed in this pass.
- **Queue worker write implementations were not exercised.** Payload tests and simulated queue results do not prove Acumatica persistence, allowlists, endpoint compatibility, holds or contact-attribute writes.
- **Web browser verification was not performed.** Components, renderers, URL helpers and route source checks passed, but deployed screenshots, actual form redirects and human interactions still need the scoped live check.
- **Stock source access/scheduling was not tested live.** Paused-worker staleness was expected. The tests used fake workbooks and local transactions, not SharePoint downloads.
- **Order Complete remains deferred.** Salesperson refresh behavior was not changed.

## Next operational gate

Do not use the passing suite count as permission for broad customer sends. Close the thank-you lifecycle coverage concerns, then verify the deployed revision and run the agreed scoped live checks with James as recipient. Record actual SMS/email delivery evidence and per-order ERP readback separately from this isolated report.

