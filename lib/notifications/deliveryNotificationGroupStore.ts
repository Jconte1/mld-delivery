import { Prisma, type PrismaClient } from "../generated/prisma/client";
import { assertGroupStillEligible, nextGroupAttemptState, type GroupAttemptState } from "./deliveryNotificationGroupLifecycle";
import type { GroupingCandidate } from "./deliveryNotificationGrouping";

type Client = Pick<PrismaClient, "$transaction">;

export async function claimDeliveryNotificationGroup(client: Client, params: {
  groupId: string;
  currentRunEventIds: Set<string>;
  freshCandidates: GroupingCandidate[];
  now?: Date;
}) {
  return client.$transaction(async tx => {
    const stored = await tx.deliveryNotificationGroup.findUnique({
      where: { id: params.groupId }, include: { members: true },
    });
    if (!stored || stored.status !== "PREPARED") return null;
    const plan = assertGroupStillEligible({ expectedMembershipKey: stored.membershipKey,
      expectedEventIds: stored.members.map(m => m.notificationEventId),
      candidates: params.freshCandidates, currentRunEventIds: params.currentRunEventIds });
    const first = plan.members[0];
    if (stored.channel !== first.channel || stored.contactId !== first.contactId ||
        stored.intervalType !== first.interval || stored.actionType !== first.action ||
        stored.stage !== first.stage || stored.deliveryDate.toISOString().slice(0, 10) !== first.deliveryDate) {
      throw new Error("stored_group_scope_mismatch");
    }
    const now = params.now ?? new Date();
    const claim = await tx.deliveryNotificationGroup.updateMany({
      where: { id: stored.id, status: "PREPARED" }, data: { status: "CLAIMED", claimedAt: now },
    });
    if (claim.count !== 1) return null;
    const eventIds = plan.members.map(m => m.eventId);
    const claimedEvents = await tx.notificationEvent.updateMany({
      where: { id: { in: eventIds }, status: "SCHEDULED", attempts: { none: {} } },
      data: { status: "PENDING", triggeredAt: now },
    });
    if (claimedEvents.count !== eventIds.length) throw new Error("group_member_already_claimed_or_attempted");
    const attempt = await tx.deliveryNotificationGroupAttempt.create({ data: {
      groupId: stored.id, attemptNumber: 1, channel: stored.channel,
      recipient: first.recipient, provider: stored.channel === "SMS" ? "twilio" : "ms_graph",
      productionEligibilityVerified: true,
    } });
    return attempt.id;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function reconcileDeliveryNotificationGroupAttempt(client: Client, params: {
  attemptId: string;
  provider: "twilio" | "ms_graph";
  externalMessageId: string | null;
  rawStatus: string;
  errorMessage?: string;
  now?: Date;
}) {
  return client.$transaction(async tx => {
    const attempt = await tx.deliveryNotificationGroupAttempt.findUnique({ where: { id: params.attemptId } });
    if (!attempt) return { matched: false };
    if (attempt.provider !== params.provider || (attempt.externalMessageId && attempt.externalMessageId !== params.externalMessageId)) {
      throw new Error("group_provider_identity_mismatch");
    }
    const rawStatus = params.rawStatus.trim().toUpperCase();
    const known = ["ACCEPTED", "QUEUED", "SENDING", "SENT", "SUBMITTED", "DELIVERED", "FAILED", "UNDELIVERED"];
    const lateInFlight = attempt.status === "FAILED" && !["FAILED", "UNDELIVERED", "DELIVERED"].includes(rawStatus);
    if (!known.includes(rawStatus) || attempt.status === "DELIVERED" || lateInFlight) {
      return { matched: true, status: attempt.status, ignored: true };
    }
    const status = nextGroupAttemptState(attempt.status as GroupAttemptState, rawStatus);
    const now = params.now ?? new Date();
    await tx.deliveryNotificationGroupAttempt.update({ where: { id: attempt.id }, data: {
      status, externalMessageId: params.externalMessageId ?? undefined,
      providerCode: rawStatus,
      submittedAt: status === "SUBMITTED" || status === "DELIVERED" ? attempt.submittedAt ?? now : undefined,
      deliveredAt: status === "DELIVERED" ? attempt.deliveredAt ?? now : undefined,
      errorMessage: status === "FAILED" ? params.errorMessage?.slice(0, 1024) : status === "DELIVERED" ? null : undefined,
    } });
    const latest = await tx.deliveryNotificationGroupAttempt.findFirst({ where: { groupId: attempt.groupId }, orderBy: { attemptNumber: "desc" } });
    if (latest?.id === attempt.id && ["SUBMITTED", "DELIVERED", "FAILED"].includes(status)) {
      await tx.deliveryNotificationGroup.update({ where: { id: attempt.groupId }, data: { status } });
      await tx.notificationEvent.updateMany({ where: { notificationGroupMember: { groupId: attempt.groupId }, status: { in: ["PENDING", "SENT", "FAILED"] } },
        data: { status: status === "FAILED" ? "FAILED" : "SENT",
          sentAt: status !== "FAILED" ? attempt.submittedAt ?? now : undefined,
          reasonFailed: status === "FAILED" ? "group_provider_failed" : null } });
    }
    return { matched: true, status };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function markDeliveryNotificationGroupUncertain(client: Client, attemptId: string) {
  return client.$transaction(async tx => {
    const attempt = await tx.deliveryNotificationGroupAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.status !== "SUBMITTING") return;
    await tx.deliveryNotificationGroupAttempt.update({ where: { id: attemptId }, data: { status: "RECONCILIATION_REQUIRED" } });
    const latest = await tx.deliveryNotificationGroupAttempt.findFirst({
      where: { groupId: attempt.groupId }, orderBy: { attemptNumber: "desc" },
    });
    if (latest?.id === attemptId) {
      await tx.deliveryNotificationGroup.update({ where: { id: attempt.groupId }, data: { status: "RECONCILIATION_REQUIRED" } });
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
