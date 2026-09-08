import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgresql://validation:validation@localhost:5432/validation";

type SchedulerModule = typeof import("./run-scheduled-delivery-interval");

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => unknown, expected: string) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(expected),
      `Expected error containing ${expected}, received ${message}`
    );
    return;
  }
  throw new Error(`Expected error containing ${expected}.`);
}

function validateTimeZoneHandling(scheduler: SchedulerModule) {
  const spring = scheduler.denverDateTimeParts(
    new Date("2026-03-08T21:00:00.000Z"),
    scheduler.DEFAULT_DELIVERY_SCHEDULER_TIMEZONE
  );
  assert(spring.date === "2026-03-08", "Denver spring DST date should be computed.");
  assert(spring.time === "15:00", "Denver spring DST local time should be 15:00.");

  const fall = scheduler.denverDateTimeParts(
    new Date("2026-11-01T22:00:00.000Z"),
    scheduler.DEFAULT_DELIVERY_SCHEDULER_TIMEZONE
  );
  assert(fall.date === "2026-11-01", "Denver fall DST date should be computed.");
  assert(fall.time === "15:00", "Denver fall DST local time should be 15:00.");

  assert(scheduler.normalizeLocalTime("05:30") === "05:30", "Valid local time should pass.");
  assertThrows(() => scheduler.normalizeLocalTime("5:30"), "HH:mm");
}

function validateArgumentHandling(scheduler: SchedulerModule) {
  const parsed = scheduler.parseSchedulerArgs([
    "--interval",
    "90",
    "--expected-local-time",
    "15:10",
    "--timezone",
    "America/Denver",
    "--send",
    "--force-local-time-check-bypass",
    "--order-type",
    "SO",
    "--order-number",
    "SO38056",
    "--now",
    "2026-08-25T21:10:00.000Z",
  ]);
  assert(parsed.interval === "90", "Expected interval 90 to parse.");
  assert(parsed.expectedLocalTime === "15:10", "Expected HH:mm override to parse.");
  assert(parsed.send === true, "Expected --send to parse.");
  assert(parsed.forceLocalTimeCheckBypass === true, "Expected local-time bypass to parse.");
  assert(parsed.orderType === "SO", "Expected order type to parse.");
  assert(parsed.orderNumber === "SO38056", "Expected order number to parse.");

  assertThrows(() => scheduler.parseSchedulerArgs(["--interval", "8"]), "interval_8_not_schedule_ready");
  assertThrows(() => scheduler.parseSchedulerArgs(["--interval", "90", "--confirm", "x"]), "derived internally");
  assertThrows(() => scheduler.parseSchedulerArgs(["--interval", "90", "--order-type", "SO"]), "provided together");
}

function validateDelegation(scheduler: SchedulerModule) {
  const args = scheduler.delegatedRunnerArgs({
    interval: "14",
    runDate: "2026-08-31",
    send: true,
    confirmPhrase: scheduler.DELIVERY_INTERVAL_SCHEDULE["14"].confirmPhrase,
    orderType: "SO",
    orderNumber: "SO38056",
  });
  assert(args[0] === "run", "Delegation should invoke npm run.");
  assert(args[1] === "run:delivery-interval", "Delegation should use run:delivery-interval.");
  assert(args.includes("--interval") && args.includes("14"), "Delegation should include interval.");
  assert(args.includes("--run-date") && args.includes("2026-08-31"), "Delegation should include Denver run date.");
  assert(args.includes("--send"), "Delegation should include --send when requested.");
  assert(args.includes("--confirm"), "Delegation should include derived confirm phrase.");
  assert(
    args.includes("RUN REAL 14 DAY CUSTOMER NOTIFICATIONS"),
    "Delegation should include interval-specific confirm phrase."
  );
  assert(args.includes("--order-type") && args.includes("SO"), "Delegation should pass order type.");
  assert(args.includes("--order-number") && args.includes("SO38056"), "Delegation should pass order number.");
  assert(
    scheduler.schedulerLockKey("42", "2026-08-28") === "delivery_interval_cron:42:2026-08-28",
    "Lock key should be interval and Denver run-date scoped."
  );
}

