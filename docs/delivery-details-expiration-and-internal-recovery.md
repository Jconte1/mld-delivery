# Details Links and Internal Email Recovery

Details-only links expire at the start of the date 30 calendar days after the
delivery date, in America/Denver. For example, an October 8 delivery expires
November 7 at 00:00 Denver time. Explicit earlier expiration is honored; a later
value cannot extend the limit. Legacy null expiresAt values use the same policy
without a backfill. Expired pages show no customer/item/payment information.

Date changes and inactive groups invalidate old links. Group links also retain
contact, address, line membership, order status, and accepted-send checks. Group
DAY_42 confirmation links keep their existing stricter expiry and response rules;
the 30-day details policy does not extend confirmation or date-change permissions.

## Internal Email Recovery

The scheduled worker still dispatches only current-run internal event IDs. It does
not automatically retry failed or uncertain internal emails.

Inspect one event (read-only; no provider calls):

```powershell
npm.cmd run recover:internal-notification -- --event-id <event-id>
```

Review the event's order relevance, recipient, subject and body before retrying.
Only FAILED rows with a recorded definite Graph rejection, no sentAt, and the
reviewed updatedAt are eligible. Use the exact order and timestamp from inspection:

```powershell
npm.cmd run recover:internal-notification -- --event-id <event-id> --order-type <type> --order-number <number> --expected-updated-at <ISO-timestamp> --send --confirm "RETRY ONE REJECTED INTERNAL EMAIL"
```

Retain the inspection/result JSON in the operator log. This is an explicit resend
of the existing internal email, not a re-evaluation of the interval or a writeback.
It uses an atomic FAILED-to-SCHEDULED claim without resetting the row to PENDING.
Concurrent retries cannot both claim the same reviewed version. Successful or
uncertain events cannot be retried with this command. Uncertain outcomes require
manual reconciliation using Graph request IDs/mailbox evidence; no override is
provided. This command neither changes recipients/content nor sends customer SMS.

No migration or new environment variable is required for these changes.
