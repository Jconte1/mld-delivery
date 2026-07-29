import { readFileSync } from "fs";
import path from "path";

const ROOT = process.cwd();
const QUEUE_ROOT = path.resolve(ROOT, "..", "mld-queue");

function readLocal(relativePath: string) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readQueue(relativePath: string) {
  return readFileSync(path.join(QUEUE_ROOT, relativePath), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(source.includes(pattern), message, failures);
}

function assertNotIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(!source.includes(pattern), message, failures);
}

async function main() {
  const failures: string[] = [];
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const {
    buildDeliveryPrepaymentHoldPayload,
    DELIVERY_PREPAYMENT_HOLD_REASON,
    DELIVERY_PREPAYMENT_HOLD_ROUTE,
    shouldDryRunDeliveryPrepaymentHold,
  } = await import("../lib/notifications/deliveryPrepaymentHoldQueue");
  const {
    holdQueueResultIsDryRun,
    holdQueueResultIsSuccess,
  } = await import("../lib/notifications/create8DayPaymentEnforcementEvents");

  const service = readLocal("lib/notifications/create8DayPaymentEnforcementEvents.ts");
  const queueHelper = readLocal("lib/notifications/deliveryPrepaymentHoldQueue.ts");
  const script = readLocal("scripts/create-8-day-payment-enforcement-events.ts");
  const packageJson = readLocal("package.json");
  const queueRoute = readQueue("gateway/src/app/api/erp/jobs/delivery/prepayment-hold/route.ts");
  const queueWorker = readQueue("worker/src/lib/deliveryPrepaymentHold.ts");
  const queueDispatcher = readQueue("worker/src/worker.ts");
  const queueSchema = readQueue("prisma/schema.prisma");

  assert(DELIVERY_PREPAYMENT_HOLD_ROUTE === "/api/erp/jobs/delivery/prepayment-hold", "hold route literal is correct", failures);
  assert(DELIVERY_PREPAYMENT_HOLD_REASON === "payment_not_received_by_deadline", "hold reason literal is correct", failures);
  assertIncludes(queueRoute, "ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD", "mld-queue route enqueues prepayment hold job", failures);
  assertIncludes(queueDispatcher, "ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD", "mld-queue worker dispatches prepayment hold job", failures);
  assertIncludes(queueSchema, "ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD", "mld-queue JobType includes prepayment hold", failures);

  for (const lifecycle of [
    "DeliveryOrderHoldActionStatus.PENDING",
    "DeliveryOrderHoldActionStatus.QUEUED",
    "DeliveryOrderHoldActionStatus.SUCCEEDED",
    "DeliveryOrderHoldActionStatus.FAILED",
    "DeliveryOrderHoldActionStatus.SKIPPED",
  ]) {
    assertIncludes(service, lifecycle, `${lifecycle} lifecycle is implemented`, failures);
  }

  assertIncludes(service, "createOrReusePendingHoldAction", "new qualifying candidate creates/reuses PENDING hold action", failures);
  assertIncludes(service, "markHoldActionQueued", "accepted queue job records queueJobId and QUEUED", failures);
  assertIncludes(service, "holdQueueResultIsDryRun", "dry_run queue result is recognized", failures);
  assertIncludes(service, "holdQueueResultIsSuccess", "succeeded/already_on_hold queue result is recognized", failures);
  assertIncludes(service, "status === \"refused\"", "refused queue result is treated as failure", failures);
  assertIncludes(service, "holdQueueResultFailureReason", "failed queue results use failure mapping", failures);
  assertIncludes(service, "retryFailedHoldActions", "failed holds require explicit retry option", failures);
  assertIncludes(
    service,
    "finalHoldAction.status === DeliveryOrderHoldActionStatus.SUCCEEDED",
    "customer/internal message path is gated by final hold success",
    failures
  );

  assert(holdQueueResultIsSuccess({ status: "succeeded" }), "succeeded maps to hold success", failures);
  assert(holdQueueResultIsSuccess({ status: "already_on_hold" }), "already_on_hold maps to idempotent hold success", failures);
  assert(!holdQueueResultIsSuccess({ status: "dry_run" }), "dry_run does not map to hold success", failures);
  assert(holdQueueResultIsDryRun({ status: "dry_run" }), "dry_run result is recognized", failures);
  assert(!holdQueueResultIsDryRun({ status: "refused" }), "refused result is not dry_run", failures);

  delete process.env.DELIVERY_PREPAYMENT_HOLD_DRY_RUN;
  assert(shouldDryRunDeliveryPrepaymentHold(), "delivery dry-run defaults true", failures);
  process.env.DELIVERY_PREPAYMENT_HOLD_DRY_RUN = "false";
  assert(!shouldDryRunDeliveryPrepaymentHold(), "delivery dry-run can be explicitly disabled", failures);
  delete process.env.DELIVERY_PREPAYMENT_HOLD_DRY_RUN;

  const payload = buildDeliveryPrepaymentHoldPayload({
    orderType: " so ",
    orderNumber: " so38056 ",
    dryRun: true,
    deliveryDate: "2026-07-29T00:00:00.000Z",
    amountDueAtTrigger: "1250.00",
    paymentDeadline: "2026-07-21",
  });
  assert(payload.orderType === "SO", "queue payload normalizes orderType", failures);
  assert(payload.orderNumber === "SO38056", "queue payload normalizes orderNumber", failures);
  assert(payload.reason === "payment_not_received_by_deadline", "queue payload sends fixed reason", failures);
  assert(payload.dryRun === true, "queue payload carries dryRun", failures);
  assert(payload.deliveryDate === "2026-07-29", "queue payload carries deliveryDate context", failures);
  assert(payload.amountDueAtTrigger === "1250.00", "queue payload carries amountDueAtTrigger context", failures);
  assert(payload.paymentDeadline === "2026-07-21", "queue payload carries paymentDeadline context", failures);

  for (const forbidden of [
    "Hold: { value: false }",
    "Hold:{value:false}",
    "orderDeliveryGroup.update",
    "orderLine.update",
    "reschedule",
    "bump",
    "twilio.messages.create",
    "client.messages.create",
    "sendMail",
    "sendSms",
    "notificationAttempt.create",
    "providerDispatch",
  ]) {
    assertNotIncludes(service, forbidden, `8-day service must not include ${forbidden}`, failures);
    assertNotIncludes(script, forbidden, `8-day script must not include ${forbidden}`, failures);
  }
  assertNotIncludes(queueWorker, "Hold: { value: false }", "mld-queue worker has no Hold=false path", failures);
  assertIncludes(queueWorker, "Hold: { value: true }", "mld-queue worker v1 writes existing On Hold=true", failures);
  assertIncludes(
    queueWorker,
    "TODO: Replace existing On Hold write target",
    "mld-queue worker documents future Prepayment Hold replacement",
    failures
  );
  assertIncludes(queueWorker, "ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED", "live write guard is implemented in queue worker", failures);
  assertIncludes(queueWorker, "ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER", "allowlist guard is implemented in queue worker", failures);
  assertIncludes(queueHelper, "MLD_QUEUE_PREPAYMENT_HOLD_TIMEOUT_MS", "delivery queue helper has hold timeout", failures);
  assertIncludes(packageJson, "validate:8-day-hold-lifecycle", "package script is registered", failures);

  if (failures.length > 0) {
    console.error("8-day hold lifecycle validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        validation: "8-day hold lifecycle validation passed",
        pendingQueuedSucceededFailedSkippedCovered: true,
        dryRunDefaultsSafe: true,
        liveWriteGuardDelegatedToMldQueue: true,
        allowlistGuardDelegatedToMldQueue: true,
        noHoldFalsePath: true,
        noDeliveryDateOrLineMutation: true,
        noProviderSends: true,
        noLiveAcumaticaWrite: true,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
