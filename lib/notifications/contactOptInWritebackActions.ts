import {
  ContactOptInWritebackChannel,
  ContactOptInWritebackStatus,
  Prisma,
} from "@/lib/generated/prisma/client";
import {
  buildContactOptInWritebackPayload,
  enqueueContactOptInWriteback,
  type EnqueueContactOptInWritebackOptions,
  type EnqueueContactOptInWritebackParams,
  type EnqueueContactOptInWritebackResult,
} from "@/lib/notifications/contactOptInWritebackQueue";
import {
  selectNotificationChannel,
  type NotificationContactInput,
  type NotificationOptOutState,
} from "@/lib/notifications/helpers";
import {
  normalizeEmailForOptOut,
  normalizeSmsPhoneForOptOut,
} from "@/lib/notifications/notificationAddressNormalization";
import { prisma } from "@/lib/prisma";

export const CONTACT_OPT_IN_TARGET_FIELD = {
  smsOptIn: "Contact.AttributeCONTEXT",
  emailOptIn: "Contact.AttributeCONEMAIL",
  phoneCallOptIn: "Contact.AttributeCONPHONE",
} as const;

type ContactOptInTarget = keyof typeof CONTACT_OPT_IN_TARGET_FIELD;

export type ContactOptInWritebackEnqueuer = (
  params: EnqueueContactOptInWritebackParams,
  options?: EnqueueContactOptInWritebackOptions
) => Promise<EnqueueContactOptInWritebackResult>;

export type ContactOptInWritebackDispatchOptions = {
  queueOptions?: EnqueueContactOptInWritebackOptions;
  enqueue?: ContactOptInWritebackEnqueuer;
  disabled?: boolean;
};

export type ContactOptInWritebackActionResult = {
  contactId: string;
  dedupeKey: string;
  actionId: string | null;
  queueJobId: string | null;
  status: "queued" | "deduped" | "failed" | "skipped";
  errorMessage?: string | null;
};

type ContactOptInWritebackClient = Pick<typeof prisma, "contactOptInWritebackAction">;

type ContactRepairClient = {
  contact: {
    findMany(args: {
      where: unknown;
      select: { contactId: true; phone1?: true; phone2?: true; email?: true };
    }): Promise<Array<{ contactId: string; phone1?: string | null; phone2?: string | null; email?: string | null }>>;
    updateMany(args: {
      where: { contactId: { in: string[] } };
      data: { smsOptIn?: false; emailOptIn?: false };
    }): Promise<{ count: number }>;
  };
};

export type ContactOptOutRepairContactInput = NotificationContactInput & {
  contactId?: string | null;
};

export type ContactOptOutRepairResult = {
  channel: ReturnType<typeof selectNotificationChannel>;
  smsContactsMatched: number;
  smsContactsUpdated: number;
  smsWritebacksQueued: number;
  smsWritebacksDeduped: number;
  smsWritebackFailures: number;
  emailContactsMatched: number;
  emailContactsUpdated: number;
  emailWritebacksQueued: number;
  emailWritebacksDeduped: number;
  emailWritebackFailures: number;
};

function hasWritebackClient(client: unknown): client is ContactOptInWritebackClient {
  if (!client || typeof client !== "object") return false;
  const delegate = (client as { contactOptInWritebackAction?: { findUnique?: unknown } })
    .contactOptInWritebackAction;
  return Boolean(
    delegate &&
      typeof delegate.findUnique === "function" &&
      typeof (delegate as { create?: unknown }).create === "function" &&
      typeof (delegate as { update?: unknown }).update === "function"
  );
}

function hasRepairClient(client: unknown): client is ContactRepairClient {
  if (!client || typeof client !== "object") return false;
  const contact = (client as { contact?: { findMany?: unknown; updateMany?: unknown } }).contact;
  return Boolean(
    contact &&
      typeof contact.findMany === "function" &&
      typeof contact.updateMany === "function"
  );
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function trimToMax(value: string, maxLength: number) {
  return value.trim().slice(0, maxLength);
}

function cleanErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2048);
}

function dedupeKey(params: {
  contactId: string;
  targetField: string;
  source: string;
}) {
  return [
    "contact_opt_in_writeback",
    params.contactId.trim(),
    params.targetField,
    "false",
    params.source.trim(),
  ].join(":");
}

