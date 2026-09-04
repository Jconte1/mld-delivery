import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { dateFromKey, dateKey } from "../lib/notifications/helpers";
import { normalizeDeliveryOrderScope } from "../lib/notifications/orderScope";
import { prisma } from "../lib/prisma";

export const DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV =
  "DELIVERY_SCHEDULER_LIVE_SEND_ENABLED";
export const DEFAULT_DELIVERY_SCHEDULER_TIMEZONE = "America/Denver";

export const DELIVERY_SCHEDULER_INTERVALS = [
  "180",
  "90",
  "60",
  "42",
  "39",
  "30",
  "14",
  "12",
  "10",
  "8",
  "2",
] as const;

export type DeliveryScheduledInterval = (typeof DELIVERY_SCHEDULER_INTERVALS)[number];
export type SchedulerLockStatus = "running" | "success" | "failed";

export const DELIVERY_INTERVAL_SCHEDULE: Record<
  DeliveryScheduledInterval,
  { expectedLocalTime: string; confirmPhrase: string }
> = {
  "180": {
    expectedLocalTime: "15:00",
    confirmPhrase: "RUN REAL 180 DAY CUSTOMER NOTIFICATIONS",
  },
  "90": {
    expectedLocalTime: "15:10",
    confirmPhrase: "RUN REAL 90 DAY CUSTOMER NOTIFICATIONS",
  },
  "60": {
    expectedLocalTime: "15:20",
    confirmPhrase: "RUN REAL 60 DAY CUSTOMER NOTIFICATIONS",
  },
  "42": {
    expectedLocalTime: "15:30",
    confirmPhrase: "RUN REAL 42 DAY CUSTOMER CONFIRMATION NOTIFICATIONS",
  },
  "39": {
    expectedLocalTime: "15:35",
    confirmPhrase: "RUN REAL 42 DAY NO RESPONSE FOLLOW UPS",
  },
  "30": {
    expectedLocalTime: "15:40",
    confirmPhrase: "RUN REAL 30 DAY CUSTOMER NOTIFICATIONS",
  },
  "14": {
    expectedLocalTime: "15:50",
    confirmPhrase: "RUN REAL 14 DAY CUSTOMER NOTIFICATIONS",
  },
  "12": {
    expectedLocalTime: "16:00",
    confirmPhrase: "RUN REAL 12 DAY CUSTOMER NOTIFICATIONS",
  },
  "10": {
    expectedLocalTime: "16:10",
    confirmPhrase: "RUN REAL 10 DAY CUSTOMER NOTIFICATIONS",
  },
  "8": {
    expectedLocalTime: "16:20",
    confirmPhrase: "RUN REAL 8 DAY CUSTOMER NOTIFICATIONS",
  },
  "2": {
    expectedLocalTime: "16:30",
    confirmPhrase: "RUN REAL 2 DAY CUSTOMER NOTIFICATIONS",
  },
};

type CliOptions = {
  interval: DeliveryScheduledInterval | null;
  expectedLocalTime: string | null;
  timezone: string;
  send: boolean;
  forceLocalTimeCheckBypass: boolean;
  allowFailedRetry: boolean;
  allowCompletedRerun: boolean;
  orderType: string | null;
  orderNumber: string | null;
  channel: "sms" | "email" | "both";
  now: Date;
};

type SchedulerRunRow = {
  id: string;
  lockKey: string;
  status: SchedulerLockStatus;
  retryCount: number;
};

type SchedulerLockResult =
  | {
      acquired: true;
      row: SchedulerRunRow;
      phase: "lock_acquired" | "lock_reacquired";
      previousLockStatus: SchedulerLockStatus | null;
    }
  | {
      acquired: false;
      row: SchedulerRunRow;
      phase:
        | "skipped_lock_active"
        | "skipped_already_completed"
        | "skipped_failed_requires_retry_flag";
      previousLockStatus: SchedulerLockStatus;
    };

type SchedulerChildResult = {
  status: number | null;
  error: string | null;
  summary: unknown;
};

