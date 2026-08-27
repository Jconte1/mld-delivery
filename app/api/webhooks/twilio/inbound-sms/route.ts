import { handleTwilioInboundSms } from "@/lib/notifications/handleTwilioInboundSms";
import {
  readTwilioFormPayload,
  twimlResponse,
  validateTwilioWebhookSignature,
} from "@/lib/notifications/twilioWebhook";

export const runtime = "nodejs";

type TwilioCurrentStateRefresher = NonNullable<
  Parameters<typeof handleTwilioInboundSms>[0]["currentStateRefresher"]
>;

const fastLocalCurrentStateRefresher: TwilioCurrentStateRefresher = async ({ candidate }) => ({
  ok: true,
  candidate,
});

export async function POST(request: Request) {
  const payload = await readTwilioFormPayload(request);
  const signature = validateTwilioWebhookSignature({ request, payload });

  if (!signature.valid) {
    console.warn("[twilio][inbound-sms] rejected invalid signature", {
      reason: signature.reason,
      messageSid: payload.MessageSid ?? payload.SmsMessageSid ?? payload.SmsSid ?? null,
    });
    return new Response("Invalid Twilio signature", { status: 403 });
  }

  try {
    const result = await handleTwilioInboundSms({
      payload,
      // The webhook must return TwiML inside Twilio's response window. The
      // queue worker still fetches current ERP confirmation fields before writeback.
      currentStateRefresher: fastLocalCurrentStateRefresher,
    });
    console.info("[twilio][inbound-sms] processed", {
      messageSid: result.messageSid,
      parsedIntent: result.parsedIntent,
      matchStatus: result.matchStatus,
      deliveryConfirmationId: result.deliveryConfirmationId,
      notificationEventId: result.notificationEventId,
      duplicate: result.duplicate,
      writebackQueued: Boolean(result.writebackJobId),
      writebackError: Boolean(result.writebackError),
    });

    return twimlResponse(result.responseMessage);
  } catch (error) {
    console.error("[twilio][inbound-sms] processing failed", {
      messageSid: payload.MessageSid ?? payload.SmsMessageSid ?? payload.SmsSid ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return twimlResponse(null, 500);
  }
}