function payloadForTarget(params: {
  contactId: string;
  target: ContactOptInTarget;
  source: string;
  reason: string;
}) {
  const base = {
    contactId: params.contactId,
    source: params.source,
    reason: params.reason,
  };

  if (params.target === "smsOptIn") {
    return buildContactOptInWritebackPayload({ ...base, smsOptIn: false });
  }
  if (params.target === "emailOptIn") {
    return buildContactOptInWritebackPayload({ ...base, emailOptIn: false });
  }
  return buildContactOptInWritebackPayload({ ...base, phoneCallOptIn: false });
}

function queuePayloadForTarget(params: {
  contactId: string;
  target: ContactOptInTarget;
  source: string;
  reason: string;
}): EnqueueContactOptInWritebackParams {
  if (params.target === "smsOptIn") {
    return {
      contactId: params.contactId,
      smsOptIn: false,
      source: params.source,
      reason: params.reason,
    };
  }
  if (params.target === "emailOptIn") {
    return {
      contactId: params.contactId,
      emailOptIn: false,
      source: params.source,
      reason: params.reason,
    };
  }
  return {
    contactId: params.contactId,
    phoneCallOptIn: false,
    source: params.source,
    reason: params.reason,
  };
}

async function findExistingAction(
  client: ContactOptInWritebackClient,
  key: string
): Promise<{
  id: string;
  status: ContactOptInWritebackStatus;
  queueJobId: string | null;
} | null> {
  return client.contactOptInWritebackAction.findUnique({
    where: { dedupeKey: key },
    select: { id: true, status: true, queueJobId: true },
  });
}

async function createPendingAction(params: {
  client: ContactOptInWritebackClient;
  dedupeKey: string;
  contactId: string;
  channel: ContactOptInWritebackChannel;
  targetField: string;
  source: string;
  reason: string;
  relatedSmsOptOutId?: string | null;
  relatedEmailOptOutId?: string | null;
}) {
  return params.client.contactOptInWritebackAction.create({
    data: {
      dedupeKey: params.dedupeKey,
      contactId: params.contactId,
      channel: params.channel,
      targetField: params.targetField,
      targetValue: false,
      source: trimToMax(params.source, 64),
      reason: trimToMax(params.reason, 128),
      status: ContactOptInWritebackStatus.PENDING,
      relatedSmsOptOutId: params.relatedSmsOptOutId ?? null,
      relatedEmailOptOutId: params.relatedEmailOptOutId ?? null,
    },
    select: { id: true },
  });
}

async function ensurePendingAction(params: {
  client: ContactOptInWritebackClient;
  dedupeKey: string;
  contactId: string;
  channel: ContactOptInWritebackChannel;
  targetField: string;
  source: string;
  reason: string;
  relatedSmsOptOutId?: string | null;
  relatedEmailOptOutId?: string | null;
}) {
  const existing = await findExistingAction(params.client, params.dedupeKey);
  if (existing && existing.status !== ContactOptInWritebackStatus.FAILED) {
    return { action: existing, deduped: true };
  }
  if (existing) {
    const action = await params.client.contactOptInWritebackAction.update({
      where: { id: existing.id },
      data: {
        status: ContactOptInWritebackStatus.PENDING,
        errorMessage: null,
        resultSummary: Prisma.JsonNull,
        queueJobId: null,
        queuedAt: null,
        completedAt: null,
      },
      select: { id: true, status: true, queueJobId: true },
    });
    return { action, deduped: false };
  }

  try {
    const created = await createPendingAction(params);
    return {
      action: {
        id: created.id,
        status: ContactOptInWritebackStatus.PENDING,
        queueJobId: null,
      },
      deduped: false,
    };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const winner = await findExistingAction(params.client, params.dedupeKey);
    if (winner) return { action: winner, deduped: true };
    throw error;
  }
}

