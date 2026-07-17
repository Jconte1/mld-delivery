# 42-Day Confirmation Response And Acumatica Writeback Audit

Generated: 2026-07-16

Scope: read-only audit/design for current 42-day delivery confirmation response storage and future Acumatica writeback through `mld-queue`.

## A. Webpage Response Storage Today

Route/page:

- `app/delivery/confirm/[token]/page.tsx`
- `app/delivery/confirm/[token]/DeliveryConfirmationActions.tsx`

The confirmation page loads a `DeliveryConfirmation` by `linkToken` and includes its related `OrderDeliveryGroup`, `Order`, `Contact`, `Address`, and order lines.

When a customer clicks **Confirm Delivery**:

- The server action is `confirmDelivery` in `app/delivery/confirm/[token]/page.tsx`.
- It selects one row from `delivery_confirmations` by `linkToken`.
- If the row is already final (`CONFIRMED` or `NEW_DATE_REQUESTED`), the customer is redirected with `updated=already_final`.
- Otherwise it updates the same `delivery_confirmations` row:
  - `status = CONFIRMED`
  - `confirmedAt = new Date()`
- It does not change `deliveryDate`.
- It does not change `deliveryGroupId`.
- The confirmation remains date-specific because the row is tied to both `deliveryGroupId` and `deliveryDate`, and the schema has `@@unique([deliveryGroupId, deliveryDate])`.
- After confirming, the customer cannot change again through the page because `CONFIRMED` is treated as final.

When a customer clicks **Request Different Date**:

- The server action is `requestDifferentDate` in `app/delivery/confirm/[token]/page.tsx`.
- It selects one row from `delivery_confirmations` by `linkToken`.
- If the row is already final (`CONFIRMED` or `NEW_DATE_REQUESTED`), the customer is redirected with `updated=already_final`.
- It validates that the submitted date exists, is later than the current scheduled/requested date, and is not a weekend.
- It updates the same `delivery_confirmations` row:
  - `status = NEW_DATE_REQUESTED`
  - `changeRequestedAt = new Date()`
  - `requestedNewDate = <validated date>`
  - `requestedNewDateRaw = <submitted value>`
  - `requestedNewDateAt = new Date()`
- The original `deliveryDate` remains preserved.
- The requested replacement date is stored separately in `requestedNewDate`.
- After submitting a new date request, the customer cannot change again through the page because `NEW_DATE_REQUESTED` is treated as final.

The webpage actions do not create `notification_events`, do not create `notification_attempts`, do not send provider messages, and do not write to Acumatica.

## B. SMS Response Storage Today

Files inspected:

- `lib/notifications/deliveryConfirmationSms.ts`
- `lib/notifications/deliveryConfirmationState.ts`
- app routes under `app/`
- `scripts/manual-demo/*`

Current production state:

- Production inbound Twilio webhook handling does not exist in the delivery app today.
- There is no `app/api/.../route.ts` that handles Twilio inbound SMS replies.
- `scripts/manual-demo` contains demo-only outbound provider code and is not production architecture.

Helper-level behavior exists:

- `parseSmsConfirmationResponse` recognizes `Y`, `YES`, `CONFIRM`, and `CONFIRMED` as confirmed.
- It recognizes `N`, `NO`, `CHANGE`, and `RESCHEDULE` as change requested.
- `parseRequestedDeliveryDate` accepts `MM/DD/YYYY`.
- `recordDeliveryConfirmationSmsResponse` can update a `DeliveryConfirmation` if a future webhook calls it with a known confirmation scope.

If a future handler calls `recordDeliveryConfirmationSmsResponse` and the reply is Y/YES/CONFIRM:

- It first calls `ensurePendingDeliveryConfirmation` for the same `deliveryGroupId + deliveryDate`.
- It updates `delivery_confirmations`:
  - `status = CONFIRMED`
  - `responseChannel = SMS`
  - `rawResponse = <raw reply>`
  - `normalizedResponse = <normalized reply>`
  - `confirmedAt = now`
- It preserves `deliveryGroupId` and `deliveryDate`.
- It returns no thank-you message (`replyMessage = null`).
- No production SMS is currently sent.

If a future handler calls it and the reply is N/NO/CHANGE:

- It updates `delivery_confirmations`:
  - `status = AWAITING_NEW_DATE`
  - `responseChannel = SMS`
  - `rawResponse = <raw reply>`
  - `normalizedResponse = <normalized reply>`
  - `changeRequestedAt = now`
- It returns the helper text: `Please provide the new delivery date in MM/DD/YYYY format.`
- No production SMS is currently sent.

If a future handler calls it while awaiting a new date and the reply is a valid `MM/DD/YYYY` date:

- It updates `delivery_confirmations`:
  - `status = NEW_DATE_REQUESTED`
  - `responseChannel = SMS`
  - `rawResponse = <raw reply>`
  - `normalizedResponse = <date key>`
  - `requestedNewDate = <parsed date>`
  - `requestedNewDateRaw = <raw value>`
  - `requestedNewDateAt = now`
