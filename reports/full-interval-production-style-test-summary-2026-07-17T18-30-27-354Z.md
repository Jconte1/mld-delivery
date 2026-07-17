# Full Delivery Interval Production-Style Smoke

Run date: 2026-07-17

Durable event/dedupe note: this run created or reused real notification_events for matching delivery groups. These events may dedupe future runs for the same order/date/interval/action combinations. This is accepted for this controlled pre-go-live test.

Provider safety: only NOTIFICATIONS_TEST_EMAIL and NOTIFICATIONS_TEST_PHONE were used as provider recipients. Both email and SMS were sent only as controlled test-recipient overrides; normal production channel policy remains SMS-first with email fallback.

## Intervals

### 180-day reminder
- Target delivery date: 2027-01-13
- Qualifying orders fetched: 0
- Full orders fetched/imported: 0
- Failed orders: 0
- Active delivery groups: 0
- Scheduled events: 0
- Skipped events: 0
- Report: reports\180-day-production-style-test-2026-07-17T18-30-27-354Z.json

### 90-day reminder
- Target delivery date: 2026-10-15
- Qualifying orders fetched: 4
- Full orders fetched/imported: 1
- Failed orders: 0
- Active delivery groups: 1
- Scheduled events: 1
- Skipped events: 0
- Report: reports\90-day-production-style-test-2026-07-17T18-30-27-354Z.json

### 60-day reminder
- Target delivery date: 2026-09-15
- Qualifying orders fetched: 334
- Full orders fetched/imported: 20
- Failed orders: 0
- Active delivery groups: 17
- Scheduled events: 17
- Skipped events: 0
- Report: reports\60-day-production-style-test-2026-07-17T18-30-27-354Z.json

### 42-day confirmation request
- Target delivery date: 2026-08-28
- Qualifying orders fetched: 982
- Full orders fetched/imported: 35
- Failed orders: 0
- Active delivery groups: 26
- Scheduled events: 23
- Skipped events: 2
- Report: reports\42-day-production-style-test-2026-07-17T18-30-27-354Z.json

## 42-Day Confirmation
- Confirmation link: https://mld-delivery.vercel.app/delivery/confirm/dc42_780e6388eb68ee533d101b7463000a63ad56abd0c1f0ed57
- Azure allowed writeback order: SO37860
- Selected 42 order: BPB00378
- Guard will block selected 42 writeback: true

## Safety Counts
```json
{
  "before": {
    "notificationEvents": 47,
    "notificationAttempts": 0,
    "deliveryConfirmations": 40
  },
  "after": {
    "notificationEvents": 90,
    "notificationAttempts": 0,
    "deliveryConfirmations": 63
  }
}
```