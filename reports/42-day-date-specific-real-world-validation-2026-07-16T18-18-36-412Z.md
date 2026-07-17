# 42-Day Date-Specific Confirmation Validation

Generated: 2026-07-16T18:18:36.412Z
Run date: 2099-01-01
Target delivery date: 2099-02-12
Method: Rollback-only representative fixtures executed through create42DayDeliveryConfirmationEvents.
Diagnostic rolled back: yes

## A. What Qualifies

- Active delivery groups whose delivery date equals runDate + 42 days are considered.
- Completed/cancelled group/order statuses and blocked/manual-review lifecycle statuses are filtered before channel selection.
- If eligible and not already confirmed for the same delivery group/date, SMS is preferred when available, then email.

## B. What Disqualifies Before Channel Selection

- Completed, canceled/cancelled, or closed order/group status.
- Internal lifecycle status BLOCKED, MANUAL_REVIEW, COMPLETED, or CANCELLED.

## C. What Creates A SKIPPED Event Instead Of SCHEDULED

- Same deliveryGroupId + deliveryDate has DeliveryConfirmation.status = CONFIRMED.
- No automated SMS/email channel is available.

## D. Same-Date Already Confirmed

- Passed: true
- Reason: already_confirmed_for_delivery_date

## E. Old-Date Confirmed, New-Date Target

- Passed: true
- New date status: SCHEDULED

## F. No-Channel Behavior

- Passed: true
- Reason: no_automated_channel_available

## G. Ineligible Orders

- Passed: true
- Skipped before event creation: 4

## H. Acumatica Confirmation Fields

- CONFIRMVIA / CONFIRMWTH / CONFIRMWITH are not imported or stored in delivery.
- They are not used as 42-day skip conditions.

## I. Remaining Business Questions

- If the exact same delivery date disappears and later reappears, current behavior reuses the same order/date delivery group. That means an existing confirmation for that same group/date still applies. Confirm this remains desired.

## Scenario Results

### newTargetNoConfirmation

Passed: true

```json
{
  "status": "SCHEDULED",
  "selectedChannel": "SMS",
  "reasonSkipped": null,
  "scheduledAt": "2099-01-01T00:00:00.000Z",
  "alreadyConfirmedForDeliveryDate": false,
  "linkTokenPresent": true,
  "confirmationStatus": "PENDING",
  "confirmationDeliveryDate": "2099-02-12"
}
```

### sameDateAlreadyConfirmed

Passed: true

```json
{
  "status": "SKIPPED",
  "reasonSkipped": "already_confirmed_for_delivery_date",
  "selectedChannel": null,
  "recipientEmail": null,
  "recipientPhone": null,
  "scheduledAt": null,
  "alreadyConfirmedForDeliveryDate": true,
  "linkTokenPresent": false,
  "confirmationStatus": "CONFIRMED",
  "confirmationDeliveryDate": "2099-02-12",
  "confirmationLinkToken": null
}
```

### oldDateConfirmedNewDate

Passed: true

```json
{
  "oldConfirmationStatus": "CONFIRMED",
  "oldConfirmationDeliveryDate": "2099-01-15",
  "newEventStatus": "SCHEDULED",
  "newEventReasonSkipped": null,
  "newEventSelectedChannel": "SMS",
  "newReportAlreadyConfirmed": false,
  "newConfirmationStatus": "PENDING",
  "newConfirmationDeliveryDate": "2099-02-12"
}
```

### sameDateDisappearsAndReappears

Passed: true

```json
{
  "originalDeliveryGroupId": "cmrnu1hnd000etwmbsq25q68j",
  "reappearedDeliveryGroupId": "cmrnu1hnd000etwmbsq25q68j",
  "sameDeliveryGroupIdReused": true,
  "isActiveAfterReappear": true,
  "confirmationStillApplied": true,
  "eventStatus": "SKIPPED",
  "reasonSkipped": "already_confirmed_for_delivery_date",
  "alreadyConfirmedForDeliveryDate": true,
  "businessRuleConfirmationPoint": "Current behavior treats same deliveryGroupId + same deliveryDate as the same confirmation scope after reactivation."
}
```

### acumaticaMetadataAloneDoesNotBlock

Passed: true

```json
{
  "applicable": false,
  "reason": "CONFIRMVIA/CONFIRMWTH/CONFIRMWITH are not imported or stored in delivery, and code search found no 42-day skip logic based on those fields."
}
```

### noAutomatedChannel

Passed: true

```json
{
  "status": "SKIPPED",
  "reasonSkipped": "no_automated_channel_available",
  "selectedChannel": null,
  "recipientEmail": null,
  "recipientPhone": null,
  "scheduledAt": null,
  "alreadyConfirmedForDeliveryDate": false,
  "deliveryConfirmationCreated": false
}
```

### ineligibleOrders

Passed: true

```json
{
  "ineligibleFixtureCount": 4,
  "ineligibleSkippedCount": 4,
  "notificationEventsCreatedForIneligibleOrders": 0,
  "orderNumbers": [
    "D42RW1784225912644-G-COMPLETED",
    "D42RW1784225912644-G-CANCELLED",
    "D42RW1784225912644-G-BLOCKED",
    "D42RW1784225912644-G-MANUAL"
  ],
  "behavior": "Ineligible delivery groups are excluded before notification_event creation."
}
```

### dedupeAndOutput

Passed: true

```json
{
  "firstRunEventsCreated": 5,
  "secondRunEventsCreated": 0,
  "secondRunEventsDeduped": 5,
  "notificationEventsForEligibleFixtures": 5,
  "dedupeKeys": [
    "delivery_notification:TS:D42RW1784225912644-A-NEW:2099-02-12:DAY_42:DELIVERY_CONFIRMATION_REQUEST",
    "delivery_notification:TS:D42RW1784225912644-B-CONFIRMED:2099-02-12:DAY_42:DELIVERY_CONFIRMATION_REQUEST",
    "delivery_notification:TS:D42RW1784225912644-C-MOVED:2099-02-12:DAY_42:DELIVERY_CONFIRMATION_REQUEST",
    "delivery_notification:TS:D42RW1784225912644-D-REAPPEAR:2099-02-12:DAY_42:DELIVERY_CONFIRMATION_REQUEST",
    "delivery_notification:TS:D42RW1784225912644-F-NOCHANNEL:2099-02-12:DAY_42:DELIVERY_CONFIRMATION_REQUEST"
  ],
  "deliveryDateInDedupeKey": true,
  "channelInDedupeKey": false,
  "reportsIncludeAlreadyConfirmedForDeliveryDate": true
}
```

### notificationAttemptsUntouched

Passed: true

```json
{
  "notificationAttemptsForFixtureEvents": 0
}
```

## Safety Counts

```json
{
  "before": {
    "notificationEvents": 46,
    "deliveryConfirmations": 39,
    "notificationAttempts": 0
  },
  "after": {
    "notificationEvents": 46,
    "deliveryConfirmations": 39,
    "notificationAttempts": 0
  },
  "unchanged": true
}
```
