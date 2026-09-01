import { NextResponse } from "next/server";

import { addDays, dateKey } from "@/lib/notifications/helpers";
import {
  DELIVERY_INTERVAL_SCHEDULE,
  type DeliveryScheduledInterval,
  DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
  denverDateTimeParts,
  isScheduledInterval,
  runScheduledDeliveryInterval,
} from "@/scripts/run-scheduled-delivery-interval";
import { runDeliveryInterval } from "@/scripts/run-delivery-interval";
import { run42DayNoResponseCommand } from "@/scripts/run-42-day-confirmation-no-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CronAuthorizationResult =
  | { ok: true; vercelCronUserAgent: boolean }
  | { ok: false; status: number; reason: string; vercelCronUserAgent: boolean };

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(
    {
      ...body,
      sensitiveValuesPrinted: false,
    },
    { status }
  );
}

function redactSensitiveText(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "<redacted-phone>")
    .slice(0, 1000);
}

function requestFlagIsTrue(request: Request, queryName: string, headerName: string) {
  const url = new URL(request.url);
  const queryValue = url.searchParams.get(queryName)?.trim().toLowerCase();
  const headerValue = request.headers.get(headerName)?.trim().toLowerCase();
  return queryValue === "true" || headerValue === "true";
}

function cronManualRetryFailedRequested(request: Request) {
  return requestFlagIsTrue(request, "retryFailed", "x-delivery-retry-failed");
}

function cronManualAllowRerunRequested(request: Request) {
  return requestFlagIsTrue(request, "allowRerun", "x-delivery-allow-rerun");
}

function queryValue(request: Request, name: string) {
  return new URL(request.url).searchParams.get(name)?.trim() || null;
}

function manualChannel(request: Request) {
  const value = queryValue(request, "channel")?.toLowerCase();
  if (!value) return "both" as const;
  if (value === "sms" || value === "email" || value === "both") return value;
  throw new Error("channel must be email, sms, or both.");
}

function intervalDays(interval: DeliveryScheduledInterval) {
  const parsed = Number(interval);
  if (!Number.isFinite(parsed)) throw new Error(`Interval ${interval} does not map to a target date.`);
  return parsed;
}

function manualRunDate(request: Request, interval: DeliveryScheduledInterval, todayInDenver: string) {
  const requestedRunDate = queryValue(request, "runDate");
  if (requestedRunDate) return dateKey(requestedRunDate);
  const deliveryDate = queryValue(request, "deliveryDate");
  if (deliveryDate) return dateKey(addDays(dateKey(deliveryDate), -intervalDays(interval)));
  return todayInDenver;
}

export function cronManualRunRequested(request: Request, forcedManualRun = false) {
  return forcedManualRun || requestFlagIsTrue(request, "manualRun", "x-delivery-manual-run");
}

export function validateCronAuthorization(
  request: Request,
  env?: { CRON_SECRET?: string | null }
): CronAuthorizationResult {
  const userAgent = request.headers.get("user-agent") ?? "";
  const vercelCronUserAgent = /^vercel-cron(?:\/|$)/i.test(userAgent);
  const cronSecret = (env?.CRON_SECRET ?? process.env.CRON_SECRET)?.trim();
  if (!cronSecret) {
    return {
      ok: false,
      status: 503,
      reason: "cron_secret_not_configured",
      vercelCronUserAgent,
    };
  }

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const expectedAuthorization = `Bearer ${cronSecret}`;
  if (authorization !== expectedAuthorization) {
    return {
      ok: false,
      status: 401,
      reason: "unauthorized",
      vercelCronUserAgent,
    };
  }

  return { ok: true, vercelCronUserAgent };
}

