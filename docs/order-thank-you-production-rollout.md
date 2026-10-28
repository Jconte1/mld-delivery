# Order Thank-You Production Rollout

The delivery worker owns order thank-you orchestration. The existing mld-queue thank-you report and mark-sent jobs remain the ERP boundary. Will Call thank-you messages acknowledge the order and tell the customer MLD will notify them when it is ready for pickup. They do not create invites or link to a customer dashboard.

## Runtime flow

1. Fetch the existing Thank You Notifications OData report through `ERP_GET_THANK_YOU_REPORT`.
2. Fetch each full Sales Order and linked Contact through mld-queue.
3. Ignore legacy order contact/opt-in UDFs and use the linked Contact's `CONTEXT`, `CONEMAIL`, and `CONPHONE` values.
4. Apply local/global opt-outs and select the normal production channel.
5. Store an order-level thank-you event and provider attempt.
6. Send through Twilio or Microsoft Graph.
7. After provider acceptance, enqueue `ERP_MARK_THANK_YOU_SENT` for `AttributeTHANKYOU=true`.
8. Reconcile and retry the writeback independently; never resend solely because the writeback failed.

## Environment placement

### mld-delivery-worker-prod

New values:

- `DELIVERY_THANK_YOU_ENABLED=true` only at final cutover. Leave unset/false during shadow verification.

Optional values:

- `DELIVERY_THANK_YOU_WILL_CALL_SHIP_VIAS=WILL CALL,WILL CALL BO,WILL CALL JX,WILL CALL PR,WILL CALL SLC,TRANS BOISE,TRANS JACKSON,TRANS PROVO,TRANS SLC`
- `DELIVERY_THANK_YOU_WRITEBACK_MAX_ATTEMPTS=10`

Existing required values:

- `DATABASE_URL`
- `USE_QUEUE_ERP=true`
- `MLD_QUEUE_BASE_URL`
- `MLD_QUEUE_TOKEN`
- `DELIVERY_REAL_CUSTOMER_SEND_ENABLED=true`
- `DELIVERY_APP_BASE_URL=https://mld.com/delivery`
- Twilio credentials and a messaging service SID or from number
- Microsoft Graph tenant/client/secret/from-email values

### Will Call dependencies

The delivery thank-you flow no longer requires a Will Call backend, invite token, frontend URL, customer email address, or billing ZIP for SMS. Email sends still require an eligible email address. Historical `willCallUrl` database values remain for audit purposes; new or retried sends store no link. Do not remove secrets from the legacy application or Will Call backend while those systems still need them.

### mld-delivery-queue-worker-prod / mld-queue gateway

No new values are required. Existing support uses:

- `ACUMATICA_THANK_YOU_ODATA_URL` (optional override)
- `ACUMATICA_THANK_YOU_WRITE_ENDPOINT_NAME` (optional; defaults to `Default`)
- `ACUMATICA_THANK_YOU_WRITE_ENDPOINT_VERSION` (optional; falls back to `ACUMATICA_ENDPOINT_VERSION`)

### Delivery Vercel project

No new thank-you-specific value is required. Deploy the delivery app after the migration so the Twilio callback route uses the generated client containing the new thank-you relations. Existing `DATABASE_URL`, `DELIVERY_APP_BASE_URL`, `TWILIO_AUTH_TOKEN`, and webhook signature settings remain required.

## Commands

Read-only preview:

```powershell
npm.cmd run run:order-thank-you -- --preview
```

Scoped preview:

```powershell
npm.cmd run run:order-thank-you -- --preview --order-type SO --order-number SO12345
```

Scoped live canary after migration/deployment and explicit approval:

```powershell
npm.cmd run run:order-thank-you -- --send --order-type SO --order-number SO12345
```

## Cutover order

1. Apply the delivery database migration.
2. Verify Will Call thank-you copy contains order/customer details and no registration or dashboard links. No Will Call backend deployment is required for this flow.
3. Deploy the delivery Vercel app and delivery worker image.
4. Keep `DELIVERY_THANK_YOU_ENABLED` unset/false.
5. Run report and scoped previews and compare against the legacy application.
6. Run approved scoped Delivery and Will Call canaries.
7. Disable the legacy `thank-you-send` and `thank-you-sync` Vercel crons.
8. Set `DELIVERY_THANK_YOU_ENABLED=true` on mld-delivery-worker-prod.
9. Monitor the delivery operations report, provider callbacks, and `THANKYOU` writebacks.
