# Delivery Notification Test Data Cleanup Plan

Status: preview only. No cleanup is approved in this phase.

The cleanup entry point is:

```powershell
npm.cmd run cleanup:delivery-notification-test-data -- --preview
```

The script reports aggregate candidate counts only. It does not print customer names, emails, phone numbers, or full message bodies.

## Candidate Buckets

The preview currently identifies:

- controlled-recipient `NotificationAttempt` rows,
- `NotificationEvent` rows linked to controlled-recipient attempts,
- disposable `LIVE42-` notification events,
- disposable `live42_` delivery confirmations,
- Twilio callback rows linked to controlled events or disposable live42 confirmations,
- Twilio inbound rows linked to disposable live42 confirmations,
- delivery hold-action test rows linked to controlled events.

Optional exact filters:

```powershell
npm.cmd run cleanup:delivery-notification-test-data -- --preview --test-run-id controlled_20260820_60_one_send
```

## Future Apply Requirements

Before any cleanup can be enabled:

- take a production database backup/export,
- review candidate IDs and counts from preview,
- use exact `--test-run-id` filters where possible,
- set `DELIVERY_NOTIFICATION_TEST_DATA_CLEANUP_CONFIRM_PHRASE`,
- pass `--apply --confirm "<phrase>"`,
- keep broad deletes blocked for production-looking data.

In this phase `--apply` intentionally refuses even with a correct phrase.

