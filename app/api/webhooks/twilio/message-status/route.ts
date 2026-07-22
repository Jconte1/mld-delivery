import { handleTwilioMessageStatus } from "@/lib/notifications/handleTwilioMessageStatus";
import {
  readTwilioFormPayload,
  validateTwilioWebhookSignature,
} from "@/lib/notifications/twilioWebhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = await readTwilioFormPayload(request);
  const signature = validateTwilioWebhookSignature({ request, payload });

  if (!signature.valid) {
    console.warn("[twilio][message-status] rejected invalid signature", {
      reason: signature.reason,
      messageSid: payload.MessageSid ?? payload.SmsMessageSid ?? payload.SmsSid ?? null,
    });
    return new Response("Invalid Twilio signature", { status: 403 });
  }

  try {
    const result = await handleTwilioMessageStatus({ payload });
    console.info("[twilio][message-status] processed", {
      messageSid: result.messageSid,
      messageStatus: result.messageStatus,
      matchStatus: result.matchStatus,
      notificationAttemptId: result.notificationAttemptId,
      notificationEventId: result.notificationEventId,
      deliveryConfirmationId: result.deliveryConfirmationId,
      manualReviewFlagged: result.manualReviewFlagged,
      duplicate: result.duplicate,
    });

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("[twilio][message-status] processing failed", {
      messageSid: payload.MessageSid ?? payload.SmsMessageSid ?? payload.SmsSid ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Status callback processing failed", { status: 500 });
  }
}
