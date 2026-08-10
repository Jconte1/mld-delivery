import { prisma } from "@/lib/prisma";
import { normalizeEmailForOptOut } from "@/lib/notifications/notificationAddressNormalization";
import {
  enqueueEmailOptOutContactWritebacks,
  type ContactOptInWritebackDispatchOptions,
} from "@/lib/notifications/contactOptInWritebackActions";

type EmailOptOutClient = Pick<typeof prisma, "contact" | "emailOptOut">;

type MatchingEmailContact = {
  contactId: string;
  email: string | null;
};

export type ProcessEmailOptOutResult = {
  normalizedEmail: string;
  optOutId: string;
  optOutCreatedOrUpdated: "created" | "updated";
  contactsMatched: number;
  contactsUpdated: number;
  writebacksQueued: number;
  writebacksDeduped: number;
  writebackFailures: number;
  globalOnly: boolean;
  providerMessageIdStored: boolean;
};

function trimToMax(value: string | null | undefined, maxLength: number) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

async function findMatchingContactsByNormalizedEmail(
  client: EmailOptOutClient,
  normalizedEmail: string
) {
  const contacts = await client.contact.findMany({
    where: { email: { not: null } },
    select: { contactId: true, email: true },
  });

  const matchingIds = new Set<string>();
  for (const contact of contacts as MatchingEmailContact[]) {
    if (normalizeEmailForOptOut(contact.email) === normalizedEmail) {
      matchingIds.add(contact.contactId);
    }
  }

  return Array.from(matchingIds);
}

async function findActiveEmailOptOutByNormalizedEmail(
  client: EmailOptOutClient,
  normalizedEmail: string
) {
  const activeOptOuts = await client.emailOptOut.findMany({
    where: { isActive: true },
    select: { id: true, email: true },
  });

  return activeOptOuts.find(
    (optOut) => normalizeEmailForOptOut(optOut.email) === normalizedEmail
  );
}

export async function processEmailOptOut(params: {
  email: unknown;
  source?: string | null;
  reason?: string | null;
  providerMessageId?: string | null;
  receivedAt?: Date;
  prismaClient?: EmailOptOutClient;
  contactOptInWriteback?: ContactOptInWritebackDispatchOptions;
}): Promise<ProcessEmailOptOutResult> {
  const client = params.prismaClient ?? prisma;
  const normalizedEmail = normalizeEmailForOptOut(params.email);
  if (!normalizedEmail) {
    throw new Error("Email opt-out requires a non-empty email address");
  }

  const now = params.receivedAt ?? new Date();
  const matchingContactIds = await findMatchingContactsByNormalizedEmail(client, normalizedEmail);
  const contactId = matchingContactIds.length === 1 ? matchingContactIds[0] : null;
  const existing = await findActiveEmailOptOutByNormalizedEmail(client, normalizedEmail);
  const data = {
    contactId,
    email: normalizedEmail,
    source: trimToMax(params.source, 64),
    reason: trimToMax(params.reason, 1024),
    optedOutAt: now,
    optedBackInAt: null,
    isActive: true,
  };

  const optOut = existing
    ? await client.emailOptOut.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      })
    : await client.emailOptOut.create({
        data,
        select: { id: true },
      });

  let contactsUpdated = 0;
  if (matchingContactIds.length > 0) {
    const updateResult = await client.contact.updateMany({
      where: { contactId: { in: matchingContactIds } },
      data: { emailOptIn: false },
    });
    contactsUpdated = updateResult.count;
  }

  const writebackResult = await enqueueEmailOptOutContactWritebacks({
    client,
    contactIds: matchingContactIds,
    relatedEmailOptOutId: optOut.id,
    dispatchOptions: params.contactOptInWriteback,
  });

  return {
    normalizedEmail,
    optOutId: optOut.id,
    optOutCreatedOrUpdated: existing ? "updated" : "created",
    contactsMatched: matchingContactIds.length,
    contactsUpdated,
    writebacksQueued: writebackResult.queued,
    writebacksDeduped: writebackResult.deduped,
    writebackFailures: writebackResult.failed,
    globalOnly: matchingContactIds.length === 0,
    providerMessageIdStored: false,
  };
}