- It preserves original `deliveryDate`.
- No production follow-up SMS is currently sent.

If the date reply is invalid:

- It leaves/sets status as `AWAITING_NEW_DATE`.
- It stores the raw response in `requestedNewDateRaw`.
- It returns the helper text: `We could not read that date. Please reply with the new delivery date in MM/DD/YYYY format.`
- No production SMS is currently sent.

Conclusion: SMS response logic currently exists only as parser/state helpers. Actual production customer SMS replies are not processed until a real authenticated Twilio inbound webhook is implemented.

## C. Production SMS Inbound Webhook Status

No production Twilio inbound webhook route/configuration was found in the delivery app.

Future task required:

- Add an authenticated inbound Twilio route.
- Validate Twilio signatures.
- Parse inbound `From` and `Body`.
- Match the inbound phone number to the correct active/pending `DeliveryConfirmation`.
- Call `recordDeliveryConfirmationSmsResponse`.
- Decide whether to send a Twilio response message.
- Audit/retry/error behavior must be designed before production.

## D. Current Source Of Truth For Already-Confirmed

The delivery app's `DeliveryConfirmation` row is the date-specific source of truth.

Current 42-day already-confirmed check:

- `isDeliveryGroupDateConfirmed` in `lib/notifications/deliveryConfirmationState.ts`
- Called from `lib/notifications/create42DayDeliveryConfirmationEvents.ts`
- Checks:
  - same `deliveryGroupId`
  - same `deliveryDate`
  - `status = CONFIRMED`

The 42-day service does not check Acumatica `CONFIRMVIA`, `CONFIRMWTH`, or `CONFIRMWITH`.

Old confirmed delivery dates do not block a new delivery date because the confirmation check is scoped to `deliveryGroupId + deliveryDate`, and the notification dedupe key includes `deliveryDate`.

## E. Current Acumatica Writeback Status

The delivery project does not write 42-day confirmation responses back to Acumatica today.

No current webpage action writes to Acumatica.

No current SMS helper writes to Acumatica.

No `CONFIRMVIA` / `CONFIRMWTH` writeback job exists in `mld-queue`.

Existing `mld-queue` read paths do reference the fields as:

- `Document.AttributeCONFIRMVIA`
- `Document.AttributeCONFIRMWTH`

The observed field spelling in mld-queue is `CONFIRMWTH`, not `CONFIRMWITH`.

## F. How mld-queue Likely Supports Future Writeback

Relevant mld-queue files inspected:

- `prisma/schema.prisma`
- `gateway/src/lib/types.ts`
- `gateway/src/lib/jobs.ts`
- `gateway/src/app/api/erp/jobs/thank-you/mark-sent/route.ts`
- `gateway/src/app/api/erp/jobs/sales-invoices/route.ts`
- `gateway/src/app/api/erp/jobs/customer-locations/route.ts`
- `worker/src/types.ts`
- `worker/src/worker.ts`
- `worker/src/lib/acumaticaClient.ts`
- `gateway/src/lib/erp/acumatica.ts`

Existing reusable patterns:

- Gateway routes authenticate with `assertInternalBearer`.
- Gateway routes enqueue jobs through `enqueueJob`.
- Jobs are stored in the mld-queue `jobs` table.
- Worker dispatches by `JobType`.
- Worker writes success/failure back to the jobs table.
- Existing Acumatica write examples use `PUT`.

Closest existing custom-attribute writeback:

- Job type: `ERP_MARK_THANK_YOU_SENT`
- Route: `gateway/src/app/api/erp/jobs/thank-you/mark-sent/route.ts`
- Worker case: `ERP_MARK_THANK_YOU_SENT`
- Worker method: `AcumaticaClient.markThankYouSent`
- Payload shape includes:
  - `OrderNbr: { value: orderNbr }`
  - optional `OrderType: { value: orderType }`
  - `custom.Document.AttributeTHANKYOU: { type: "CustomBooleanField", value: true }`
- Method: Acumatica `PUT`
- Endpoint envs:
  - `ACUMATICA_THANK_YOU_WRITE_ENDPOINT_NAME`
  - `ACUMATICA_THANK_YOU_WRITE_ENDPOINT_VERSION`

Future delivery confirmation writeback could reuse this same shape.

Likely future job type:

- `ERP_UPDATE_DELIVERY_CONFIRMATION_ATTRIBUTES`

Likely mld-queue changes later:

- Add enum value in `prisma/schema.prisma`.
- Add union member in `gateway/src/lib/types.ts`.
- Add union member in `worker/src/types.ts`.
- Add gateway route, likely:
  - `gateway/src/app/api/erp/jobs/delivery/confirmations/writeback/route.ts`
