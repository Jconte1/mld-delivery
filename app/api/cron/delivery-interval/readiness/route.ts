import { NextResponse } from "next/server";

import {
  DELIVERY_INTERVAL_SCHEDULE,
  DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
  denverDateTimeParts,
} from "@/scripts/run-scheduled-delivery-interval";
import { validateCronAuthorization } from "../[interval]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function boolState(name: string) {
  const value = envValue(name).toLowerCase();
  return value === "true" ? "true" : value === "false" ? "false" : value ? "set_non_boolean" : "unset";
}

function present(name: string) {
  return Boolean(envValue(name));
}

function liveWritebackReadiness(dryRunEnv: string, enabledEnv: string) {
  const dryRun = boolState(dryRunEnv);
  const enabled = boolState(enabledEnv);
  return {
    dryRun,
    enabled,
    readyForPresentation: dryRun === "true" || (dryRun === "false" && enabled === "true"),
    liveWriteback: dryRun === "false" && enabled === "true",
  };
}

export async function GET(request: Request) {
  const authorization = validateCronAuthorization(request);
  if (!authorization.ok) {
    return NextResponse.json(
      {
        ok: false,
        phase: authorization.reason,
        vercelCronUserAgent: authorization.vercelCronUserAgent,
        sensitiveValuesPrinted: false,
      },
      { status: authorization.status }
    );
  }

  const denver = denverDateTimeParts(new Date(), DEFAULT_DELIVERY_SCHEDULER_TIMEZONE);
  return NextResponse.json({
    ok: true,
    phase: "readiness",
    timezone: DEFAULT_DELIVERY_SCHEDULER_TIMEZONE,
    todayInDenver: denver.date,
    actualDenverLocalTime: denver.time,
    customerSends: {
      enabled: boolState("DELIVERY_REAL_CUSTOMER_SEND_ENABLED"),
      controlledRecipientMode: boolState("DELIVERY_CONTROLLED_RECIPIENT_MODE"),
      forcedContactEligibility: boolState("DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST"),
      demoSendEnabled: boolState("DEMO_NOTIFICATION_SEND_ENABLED"),
    },
    writebacks: {
      confirmationDryRun: boolState("DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN"),
      confirmationEnabled: boolState("ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED"),
      confirmationPresentationReady: liveWritebackReadiness(
        "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN",
        "ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED"
      ),
      requestedDateDryRun: boolState("DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN"),
      requestedDateEnabled: boolState("ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED"),
      requestedDatePresentationReady: liveWritebackReadiness(
        "DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN",
        "ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED"
      ),
      tenDayConfirmationDryRun: boolState("DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN"),
      tenDayConfirmationEnabled: boolState("ACUMATICA_TEN_DAY_CONFIRMATION_WRITE_ENABLED"),
      tenDayConfirmationPresentationReady: liveWritebackReadiness(
        "DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN",
        "ACUMATICA_TEN_DAY_CONFIRMATION_WRITE_ENABLED"
      ),
      contactOptInDryRun: boolState("DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN"),
      prepaymentHoldDryRun: boolState("DELIVERY_PREPAYMENT_HOLD_DRY_RUN"),
    },
    providers: {
      twilioAccountSidPresent: present("TWILIO_ACCOUNT_SID"),
      twilioAuthTokenPresent: present("TWILIO_AUTH_TOKEN"),
      twilioMessagingServiceOrFromPresent:
        present("TWILIO_MESSAGING_SERVICE_SID") || present("TWILIO_FROM_NUMBER"),
      graphTenantPresent: present("MS_GRAPH_TENANT_ID"),
      graphClientPresent: present("MS_GRAPH_CLIENT_ID"),
      graphSecretPresent: present("MS_GRAPH_CLIENT_SECRET"),
      graphFromPresent: present("MS_GRAPH_FROM_EMAIL"),
      twilioWebhookSignatureValidation: boolState("TWILIO_WEBHOOK_VALIDATE_SIGNATURES"),
    },
    queueErp: {
      useQueueErp: boolState("USE_QUEUE_ERP"),
      queueBaseUrlPresent: present("MLD_QUEUE_BASE_URL"),
      queueTokenPresent: present("MLD_QUEUE_TOKEN"),
    },
    manuallyRunnableIntervals: {
      "90": DELIVERY_INTERVAL_SCHEDULE["90"].confirmPhrase,
      "42": DELIVERY_INTERVAL_SCHEDULE["42"].confirmPhrase,
      "39": DELIVERY_INTERVAL_SCHEDULE["39"].confirmPhrase,
      "30": DELIVERY_INTERVAL_SCHEDULE["30"].confirmPhrase,
      "14": DELIVERY_INTERVAL_SCHEDULE["14"].confirmPhrase,
      "10": DELIVERY_INTERVAL_SCHEDULE["10"].confirmPhrase,
      "8": DELIVERY_INTERVAL_SCHEDULE["8"].confirmPhrase,
      "2": DELIVERY_INTERVAL_SCHEDULE["2"].confirmPhrase,
    },
    scheduledCronStillTimeGated: true,
    manualRunsBypassOnlyLocalTimeGate: true,
    sensitiveValuesPrinted: false,
  });
}
