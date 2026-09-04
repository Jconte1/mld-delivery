# Delivery Notification Worker Runbook

This worker moves interval scheduling toward the Will Call pattern:

```text
delivery-owned worker -> Denver time check -> scheduler lock -> production interval runner
```

It does not replace Vercel Cron until a later approved phase.

## Commands

Start continuously:

```powershell
npm.cmd run notifications:worker
```

One-shot broad dry-run:

```powershell
npm.cmd run notifications:worker -- --once --bypass-local-time-gate --dry-run
```

One-shot interval dry-run:

```powershell
npm.cmd run notifications:worker -- --once --interval 90 --bypass-local-time-gate --dry-run
```

One-shot scoped dry-run:

```powershell
npm.cmd run notifications:worker -- --once --interval 42 --order-type SO --order-number SO38056 --delivery-date 2026-10-09 --channel sms --bypass-local-time-gate --dry-run
```

Read-only env readiness:

```powershell
npm.cmd run validate:delivery-worker-env
```

Read-only scheduler lock audit:

```powershell
npm.cmd run audit:delivery-scheduler-locks -- --interval 90 --take 25
```

## Worker Image

Build locally:

```powershell
docker build -f Dockerfile.worker -t mld-delivery-notification-worker:local .
```

Azure Container Registry build shape:

```powershell
az acr build --registry <acr-name> --image mld-delivery-notification-worker:<tag> --file Dockerfile.worker .
```

Container command:

```text
npm run notifications:worker
```

## Env Posture

Hard requirements are limited to values the worker needs to actually run production notification flows:

- `DATABASE_URL`
- `USE_QUEUE_ERP=true`
- `MLD_QUEUE_BASE_URL`
- `MLD_QUEUE_TOKEN`
- `DELIVERY_APP_BASE_URL`
- Twilio send envs
- Microsoft Graph send envs
- real-customer routing must not be explicitly disabled
- controlled/test routing must be false or unset

Writeback and hold envs follow code defaults. Leave them unset for production default behavior, or set the relevant dry-run/disable env explicitly only when you need to temporarily turn a feature off.

`DELIVERY_SCHEDULER_LIVE_SEND_ENABLED` also follows the production-default posture. Leave it unset for normal operation, or set it to `false` only when you need to temporarily stop scheduled worker sends.

## Rollout

1. Keep Vercel Cron/manual routes working.
2. Build and deploy the delivery worker disabled or in dry-run posture first.
3. Run a scoped one-shot dry-run.
4. Run one scoped live interval.
5. Run one broad live interval.
6. Disable Vercel Cron only after the worker proves stable.
7. Remove old Vercel cron route and mld-queue shell-out scaffold in a later cleanup phase.
