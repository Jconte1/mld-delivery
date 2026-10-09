import { Socket } from "node:net";

process.env.DATABASE_URL = "postgresql://validation:validation@localhost:1/validation";
Object.defineProperty(Socket.prototype, "connect", { value: () => { throw new Error("Validation forbids network connections"); } });
globalThis.fetch = async () => { throw new Error("Validation forbids fetch"); };

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
    }).join(",") === "180,90",
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
  assert(
    worker.isWeeklyStockSyncDue({ weekday: "Sun", localTime: "03:00", env: {} }),
    "SharePoint stock sync should default to Sunday 03:00 Denver time."
  );
  assert(
    worker.isWeeklyStockSyncDue({ weekday: "Sun", localTime: "03:01", env: {} }),
    "SharePoint stock sync should catch up after its due minute."
  );
  assert(
    !worker.isWeeklyStockSyncDue({
      weekday: "Sun",
      localTime: "03:00",
      env: { DELIVERY_SHAREPOINT_STOCK_SYNC_ENABLED: "false" },
    }),
    "Explicit false should disable weekly SharePoint stock sync."
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

async function validateCatchup(worker: WorkerModule, scheduler: SchedulerModule) {
  let now = new Date("2026-10-07T21:30:00Z");
  const completed = new Set<string>();
  const ran: string[] = [];
  const options = worker.parseDeliveryNotificationWorkerArgs([]);
  const tick = () => worker.runDeliveryNotificationWorkerTick({ ...options, now }, {
    now,
    clock: () => now,
    scheduler: (params) => scheduler.runScheduledDeliveryInterval({
      ...params,
      acquireLock: async (lock) => {
        assert(!lock.allowCompletedRerun && !lock.allowFailedRetry, "Catchup must not enable retries or reruns");
        const exists = completed.has(lock.lockKey);
        completed.add(lock.lockKey);
        return { acquired: !exists, phase: exists ? "skipped_already_completed" : "lock_acquired",
          previousLockStatus: exists ? "success" : null,
          row: { id: lock.lockKey, lockKey: lock.lockKey, status: exists ? "success" : "running", retryCount: 0 } } as Awaited<ReturnType<NonNullable<typeof params.acquireLock>>>;
      },
      markRun: async () => undefined,
      runTask: async (payload) => {
        ran.push(payload.interval);
        if (payload.interval === "42") now = new Date("2026-10-07T21:42:00Z");
      },
    }),
  });
  assert((await tick()).ok, "Initial slow-import tick succeeds");
  assert((await tick()).ok, "Restart/next tick catches missed minutes");
  assert(ran.join(",") === "180,90,60,42,39,30", "Slow 42 must not lose 39 or rerun completed intervals");
  await tick();
  assert(ran.length === 6, "Restart must retain date locks");
  now = new Date("2026-10-08T06:00:00Z");
  assert((await tick()).dueIntervals.length === 0, "Midnight must not replay yesterday");
  let calls = 0;
  await worker.runDeliveryNotificationWorkerTick({ ...options, now: new Date("2026-10-08T05:59:00Z") }, {
    clock: () => ++calls === 1 ? new Date("2026-10-08T05:59:00Z") : new Date("2026-10-08T06:00:00Z"),
    scheduler: async () => { throw new Error("mock failed import"); },
  });
  assert(calls === 2, "Cross-midnight tick must stop before the next interval");
  for (const timestamp of ["2026-03-08T21:36:00Z", "2026-11-01T22:36:00Z"]) {
    const local = scheduler.denverDateTimeParts(new Date(timestamp));
    assert(worker.dueIntervalsForLocalTime({ intervals: ["42", "39", "30"], localTime: local.time, bypassLocalTimeGate: false }).join(",") === "42,39", "DST catchup uses Denver wall time");
  }
  try {
    await worker.runDeliveryNotificationWorkerTick({ ...options, allowCompletedRerun: true });
    throw new Error("Expected completed-rerun rejection");
  } catch (error) {
    assert(String(error).includes("require --once and --interval"), "Automatic reruns must fail closed");
  }
}

async function validateStockRecovery(worker: WorkerModule) {
  const { SHAREPOINT_STOCK_SOURCES: sources } = await import("../lib/sharepoint-stock/regionalStockLists");
  const now = new Date("2026-10-07T18:00:00Z");
  const success = new Map<string, Date | null>([
    [sources.utah_wyoming, new Date("2026-09-21T18:00:00Z")],
    [sources.idaho, new Date("2026-10-05T18:00:00Z")],
    [sources.southwest, null],
  ]);
  const calls: string[] = [];
  let fail = true;
  const dependencies = {
    env: { NODE_ENV: "test" as const },
    latestSuccess: async (source: string) => ({ completedAt: success.get(source) ?? null }),
    sync: (async (params: { stockListKey?: keyof typeof sources }) => {
      const key = params.stockListKey!;
      calls.push(key);
      if (key === "utah_wyoming" && fail) throw new Error("mock regional failure");
      success.set(sources[key], now);
      return { status: "SUCCESS", stockListKey: key, source: sources[key] };
    }) as NonNullable<NonNullable<Parameters<typeof worker.runWeeklySharePointStockSync>[1]>["sync"]>,
  };
  const run = () => worker.runWeeklySharePointStockSync({ todayInDenver: "2026-10-07", now }, dependencies);
  const first = await run();
  assert(first.some((r) => r.status === "FAILED"), "Failure must remain visible");
  assert(calls.join(",") === "utah_wyoming,southwest", "Startup refreshes only stale/missing regions, despite partial failure");
  fail = false;
  await run();
  await run();
  assert(calls.join(",") === "utah_wyoming,southwest,utah_wyoming", "Restart skips successful regions and recovers failed region");
  success.set(sources.idaho, new Date("2026-10-03T18:00:00Z"));
  await run();
  assert(calls.at(-1) === "idaho", "Fresh but missed weekly deadline must catch up");
  success.set(sources.idaho, new Date("2026-10-05T18:00:00Z"));
  await worker.runWeeklySharePointStockSync({ todayInDenver: "2026-10-07", now }, { ...dependencies, env: { NODE_ENV: "test", SHAREPOINT_STOCK_FRESHNESS_DAYS: "1" } });
  assert(calls.filter((key) => key === "idaho").length === 2, "Custom freshness cutoff remains enforced");
  await worker.runWeeklySharePointStockSync({ todayInDenver: "2026-10-07", now }, {
    env: { NODE_ENV: "test", DELIVERY_SHAREPOINT_STOCK_SYNC_ENABLED: "false" },
    latestSuccess: async () => { throw new Error("Disabled sync must not query"); },
  });
  assert(worker.latestStockSyncDeadline(new Date("2026-03-08T09:30:00Z"), dependencies.env) === "2026-03-08T03:00", "Spring DST deadline");
  assert(worker.latestStockSyncDeadline(new Date("2026-11-01T08:30:00Z"), dependencies.env) === "2026-10-25T03:00", "Repeated fall hour is before weekly deadline");
  assert(worker.latestStockSyncDeadline(new Date("2026-11-01T10:01:00Z"), dependencies.env) === "2026-11-01T03:00", "Fall DST missed minute deadline");
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
  await validateCatchup(worker, scheduler);
  await validateStockRecovery(worker);

  console.log(
    "Delivery notification worker validation passed. No provider calls, Acumatica writes, deploys, or production data mutations were performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
