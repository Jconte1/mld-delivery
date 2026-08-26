# Delivery Notification Writeback Go-Live Matrix

Status: writebacks remain disabled for customer go-live review.

The delivery app can enqueue queue-backed writeback jobs, but live Acumatica writes require both the delivery payload dry-run posture and the mld-queue worker write gate to be deliberately changed.

## Shared Queue Requirements

Delivery app:

- `MLD_QUEUE_BASE_URL` points at the deployed mld-queue gateway.
- `MLD_QUEUE_TOKEN` matches the queue gateway token.

mld-queue:

- Gateway and worker are deployed from the reviewed source.
- Worker has Acumatica credentials for the target tenant.
- Worker-specific live write flags remain off until a separate approval.

## Matrix

| Writeback | Delivery env, dry run | Delivery env, live payload | Queue worker env, dry run | Queue worker env, live | Launch phase | Risk | Test procedure |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 42-day `CONFIRMVIA` / `CONFIRMWTH` | `DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN=true` or unset | `DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN=false` | `ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED=false` | `ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED=true` plus `ACUMATICA_CONFIRMATION_WRITEBACK_ALLOW_ALL=true` or matching `ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS` / `ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_TYPES` | 42-day initial confirmation launch, after final approval | Writes customer confirmation source/name to sales order attributes | Use allowlisted launch first when possible; for broad go-live, explicitly set allow-all and verify the worker still only fills blank `CONFIRMVIA`/`CONFIRMWTH` fields. |
| `ONEWEEKCON` | `DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN=true` or unset | `DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN=false` | `ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN=true`; `ACUMATICA_TEN_DAY_CONFIRMATION_WRITE_ENABLED=false` | `ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN=false`; `ACUMATICA_TEN_DAY_CONFIRMATION_WRITE_ENABLED=true`; optional `ACUMATICA_TEN_DAY_CONFIRMATION_ALLOWED_ORDER_NUMBER=<order>` | After 14/12/10/8 payment logic is approved | Marks Acumatica `Document.AttributeONEWEEKCON=true`; affects 2-day qualification | Use one allowlisted no-balance delivery group, compare before/after Acumatica value, confirm 2-day logic consumes local and ERP state correctly. |
| 8-day prepayment hold | `DELIVERY_PREPAYMENT_HOLD_DRY_RUN=true` or unset | `DELIVERY_PREPAYMENT_HOLD_DRY_RUN=false` | `ACUMATICA_PREPAYMENT_HOLD_DRY_RUN=true`; `ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED=false` | `ACUMATICA_PREPAYMENT_HOLD_DRY_RUN=false`; `ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED=true`; required launch allowlist `ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER=<order>` | Last, after payment audit and operations approval | Places/maintains sales order hold in Acumatica | Run dry-run workbook, validate amount due/deadline, run one allowlisted live hold, verify Acumatica hold/status and internal alert behavior. |
| Contact opt-out false writeback | `DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN=true` or unset | `DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN=false` | `ACUMATICA_CONTACT_OPT_IN_DRY_RUN=true`; `ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED=false` | `ACUMATICA_CONTACT_OPT_IN_DRY_RUN=false`; `ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED=true`; optional `ACUMATICA_CONTACT_OPT_IN_ALLOWED_CONTACT_ID=<contact>` | After STOP/email opt-out lifecycle is approved | Writes only false values to Contact opt-in attributes | Use one allowlisted contact, trigger STOP/email opt-out, verify queued action, worker result, Acumatica Contact custom fields, and local opt-out state. |

## Current Recommendation

For the initial live 42-day confirmation launch, enable live customer sends and live 42 confirmation writeback only after final approval:

- Delivery app: `DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN=false`
- mld-queue worker: `ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED=true`
- mld-queue worker: `ACUMATICA_CONFIRMATION_WRITEBACK_ALLOW_ALL=true`, or use a matching order allowlist during a narrower launch.

Keep unrelated writeback/hold paths dry-run unless separately approved:

- `DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN=true`
- `DELIVERY_PREPAYMENT_HOLD_DRY_RUN=true`
- `DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN=true`