export async function recordAndEnqueueContactOptInWriteback(params: {
  client?: unknown;
  contactId: string;
  channel: ContactOptInWritebackChannel;
  target: ContactOptInTarget;
  source: string;
  reason: string;
  relatedSmsOptOutId?: string | null;
  relatedEmailOptOutId?: string | null;
  dispatchOptions?: ContactOptInWritebackDispatchOptions;
}): Promise<ContactOptInWritebackActionResult> {
  const contactId = clean(params.contactId);
  const source = clean(params.source);
  const reason = clean(params.reason);
  if (!contactId) throw new Error("contactId is required");
  if (!source) throw new Error("source is required");
  if (!reason) throw new Error("reason is required");

  const targetField = CONTACT_OPT_IN_TARGET_FIELD[params.target];
  const key = dedupeKey({ contactId, targetField, source });
  if (params.dispatchOptions?.disabled) {
    return {
      contactId,
      dedupeKey: key,
      actionId: null,
      queueJobId: null,
      status: "skipped",
    };
  }

  const writebackClient = hasWritebackClient(params.client) ? params.client : null;
  let actionId: string | null = null;
  if (writebackClient) {
    const { action, deduped } = await ensurePendingAction({
      client: writebackClient,
      dedupeKey: key,
      contactId,
      channel: params.channel,
      targetField,
      source,
      reason,
      relatedSmsOptOutId: params.relatedSmsOptOutId,
      relatedEmailOptOutId: params.relatedEmailOptOutId,
    });
    actionId = action.id;
    if (deduped) {
      return {
        contactId,
        dedupeKey: key,
        actionId,
        queueJobId: action.queueJobId,
        status: "deduped",
      };
    }
  }

  const enqueue = params.dispatchOptions?.enqueue ?? enqueueContactOptInWriteback;
  const queuePayload = queuePayloadForTarget({ contactId, target: params.target, source, reason });

  try {
    const queued = await enqueue(queuePayload, params.dispatchOptions?.queueOptions);
    if (writebackClient && actionId) {
      await writebackClient.contactOptInWritebackAction.update({
        where: { id: actionId },
        data: {
          status: ContactOptInWritebackStatus.QUEUED,
          queueJobId: queued.jobId,
          queuedAt: new Date(),
          resultSummary: {
            payload: payloadForTarget({ contactId, target: params.target, source, reason }),
          } as Prisma.InputJsonObject,
          errorMessage: null,
        },
      });
    }

    return {
      contactId,
      dedupeKey: key,
      actionId,
      queueJobId: queued.jobId,
      status: "queued",
    };
  } catch (error) {
    const errorMessage = cleanErrorMessage(error);
    if (writebackClient && actionId) {
      await writebackClient.contactOptInWritebackAction.update({
        where: { id: actionId },
        data: {
          status: ContactOptInWritebackStatus.FAILED,
          errorMessage,
          resultSummary: Prisma.JsonNull,
        },
      });
    }

    return {
      contactId,
      dedupeKey: key,
      actionId,
      queueJobId: null,
      status: "failed",
      errorMessage,
    };
  }
}