export type DeliveryScheduledIntervalTaskPayload = {
  interval: DeliveryScheduledInterval;
  runDate: string;
  timezone: string;
  expectedLocalTime: string;
  manualRun: boolean;
  schedulerRunId: string;
  lockKey: string;
  send: true;
  confirmationPhrase: string;
  requestedBy: "vercel-cron" | "manual";
  channel: "sms" | "email" | "both";
  orderScope?: {
    orderType: string;
    orderNumber: string;
  };
};

export type RunScheduledDeliveryIntervalParams = {
  interval: DeliveryScheduledInterval;
  expectedLocalTime?: string | null;
  timezone?: string | null;
  send?: boolean;
  forceLocalTimeCheckBypass?: boolean;
  allowFailedRetry?: boolean;
  allowCompletedRerun?: boolean;
  orderType?: string | null;
  orderNumber?: string | null;
  channel?: "sms" | "email" | "both" | null;
  runDateOverride?: string | null;
  lockScopeParts?: Array<string | null | undefined>;
  now?: Date;
  manualRun?: boolean;
  requestedBy?: "vercel-cron" | "manual";
  runTask?: (payload: DeliveryScheduledIntervalTaskPayload) => Promise<unknown>;
  acquireLock?: (params: {
    lockKey: string;
    interval: string;
    runDate: string;
    timezone: string;
    expectedLocalTime: string;
    actualLocalTime: string;
    delegatedArgs: string[];
    allowFailedRetry: boolean;
    allowCompletedRerun: boolean;
  }) => Promise<SchedulerLockResult>;
  markRun?: (params: {
    id: string;
    status: "success" | "failed";
    resultSummary: unknown;
    errorMessage?: string | null;
  }) => Promise<void>;
  runChildProcess?: (args: string[]) => SchedulerChildResult | Promise<SchedulerChildResult>;
};

export type ScheduledDeliveryIntervalResult = {
  ok: boolean;
  phase: string;
  interval: DeliveryScheduledInterval;
  timezone: string;
  expectedLocalTime: string;
  actualDenverLocalTime: string;
  todayInDenver: string;
  lockKey?: string;
  previousLockStatus?: SchedulerLockStatus | null;
  schedulerRunId?: string;
  retryCount?: number;
  delegatedArgs: string[];
  childExitStatus?: number | null;
  childResultSummary: unknown;
  sensitiveValuesPrinted: false;
};

function readOption(args: string[], index: number, name: string) {
  const arg = args[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, nextIndex: index + 1 };
}

export function isScheduledInterval(value: string): value is DeliveryScheduledInterval {
  return DELIVERY_SCHEDULER_INTERVALS.includes(value as DeliveryScheduledInterval);
}

export function normalizeLocalTime(value: string) {
  const match = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error("--expected-local-time must use HH:mm 24-hour format.");
  return `${match[1]}:${match[2]}`;
}

export function denverDateTimeParts(
  now: Date = new Date(),
  timezone = DEFAULT_DELIVERY_SCHEDULER_TIMEZONE
) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const hour = part("hour") === "24" ? "00" : part("hour");
  const minute = part("minute");
  if (!year || !month || !day || !hour || !minute) {
    throw new Error(`Could not compute local date/time for timezone ${timezone}.`);
  }
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
  };
}

export function schedulerLockKey(
  interval: string,
  runDate: string,
  scopeParts: Array<string | null | undefined> = []
) {
  const normalizedScope = scopeParts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/[^A-Za-z0-9_.-]/g, "_"));
  return [`delivery_interval_cron:${interval}:${runDate}`, ...normalizedScope].join(":");
}

export function delegatedRunnerArgs(params: {
  interval: DeliveryScheduledInterval;
  runDate: string;
  send: boolean;
  confirmPhrase: string;
  orderType?: string | null;
  orderNumber?: string | null;
  channel?: "sms" | "email" | "both" | null;
}): string[] {
  const args = [
    "run",
    "run:delivery-interval",
    "--",
    "--interval",
    params.interval,
    "--run-date",
    params.runDate,
  ];
  if (params.orderType && params.orderNumber) {
    args.push("--order-type", params.orderType, "--order-number", params.orderNumber);
  }
  if (params.channel && params.channel !== "both") {
    args.push("--channel", params.channel);
  }
  if (params.send) {
    args.push("--send", "--confirm", params.confirmPhrase);
  }
  return args;
}

