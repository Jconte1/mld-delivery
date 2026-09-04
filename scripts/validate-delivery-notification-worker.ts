process.env.DATABASE_URL ??= "postgresql://validation:validation@localhost:5432/validation";

export {};

type WorkerModule = typeof import("./delivery-notification-worker");
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

function validateArgumentParsing(worker: WorkerModule) {
  const parsed = worker.parseDeliveryNotificationWorkerArgs([
    "--once",
    "--interval",
    "42",
    "--order-type",
    "SO",
    "--order-number",
    "SO38056",
    "--delivery-date",
    "2026-10-09",
    "--channel",
    "sms",
    "--bypass-local-time-gate",
    "--allow-failed-retry",
    "--allow-completed-rerun",
    "--dry-run",
    "--worker-interval-ms",
    "1000",
    "--now",
    "2026-08-28T21:30:00.000Z",
  ]);

  assert(parsed.once, "--once should parse.");
  assert(parsed.interval === "42", "--interval should parse.");
  assert(parsed.orderType === "SO", "--order-type should parse.");
  assert(parsed.orderNumber === "SO38056", "--order-number should parse.");
  assert(parsed.deliveryDate === "2026-10-09", "--delivery-date should parse.");
  assert(parsed.channel === "sms", "--channel should parse.");
  assert(parsed.bypassLocalTimeGate, "--bypass-local-time-gate should parse.");
  assert(parsed.allowFailedRetry, "--allow-failed-retry should parse.");
  assert(parsed.allowCompletedRerun, "--allow-completed-rerun should parse.");
  assert(parsed.dryRun, "--dry-run should parse.");
  assert(parsed.workerIntervalMs === 1000, "--worker-interval-ms should parse.");

  assertThrows(() => worker.parseDeliveryNotificationWorkerArgs(["--interval", "7"]), "must be one of");
  assertThrows(() => worker.parseDeliveryNotificationWorkerArgs(["--channel", "fax"]), "sms, email, or both");
}

function validateScheduleAwareness(worker: WorkerModule, scheduler: SchedulerModule) {
  const intervals = worker.intervalsForWorkerTick({ interval: null });
  for (const interval of scheduler.DELIVERY_SCHEDULER_INTERVALS) {
    assert(intervals.includes(interval), `Worker should know interval ${interval}.`);
    assert(
      Boolean(scheduler.DELIVERY_INTERVAL_SCHEDULE[interval]?.expectedLocalTime),
      `Interval ${interval} should have an expected local time.`
    );
  }

  assert(
    worker.intervalsForWorkerTick({ interval: "90" }).join(",") === "90",
    "--interval should limit a worker tick to one interval."
  );
  assert(
    worker.dueIntervalsForLocalTime({
      intervals,
      localTime: scheduler.DELIVERY_INTERVAL_SCHEDULE["90"].expectedLocalTime,
      bypassLocalTimeGate: false,
    }).join(",") === "90",
    "Worker should identify interval 90 as due at its configured local time."
  );
  assert(
    worker.dueIntervalsForLocalTime({
      intervals: ["8"],
      localTime: "00:00",
      bypassLocalTimeGate: true,
    }).join(",") === "8",
    "Interval 8 should be worker/manual supported when the local time gate is bypassed."
  );
}

async function validateDryRunTick(worker: WorkerModule) {
  const options = worker.parseDeliveryNotificationWorkerArgs([
    "--once",
    "--interval",
    "39",
    "--dry-run",
    "--bypass-local-time-gate",
    "--order-type",
    "SO",
    "--order-number",
    "SO38056",
    "--channel",
    "email",
    "--now",
    "2026-08-31T21:35:00.000Z",
  ]);
  const result = await worker.runDeliveryNotificationWorkerTick(options, {
    now: new Date("2026-08-31T21:35:00.000Z"),
  });

  assert(result.ok, "Dry-run tick should succeed.");
  assert(result.phase === "dry_run", "Dry-run tick should report dry_run phase.");
  assert(result.dueIntervals.join(",") === "39", "Dry-run tick should run only interval 39.");
  assert(result.results.length === 1, "Dry-run tick should return one result.");
  assert(
    result.results[0]?.route === "run42DayNoResponseCommand",
    "Interval 39 should route to run42DayNoResponseCommand."
  );
  assert(result.results[0]?.providerCalls === 0, "Dry-run should not call providers.");
  assert(result.results[0]?.acumaticaWrites === 0, "Dry-run should not write Acumatica.");
}

async function validateInjectedScheduler(worker: WorkerModule, scheduler: SchedulerModule) {
  const previousGate = process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
  process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV] = "true";
  const seen: string[] = [];
  try {
    const options = worker.parseDeliveryNotificationWorkerArgs([
      "--once",
      "--interval",
      "8",
      "--bypass-local-time-gate",
      "--allow-failed-retry",
      "--allow-completed-rerun",
      "--now",
      "2026-09-01T22:20:00.000Z",
    ]);
    const result = await worker.runDeliveryNotificationWorkerTick(options, {
      now: new Date("2026-09-01T22:20:00.000Z"),
      scheduler: async (params) => {
        seen.push(params.interval);
        assert(params.send === true, "Live worker tick should delegate scheduled sends.");
        assert(params.forceLocalTimeCheckBypass === true, "Bypass flag should pass to scheduler.");
        assert(params.allowFailedRetry === true, "Failed retry flag should pass to scheduler.");
        assert(params.allowCompletedRerun === true, "Completed rerun flag should pass to scheduler.");
        assert(typeof params.runTask === "function", "Worker should inject the delivery run task.");
        return {
          ok: true,
          phase: "completed",
          interval: params.interval,
          timezone: scheduler.DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
          expectedLocalTime: scheduler.DELIVERY_INTERVAL_SCHEDULE[params.interval].expectedLocalTime,
          actualDenverLocalTime: "16:20",
          todayInDenver: "2026-09-01",
          lockKey: `delivery_interval_cron:${params.interval}:2026-09-01`,
          previousLockStatus: null,
          schedulerRunId: "validation-scheduler-run",
          retryCount: 0,
          delegatedArgs: [],
          childExitStatus: 0,
          childResultSummary: { ok: true, providerCalls: 0, acumaticaWrites: 0 },
          sensitiveValuesPrinted: false,
        };
      },
    });

    assert(result.ok, "Injected scheduler tick should succeed.");
    assert(seen.join(",") === "8", "Injected scheduler should be called for interval 8.");
  } finally {
    if (previousGate === undefined) {
      delete process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
    } else {
      process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV] = previousGate;
    }
  }
}

async function main() {
  const worker = await import("./delivery-notification-worker");
  const scheduler = await import("./run-scheduled-delivery-interval");

  const denver = scheduler.denverDateTimeParts(
    new Date("2026-08-25T21:10:00.000Z"),
    scheduler.DEFAULT_DELIVERY_SCHEDULER_TIMEZONE
  );
  assert(denver.date === "2026-08-25", "Worker should be able to compute today in Denver.");
  assert(denver.time === "15:10", "Worker should compute Denver local time.");

  validateArgumentParsing(worker);
  validateScheduleAwareness(worker, scheduler);
  await validateDryRunTick(worker);
  await validateInjectedScheduler(worker, scheduler);

  console.log(
    "Delivery notification worker validation passed. No provider calls, Acumatica writes, deploys, or production data mutations were performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