function countWritebackResults(results: ContactOptInWritebackActionResult[]) {
  return {
    queued: results.filter((result) => result.status === "queued").length,
    deduped: results.filter((result) => result.status === "deduped").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
}

async function safeRecordAndEnqueueContactOptInWriteback(
  params: Parameters<typeof recordAndEnqueueContactOptInWriteback>[0]
): Promise<ContactOptInWritebackActionResult> {
  try {
    return await recordAndEnqueueContactOptInWriteback(params);
  } catch (error) {
    return {
      contactId: params.contactId,
      dedupeKey: "unavailable",
      actionId: null,
      queueJobId: null,
      status: "failed",
      errorMessage: cleanErrorMessage(error),
    };
  }
}

export async function enqueueSmsOptOutContactWritebacks(params: {
  client?: unknown;
  contactIds: string[];
  relatedSmsOptOutId?: string | null;
  dispatchOptions?: ContactOptInWritebackDispatchOptions;
}) {
  const results: ContactOptInWritebackActionResult[] = [];
  for (const contactId of Array.from(new Set(params.contactIds.map((id) => id.trim()).filter(Boolean)))) {
    try {
      results.push(await safeRecordAndEnqueueContactOptInWriteback({
        client: params.client,
        contactId,
        channel: ContactOptInWritebackChannel.SMS,
        target: "smsOptIn",
        source: "twilio_stop",
        reason: "customer_sms_opt_out",
        relatedSmsOptOutId: params.relatedSmsOptOutId,
        dispatchOptions: params.dispatchOptions,
      }));
    } catch (error) {
      results.push({
        contactId,
        dedupeKey: "unavailable",
        actionId: null,
        queueJobId: null,
        status: "failed",
        errorMessage: cleanErrorMessage(error),
      });
    }
  }
  return { results, ...countWritebackResults(results) };
}

export async function enqueueEmailOptOutContactWritebacks(params: {
  client?: unknown;
  contactIds: string[];
  relatedEmailOptOutId?: string | null;
  dispatchOptions?: ContactOptInWritebackDispatchOptions;
}) {
  const results: ContactOptInWritebackActionResult[] = [];
  for (const contactId of Array.from(new Set(params.contactIds.map((id) => id.trim()).filter(Boolean)))) {
    try {
      results.push(await safeRecordAndEnqueueContactOptInWriteback({
        client: params.client,
        contactId,
        channel: ContactOptInWritebackChannel.EMAIL,
        target: "emailOptIn",
        source: "email_unsubscribe",
        reason: "customer_email_opt_out",
        relatedEmailOptOutId: params.relatedEmailOptOutId,
        dispatchOptions: params.dispatchOptions,
      }));
    } catch (error) {
      results.push({
        contactId,
        dedupeKey: "unavailable",
        actionId: null,
        queueJobId: null,
        status: "failed",
        errorMessage: cleanErrorMessage(error),
      });
    }
  }
  return { results, ...countWritebackResults(results) };
}

function normalizedOptOutPhoneSet(optOutState: NotificationOptOutState) {
  return new Set(
    optOutState.activeSmsOptOutPhones?.map(normalizeSmsPhoneForOptOut).filter(Boolean)
  );
}

function normalizedOptOutEmailSet(optOutState: NotificationOptOutState) {
  return new Set(
    optOutState.activeEmailOptOutEmails?.map(normalizeEmailForOptOut).filter(Boolean)
  );
}

function contactSmsOptedOutPhone(contact: ContactOptOutRepairContactInput, optOutState: NotificationOptOutState) {
  const optedOutPhones = normalizedOptOutPhoneSet(optOutState);
  return [contact.phone1, contact.phone2]
    .map(normalizeSmsPhoneForOptOut)
    .find((phone) => phone && optedOutPhones.has(phone)) ?? null;
}

function contactEmailOptedOut(contact: ContactOptOutRepairContactInput, optOutState: NotificationOptOutState) {
  const optedOutEmails = normalizedOptOutEmailSet(optOutState);
  const normalizedEmail = normalizeEmailForOptOut(contact.email);
  return Boolean(normalizedEmail && optedOutEmails.has(normalizedEmail));
}

async function findMatchingContactIdsByNormalizedPhone(
  client: unknown,
  normalizedPhone: string,
  fallbackContact: ContactOptOutRepairContactInput
) {
  if (!hasRepairClient(client)) {
    return fallbackContact.contactId &&
      (normalizeSmsPhoneForOptOut(fallbackContact.phone1) === normalizedPhone ||
        normalizeSmsPhoneForOptOut(fallbackContact.phone2) === normalizedPhone)
      ? [fallbackContact.contactId]
      : [];
  }

  const contacts = await client.contact.findMany({
    where: {
      OR: [{ phone1: { not: null } }, { phone2: { not: null } }],
    },
    select: { contactId: true, phone1: true, phone2: true },
  });

  const matchingIds = new Set<string>();
  for (const contact of contacts) {
    if (
      normalizeSmsPhoneForOptOut(contact.phone1) === normalizedPhone ||
      normalizeSmsPhoneForOptOut(contact.phone2) === normalizedPhone
    ) {
      matchingIds.add(contact.contactId);
    }
  }

  return Array.from(matchingIds);
}

async function findMatchingContactIdsByNormalizedEmail(
  client: unknown,
  normalizedEmail: string,
  fallbackContact: ContactOptOutRepairContactInput
) {
  if (!hasRepairClient(client)) {
    return fallbackContact.contactId &&
      normalizeEmailForOptOut(fallbackContact.email) === normalizedEmail
      ? [fallbackContact.contactId]
      : [];
  }

  const contacts = await client.contact.findMany({
    where: { email: { not: null } },
    select: { contactId: true, email: true },
  });

  const matchingIds = new Set<string>();
  for (const contact of contacts) {
    if (normalizeEmailForOptOut(contact.email) === normalizedEmail) {
      matchingIds.add(contact.contactId);
    }
  }

  return Array.from(matchingIds);
}

async function updateSmsContactsFalse(client: unknown, contactIds: string[]) {
  if (!hasRepairClient(client) || contactIds.length === 0) return 0;
  const result = await client.contact.updateMany({
    where: { contactId: { in: contactIds } },
    data: { smsOptIn: false },
  });
  return result.count;
}

async function updateEmailContactsFalse(client: unknown, contactIds: string[]) {
  if (!hasRepairClient(client) || contactIds.length === 0) return 0;
  const result = await client.contact.updateMany({
    where: { contactId: { in: contactIds } },
    data: { emailOptIn: false },
  });
  return result.count;
}

export async function selectNotificationChannelWithOptOutRepair(params: {
  client?: unknown;
  contact: ContactOptOutRepairContactInput;
  optOutState?: NotificationOptOutState;
  dispatchOptions?: ContactOptInWritebackDispatchOptions;
}): Promise<ContactOptOutRepairResult> {
  const optOutState = params.optOutState ?? {};
  const repairedContact: ContactOptOutRepairContactInput = { ...params.contact };
  let smsContactsMatched = 0;
  let smsContactsUpdated = 0;
  let smsWritebacksQueued = 0;
  let smsWritebacksDeduped = 0;
  let smsWritebackFailures = 0;
  let emailContactsMatched = 0;
  let emailContactsUpdated = 0;
  let emailWritebacksQueued = 0;
  let emailWritebacksDeduped = 0;
  let emailWritebackFailures = 0;

  const optedOutPhone = contactSmsOptedOutPhone(params.contact, optOutState);
  if (params.contact.smsOptIn === true && optedOutPhone) {
    const matchingContactIds = await findMatchingContactIdsByNormalizedPhone(
      params.client,
      optedOutPhone,
      params.contact
    );
    smsContactsMatched = matchingContactIds.length;
    smsContactsUpdated = await updateSmsContactsFalse(params.client, matchingContactIds);
    if (matchingContactIds.includes(params.contact.contactId ?? "")) {
      repairedContact.smsOptIn = false;
    }

    const writebacks = [];
    for (const contactId of matchingContactIds) {
      writebacks.push(
        await safeRecordAndEnqueueContactOptInWriteback({
          client: params.client,
          contactId,
          channel: ContactOptInWritebackChannel.SMS,
          target: "smsOptIn",
          source: "send_gate_repair",
          reason: "active_sms_opt_out_send_gate_repair",
          dispatchOptions: params.dispatchOptions,
        })
      );
    }
    const counts = countWritebackResults(writebacks);
    smsWritebacksQueued = counts.queued;
    smsWritebacksDeduped = counts.deduped;
    smsWritebackFailures = counts.failed;
  }

  const normalizedEmail = normalizeEmailForOptOut(params.contact.email);
  if (params.contact.emailOptIn === true && normalizedEmail && contactEmailOptedOut(params.contact, optOutState)) {
    const matchingContactIds = await findMatchingContactIdsByNormalizedEmail(
      params.client,
      normalizedEmail,
      params.contact
    );
    emailContactsMatched = matchingContactIds.length;
    emailContactsUpdated = await updateEmailContactsFalse(params.client, matchingContactIds);
    if (matchingContactIds.includes(params.contact.contactId ?? "")) {
      repairedContact.emailOptIn = false;
    }

    const writebacks = [];
    for (const contactId of matchingContactIds) {
      writebacks.push(
        await safeRecordAndEnqueueContactOptInWriteback({
          client: params.client,
          contactId,
          channel: ContactOptInWritebackChannel.EMAIL,
          target: "emailOptIn",
          source: "send_gate_repair",
          reason: "active_email_opt_out_send_gate_repair",
          dispatchOptions: params.dispatchOptions,
        })
      );
    }
    const counts = countWritebackResults(writebacks);
    emailWritebacksQueued = counts.queued;
    emailWritebacksDeduped = counts.deduped;
    emailWritebackFailures = counts.failed;
  }

  return {
    channel: selectNotificationChannel(repairedContact, optOutState),
    smsContactsMatched,
    smsContactsUpdated,
    smsWritebacksQueued,
    smsWritebacksDeduped,
    smsWritebackFailures,
    emailContactsMatched,
    emailContactsUpdated,
    emailWritebacksQueued,
    emailWritebacksDeduped,
    emailWritebackFailures,
  };
}
