import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgresql://validation:validation@localhost:5432/validation";

type SchedulerModule = typeof import("./run-scheduled-delivery-interval");
type CronRouteModule = typeof import("../app/api/cron/delivery-interval/[interval]/route");
type ManualCronRouteModule = typeof import("../app/api/cron/delivery-interval/[interval]/manual/route");

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
  const previousGate = process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
  process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV] = "true";
  try {
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
    assert(failedWithoutRetry.previousLockStatus === "failed", "Failed skip should report prior lock status.");
    assert(failedWithoutRetry.childResultSummary === null, "Failed skip should not delegate.");

    let retriedDelegated = false;
    let markedRetried = false;
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
      markRun: async () => {
        markedRetried = true;
      },
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
    assert(failedWithRetry.previousLockStatus === "failed", "Retry should report prior failed lock.");
    assert(failedWithRetry.retryCount === 1, "Retry should expose incremented retry count.");
    assert(retriedDelegated, "retryFailed=true equivalent should delegate.");
    assert(markedRetried, "Retried run should mark scheduler run completion.");

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
    assert(completedWithoutRerun.previousLockStatus === "success", "Completed skip should report prior lock status.");

    let rerunDelegated = false;
    const completedWithRerun = await scheduler.runScheduledDeliveryInterval({
      interval: "90",
      send: true,
      forceLocalTimeCheckBypass: true,
      allowCompletedRerun: true,
      now: new Date("2026-08-25T20:00:00.000Z"),
      acquireLock: async () => ({
        acquired: true,
        phase: "lock_reacquired",
        previousLockStatus: "success",
        row: {
          id: "success-lock",
          lockKey: "delivery_interval_cron:90:2026-08-25",
          status: "running",
          retryCount: 1,
        },
      }),
      markRun: async () => undefined,
      runChildProcess: () => {
        rerunDelegated = true;
        return {
          status: 0,
          error: null,
          summary: { ok: true, providerCalls: 0 },
        };
      },
    });
    assert(completedWithRerun.phase === "completed", "Completed lock with allowRerun should delegate.");
    assert(completedWithRerun.previousLockStatus === "success", "Rerun should report prior success lock.");
    assert(rerunDelegated, "allowRerun=true equivalent should delegate.");
  } finally {
    if (previousGate === undefined) {
      delete process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
    } else {
      process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV] = previousGate;
    }
  }
}

async function validateQueueEnqueueMode(scheduler: SchedulerModule) {
  const previousGate = process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
  process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV] = "true";
  try {
    let enqueuedPayload: unknown = null;
    let markEnqueuedCalled = false;
    let childCalled = false;
    const result = await scheduler.runScheduledDeliveryInterval({
      interval: "90",
      send: true,
      manualRun: true,
      requestedBy: "manual",
      forceLocalTimeCheckBypass: true,
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
      enqueueJob: async (payload) => {
        enqueuedPayload = payload;
        return {
          jobId: "queue_job_90",
          payload,
        };
      },
      markEnqueued: async () => {
        markEnqueuedCalled = true;
      },
      runChildProcess: () => {
        childCalled = true;
        throw new Error("enqueue mode must not spawn child process");
      },
    });

    assert(result.phase === "enqueued", "Scheduler enqueue mode should return enqueued phase.");
    assert(result.queueJobId === "queue_job_90", "Scheduler enqueue mode should return queue job id.");
    assert(result.schedulerRunId === "scheduler_run_90", "Scheduler enqueue mode should return scheduler run id.");
    assert(result.previousLockStatus === "failed", "Scheduler enqueue mode should preserve previous lock status.");
    assert(result.retryCount === 2, "Scheduler enqueue mode should expose retry count.");
    assert(markEnqueuedCalled, "Scheduler enqueue mode should record queue job metadata on scheduler row.");
    assert(!childCalled, "Scheduler enqueue mode must not spawn child process.");

    const payload = enqueuedPayload as {
      interval?: string;
      runDate?: string;
      schedulerRunId?: string;
      lockKey?: string;
      confirmationPhrase?: string;
      send?: boolean;
      manualRun?: boolean;
      requestedBy?: string;
    } | null;
    assert(payload?.interval === "90", "Queue payload should include interval.");
    assert(payload?.runDate === result.todayInDenver, "Queue payload should use Denver run date.");
    assert(payload?.schedulerRunId === "scheduler_run_90", "Queue payload should include scheduler run id.");
    assert(payload?.lockKey === "delivery_interval_cron:90:2026-09-01", "Queue payload should include lock key.");
    assert(
      payload?.confirmationPhrase === "RUN REAL 90 DAY CUSTOMER NOTIFICATIONS",
      "Queue payload should include exact interval confirmation phrase."
    );
    assert(payload?.send === true, "Queue payload should request live send path.");
    assert(payload?.manualRun === true, "Queue payload should preserve manualRun.");
    assert(payload?.requestedBy === "manual", "Queue payload should preserve requestedBy.");
  } finally {
    if (previousGate === undefined) {
      delete process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
    } else {
      process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV] = previousGate;
    }
  }
}

