import { createHash } from "node:crypto";

export type GroupingAddress = {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

export type GroupingCandidate = {
  eventId: string;
  orderType: string;
  orderNumber: string;
  contactId: string;
  deliveryDate: string;
  interval: string;
  action: string;
  stage: string;
  channel: "EMAIL" | "SMS";
  recipient: string;
  address: GroupingAddress | null;
  eligible: boolean;
  freshlyImported: boolean;
  optedOut: boolean;
};

const normalize = (value?: string | null) => value?.trim().replace(/\s+/g, " ").toUpperCase() ?? "";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function deliveryAddressGroupingKey(address: GroupingAddress | null): string | null {
  if (!address) return null;
  const parts = [address.addressLine1, address.addressLine2, address.city, address.state,
    address.postalCode, address.country].map(normalize);
  // Do not infer country, abbreviations, units, or postal-code equivalence.
  if ([0, 2, 3, 4, 5].some((index) => !parts[index])) return null;
  return digest(parts);
}

export function deliveryNotificationCompatibilityKey(candidate: Pick<GroupingCandidate,
  "eventId" | "contactId" | "recipient" | "channel" | "deliveryDate" | "interval" | "action" | "stage" | "address">) {
  return digest([candidate.contactId, candidate.recipient, candidate.channel,
    candidate.deliveryDate, candidate.interval, candidate.action, candidate.stage,
    deliveryAddressGroupingKey(candidate.address) ?? candidate.eventId]);
}

export function planDeliveryNotificationGroups(candidates: GroupingCandidate[], currentRunEventIds: Set<string>) {
  const groups = new Map<string, { key: string; members: GroupingCandidate[]; separateReason: string | null }>();
  const excluded: { eventId: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.eventId)) throw new Error(`Duplicate grouping event: ${candidate.eventId}`);
    seen.add(candidate.eventId);
    const reason = !currentRunEventIds.has(candidate.eventId) ? "outside_current_run"
      : !candidate.freshlyImported ? "fresh_import_not_verified"
      : candidate.optedOut ? "opted_out"
      : !candidate.eligible ? "production_ineligible"
      : !candidate.contactId.trim() || !candidate.recipient.trim() ? "missing_contact_or_recipient"
      : !candidate.stage.trim() ? "missing_notification_stage" : null;
    if (reason) { excluded.push({ eventId: candidate.eventId, reason }); continue; }
    const address = deliveryAddressGroupingKey(candidate.address);
    // Recipient is deliberately exact: callers must supply the production-selected address.
    const key = deliveryNotificationCompatibilityKey(candidate);
    const group = groups.get(key) ?? { key, members: [], separateReason: address ? null : "incomplete_delivery_address" };
    group.members.push(candidate);
    groups.set(key, group);
  }
  return { groups: [...groups.values()].map(group => ({ ...group,
    members: group.members.sort((a, b) => a.eventId.localeCompare(b.eventId)),
    membershipKey: digest([group.key, group.members.map(m => m.eventId).sort()]),
  })), excluded };
}