export async function handleDeliveryIntervalCronRequest(
  request: Request,
  context: { params: Promise<{ interval?: string }> },
  options: { manualRun?: boolean } = {}
) {
  const authorization = validateCronAuthorization(request);
  const manualRun = cronManualRunRequested(request, options.manualRun === true);
  const localTimeGateBypassed = manualRun;
  const retryFailed = manualRun && cronManualRetryFailedRequested(request);
  const allowRerun = manualRun && cronManualAllowRerunRequested(request);
  if (!authorization.ok) {
    return jsonResponse(
      {
        ok: false,
        phase: authorization.reason,
        manualRun,
        retryFailed,
        allowRerun,
        localTimeGateBypassed: false,
        vercelCronUserAgent: authorization.vercelCronUserAgent,
      },
      authorization.status
    );
  }

  const params = await context.params;
  const interval = params.interval?.trim() ?? "";

  if (interval === "8" && !manualRun) {
    return jsonResponse(
      {
        ok: false,
        phase: "interval_8_not_schedule_ready",
        interval,
        manualRun,
        retryFailed,
        allowRerun,
        localTimeGateBypassed,
        vercelCronUserAgent: authorization.vercelCronUserAgent,
      },
      400
    );
  }

  if (!isScheduledInterval(interval)) {
    return jsonResponse(
      {
        ok: false,
        phase: "unsupported_interval",
        interval,
        supportedIntervals: Object.keys(DELIVERY_INTERVAL_SCHEDULE),
        manualRun,
        retryFailed,
        allowRerun,
        localTimeGateBypassed,
        vercelCronUserAgent: authorization.vercelCronUserAgent,
      },
      400
    );
  }

  try {
    const local = denverDateTimeParts(new Date(), DEFAULT_DELIVERY_SCHEDULER_TIMEZONE);
    const channel = manualRun ? manualChannel(request) : "both";
    const orderType = manualRun ? queryValue(request, "orderType") : null;
    const orderNumber = manualRun ? queryValue(request, "orderNumber") : null;
    const runDate = manualRun
      ? manualRunDate(request, interval as DeliveryScheduledInterval, local.date)
      : local.date;
    const lockScopeParts =
      manualRun && (orderType || orderNumber || channel !== "both")
        ? [orderType, orderNumber, channel]
        : [];
    const result = await runScheduledDeliveryInterval({
      interval: interval as DeliveryScheduledInterval,
      send: true,
      forceLocalTimeCheckBypass: manualRun,
      allowFailedRetry: retryFailed,
      allowCompletedRerun: allowRerun,
      runDateOverride: runDate,
      lockScopeParts,
      orderType,
      orderNumber,
      channel,
      manualRun,
      requestedBy: manualRun ? "manual" : "vercel-cron",
      runTask: async (payload) => {
        if (payload.interval === "39") {
          return run42DayNoResponseCommand({
            runDate: payload.runDate,
            mode: "send",
            confirmPhrase: payload.confirmationPhrase,
            testRunId: `${payload.requestedBy}_${payload.runDate.replace(/-/g, "")}_39`,
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
          runId: `${payload.requestedBy}_${payload.runDate.replace(/-/g, "")}_${payload.interval}`,
          orderType: payload.orderScope?.orderType ?? null,
          orderNumber: payload.orderScope?.orderNumber ?? null,
          orderScope: payload.orderScope ?? null,
          channel: payload.channel,
          verifyPackageAndMigrations: false,
          manualPresentationRun: payload.manualRun,
        });
      },
    });

    return jsonResponse(
      {
        ...result,
        manualRun,
        retryFailed,
        allowRerun,
        requestedChannel: channel,
        scopedOrderType: orderType,
        scopedOrderNumber: orderNumber,
        localTimeGateBypassed,
        vercelCronUserAgent: authorization.vercelCronUserAgent,
      },
      result.ok ? 200 : 500
    );
  } catch (error) {
    const schedule = DELIVERY_INTERVAL_SCHEDULE[interval as DeliveryScheduledInterval];
    const local = schedule
      ? denverDateTimeParts(new Date(), DEFAULT_DELIVERY_SCHEDULER_TIMEZONE)
      : null;
    return jsonResponse(
      {
        ok: false,
        phase: "failed",
        interval,
        manualRun,
        retryFailed,
        allowRerun,
        localTimeGateBypassed,
        timezone: DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
        expectedLocalTime: schedule?.expectedLocalTime ?? null,
        actualDenverLocalTime: local?.time ?? null,
        todayInDenver: local?.date ?? null,
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        vercelCronUserAgent: authorization.vercelCronUserAgent,
      },
      500
    );
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ interval?: string }> }
) {
  return handleDeliveryIntervalCronRequest(request, context);
}
