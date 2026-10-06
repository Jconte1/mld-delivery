# Delivery Contact Routing

Orders retain their primary `contactId` and have a separate nullable
`deliveryContactId`, both referencing `contacts`. No new environment flags.

## Import and Selection

- Full SalesOrder reads expect scalar `DeliveryContact.value` containing the ContactID.
- Both contacts use the existing Contact fetch path, queue-backed when configured.
- A shared primary/delivery ID is fetched once per import.
- Removed or absent delivery assignments clear the old assignment.
- Failed or mismatched delivery Contact reads record `unavailable`; they do not
  block unrelated primary-contact intervals or authorize stale contact routing.
- Only DAY_2 prefers the delivery contact. Missing/unavailable contacts or no
  eligible opted-in channel fall back to a freshly fetched primary contact.
- Opt-outs and valid recipient checks apply separately to the selected contact.
- All other intervals retain primary-contact routing.

Events record the selected contact, role, and fallback reason. Dispatch reselects
against current imported assignments and opt-outs; a different selected contact
blocks the old event rather than silently rerouting it. Multi-order grouping uses
the selected contact and the existing date/address/channel criteria.

## Rollout

1. Expose `DeliveryContact` as a scalar ContactID on the configured full SalesOrder
   endpoint (`DeliverySalesOrder` by default). Do not expand it as a navigation field.
2. Apply `20261006120000_add_order_delivery_contact` with the other pending reviewed
   migrations before deploying code that queries these columns. Generate Prisma Client.
3. Deploy delivery app and notification worker together. No mld-queue code change
   is needed when the mapped scalar is returned by the existing full-order read.
4. Fresh-import a scoped order with a populated delivery contact; preview DAY_2 and
   review `recipientContactId`, `recipientContactRole`, and `recipientFallbackReason`
   before authorizing a real send.

Read-only check on 2026-10-06: SO38056 returned `DeliveryContact: {}` through
CustomEndpoint and omitted the field through DeliverySalesOrder. The second-contact
live mapping remains unverified; primary fallback is expected until populated/exposed.

## Validation

`validate:delivery-contact-routing` requires an explicit isolated loopback database
in `TEST_DELIVERY_GROUP_DATABASE_URL` whose name starts with `delivery_group_validation`.
It uses injected ERP reads and forbids network fetch. It covers routing, opt-outs,
real local import/upsert, failed/mismatched reads, removal, and shared-ID fetch reuse.
The DAY_2 creation and grouped workflow validations additionally cover selected
recipient reporting, group pages, and blocking dispatch after contact reassignment.
No live providers or queue jobs are used by these tests.
