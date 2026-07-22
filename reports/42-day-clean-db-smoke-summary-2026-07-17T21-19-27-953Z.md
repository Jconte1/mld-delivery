# 42-Day Clean DB Production-Style Smoke

Run date: 2026-07-17
42-day target date: 2026-08-28
RequestedOn import timestamp: 2026-08-28T09:19:00.000Z

## Counts
```json
{
  "beforeClearCounts": {
    "contacts": 70,
    "orders": 95,
    "order_totals": 95,
    "order_tax_details": 157,
    "order_lines": 1865,
    "order_line_allocations": 2050,
    "order_addresses": 95,
    "order_delivery_groups": 209,
    "delivery_confirmations": 63,
    "notification_events": 90,
    "notification_attempts": 0,
    "sms_opt_outs": 0,
    "email_opt_outs": 0
  },
  "tablesCleared": {
    "notification_attempts": 0,
    "delivery_confirmations": 63,
    "notification_events": 90,
    "order_delivery_groups": 209,
    "order_line_allocations": 2050,
    "order_lines": 1865,
    "order_addresses": 95,
    "order_tax_details": 157,
    "order_totals": 95,
    "orders": 95,
    "contacts": 70
  },
  "afterClearCounts": {
    "contacts": 0,
    "orders": 0,
    "order_totals": 0,
    "order_tax_details": 0,
    "order_lines": 0,
    "order_line_allocations": 0,
    "order_addresses": 0,
    "order_delivery_groups": 0,
    "delivery_confirmations": 0,
    "notification_events": 0,
    "notification_attempts": 0,
    "sms_opt_outs": 0,
    "email_opt_outs": 0
  },
  "afterImportCounts": {
    "contacts": 18,
    "orders": 26,
    "order_totals": 26,
    "order_tax_details": 46,
    "order_lines": 879,
    "order_line_allocations": 969,
    "order_addresses": 26,
    "order_delivery_groups": 76,
    "delivery_confirmations": 23,
    "notification_events": 25,
    "notification_attempts": 0,
    "sms_opt_outs": 0,
    "email_opt_outs": 0
  },
  "notificationAttemptsAfterSend": 0
}
```

## Import
```json
{
  "requestedOn": "2026-08-28",
  "qualifyingOrdersFetched": 982,
  "fullOrdersFetched": 35,
  "contactsUpserted": 26,
  "ordersCreated": 26,
  "ordersUpdated": 0,
  "totalsUpserted": 26,
  "taxDetailsUpserted": 46,
  "linesUpserted": 879,
  "allocationsUpserted": 969,
  "addressesUpserted": 26,
  "deliveryGroupsUpserted": 76,
  "changeEventsDetected": 0,
  "changeEventsCreated": 0,
  "changeEventsDeduped": 0,
  "skippedOrders": 9,
  "failedOrders": 0,
  "errors": [
    {
      "orderNumber": "BQ00950",
      "orderType": "BQ",
      "reason": "Full SalesOrder payload is missing required ContactID"
    },
    {
      "orderNumber": "C106379",
      "orderType": "C1",
      "reason": "Full SalesOrder payload is missing required ContactID"
    },
    {
      "orderNumber": "BPB00384",
      "orderType": "PB",
      "reason": "Full SalesOrder payload is missing required ContactID"
    },
    {
      "orderNumber": "PL02487",
      "orderType": "PL",
      "reason": "Full SalesOrder payload is missing required ContactID"
    },
    {
      "orderNumber": "SO39711",
      "orderType": "SO",
      "reason": "Full SalesOrder payload is missing required ContactID"
    },
    {
      "orderNumber": "SO39723",
      "orderType": "SO",
      "reason": "Full SalesOrder payload is missing required ContactID"
    },
    {
      "orderNumber": "SO39749",
      "orderType": "SO",
      "reason": "Full SalesOrder payload is missing required ContactID"
    },
    {
      "orderNumber": "SO40201",
      "orderType": "SO",
      "reason": "Full SalesOrder payload is missing required ContactID"
    },
    {
      "orderNumber": "SRV01822",
      "orderType": "SV",
      "reason": "Full SalesOrder payload is missing required ContactID"
    }
  ]
}
```

## Events
```json
{
  "eventsCreated": 25,
  "eventsDeduped": 0,
  "eventsSkipped": 2,
  "scheduledEvents": 23,
  "skippedReasons": {
    "no_automated_channel_available": 2
  },
  "confirmationsCreatedOrReused": 23,
  "confirmationsCreated": 23,
  "confirmationsReused": 0,
  "notificationEventCounts": {
    "scheduled": 23,
    "skipped": 2,
    "skippedByReason": {
      "no_automated_channel_available": 2
    },
    "groupedRows": [
      {
        "_count": {
          "_all": 23
        },
        "status": "SCHEDULED",
        "reasonSkipped": null
      },
      {
        "_count": {
          "_all": 2
        },
        "status": "SKIPPED",
        "reasonSkipped": "no_automated_channel_available"
      }
    ]
  }
}
```

## Selected Test Event
```json
{
  "selected": {
    "eventId": "cmrpg4ku701lmscmbpctxfkm4",
    "orderType": "PB",
    "orderNumber": "BPB00378",
    "deliveryGroupId": "cmrpfzbi60051scmb71cvcpbn",
    "deliveryDate": "2026-08-28",
    "productionSelectedChannel": "EMAIL",
    "productionChannelReason": "email_available_sms_unavailable",
    "providerRecipientsOverriddenToTestOnly": true,
    "testEmailRecipient": "j***@mld.com",
    "testPhoneRecipient": "***-***-5923",
    "confirmationLink": "https://mld-delivery.vercel.app/delivery/confirm/dc42_f0c3a07e7b03417415c65993aa7ca70acf6af158b4511288",
    "confirmationId": "cmrpg4kwj01lnscmbk6vw4p6w",
    "confirmationStatus": "PENDING"
  },
  "sendResults": {
    "email": {
      "recipientEnvVar": "NOTIFICATIONS_TEST_EMAIL",
      "ok": true,
      "provider": "ms_graph",
      "error": null
    },
    "sms": {
      "recipientEnvVar": "NOTIFICATIONS_TEST_PHONE",
      "ok": true,
      "provider": "twilio",
      "idPresent": true,
      "error": null
    }
  },
  "confirmationLink": "https://mld-delivery.vercel.app/delivery/confirm/dc42_f0c3a07e7b03417415c65993aa7ca70acf6af158b4511288"
}
```

Manual stop point: open the hosted confirmation link and click Confirm Delivery manually.