async function validateLockRetryBehavior(scheduler: SchedulerModule) {
  const failedWithoutRetry = await scheduler.runScheduledDeliveryInterval({
    interval: "90",
    send: true,
    forceLocalTimeCheckBypass: true,
    now: new Date("2026-08-25T20:00:00.000Z"),
    acquireLock: async () => ({
      acquired: false,
      phase: "skipped_failed_requires_retry_flag",
      previousLockStatus: "failed",
      row: {
        id: "failed-lock",
        lockKey: "delivery_interval_cron:90:2026-08-25",
        status: "failed",
        retryCount: 0,
      },
    }),
    runChildProcess: () => {
      throw new Error("Failed lock without retry must not delegate.");
    },
  });
  assert(
    failedWithoutRetry.phase === "skipped_failed_requires_retry_flag",
    "Failed lock without retry should skip."
  );
  assert(failedWithoutRetry.childResultSummary === null, "Failed skip should not delegate.");

  let retriedDelegated = false;
  const failedWithRetry = await scheduler.runScheduledDeliveryInterval({
    interval: "90",
    send: true,
    forceLocalTimeCheckBypass: true,
    allowFailedRetry: true,
    now: new Date("2026-08-25T20:00:00.000Z"),
    acquireLock: async () => ({
      acquired: true,
      phase: "lock_reacquired",
      previousLockStatus: "failed",
      row: {
        id: "failed-lock",
        lockKey: "delivery_interval_cron:90:2026-08-25",
        status: "running",
        retryCount: 1,
      },
    }),
    markRun: async () => undefined,
    runChildProcess: () => {
      retriedDelegated = true;
      return {
        status: 0,
        error: null,
        summary: { ok: true, providerCalls: 0 },
      };
    },
  });
  assert(failedWithRetry.phase === "completed", "Failed lock with retry should delegate and complete.");
  assert(failedWithRetry.retryCount === 1, "Retry should expose incremented retry count.");
  assert(retriedDelegated, "allowFailedRetry should delegate.");

  const completedWithoutRerun = await scheduler.runScheduledDeliveryInterval({
    interval: "90",
    send: true,
    forceLocalTimeCheckBypass: true,
    now: new Date("2026-08-25T20:00:00.000Z"),
    acquireLock: async () => ({
      acquired: false,
      phase: "skipped_already_completed",
      previousLockStatus: "success",
      row: {
        id: "success-lock",
        lockKey: "delivery_interval_cron:90:2026-08-25",
        status: "success",
        retryCount: 0,
      },
    }),
    runChildProcess: () => {
      throw new Error("Completed lock without rerun must not delegate.");
    },
  });
  assert(completedWithoutRerun.phase === "skipped_already_completed", "Completed lock should skip by default.");
}

async function validateDirectTaskMode(scheduler: SchedulerModule) {
  let taskPayload: unknown = null;
  let childCalled = false;
  const result = await scheduler.runScheduledDeliveryInterval({
    interval: "90",
    send: true,
    manualRun: true,
    requestedBy: "manual",
    forceLocalTimeCheckBypass: true,
    runDateOverride: "2026-09-01",
    orderType: "SO",
    orderNumber: "SO38056",
    channel: "sms",
    lockScopeParts: ["SO", "SO38056", "sms"],
    now: new Date("2026-09-01T15:10:00.000Z"),
    acquireLock: async () => ({
      acquired: true,
      phase: "lock_reacquired",
      previousLockStatus: "failed",
      row: {
        id: "scheduler_run_90",
        lockKey: "delivery_interval_cron:90:2026-09-01",
        status: "running",
        retryCount: 2,
      },
    }),
    runTask: async (payload) => {
      taskPayload = payload;
      return { ok: true, providerCalls: 0 };
    },
    markRun: async () => undefined,
    runChildProcess: () => {
      childCalled = true;
      throw new Error("direct task mode must not spawn child process");
    },
  });

  assert(result.phase === "completed", "Scheduler direct task mode should return completed phase.");
  assert(!childCalled, "Scheduler direct task mode must not spawn child process.");
  const payload = taskPayload as {
    interval?: string;
    runDate?: string;
    schedulerRunId?: string;
    lockKey?: string;
    send?: boolean;
    manualRun?: boolean;
    requestedBy?: string;
    channel?: string;
  } | null;
  assert(payload?.interval === "90", "Direct task payload should include interval.");
  assert(payload?.runDate === result.todayInDenver, "Direct task payload should use Denver run date.");
  assert(payload?.schedulerRunId === "scheduler_run_90", "Direct task payload should include scheduler run id.");
  assert(payload?.lockKey === "delivery_interval_cron:90:2026-09-01:SO:SO38056:sms", "Direct task payload should include scoped lock key.");
  assert(payload?.send === true, "Direct task payload should request live send path.");
  assert(payload?.manualRun === true, "Direct task payload should preserve manualRun.");
  assert(payload?.requestedBy === "manual", "Direct task payload should preserve requestedBy.");
  assert(payload?.channel === "sms", "Direct task payload should preserve channel filter.");
}

