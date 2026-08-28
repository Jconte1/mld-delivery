# Delivery Notification Script Inventory

Status: package script targets audited on 2026-08-24. No current package script points to a missing `scripts/...` file.

## Production Creation And Runtime

- `sync:sharepoint-stock`
- `create:180-day-delivery-reminder-events`
- `create:90-day-delivery-reminder-events`
- `create:60-day-delivery-reminder-events`
- `create:42-day-delivery-confirmation-events`
- `create:30-day-delivery-reminder-events`
- `create:14-day-delivery-reminder-events`
- `create:12-day-delivery-payment-request-events`
- `create:10-day-delivery-payment-request-events`
- `create:8-day-payment-enforcement-events`
- `create:2-day-delivery-reminder-events`
- `run:42-day-confirmation-no-response`
- `dispatch:delivery-notifications`

Production dispatcher sends are still gated by `DELIVERY_REAL_CUSTOMER_SEND_ENABLED=true`. Controlled-recipient test envs are not a production send path.

`run:delivery-interval` supports real production creation/dispatch for 180, 90, 60, and the initial 42-day confirmation request. The 42-day path dispatches only the exact event ids created by the current run and does not run no-response follow-up.

`run:42-day-confirmation-no-response` supports the separate 41/40/39 no-response lifecycle. Send mode requires `RUN REAL 42 DAY NO RESPONSE FOLLOW UPS`, dispatches only customer reminder events created by that run, and leaves old scheduled `DAY_42` events untouched. The 39-day salesperson escalation currently uses `InternalNotificationEvent` as a review queue; inspect it with `review:42-day-no-response-internal-escalations`.

## Preview And Controlled Testing

- `test:delivery-intervals:production-style`
- `cleanup:delivery-notification-test-data`
- `preview:contact-opt-in-mapping`
- `refresh:contact-opt-ins`
- `run:42-day-no-response-real-order-dry-run`
- `test:42-day-special-date-rules`

`cleanup:delivery-notification-test-data` is preview-only in this phase. Apply mode intentionally refuses.

## Validation And Inspection

- `validate:delivery-notification-dispatcher`
- `review:42-day-no-response-internal-escalations`
- `validate:sharepoint-stock-sync`
- `validate:sharepoint-stock-readiness-integration`
- `validate:salesperson-contact-sync`
- `validate:salesperson-import`
- `validate:contact-opt-in-mapping`
- `validate:opt-out-volume-and-send-gating`
- `validate:contact-opt-out-writeback`
- `validate:salesperson-rendering`
- `validate:delivery-date-eligibility`
- `validate:twilio-inbound`
- `validate:twilio-inbound-sms-foundation`
- `validate:delivery-details-link-safety`
- `validate:customer-rendering-rules`
- `validate:delivery-group-payment-scenarios`
- `validate:delivery-payment-payable-basis`
- `validate:delivery-payment-interval-scenarios`
- `validate:one-week-confirmation-foundation`
- `validate:one-week-confirmation-intervals`
- all interval-specific `validate:*notification*` and rendering scripts.

## Manual/Demo/Deprecated

The obsolete `manual-demo:test-interval-emails-with-salesperson` package script was removed because it targeted a deleted demo file.

The remaining `scripts/manual-demo/demoNotificationDispatch.ts` helper is kept only because `run-42-day-special-date-rule-test.ts` imports it. It remains quarantined under `scripts/manual-demo/` and requires demo send guards before any provider call.
