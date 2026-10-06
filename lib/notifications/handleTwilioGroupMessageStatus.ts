import type { PrismaClient } from "../generated/prisma/client";
import { normalizeSmsPhoneForOptOut } from "./notificationAddressNormalization";
import { reconcileDeliveryNotificationGroupAttempt } from "./deliveryNotificationGroupStore";
import type { TwilioFormPayload } from "./twilioWebhook";

// Called only after the HTTP handler validates the Twilio signature, including query parameters.
export async function handleTwilioGroupMessageStatus(params: {
  client: PrismaClient;
  groupAttemptId: string;
  payload: TwilioFormPayload;
}) {
  const { client, payload, groupAttemptId } = params;
  const sid = (payload.MessageSid ?? payload.SmsSid ?? payload.SmsMessageSid)?.trim();
  const status = (payload.MessageStatus ?? payload.SmsStatus)?.trim().toUpperCase();
  if (!sid || !status) throw new Error("group_callback_missing_sid_or_status");
  const attempt = await client.deliveryNotificationGroupAttempt.findUnique({ where: { id: groupAttemptId } });
  if (!attempt) {
    await client.twilioMessageStatusCallback.upsert({
      where: { callbackKey: `group:${groupAttemptId}:${sid}:${status}:${payload.ErrorCode ?? "none"}` }, update: {},
      create: { callbackKey: `group:${groupAttemptId}:${sid}:${status}:${payload.ErrorCode ?? "none"}`,
        messageSid: sid, messageStatus: status, rawPayload: payload,
        matchStatus: "UNMATCHED_GROUP_ATTEMPT", processedAt: new Date() },
    });
    return { matchStatus: "UNMATCHED_GROUP_ATTEMPT", groupAttemptId };
  }
  if (attempt.provider !== "twilio" || attempt.channel !== "SMS" ||
      !normalizeSmsPhoneForOptOut(payload.To) ||
      normalizeSmsPhoneForOptOut(payload.To) !== normalizeSmsPhoneForOptOut(attempt.recipient) ||
      (attempt.externalMessageId && attempt.externalMessageId !== sid)) throw new Error("group_callback_identity_mismatch");
  const key = `group:${groupAttemptId}:${sid}:${status}:${payload.ErrorCode ?? "none"}`;
  const callback = await client.twilioMessageStatusCallback.upsert({ where: { callbackKey: key }, update: {}, create: {
    callbackKey: key, messageSid: sid, messageStatus: status, groupAttemptId,
    accountSid: payload.AccountSid ?? null, toPhone: normalizeSmsPhoneForOptOut(payload.To),
    fromPhone: normalizeSmsPhoneForOptOut(payload.From), errorCode: payload.ErrorCode ?? null,
    errorMessage: payload.ErrorMessage?.slice(0, 1024) ?? null, rawPayload: payload,
  } });
  if (callback.processedAt) return { matchStatus: "DUPLICATE", groupAttemptId };
  // If reconciliation fails, leave the durable callback unprocessed so Twilio can retry.
  await reconcileDeliveryNotificationGroupAttempt(client, { attemptId: groupAttemptId, provider: "twilio",
    externalMessageId: sid, rawStatus: status, errorMessage: payload.ErrorMessage });
  await client.twilioMessageStatusCallback.update({ where: { id: callback.id }, data: {
    matchStatus: "MATCHED_GROUP_ATTEMPT", processedAt: new Date(),
  } });
  return { matchStatus: "MATCHED_GROUP_ATTEMPT", groupAttemptId };
}