function validateStaticFiles(scheduler: SchedulerModule) {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert(
    packageJson.scripts["scheduled:delivery-interval"]?.includes(
      "scripts/run-scheduled-delivery-interval.ts"
    ),
    "package.json should expose scheduled:delivery-interval."
  );
  assert(
    packageJson.scripts["notifications:worker"]?.includes(
      "scripts/delivery-notification-worker.ts"
    ),
    "package.json should expose notifications:worker."
  );

  const schema = readFileSync("prisma/schema.prisma", "utf8");
  assert(
    schema.includes("model DeliveryIntervalSchedulerRun"),
    "Prisma schema should define DeliveryIntervalSchedulerRun."
  );
  assert(
    schema.includes("@@map(\"delivery_interval_scheduler_runs\")"),
    "Scheduler run model should map to delivery_interval_scheduler_runs."
  );

  const migration = readFileSync(
    "prisma/migrations/20260901150000_add_delivery_interval_scheduler_runs/migration.sql",
    "utf8"
  );
  assert(
    migration.includes("CREATE TABLE \"delivery_interval_scheduler_runs\""),
    "Scheduler lock migration should create delivery_interval_scheduler_runs."
  );
  assert(
    migration.includes("CREATE UNIQUE INDEX \"delivery_interval_scheduler_runs_lockKey_key\""),
    "Scheduler lock migration should enforce unique lock keys."
  );

  const wrapper = readFileSync("scripts/run-scheduled-delivery-interval.ts", "utf8");
  assert(
    wrapper.includes(scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV),
    "Wrapper should include the explicit scheduled-send disable gate."
  );
  assert(wrapper.includes("skipped_wrong_local_time"), "Wrapper should skip wrong local time.");
  assert(wrapper.includes("skipped_lock_active"), "Wrapper should skip active locks.");
  assert(wrapper.includes("skipped_already_completed"), "Wrapper should skip completed locks.");
  assert(
    wrapper.includes("skipped_failed_requires_retry_flag"),
    "Wrapper should require explicit retry after failure."
  );
  assert(wrapper.includes("\"retryCount\" = \"retryCount\" + 1"), "Wrapper should record retries.");
  assert(
    !wrapper.includes("twilio.messages.create") && !wrapper.includes("sendMail("),
    "Wrapper must not call providers directly."
  );
}

async function main() {
  const scheduler = await import("./run-scheduled-delivery-interval");
  validateTimeZoneHandling(scheduler);
  validateArgumentHandling(scheduler);
  validateDelegation(scheduler);
  await validateLockRetryBehavior(scheduler);
  await validateDirectTaskMode(scheduler);
  validateStaticFiles(scheduler);

  console.log(
    "Delivery scheduler wrapper validation passed. No Vercel cron routes, SMS/email, provider calls, Acumatica writes, queue writebacks, holds, deploys, or production data mutations were performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
