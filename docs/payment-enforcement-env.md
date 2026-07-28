# Payment Enforcement Environment Variables

These settings are for the 8-day payment enforcement foundation.

```env
DELIVERY_PREPAYMENT_HOLD_DRY_RUN=true
DELIVERY_PAYMENT_ENFORCEMENT_FALLBACK_EMAIL=
```

- `DELIVERY_PREPAYMENT_HOLD_DRY_RUN` controls future delivery-side orchestration behavior and should default safe.
- `DELIVERY_PAYMENT_ENFORCEMENT_FALLBACK_EMAIL` is the future fallback recipient for missing or inactive salesperson email.

Actual Acumatica hold writes are controlled by `mld-queue` worker environment variables, not by delivery.
