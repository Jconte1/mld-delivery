# Delivery Notification Historical Callback Correction

Status: read-only recommendation. No historical rows are changed in this phase.

## Known Condition

Before the delivered-callback fix, a controlled Twilio SMS attempt could receive a `DELIVERED` status callback while the related `NotificationAttempt.status` stayed `SUBMITTED`. The callback row still proves Twilio delivered the message, but event/attempt reporting remains stale.

## Candidate Definition

A candidate is a `NotificationAttempt` where:

- `channel = SMS`,
- `status = SUBMITTED`,
- `externalMessageId` is present,
- at least one linked `TwilioMessageStatusCallback` for the same message has `messageStatus = DELIVERED`,
- the attempt is controlled/test data, or otherwise explicitly approved for correction.

Do not include failed, undelivered, unmatched, or customer-production attempts without separate review.

## Read-Only Inspection

Use this shape from a SQL client or an approved read-only script:

```sql
SELECT
  a.id AS "attemptId",
  a."notificationEventId",
  a.status AS "attemptStatus",
  a."controlledRecipientMode",
  a."testRunId",
  a."externalMessageId",
  e.status AS "eventStatus",
  COUNT(c.id) AS "deliveredCallbackCount",
  MAX(c."receivedAt") AS "lastDeliveredCallbackAt"
FROM "notification_attempts" a
JOIN "notification_events" e ON e.id = a."notificationEventId"
JOIN "twilio_message_status_callbacks" c
  ON c."notificationAttemptId" = a.id
  AND UPPER(c."messageStatus") = 'DELIVERED'
WHERE a.channel = 'SMS'
  AND a.status = 'submitted'
  AND a."externalMessageId" IS NOT NULL
GROUP BY a.id, e.id
ORDER BY MAX(c."receivedAt") DESC;
```

Mask recipients in any report. Attempt IDs, event IDs, test run IDs, callback counts, and timestamps are enough for review.

## One-Time Correction Procedure

Only after explicit approval, use a reviewed one-time script that:

- starts from the read-only candidate list,
- updates only candidate `NotificationAttempt.status` to `DELIVERED`,
- sets `providerCode = DELIVERED`,
- preserves `externalMessageId`,
- sets `sentAt` only if the existing schema has no separate delivered timestamp,
- updates the related event to the existing successful final state only if no newer failed or superseding attempt exists,
- writes an audit note/manifest with before and after counts,
- refuses to run without an exact confirmation phrase.

No correction should call Twilio, send notifications, write Acumatica, place holds, or alter delivery data.

