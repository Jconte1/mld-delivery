import { planDeliveryNotificationGroups, type GroupingCandidate } from "./deliveryNotificationGrouping";

export type GroupAttemptState = "SUBMITTING" | "SUBMITTED" | "DELIVERED" | "FAILED" | "RECONCILIATION_REQUIRED";

export function nextGroupAttemptState(current: GroupAttemptState, rawStatus: string): GroupAttemptState {
  const status = rawStatus.trim().toUpperCase();
  if (status === "DELIVERED") return "DELIVERED";
  if (current === "DELIVERED") return current;
  if (status === "FAILED" || status === "UNDELIVERED") return "FAILED";
  if (["ACCEPTED", "QUEUED", "SENDING", "SENT", "SUBMITTED"].includes(status)) {
    return current === "FAILED" ? current : "SUBMITTED";
  }
  return current;
}

export function assertGroupStillEligible(params: {
  expectedMembershipKey: string;
  expectedEventIds: string[];
  candidates: GroupingCandidate[];
  currentRunEventIds: Set<string>;
}) {
  const expected = [...params.expectedEventIds].sort();
  if (!expected.length || new Set(expected).size !== expected.length) throw new Error("invalid_group_membership");
  const plan = planDeliveryNotificationGroups(params.candidates, params.currentRunEventIds);
  if (plan.excluded.length || plan.groups.length !== 1) throw new Error("group_requires_requalification");
  const group = plan.groups[0];
  if (group.membershipKey !== params.expectedMembershipKey ||
      JSON.stringify(group.members.map(m => m.eventId).sort()) !== JSON.stringify(expected)) {
    throw new Error("group_membership_changed");
  }
  return group;
}

// Sends stay injectable until grouped renderers, production gates, and callback routing are integrated.
export async function executeClaimedGroupSend<Result>(ports: {
  revalidate: () => Promise<void>;
  claim: () => Promise<string | null>;
  send: (attemptId: string) => Promise<Result>;
  recordAccepted: (attemptId: string, result: Result) => Promise<void>;
  recordUncertain: (attemptId: string) => Promise<void>;
}) {
  await ports.revalidate();
  const attemptId = await ports.claim();
  if (!attemptId) return { outcome: "already_claimed" as const };
  try {
    // Recheck after winning the claim, immediately before the provider boundary.
    await ports.revalidate();
    const result = await ports.send(attemptId);
    await ports.recordAccepted(attemptId, result);
    return { outcome: "submitted" as const, attemptId };
  } catch {
    // A network exception or failed DB save does not prove the provider rejected the send.
    await ports.recordUncertain(attemptId);
    return { outcome: "reconciliation_required" as const, attemptId };
  }
}