export function parseSchedulerArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    interval: null,
    expectedLocalTime: null,
    timezone: DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
    send: false,
    forceLocalTimeCheckBypass: false,
    allowFailedRetry: false,
    allowCompletedRerun: false,
    orderType: null,
    orderNumber: null,
    channel: "both",
    now: new Date(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--send") {
      options.send = true;
      continue;
    }
    if (arg === "--force-local-time-check-bypass") {
      options.forceLocalTimeCheckBypass = true;
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
    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const parsed = readOption(args, index, "--interval");
      const interval = parsed.value.trim();
      if (interval === "8") throw new Error("interval_8_not_schedule_ready");
      if (!isScheduledInterval(interval)) {
        throw new Error(`--interval must be one of ${DELIVERY_SCHEDULER_INTERVALS.join(", ")}.`);
      }
      options.interval = interval;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--expected-local-time" || arg.startsWith("--expected-local-time=")) {
      const parsed = readOption(args, index, "--expected-local-time");
      options.expectedLocalTime = normalizeLocalTime(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--timezone" || arg.startsWith("--timezone=")) {
      const parsed = readOption(args, index, "--timezone");
      options.timezone = parsed.value.trim() || DEFAULT_DELIVERY_SCHEDULER_TIMEZONE;
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
    if (arg === "--now" || arg.startsWith("--now=")) {
      const parsed = readOption(args, index, "--now");
      const now = new Date(parsed.value);
      if (Number.isNaN(now.getTime())) throw new Error("--now must be an ISO timestamp.");
      options.now = now;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      throw new Error("--confirm is derived internally by the scheduler wrapper.");
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.interval) throw new Error("--interval is required.");
  normalizeDeliveryOrderScope({
    orderType: options.orderType,
    orderNumber: options.orderNumber,
  });

  return options;
}

function redactSensitiveText(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "<redacted-phone>")
    .slice(0, 1000);
}

function parseChildJson(output: string) {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return { output: redactSensitiveText(trimmed) };
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { output: redactSensitiveText(trimmed) };
  }
}

async function acquireSchedulerRunLock(params: {
  lockKey: string;
  interval: string;
  runDate: string;
  timezone: string;
  expectedLocalTime: string;
  actualLocalTime: string;
  delegatedArgs: string[];
  allowFailedRetry: boolean;
  allowCompletedRerun: boolean;
}) {
  const inserted = await prisma.$queryRaw<SchedulerRunRow[]>`
    INSERT INTO "delivery_interval_scheduler_runs"
      ("id", "lockKey", "interval", "runDate", "timezone", "expectedLocalTime", "actualLocalTime", "status", "startedAt", "delegatedArgs", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${params.lockKey}, ${params.interval}, ${dateFromKey(params.runDate)}, ${params.timezone}, ${params.expectedLocalTime}, ${params.actualLocalTime}, 'running'::"DeliveryIntervalSchedulerRunStatus", now(), ${JSON.stringify(params.delegatedArgs)}::jsonb, now(), now())
    ON CONFLICT ("lockKey") DO NOTHING
    RETURNING "id", "lockKey", "status"::text AS "status", "retryCount"
  `;
  if (inserted[0]) {
    return {
      acquired: true,
      row: inserted[0],
      phase: "lock_acquired",
      previousLockStatus: null,
    };
  }

  const existing = (
    await prisma.$queryRaw<SchedulerRunRow[]>`
      SELECT "id", "lockKey", "status"::text AS "status", "retryCount"
      FROM "delivery_interval_scheduler_runs"
      WHERE "lockKey" = ${params.lockKey}
      LIMIT 1
    `
  )[0];
  if (!existing) throw new Error("scheduler_lock_missing_after_conflict");

  if (existing.status === "running") {
    return {
      acquired: false,
      row: existing,
      phase: "skipped_lock_active",
      previousLockStatus: existing.status,
    };
  }
  if (existing.status === "success" && !params.allowCompletedRerun) {
    return {
      acquired: false,
      row: existing,
      phase: "skipped_already_completed",
      previousLockStatus: existing.status,
    };
  }
  if (existing.status === "failed" && !params.allowFailedRetry) {
    return {
      acquired: false,
      row: existing,
      phase: "skipped_failed_requires_retry_flag",
      previousLockStatus: existing.status,
    };
  }

  const updated = (
    await prisma.$queryRaw<SchedulerRunRow[]>`
      UPDATE "delivery_interval_scheduler_runs"
      SET
        "status" = 'running'::"DeliveryIntervalSchedulerRunStatus",
        "retryCount" = "retryCount" + 1,
        "startedAt" = now(),
        "completedAt" = NULL,
        "failedAt" = NULL,
        "timezone" = ${params.timezone},
        "expectedLocalTime" = ${params.expectedLocalTime},
        "actualLocalTime" = ${params.actualLocalTime},
        "delegatedArgs" = ${JSON.stringify(params.delegatedArgs)}::jsonb,
        "resultSummary" = NULL,
        "errorMessage" = NULL,
        "updatedAt" = now()
      WHERE "lockKey" = ${params.lockKey}
      RETURNING "id", "lockKey", "status"::text AS "status", "retryCount"
    `
  )[0];

  return {
    acquired: true,
    row: updated,
    phase: "lock_reacquired",
    previousLockStatus: existing.status,
  };
}