function validateVercelCronConfig() {
  const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    crons?: Array<{ path?: string; schedule?: string }>;
  };
  const expected = new Map([
    ["/api/cron/delivery-interval/180", "0 21,22 * * 1-5"],
    ["/api/cron/delivery-interval/90", "10 21,22 * * 1-5"],
    ["/api/cron/delivery-interval/60", "20 21,22 * * 1-5"],
    ["/api/cron/delivery-interval/42", "30 21,22 * * 1-5"],
    ["/api/cron/delivery-interval/30", "40 21,22 * * 1-5"],
    ["/api/cron/delivery-interval/14", "50 21,22 * * 1-5"],
    ["/api/cron/delivery-interval/12", "0 22,23 * * 1-5"],
    ["/api/cron/delivery-interval/10", "10 22,23 * * 1-5"],
    ["/api/cron/delivery-interval/2", "30 22,23 * * 1-5"],
  ]);
  if (!Array.isArray(vercelConfig.crons)) {
    throw new Error("vercel.json should define crons.");
  }
  const crons = vercelConfig.crons;
  assert(crons.length === expected.size, "vercel.json should contain exactly the schedule-ready intervals.");
  for (const [path, schedule] of expected) {
    const actual = crons.find((cron) => cron.path === path);
    assert(actual?.schedule === schedule, `${path} should use schedule ${schedule}.`);
  }
  assert(
    !crons.some((cron) => cron.path === "/api/cron/delivery-interval/8"),
    "vercel.json must not schedule interval 8."
  );
}

