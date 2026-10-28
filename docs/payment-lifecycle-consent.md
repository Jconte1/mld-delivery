# Payment lifecycle consent and late-entry clearance

## Rules

14/12/10/8-day actions require fresh ERP import, an active eligible delivery group, both CONFIRMVIA and CONFIRMWTH, and an eligible primary SMS/email contact with no applicable local/global opt-out. ONEWEEKCON=true stops payment notifications and enforcement before a hold is queued.

- Day 14 keeps its ordinary delivery reminder. Paid prepayment and terms orders can clear only after a qualifying provider-accepted notification.
- Day 12/10 send a payment request for unpaid prepayment orders. Paid prepayment (balance <= $2) and terms orders reuse qualifying notification evidence or receive one payment-free catch-up delivery reminder before clearance.
- Day 8 enforces unpaid prepayment orders regardless of earlier reminder history. Paid/terms orders receive no catch-up and initiate no clearance writeback.
- Each member of a multi-order notification remains independently eligible. Catch-up and payment requests have different actions and are not grouped together.
- A hold is whole-order Hold=true, verified with ERP GET. This change does not implement automatic release or a custom Prepayment Hold status.

## Queue-time checks

The ERP worker freshly reads the order/payment/contact and verifies both confirmation attributes and ONEWEEKCON before the write. It calls the authenticated, read-only delivery endpoint:

`POST <DELIVERY_APP_BASE_URL>/api/internal/delivery-payment-eligibility`

This endpoint checks local order/contact assignment, active delivery-group membership and local/global opt-outs. Clearance additionally requires an accepted production notification for the current contact/recipient, order, group and date. Historical DAY_8 attempts do not authorize clearance. The endpoint neither imports ERP data nor queues writes, so it does not cause recursive queue work.

Missing configuration, failed HTTP/auth, missing consent, opt-out, changed contact/date or missing send evidence fail closed. The worker must not trust consent in an old queue payload. Ordinary delayed/retried DAY_14/12/10 clearance jobs remain allowed when all checks still pass; the calendar reaching eight days is not a reason to reject such a job.

## Deployment

1. Pause the delivery notification scheduler during coordinated rollout. Do not clear existing jobs or notification history.
2. Apply delivery migration `20261028120000_add_order_confirm_with`, then generate the delivery Prisma client. The nullable column has no backfill; normal fresh import populates it and clears it when ERP clears the attribute.
3. Deploy the delivery app (Vercel) so the read-only endpoint is available.
4. On the delivery ERP queue worker (`mld-delivery-queue-worker-prod`), configure `DELIVERY_APP_BASE_URL=https://mld.com/delivery` and `MLD_QUEUE_TOKEN` matching the delivery app/gateway token. These are connection credentials, not feature switches. Do not print the token.
5. Deploy the queue worker from mld-queue, then the notification worker from delivery. No queue schema migration is added by this change.
6. Verify endpoint authentication and run approved scoped canaries before resuming broad scheduling. Existing jobs without a valid clearance source are refused and require review, not blind replay.

The existing explicit dry-run/disable overrides remain unchanged. No new live-enable flag is introduced.

## Isolated validation

Delivery: `npm.cmd run validate:payment-lifecycle-consent`

Queue worker: `npm.cmd --prefix worker run validate:payment-consent-lifecycle`

These scripts inject in-memory database/ERP/HTTP clients. They do not send messages, queue production jobs, write ERP or alter production tables.
