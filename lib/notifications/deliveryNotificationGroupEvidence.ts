import { NotificationAttemptStatus, type DeliveryNotificationGroupAttempt } from "../generated/prisma/client";

export const groupEvidenceSelect = {
  select: { group: { select: { id: true, attempts: { orderBy: { attemptNumber: "asc" as const } } } } },
} as const;

// A read model of the one real shared attempt, not a fabricated per-order DB row.
export function sharedAttemptEvidence(attempt: DeliveryNotificationGroupAttempt) {
  const status = attempt.status === "DELIVERED" ? NotificationAttemptStatus.DELIVERED :
    attempt.status === "SUBMITTED" ? NotificationAttemptStatus.SUBMITTED :
    attempt.status === "FAILED" ? NotificationAttemptStatus.FAILED : NotificationAttemptStatus.CREATED;
  return { ...attempt, status, success: ["SUBMITTED", "DELIVERED"].includes(attempt.status) && attempt.productionEligibilityVerified,
    sentAt: attempt.submittedAt, controlledRecipientMode: false, forcedContactEligibility: false,
    realSmsOptIn: attempt.channel === "SMS" && attempt.productionEligibilityVerified,
    realEmailOptIn: attempt.channel === "EMAIL" && attempt.productionEligibilityVerified,
    localSmsOptOutActive: false, globalSmsOptOutActive: false, localEmailOptOutActive: false, globalEmailOptOutActive: false,
    sharedGroupAttempt: true };
}
