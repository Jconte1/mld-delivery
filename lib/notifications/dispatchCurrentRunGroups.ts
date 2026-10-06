import { prisma } from "../prisma";
import { dispatchGroupedDeliveryNotifications } from "./deliveryNotificationDispatcher";
import type { DeliveryIntervalFreshImportResult } from "./freshDeliveryIntervalImport";

export async function dispatchCurrentRunGroups(params: {
  eventIds: string[]; freshImport: DeliveryIntervalFreshImportResult; runStartedAt: Date; runId: string;
  channel?: "sms" | "email" | "both"; now?: Date;
}) {
  const options = { currentRunEventIds: params.eventIds, freshImport: params.freshImport, runStartedAt: params.runStartedAt,
    testRunId: params.runId, channel: params.channel, now: params.now };
  const preview = await dispatchGroupedDeliveryNotifications(options);
  const dispatched = await dispatchGroupedDeliveryNotifications({ ...options, send: true });
  const sharedIds = dispatched.reports.flatMap(r => r.groupId && r.attemptId ? [r.attemptId] : []);
  const individualIds = [...new Set(dispatched.reports.flatMap(r => !r.groupId
    ? [r.attemptId, "fallbackAttemptId" in r ? r.fallbackAttemptId : null].filter((id): id is string => Boolean(id)) : []))];
  const shared = await prisma.deliveryNotificationGroupAttempt.findMany({ where: { id: { in: sharedIds } } });
  const individual = await prisma.notificationAttempt.findMany({ where: { id: { in: individualIds } } });
  const attempts = [...shared, ...individual];
  return { ok: dispatched.reports.every(r => r.outcome === "submitted"),
    previewReports: preview.reports.map(r => ({ ...r, rendered: undefined })),
    reports: dispatched.reports.map(r => ({ ...r, rendered: undefined })),
    notificationGroupAttemptsCreated: shared.length, notificationAttemptsCreated: individual.length,
    smsAttemptsCreated: attempts.filter(a => a.channel === "SMS").length,
    emailAttemptsCreated: attempts.filter(a => a.channel === "EMAIL").length,
    providerAcceptedCount: attempts.filter(a => ["SUBMITTED", "DELIVERED"].includes(a.status)).length,
    providerFailedCount: attempts.filter(a => a.status === "FAILED").length,
    reconciliationRequiredCount: attempts.filter(a => a.status === "RECONCILIATION_REQUIRED").length,
    // Identifiers only; recipients and bearer links are not emitted into worker logs.
    attempts: attempts.map(a => ({ id: a.id, channel: a.channel, status: a.status,
      provider: a.provider, externalMessageIdMasked: a.externalMessageId ? `${a.externalMessageId.slice(0, 4)}...${a.externalMessageId.slice(-4)}` : null })),
  };
}