- Add worker dispatch case.
- Add Acumatica client method, likely:
  - `updateDeliveryConfirmationAttributes`
- Add migration for the new job type.

Likely delivery app payload to mld-queue:

```json
{
  "orderType": "SO",
  "orderNumber": "SO40466",
  "deliveryDate": "2026-07-22",
  "deliveryConfirmationId": "local-id",
  "source": "web",
  "confirmedVia": "WEB",
  "confirmedWith": "Customer Name or contact detail",
  "writeIfBlankOnly": true
}
```

Likely Acumatica target:

- Delivery SalesOrder or Default/Thank-You write endpoint SalesOrder, depending on which endpoint supports writing these attributes.
- Entity: `SalesOrder`
- Method likely `PUT`, based on existing mld-queue Acumatica write methods.

Likely Acumatica payload:

```json
{
  "OrderNbr": { "value": "SO40466" },
  "OrderType": { "value": "SO" },
  "custom": {
    "Document": {
      "AttributeCONFIRMVIA": { "type": "CustomStringField", "value": "WEB" },
      "AttributeCONFIRMWTH": { "type": "CustomStringField", "value": "Customer Name" }
    }
  }
}
```

The exact custom field type must be confirmed against Acumatica metadata/payload behavior before implementation.

## G. Proposed Future Writeback Architecture

Recommended future flow when customer confirms delivery:

1. Delivery app updates `delivery_confirmations` first.
2. Delivery app enqueues a mld-queue job for Acumatica writeback.
3. mld-queue worker writes Acumatica custom attributes.
4. mld-queue stores success/failure in its `jobs` table.
5. Delivery app either stores local writeback status later or references mld-queue job status.

Recommended blank-only rule:

- Only write `AttributeCONFIRMVIA` and `AttributeCONFIRMWTH` if Acumatica fields are blank, unless business approves overwrite.
- If fields are already populated, job should return a clear `skipped_existing_values` result rather than overwrite.

Recommended behavior for new-date requests:

- Do not write confirmation fields.
- Store request in delivery DB only.
- Treat Acumatica update/move date as a separate workflow.
- Do not imply the delivery date was moved until Acumatica is updated/approved.

Recommended failure behavior:

- DeliveryConfirmation remains source of truth even if Acumatica writeback fails.
- Writeback failure should not undo the customer's saved confirmation.
- Failed writeback should be visible via mld-queue job failure.
- Retry policy must be explicit. Existing worker retries transient failures except for `ERP_PUT_SALES_INVOICE`; a new confirmation writeback job should have an intentional retry policy.

## H. Fields/Payload Likely Needed

Delivery app to mld-queue:

- `orderType`
- `orderNumber`
- `deliveryDate`
- `deliveryConfirmationId`
- `source` / `responseChannel`
- `confirmedVia`
- `confirmedWith`
- `confirmedAt`
- `writeIfBlankOnly`

Acumatica identifying fields:

- `OrderNbr`
- `OrderType`
- Possibly Acumatica record ID or `noteId` only if the endpoint requires it; existing `markThankYouSent` uses `OrderNbr` and optional `OrderType`.

Acumatica attributes:

- `AttributeCONFIRMVIA`
- `AttributeCONFIRMWTH`

Need to confirm business meaning:

- Whether `CONFIRMVIA` means the method/channel (`WEB`, `SMS`, etc.).
- Whether `CONFIRMWTH` means the person/contact confirmed with.

## I. Twilio Inbound Response Handling Gaps

Needed before production SMS replies can work:

- Twilio webhook URL.
- Route implementation in delivery app.
- Twilio request signature validation.
- Phone normalization and matching.
- Rules for matching one inbound phone to one active/pending confirmation.
- Handling duplicate/repeated replies.
- Handling replies after link/group is inactive or expired.
- Whether the app sends Twilio response messages.
- How inbound SMS response messages are logged/audited.
- Whether inbound SMS should create `notification_attempts` or a separate inbound response audit model.

## J. Risks / Open Questions

Before Acumatica writeback implementation:

- Confirm exact field names: `AttributeCONFIRMWTH` vs any `CONFIRMWITH` variant.
- Confirm exact field types.
- Confirm endpoint/entity that supports writing the fields.
- Confirm whether blank-only is approved.
- Confirm values for web confirmation and future SMS confirmation.
- Confirm whether failed writeback should retry automatically.
- Decide whether delivery needs local writeback status fields.
- Decide how to avoid treating Acumatica fields as date-specific confirmation state.
- Decide how inbound SMS phone matching should behave if multiple confirmations share a phone.

## K. No-Change / Safety Confirmation

No code changes were made except this report file.

No database rows were mutated.

No notification attempts were created.

No SMS or email was sent.

No Acumatica write APIs were called.

No provider code was changed.

No readiness, payment, delivery group lifecycle, or 42-day eligibility rules were changed.

Manual demo tooling remains quarantined and was not wired into production.
