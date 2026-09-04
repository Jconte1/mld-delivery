import {
  DELIVERY_INTERVAL_SCHEDULE,
  DELIVERY_SCHEDULER_INTERVALS,
  DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
  denverDateTimeParts,
  isScheduledInterval,
  runScheduledDeliveryInterval,
  type DeliveryScheduledInterval,
  type DeliveryScheduledIntervalTaskPayload,
  type ScheduledDeliveryIntervalResult,
} from "./run-scheduled-delivery-interval";
import { runDeliveryInterval } from "./run-delivery-interval";
import { run42DayNoResponseCommand } from "./run-42-day-confirmation-no-response";
import { addDays, dateKey } from "../lib/notifications/helpers";
import {
  normalizeDeliveryOrderScope,
} from "../lib/notifications/orderScope";
import { prisma } from "../lib/prisma";

const DEFAULT_WORKER_INTERVAL_MS = 60_000;
const NO_RESPONSE_INTERVAL = "39";

type WorkerChannel = "sms" | "email" | "both";

export type DeliveryNotificationWorkerOptions = {
  once: boolean;
  interval: DeliveryScheduledInterval | null;
  orderType: string | null;
  orderNumber: string | null;
  deliveryDate: string | null;
  channel: WorkerChannel;
  bypassLocalTimeGate: boolean;
  allowFailedRetry: boolean;
  allowCompletedRerun: boolean;
  dryRun: boolean;
  workerIntervalMs: number;
  now: Date;
};

export type DeliveryNotificationWorkerRunTask = (
  payload: DeliveryScheduledIntervalTaskPayload
) => Promise<unknown>;

export type DeliveryNotificationWorkerScheduler = (
  params: Parameters<typeof runScheduledDeliveryInterval>[0]
) => Promise<ScheduledDeliveryIntervalResult>;

export type DeliveryNotificationWorkerTickResult = {
  ok: boolean;
  phase: "dry_run" | "completed";
  timezone: string;
  actualDenverLocalTime: string;
  todayInDenver: string;
  intervalsConsidered: DeliveryScheduledInterval[];
  dueIntervals: DeliveryScheduledInterval[];
  results: Array<Record<string, unknown>>;
  sensitiveValuesPrinted: false;
};

function log(level: "info" | "warn" | "error", message: string, details: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...details,
      sensitiveValuesPrinted: false,
    })
  );
}

function readOption(args: string[], index: number, name: string) {
  const arg = args[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, nextIndex: index + 1 };
}

