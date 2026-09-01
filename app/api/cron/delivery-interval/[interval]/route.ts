import { NextResponse } from "next/server";

import { enqueueDeliveryScheduledInterval } from "@/lib/notifications/deliveryScheduledIntervalQueue";
import {
  DELIVERY_INTERVAL_SCHEDULE,
  type DeliveryScheduledInterval,
  DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
  denverDateTimeParts,
  isScheduledInterval,
  runScheduledDeliveryInterval,
} from "@/scripts/run-scheduled-delivery-interval";

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

  if (interval === "8") {
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
    const result = await runScheduledDeliveryInterval({
      interval: interval as DeliveryScheduledInterval,
      send: true,
      forceLocalTimeCheckBypass: manualRun,
      allowFailedRetry: retryFailed,
      allowCompletedRerun: allowRerun,
      manualRun,
      requestedBy: manualRun ? "manual" : "vercel-cron",
      enqueueJob: enqueueDeliveryScheduledInterval,
    });

    return jsonResponse(
      {
        ...result,
        manualRun,
        retryFailed,
        allowRerun,
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
