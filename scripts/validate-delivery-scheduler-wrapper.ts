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

function validateStaticFiles(scheduler: SchedulerModule) {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert(
    packageJson.scripts["scheduled:delivery-interval"]?.includes(
      "scripts/run-scheduled-delivery-interval.ts"
    ),
    "package.json should expose scheduled:delivery-interval."
  );
  assert(
    packageJson.scripts["validate:delivery-scheduler-wrapper"]?.includes(
      "scripts/validate-delivery-scheduler-wrapper.ts"
    ),
    "package.json should expose validate:delivery-scheduler-wrapper."
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
    "Wrapper should require the scheduler live-send env gate."
  );
  assert(
    wrapper.includes("skipped_wrong_local_time"),
    "Wrapper should skip successfully when local time does not match."
  );
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

  const docs = readFileSync("docs/delivery-notification-production-scheduler.md", "utf8");
  assert(docs.includes("scheduler wrapper foundation"), "Scheduler docs should describe the wrapper.");
  assert(docs.includes("0 21,22"), "Scheduler docs should include DST-safe UTC candidate cron examples.");
  assert(docs.includes("interval 8"), "Scheduler docs should explain that interval 8 is not schedule-ready.");
}

async function main() {
  const scheduler = await import("./run-scheduled-delivery-interval");
  validateTimeZoneHandling(scheduler);
  validateArgumentHandling(scheduler);
  validateDelegation(scheduler);
  validateStaticFiles(scheduler);

  console.log(
    "Delivery scheduler wrapper validation passed. No cron jobs, SMS/email, provider calls, Acumatica writes, queue writebacks, holds, deploys, or production data mutations were performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