function parseBooleanNumber(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

export function parseDeliveryNotificationWorkerArgs(
  args: string[]
): DeliveryNotificationWorkerOptions {
  const options: DeliveryNotificationWorkerOptions = {
    once: false,
    interval: null,
    orderType: null,
    orderNumber: null,
    deliveryDate: null,
    channel: "both",
    bypassLocalTimeGate: false,
    allowFailedRetry: false,
    allowCompletedRerun: false,
    dryRun: false,
    workerIntervalMs: Number(process.env.DELIVERY_NOTIFICATION_WORKER_INTERVAL_MS || DEFAULT_WORKER_INTERVAL_MS),
    now: new Date(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--bypass-local-time-gate") {
      options.bypassLocalTimeGate = true;
      continue;
    }
    if (arg === "--allow-failed-retry") {
      options.allowFailedRetry = true;
      continue;
    }
    if (arg === "--allow-completed-rerun") {
      options.allowCompletedRerun = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const parsed = readOption(args, index, "--interval");
      const interval = parsed.value.trim();
      if (!isScheduledInterval(interval)) {
        throw new Error(`--interval must be one of ${DELIVERY_SCHEDULER_INTERVALS.join(", ")}.`);
      }
      options.interval = interval;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--order-type" || arg.startsWith("--order-type=")) {
      const parsed = readOption(args, index, "--order-type");
      options.orderType = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--order-number" || arg.startsWith("--order-number=")) {
      const parsed = readOption(args, index, "--order-number");
      options.orderNumber = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--delivery-date" || arg.startsWith("--delivery-date=")) {
      const parsed = readOption(args, index, "--delivery-date");
      options.deliveryDate = dateKey(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--channel" || arg.startsWith("--channel=")) {
      const parsed = readOption(args, index, "--channel");
      const channel = parsed.value.trim().toLowerCase();
      if (channel !== "sms" && channel !== "email" && channel !== "both") {
        throw new Error("--channel must be sms, email, or both.");
      }
      options.channel = channel;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--worker-interval-ms" || arg.startsWith("--worker-interval-ms=")) {
      const parsed = readOption(args, index, "--worker-interval-ms");
      options.workerIntervalMs = parseBooleanNumber(parsed.value, "--worker-interval-ms");
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--now" || arg.startsWith("--now=")) {
      const parsed = readOption(args, index, "--now");
      const now = new Date(parsed.value);
      if (Number.isNaN(now.getTime())) throw new Error("--now must be an ISO timestamp.");
      options.now = now;
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  normalizeDeliveryOrderScope({
    orderType: options.orderType,
    orderNumber: options.orderNumber,
  });

  return options;
}

export function intervalsForWorkerTick(options: {
  interval: DeliveryScheduledInterval | null;
}): DeliveryScheduledInterval[] {
  return options.interval ? [options.interval] : [...DELIVERY_SCHEDULER_INTERVALS];
}

export function dueIntervalsForLocalTime(params: {
  intervals: DeliveryScheduledInterval[];
  localTime: string;
  bypassLocalTimeGate: boolean;
}) {
  if (params.bypassLocalTimeGate) return params.intervals;
  return params.intervals.filter(
    (interval) => DELIVERY_INTERVAL_SCHEDULE[interval].expectedLocalTime === params.localTime
  );
}

function intervalDays(interval: DeliveryScheduledInterval) {
  if (interval === NO_RESPONSE_INTERVAL) return 39;
  const parsed = Number(interval);
  if (!Number.isFinite(parsed)) throw new Error(`Interval ${interval} does not map to a day count.`);
  return parsed;
}

export function runDateForWorkerInterval(params: {
  interval: DeliveryScheduledInterval;
  todayInDenver: string;
  deliveryDate: string | null;
}) {
  if (!params.deliveryDate) return params.todayInDenver;
  return dateKey(addDays(params.deliveryDate, -intervalDays(params.interval)));
}

export async function runDeliveryNotificationWorkerTask(
  payload: DeliveryScheduledIntervalTaskPayload
) {
  const runIdPrefix = `${payload.requestedBy}_${payload.runDate.replace(/-/g, "")}_${payload.interval}`;
  if (payload.interval === NO_RESPONSE_INTERVAL) {
    return run42DayNoResponseCommand({
      runDate: payload.runDate,
      mode: "send",
      confirmPhrase: payload.confirmationPhrase,
      testRunId: runIdPrefix,
      orderType: payload.orderScope?.orderType ?? null,
      orderNumber: payload.orderScope?.orderNumber ?? null,
      orderScope: payload.orderScope ?? null,
    });
  }

  return runDeliveryInterval({
    interval: payload.interval,
    runDate: payload.runDate,
    send: true,
    confirmPhrase: payload.confirmationPhrase,
    runId: runIdPrefix,
    orderType: payload.orderScope?.orderType ?? null,
    orderNumber: payload.orderScope?.orderNumber ?? null,
    orderScope: payload.orderScope ?? null,
    channel: payload.channel,
    verifyPackageAndMigrations: false,
    manualPresentationRun: false,
  });
}

function resultForLog(result: ScheduledDeliveryIntervalResult | Record<string, unknown>) {
  return {
    ok: result.ok,
    phase: result.phase,
    interval: result.interval,
    todayInDenver: result.todayInDenver,
    expectedLocalTime: result.expectedLocalTime,
    actualDenverLocalTime: result.actualDenverLocalTime,
    lockKey: result.lockKey,
    previousLockStatus: result.previousLockStatus,
    schedulerRunId: result.schedulerRunId,
    retryCount: result.retryCount,
    childExitStatus: result.childExitStatus,
    sensitiveValuesPrinted: false,
  };
}

export async function runDeliveryNotificationWorkerTick(
  options: DeliveryNotificationWorkerOptions,
  dependencies: {
    scheduler?: DeliveryNotificationWorkerScheduler;
    runTask?: DeliveryNotificationWorkerRunTask;
    now?: Date;
  } = {}
): Promise<DeliveryNotificationWorkerTickResult> {
  const now = dependencies.now ?? options.now ?? new Date();
  const local = denverDateTimeParts(now, DEFAULT_DELIVERY_SCHEDULER_TIMEZONE);
  const intervalsConsidered = intervalsForWorkerTick({ interval: options.interval });
  const dueIntervals = dueIntervalsForLocalTime({
    intervals: intervalsConsidered,
    localTime: local.time,
    bypassLocalTimeGate: options.bypassLocalTimeGate,
  });
  const orderScope = normalizeDeliveryOrderScope({
    orderType: options.orderType,
    orderNumber: options.orderNumber,
  });
  const results: Array<Record<string, unknown>> = [];

  for (const interval of dueIntervals) {
    const runDate = runDateForWorkerInterval({
      interval,
      todayInDenver: local.date,
      deliveryDate: options.deliveryDate,
    });

    if (options.dryRun) {
      const dryRunResult = {
        ok: true,
        phase: "dry_run_would_run",
        interval,
        runDate,
        expectedLocalTime: DELIVERY_INTERVAL_SCHEDULE[interval].expectedLocalTime,
        actualDenverLocalTime: local.time,
        todayInDenver: local.date,
        orderScope,
        channel: options.channel,
        route:
          interval === NO_RESPONSE_INTERVAL
            ? "run42DayNoResponseCommand"
            : "runDeliveryInterval",
        providerCalls: 0,
        acumaticaWrites: 0,
        sensitiveValuesPrinted: false,
      };
      log("info", "delivery_notification_worker_interval_dry_run", dryRunResult);
      results.push(dryRunResult);
      continue;
    }

    try {
      const schedulerResult = await (dependencies.scheduler ?? runScheduledDeliveryInterval)({
        interval,
        send: true,
        forceLocalTimeCheckBypass: options.bypassLocalTimeGate,
        allowFailedRetry: options.allowFailedRetry,
        allowCompletedRerun: options.allowCompletedRerun,
        orderType: orderScope?.orderType ?? null,
        orderNumber: orderScope?.orderNumber ?? null,
        channel: options.channel,
        runDateOverride: runDate,
        manualRun: options.bypassLocalTimeGate,
        requestedBy: options.bypassLocalTimeGate ? "manual" : "vercel-cron",
        runTask: dependencies.runTask ?? runDeliveryNotificationWorkerTask,
      });
      log("info", "delivery_notification_worker_interval_result", resultForLog(schedulerResult));
      results.push(schedulerResult as unknown as Record<string, unknown>);
    } catch (error) {
      const failed = {
        ok: false,
        phase: "interval_failed",
        interval,
        runDate,
        error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        sensitiveValuesPrinted: false,
      };
      log("error", "delivery_notification_worker_interval_failed", failed);
      results.push(failed);
    }
  }

  if (!dueIntervals.length) {
    log("info", "delivery_notification_worker_no_due_intervals", {
      timezone: DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
      actualDenverLocalTime: local.time,
      todayInDenver: local.date,
      intervalsConsidered,
    });
  }

  return {
    ok: results.every((result) => result.ok !== false),
    phase: options.dryRun ? "dry_run" : "completed",
    timezone: DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
    actualDenverLocalTime: local.time,
    todayInDenver: local.date,
    intervalsConsidered,
    dueIntervals,
    results,
    sensitiveValuesPrinted: false,
  };
}

async function main() {
  const options = parseDeliveryNotificationWorkerArgs(process.argv.slice(2));
  let shuttingDown = false;
  const shutdown = () => {
    shuttingDown = true;
    log("info", "delivery_notification_worker_shutdown_requested");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  log("info", "delivery_notification_worker_started", {
    once: options.once,
    interval: options.interval,
    dryRun: options.dryRun,
    workerIntervalMs: options.workerIntervalMs,
  });

  do {
    const result = await runDeliveryNotificationWorkerTick({
      ...options,
      now: new Date(),
    });
    if (options.once) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, options.workerIntervalMs));
  } while (!shuttingDown);
}

if (typeof require !== "undefined" && require.main === module) {
  main()
    .catch((error) => {
      log("error", "delivery_notification_worker_fatal", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