async function markSchedulerRun(params: {
  id: string;
  status: "success" | "failed";
  resultSummary: unknown;
  errorMessage?: string | null;
}) {
  await prisma.$executeRaw`
    UPDATE "delivery_interval_scheduler_runs"
    SET
      "status" = CASE
        WHEN ${params.status} = 'success' THEN 'success'::"DeliveryIntervalSchedulerRunStatus"
        ELSE 'failed'::"DeliveryIntervalSchedulerRunStatus"
      END,
      "completedAt" = CASE WHEN ${params.status} = 'success' THEN now() ELSE "completedAt" END,
      "failedAt" = CASE WHEN ${params.status} = 'failed' THEN now() ELSE "failedAt" END,
      "resultSummary" = ${JSON.stringify(params.resultSummary)}::jsonb,
      "errorMessage" = ${redactSensitiveText(params.errorMessage) ?? null},
      "updatedAt" = now()
    WHERE "id" = ${params.id}
  `;
}

function runChild(args: string[]): SchedulerChildResult {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return {
    status: result.status,
    error: result.error ? result.error.message : null,
    summary: parseChildJson(output),
  };
}

export async function runScheduledDeliveryInterval(
  params: RunScheduledDeliveryIntervalParams
): Promise<ScheduledDeliveryIntervalResult> {
  const orderScope = normalizeDeliveryOrderScope({
    orderType: params.orderType ?? null,
    orderNumber: params.orderNumber ?? null,
  });
  const interval = params.interval;
  const schedule = DELIVERY_INTERVAL_SCHEDULE[interval];
  const expectedLocalTime = params.expectedLocalTime
    ? normalizeLocalTime(params.expectedLocalTime)
    : schedule.expectedLocalTime;
  const timezone = params.timezone?.trim() || DEFAULT_DELIVERY_SCHEDULER_TIMEZONE;
  const local = denverDateTimeParts(params.now ?? new Date(), timezone);
  const runDate = params.runDateOverride ? dateKey(params.runDateOverride) : local.date;
  const channel = params.channel ?? "both";
  const lockKey = schedulerLockKey(interval, runDate, params.lockScopeParts ?? []);
  const delegatedArgs = delegatedRunnerArgs({
    interval,
    runDate,
    send: params.send === true,
    confirmPhrase: schedule.confirmPhrase,
    orderType: orderScope?.orderType ?? null,
    orderNumber: orderScope?.orderNumber ?? null,
    channel,
  });

  if (params.forceLocalTimeCheckBypass !== true && local.time !== expectedLocalTime) {
    return {
      ok: true,
      phase: "skipped_wrong_local_time",
      interval,
      timezone,
      expectedLocalTime,
      actualDenverLocalTime: local.time,
      todayInDenver: runDate,
      delegatedArgs,
      childResultSummary: null,
      sensitiveValuesPrinted: false,
    };
  }

  if (
    params.send === true &&
    process.env[DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV]?.trim().toLowerCase() === "false"
  ) {
    throw new Error(`${DELIVERY_SCHEDULER_LIVE_SEND_ENABLED_ENV} is explicitly false for scheduled sends.`);
  }

  const lock = await (params.acquireLock ?? acquireSchedulerRunLock)({
    lockKey,
    interval,
    runDate,
    timezone,
    expectedLocalTime,
    actualLocalTime: local.time,
    delegatedArgs,
    allowFailedRetry: params.allowFailedRetry === true,
    allowCompletedRerun: params.allowCompletedRerun === true,
  });

  if (!lock.acquired) {
    return {
      ok: true,
      phase: lock.phase,
      interval,
      timezone,
      expectedLocalTime,
      actualDenverLocalTime: local.time,
      todayInDenver: runDate,
      lockKey,
      previousLockStatus: lock.previousLockStatus,
      retryCount: lock.row.retryCount,
      delegatedArgs,
      childResultSummary: null,
      sensitiveValuesPrinted: false,
    };
  }

  if (params.runTask) {
    const taskPayload: DeliveryScheduledIntervalTaskPayload = {
      interval,
      runDate,
      timezone,
      expectedLocalTime,
      manualRun: params.manualRun === true,
      schedulerRunId: lock.row.id,
      lockKey,
      send: true,
      confirmationPhrase: schedule.confirmPhrase,
      requestedBy: params.requestedBy ?? (params.manualRun === true ? "manual" : "vercel-cron"),
      channel,
      ...(orderScope
        ? {
            orderScope: {
              orderType: orderScope.orderType,
              orderNumber: orderScope.orderNumber,
            },
          }
        : {}),
    };
    try {
      const resultSummary = await params.runTask(taskPayload);
      await (params.markRun ?? markSchedulerRun)({
        id: lock.row.id,
        status: "success",
        resultSummary,
      });
      return {
        ok: true,
        phase: "completed",
        interval,
        timezone,
        expectedLocalTime,
        actualDenverLocalTime: local.time,
        todayInDenver: runDate,
        lockKey,
        previousLockStatus: lock.previousLockStatus,
        schedulerRunId: lock.row.id,
        retryCount: lock.row.retryCount,
        delegatedArgs,
        childExitStatus: 0,
        childResultSummary: resultSummary,
        sensitiveValuesPrinted: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await (params.markRun ?? markSchedulerRun)({
        id: lock.row.id,
        status: "failed",
        resultSummary: { ok: false, error: redactSensitiveText(message) },
        errorMessage: message,
      });
      throw error;
    }
  }

  const child = await (params.runChildProcess ?? runChild)(delegatedArgs);
  const ok = child.status === 0 && !child.error;
  await (params.markRun ?? markSchedulerRun)({
    id: lock.row.id,
    status: ok ? "success" : "failed",
    resultSummary: child.summary,
    errorMessage: child.error,
  });

  return {
    ok,
    phase: ok ? "completed" : "failed",
    interval,
    timezone,
    expectedLocalTime,
    actualDenverLocalTime: local.time,
    todayInDenver: runDate,
    lockKey,
    previousLockStatus: lock.previousLockStatus,
    schedulerRunId: lock.row.id,
    retryCount: lock.row.retryCount,
    delegatedArgs,
    childExitStatus: child.status,
    childResultSummary: child.summary,
    sensitiveValuesPrinted: false,
  };
}

async function run() {
  const options = parseSchedulerArgs(process.argv.slice(2));
  const result = await runScheduledDeliveryInterval({
    interval: options.interval as DeliveryScheduledInterval,
    expectedLocalTime: options.expectedLocalTime,
    timezone: options.timezone,
    send: options.send,
    forceLocalTimeCheckBypass: options.forceLocalTimeCheckBypass,
    allowFailedRetry: options.allowFailedRetry,
    allowCompletedRerun: options.allowCompletedRerun,
    orderType: options.orderType,
    orderNumber: options.orderNumber,
    now: options.now,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (typeof require !== "undefined" && require.main === module) {
  run()
    .catch((error) => {
      console.error(
        JSON.stringify(
          {
            ok: false,
            phase: "failed",
            error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            sensitiveValuesPrinted: false,
          },
          null,
          2
        )
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
