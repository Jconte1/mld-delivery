import { NextResponse } from "next/server";

import {
  DELIVERY_INTERVAL_SCHEDULE,
  type DeliveryScheduledInterval,
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

export async function GET(
  request: Request,
  context: { params: Promise<{ interval?: string }> }
) {
  const authorization = validateCronAuthorization(request);
  if (!authorization.ok) {
    return jsonResponse(
      {
        ok: false,
        phase: authorization.reason,
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
        vercelCronUserAgent: authorization.vercelCronUserAgent,
      },
      400
    );
  }

  try {
    const result = await runScheduledDeliveryInterval({
      interval: interval as DeliveryScheduledInterval,
      send: true,
    });

    return jsonResponse(
      {
        ...result,
        vercelCronUserAgent: authorization.vercelCronUserAgent,
      },
      result.ok ? 200 : 500
    );
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        phase: "failed",
        interval,
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        vercelCronUserAgent: authorization.vercelCronUserAgent,
      },
      500
    );
  }
}
