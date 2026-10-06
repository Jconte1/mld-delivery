# Daily delivery operations recap

The delivery notification worker sends the internal recap at or after 17:00 America/Denver. It uses the existing report recipient (`DELIVERY_OPERATIONS_REPORT_EMAIL`, default `james@mld.com`) and Graph credentials. No new environment variables or migrations are needed for the recap.

The email puts actionable problems first and attaches an Excel workbook:

- Attention: missing/failed runs, import problems, notification errors, pending work, writeback failures and possible duplicates, with order identifiers and suggested checks.
- Interval Runs: execution, qualification, import counts and retry counts.
- Notifications: each attempt, order, interval, masked recipient, timestamps, provider IDs, acceptance versus delivery evidence, and controlled-send indicator. Internal escalations are explicitly labeled.
- Customer Responses: SMS/web actions received in the coverage window, including responses to earlier notifications.
- Writebacks: intended fields/line numbers/dates, queue IDs, queue/business status and separate ERP verification evidence. Contact opt-outs and thank-you writebacks are included where available.
- Skipped Orders: per-order reasons. Where historical run summaries only recorded counts, these are explicitly marked as aggregate-only; identities are not invented.
- Import Results: successfully refreshed orders and individual import errors.
- Coverage: loaded/unavailable/truncated sections and evidence limitations.

## Dates and evidence

Coverage uses exact America/Denver day boundaries (including DST). Scheduled reports end when generation begins. The next successful report starts from the previous saved coverage end so after-hours replies and callbacks are not lost. Failed/pending records are also carried forward independently of their creation date. The first report after upgrading an old format intentionally overlaps its last reported day because older reports lack exact cutoff metadata.

If a core data section could not load or was truncated, the next report retains the earlier coverage start so the missing evidence can be recovered. The optional thank-you section is separately warned when its migration is pending. Queue status lookup failures are visible per job; unresolved local statuses remain candidates for later reports.

Historical previews are current database/queue snapshots, not historical ERP replays. A queue success or HTTP 200 is not labeled verified: verification requires recognized worker readback evidence. Current ERP contents can differ after later manual changes. Contact/confirmation tables are mutable and cannot reconstruct overwritten responses; inbound SMS records provide additional history. The report does not claim email inbox delivery from Graph acceptance.

Report collection performs SELECTs and existing-job queue GETs only. It does not enqueue ERP jobs, refresh orders, mutate confirmation statuses, or send customer notifications. Live email mode writes only its own report scheduler lock/result and calls Graph for the internal report.

Missing data sections produce explicit warnings rather than a misleading all-clear. Source collections are capped at 10,000 rows with a truncation warning. Queue lookups use four concurrent reads, a 15-second timeout and a 500-job cap with a coverage warning. Inline email tables are shortened; workbook rows are not silently removed. Attachments over 2.5 MB fail explicitly; use preview export for investigation.

## Review without sending

```powershell
npm.cmd run report:delivery-operations -- --preview --run-date 2026-09-28
```

Creates `artifacts/delivery-recap-2026-09-28.xlsx`, `.html`, and `.json`. These contain operational data and should not be committed. Preview does not acquire report locks or modify DB data.

## Send an approved internal report

```powershell
npm.cmd run report:delivery-operations -- --send --run-date 2026-09-28
```

Use `--retry-failed` to retry a failed report. Successful and running report locks prevent duplicate emails. An interrupted running report requires operator inspection before resetting its lock, since Graph may already have accepted the email.

Deploy the updated delivery notification worker for scheduled recaps to use this implementation. Vercel/queue worker changes are not required. The optional thank-you schema remains a separate rollout: if it is missing, the report explicitly marks that section unavailable.

The attachment uses Microsoft Graph's documented file attachment format: https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