async function validateCronRouteBehavior(
  scheduler: SchedulerModule,
  route: CronRouteModule,
  manualRoute: ManualCronRouteModule
) {
  const unauthenticated = route.validateCronAuthorization(
    new Request("https://example.com/api/cron/delivery-interval/90", {
      headers: { "user-agent": "vercel-cron/1.0" },
    }),
    {}
  );
  assert(!unauthenticated.ok, "Cron route should fail closed when CRON_SECRET is missing.");
  if (!unauthenticated.ok) {
    assert(
      unauthenticated.reason === "cron_secret_not_configured",
      "Missing CRON_SECRET should report cron_secret_not_configured."
    );
  }

  const unauthorized = route.validateCronAuthorization(
    new Request("https://example.com/api/cron/delivery-interval/90", {
      headers: { authorization: "Bearer wrong", "user-agent": "vercel-cron/1.0" },
    }),
    { CRON_SECRET: "secret" }
  );
  assert(!unauthorized.ok, "Cron route should reject bad bearer token.");
  if (!unauthorized.ok) assert(unauthorized.reason === "unauthorized", "Bad bearer token should be unauthorized.");

  const authorized = route.validateCronAuthorization(
    new Request("https://example.com/api/cron/delivery-interval/90", {
      headers: { authorization: "Bearer secret", "user-agent": "vercel-cron/1.0" },
    }),
    { CRON_SECRET: "secret" }
  );
  assert(authorized.ok, "Cron route should accept matching bearer token.");
  assert(authorized.vercelCronUserAgent === true, "Cron route should recognize Vercel cron user agent.");

  const previousCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "secret";
  const interval8Response = await route.GET(
    new Request("https://example.com/api/cron/delivery-interval/8", {
      headers: { authorization: "Bearer secret", "user-agent": "vercel-cron/1.0" },
    }),
    { params: Promise.resolve({ interval: "8" }) }
  );
  if (previousCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = previousCronSecret;
  }
  const interval8Body = await interval8Response.json();
  assert(interval8Response.status === 400, "Cron route should reject interval 8.");
  assert(interval8Body.phase === "interval_8_not_schedule_ready", "Interval 8 rejection should use the expected phase.");
  assert(interval8Body.manualRun === false, "Scheduled interval 8 rejection should report manualRun false.");

  process.env.CRON_SECRET = "secret";
  const scheduledWrongTimeResponse = await route.GET(
    new Request("https://example.com/api/cron/delivery-interval/90", {
      headers: { authorization: "Bearer secret", "user-agent": "vercel-cron/1.0" },
    }),
    { params: Promise.resolve({ interval: "90" }) }
  );
  if (previousCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = previousCronSecret;
  }
  const scheduledWrongTimeBody = await scheduledWrongTimeResponse.json();
  assert(scheduledWrongTimeResponse.status === 200, "Scheduled wrong-time route should exit successfully.");
  assert(
    scheduledWrongTimeBody.phase === "skipped_wrong_local_time",
    "Scheduled wrong-time route should preserve local-time gate."
  );
  assert(scheduledWrongTimeBody.manualRun === false, "Scheduled wrong-time route should report manualRun false.");
  assert(
    scheduledWrongTimeBody.localTimeGateBypassed === false,
    "Scheduled wrong-time route should not bypass local-time gate."
  );

  const wrongTime = await scheduler.runScheduledDeliveryInterval({
    interval: "90",
    send: true,
    now: new Date("2026-08-25T20:10:00.000Z"),
  });
  assert(wrongTime.ok === true, "Wrong-time scheduler call should exit successfully.");
  assert(wrongTime.phase === "skipped_wrong_local_time", "Wrong-time scheduler call should not delegate.");
  assert(wrongTime.childResultSummary === null, "Wrong-time scheduler call should not run child process.");

  const previousGate = process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
  delete process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
  await (async () => {
    try {
      await scheduler.runScheduledDeliveryInterval({
        interval: "90",
        send: true,
        now: new Date("2026-08-25T21:10:00.000Z"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert(
        message.includes(scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV),
        "Live-send gate should block scheduled send before delegation."
      );
      return;
    } finally {
      if (previousGate === undefined) {
        delete process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV];
      } else {
        process.env[scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV] = previousGate;
      }
    }
    throw new Error("Expected live-send gate to block scheduled send.");
  })();

  process.env.CRON_SECRET = "secret";
  const manualWrongTimeResponse = await route.GET(
    new Request("https://example.com/api/cron/delivery-interval/90?manualRun=true", {
      headers: { authorization: "Bearer secret", "user-agent": "vercel-cron/1.0" },
    }),
    { params: Promise.resolve({ interval: "90" }) }
  );
  const manualWrongTimeBody = await manualWrongTimeResponse.json();
  assert(manualWrongTimeResponse.status === 500, "Manual route should fail closed when live scheduler gate is off.");
  assert(manualWrongTimeBody.phase === "failed", "Manual route should fail at the live scheduler gate.");
  assert(manualWrongTimeBody.manualRun === true, "Manual query route should report manualRun true.");
  assert(
    manualWrongTimeBody.localTimeGateBypassed === true,
    "Manual query route should report local-time gate bypass."
  );
  assert(
    String(manualWrongTimeBody.error).includes(scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV),
    "Manual query route should still require scheduler live-send gate."
  );
  assert(
    manualWrongTimeBody.todayInDenver,
    "Manual query route should report the Denver run date even when blocked."
  );

  const manualEndpointResponse = await manualRoute.GET(
    new Request("https://example.com/api/cron/delivery-interval/90/manual", {
      headers: { authorization: "Bearer secret", "user-agent": "vercel-cron/1.0" },
    }),
    { params: Promise.resolve({ interval: "90" }) }
  );
  if (previousCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = previousCronSecret;
  }
  const manualEndpointBody = await manualEndpointResponse.json();
  assert(manualEndpointResponse.status === 500, "Manual endpoint should fail closed when live scheduler gate is off.");
  assert(manualEndpointBody.manualRun === true, "Manual endpoint should report manualRun true.");
  assert(
    manualEndpointBody.localTimeGateBypassed === true,
    "Manual endpoint should report local-time gate bypass."
  );
  assert(
    String(manualEndpointBody.error).includes(scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV),
    "Manual endpoint should still require scheduler live-send gate."
  );

  process.env.CRON_SECRET = "secret";
  const retryFailedResponse = await manualRoute.GET(
    new Request("https://example.com/api/cron/delivery-interval/90/manual?retryFailed=true", {
      headers: { authorization: "Bearer secret", "user-agent": "vercel-cron/1.0" },
    }),
    { params: Promise.resolve({ interval: "90" }) }
  );
  if (previousCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = previousCronSecret;
  }
  const retryFailedBody = await retryFailedResponse.json();
  assert(retryFailedBody.manualRun === true, "Manual retry endpoint should report manualRun true.");
  assert(retryFailedBody.retryFailed === true, "Manual retry endpoint should recognize retryFailed=true.");
  assert(retryFailedBody.allowRerun === false, "Manual retry endpoint should not imply allowRerun.");
  assert(
    retryFailedBody.localTimeGateBypassed === true,
    "Manual retry endpoint should bypass the local-time gate."
  );
  assert(
    String(retryFailedBody.error).includes(scheduler.DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV),
    "Manual retry endpoint should still require live-send gate before touching lock/delegate."
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

  const route = readFileSync("app/api/cron/delivery-interval/[interval]/route.ts", "utf8");
  assert(route.includes("CRON_SECRET"), "Cron route should require CRON_SECRET.");
  assert(route.includes("runScheduledDeliveryInterval"), "Cron route should call scheduler wrapper logic.");
  assert(route.includes("enqueueDeliveryScheduledInterval"), "Cron route should enqueue queue-backed scheduler job.");
  assert(route.includes("interval_8_not_schedule_ready"), "Cron route should fail closed for interval 8.");
  assert(route.includes("send: true"), "Cron route should request scheduled live-send behavior.");
  assert(route.includes("manualRun"), "Cron route should support authenticated manual run bypass.");
  assert(route.includes("forceLocalTimeCheckBypass: manualRun"), "Manual run should use scheduler bypass behavior.");
  assert(route.includes("retryFailed"), "Cron route should pass retryFailed into scheduler retry handling.");
  assert(route.includes("allowFailedRetry: retryFailed"), "Cron route should map retryFailed to allowFailedRetry.");
  assert(
    route.includes("allowRerun") && route.includes("allowCompletedRerun"),
    "Manual rerun should be explicit and protected."
  );
  assert(
    route.includes("delivery_interval_cron") === false,
    "Cron route should not duplicate scheduler lock implementation."
  );
  assert(!route.includes("child_process"), "Cron route must not import child_process.");
  assert(!route.includes("spawnSync"), "Cron route must not spawn npm.");

  const manualRoute = readFileSync("app/api/cron/delivery-interval/[interval]/manual/route.ts", "utf8");
  assert(
    manualRoute.includes("handleDeliveryIntervalCronRequest"),
    "Manual endpoint should share the scheduled route handler."
  );
}

async function main() {
  const scheduler = await import("./run-scheduled-delivery-interval");
  const route = await import("../app/api/cron/delivery-interval/[interval]/route");
  const manualRoute = await import("../app/api/cron/delivery-interval/[interval]/manual/route");
  validateTimeZoneHandling(scheduler);
  validateArgumentHandling(scheduler);
  validateDelegation(scheduler);
  await validateLockRetryBehavior(scheduler);
  await validateQueueEnqueueMode(scheduler);
  validateStaticFiles(scheduler);
  validateVercelCronConfig();
  await validateCronRouteBehavior(scheduler, route, manualRoute);

  console.log(
    "Delivery scheduler wrapper validation passed. No cron jobs, SMS/email, provider calls, Acumatica writes, queue writebacks, holds, deploys, or production data mutations were performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
