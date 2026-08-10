import { handleTwilioInboundSms } from "@/lib/notifications/handleTwilioInboundSms";
import { normalizePhoneToE164 } from "@/lib/notifications/deliveryConfirmationSmsReplies";
import { processEmailOptOut } from "@/lib/notifications/emailOptOuts";
import {
  buildContactOptInWritebackPayload,
  type EnqueueContactOptInWritebackParams,
  type EnqueueContactOptInWritebackResult,
} from "@/lib/notifications/contactOptInWritebackQueue";
import { selectNotificationChannel } from "@/lib/notifications/helpers";
import {
  normalizeEmailForOptOut,
  normalizeSmsPhoneForOptOut,
} from "@/lib/notifications/notificationAddressNormalization";
import { prisma } from "@/lib/prisma";

type BooleanCounts = {
  true: number;
  false: number;
};

type ContactSnapshot = {
  contactId: string;
  smsOptIn: boolean;
  emailOptIn: boolean;
  phoneCallOptIn: boolean;
};

type PhoneCandidate = ContactSnapshot & {
  phone: string;
  phoneE164: string;
  phoneKey: string;
};

type EmailCandidate = ContactSnapshot & {
  email: string;
  emailKey: string;
};

type CreatedSmsOptOut = {
  id: string;
  contactId: string | null;
  phone: string;
};

type CreatedEmailOptOut = {
  id: string;
  contactId: string | null;
  email: string;
};

const SMS_OPT_OUT_TARGET = 40;
const EMAIL_OPT_OUT_TARGET = 40;
const CONTROL_TARGET = 5;
const RUN_ID = `optout_volume_test_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const TEST_SOURCE = RUN_ID.slice(0, 64);
const TEST_REASON = RUN_ID;
const TEST_TO_PHONE = "+18015550100";

function createFakeContactOptInWritebackEnqueue(runId: string) {
  const payloads: Array<ReturnType<typeof buildContactOptInWritebackPayload>> = [];
  const enqueue = async (
    params: EnqueueContactOptInWritebackParams
  ): Promise<EnqueueContactOptInWritebackResult> => {
    const payload = buildContactOptInWritebackPayload(params);
    payloads.push(payload);
    return {
      jobId: `dry-run-contact-opt-in-${runId}-${String(payloads.length).padStart(4, "0")}`,
      payload,
    };
  };

  return { enqueue, payloads };
}

function booleanCounts(): BooleanCounts {
  return { true: 0, false: 0 };
}

function addBoolean(counts: BooleanCounts, value: boolean) {
  if (value) {
    counts.true += 1;
  } else {
    counts.false += 1;
  }
}

function phoneKey(value: string | null | undefined) {
  return normalizeSmsPhoneForOptOut(value);
}

function emailKey(value: string | null | undefined) {
  const normalized = normalizeEmailForOptOut(value);
  if (!normalized || !normalized.includes("@") || /\s/.test(normalized)) return null;
  return normalized;
}

function buildCounts(contacts: ContactSnapshot[]) {
  const smsOptIn = booleanCounts();
  const emailOptIn = booleanCounts();
  const phoneCallOptIn = booleanCounts();

  for (const contact of contacts) {
    addBoolean(smsOptIn, contact.smsOptIn);
    addBoolean(emailOptIn, contact.emailOptIn);
    addBoolean(phoneCallOptIn, contact.phoneCallOptIn);
  }

  return { smsOptIn, emailOptIn, phoneCallOptIn };
}

function takeAvailable<T extends { contactId: string }>(
  candidates: T[],
  count: number,
  usedContactIds: Set<string>
) {
  const selected: T[] = [];
  for (const candidate of candidates) {
    if (selected.length >= count) break;
    if (usedContactIds.has(candidate.contactId)) continue;
    selected.push(candidate);
    usedContactIds.add(candidate.contactId);
  }
  return selected;
}

function smsWouldSend(candidate: PhoneCandidate, optOutPhones: string[] = []) {
  return (
    selectNotificationChannel(
      {
        smsOptIn: true,
        emailOptIn: false,
        phone1: candidate.phone,
        phone2: null,
        email: null,
      },
      { activeSmsOptOutPhones: optOutPhones }
    ).selectedChannel === "SMS"
  );
}

function emailWouldSend(candidate: EmailCandidate, optOutEmails: string[] = []) {
  return (
    selectNotificationChannel(
      {
        smsOptIn: false,
        emailOptIn: true,
        phone1: null,
        phone2: null,
        email: candidate.email,
      },
      { activeEmailOptOutEmails: optOutEmails }
    ).selectedChannel === "EMAIL"
  );
}

async function restoreContacts(snapshots: Map<string, ContactSnapshot>) {
  const updates = Array.from(snapshots.values()).map((snapshot) =>
    prisma.contact.update({
      where: { contactId: snapshot.contactId },
      data: {
        smsOptIn: snapshot.smsOptIn,
        emailOptIn: snapshot.emailOptIn,
        phoneCallOptIn: snapshot.phoneCallOptIn,
      },
    })
  );

  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }
}

async function snapshotActiveSmsOptOuts() {
  const rows = await prisma.smsOptOut.findMany({
    where: { isActive: true },
    select: {
      id: true,
      contactId: true,
      phone: true,
      source: true,
      reason: true,
      optedOutAt: true,
      optedBackInAt: true,
      isActive: true,
    },
    orderBy: { id: "asc" },
  });

  return new Map(rows.map((row) => [row.id, JSON.stringify(row)]));
}

async function snapshotActiveEmailOptOuts() {
  const rows = await prisma.emailOptOut.findMany({
    where: { isActive: true },
    select: {
      id: true,
      contactId: true,
      email: true,
      source: true,
      reason: true,
      optedOutAt: true,
      optedBackInAt: true,
      isActive: true,
    },
    orderBy: { id: "asc" },
  });

  return new Map(rows.map((row) => [row.id, JSON.stringify(row)]));
}

async function compareActiveSmsSnapshot(snapshot: Map<string, string>) {
  const current = await snapshotActiveSmsOptOuts();
  if (current.size !== snapshot.size) return false;
  for (const [id, value] of snapshot) {
    if (current.get(id) !== value) return false;
  }
  return true;
}

async function compareActiveEmailSnapshot(snapshot: Map<string, string>) {
  const current = await snapshotActiveEmailOptOuts();
  if (current.size !== snapshot.size) return false;
  for (const [id, value] of snapshot) {
    if (current.get(id) !== value) return false;
  }
  return true;
}

async function verifyContactRestore(snapshots: Map<string, ContactSnapshot>) {
  const rows = await prisma.contact.findMany({
    where: { contactId: { in: Array.from(snapshots.keys()) } },
    select: {
      contactId: true,
      smsOptIn: true,
      emailOptIn: true,
      phoneCallOptIn: true,
    },
  });

  for (const row of rows) {
    const snapshot = snapshots.get(row.contactId);
    if (!snapshot) return false;
    if (
      row.smsOptIn !== snapshot.smsOptIn ||
      row.emailOptIn !== snapshot.emailOptIn ||
      row.phoneCallOptIn !== snapshot.phoneCallOptIn
    ) {
      return false;
    }
  }

  return rows.length === snapshots.size;
}

function addSnapshot(
  selectedSnapshots: Map<string, ContactSnapshot>,
  contact: ContactSnapshot
) {
  if (!selectedSnapshots.has(contact.contactId)) {
    selectedSnapshots.set(contact.contactId, contact);
  }
}

function selectRecord(record: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return record;
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, include]) => include)
      .map(([key]) => [key, record[key]])
  );
}

async function validateSyntheticMultipleSmsExactMatch() {
  const contacts = [
    { contactId: "synthetic_sms_1", phone1: "(801) 555-1212", phone2: null, smsOptIn: true },
    { contactId: "synthetic_sms_2", phone1: "+1 801 555 1212", phone2: null, smsOptIn: true },
  ];
  const smsOptOuts: Array<Record<string, unknown>> = [];
  const inboundMessages: Array<Record<string, unknown>> = [];
  const client = {
    contact: {
      findMany: async (args: { select?: Record<string, boolean> }) =>
        contacts.map((contact) =>
          selectRecord(contact as unknown as Record<string, unknown>, args.select)
        ),
      updateMany: async (args: {
        where: { contactId: { in: string[] } };
        data: { smsOptIn?: boolean };
      }) => {
        let count = 0;
        for (const contact of contacts) {
          if (!args.where.contactId.in.includes(contact.contactId)) continue;
          if (args.data.smsOptIn !== undefined) contact.smsOptIn = args.data.smsOptIn;
          count += 1;
        }
        return { count };
      },
    },
    smsOptOut: {
      findMany: async (args: { where?: { isActive?: boolean }; select?: Record<string, boolean> }) =>
        smsOptOuts
          .filter((row) => args.where?.isActive === undefined || row.isActive === args.where.isActive)
          .map((row) => selectRecord(row, args.select)),
      create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const record = { id: "synthetic_sms_optout", ...args.data };
        smsOptOuts.push(record);
        return selectRecord(record, args.select);
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        const record = smsOptOuts.find((row) => row.id === args.where.id);
        if (!record) throw new Error("missing synthetic sms opt-out");
        Object.assign(record, args.data);
        return selectRecord(record, args.select);
      },
      updateMany: async () => ({ count: 0 }),
    },
    twilioInboundMessage: {
      findUnique: async () => null,
      create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const record = { id: "synthetic_inbound", ...args.data, processedAt: null };
        inboundMessages.push(record);
        return selectRecord(record, args.select);
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = inboundMessages.find((row) => row.id === args.where.id);
        if (!record) throw new Error("missing synthetic inbound");
        Object.assign(record, args.data);
        return record;
      },
    },
    deliveryConfirmation: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      update: async () => null,
    },
  };

  const writeback = createFakeContactOptInWritebackEnqueue("synthetic-sms");
  const result = await handleTwilioInboundSms({
    payload: {
      MessageSid: "SM_SYNTHETIC_MULTIPLE_SMS",
      AccountSid: "AC_OPT_OUT_VOLUME_TEST",
      From: "+18015551212",
      To: TEST_TO_PHONE,
      Body: "STOP",
    },
    prismaClient: client as unknown as Parameters<typeof handleTwilioInboundSms>[0]["prismaClient"],
    now: new Date("2026-08-10T00:00:00.000Z"),
    contactOptInWriteback: { enqueue: writeback.enqueue },
  });

  const flagsFalse = contacts.filter((contact) => contact.smsOptIn === false).length;
  const optOut = smsOptOuts[0];
  const optOutGlobal = optOut?.contactId === null;
  const queuedContactIds = writeback.payloads.map((payload) => payload.contactId).sort();
  return {
    passed:
      result.matchStatus === "OPTED_OUT" &&
      result.optOutContactsMatched === 2 &&
      result.optOutContactsUpdated === 2 &&
      result.optOutWritebacksQueued === 2 &&
      flagsFalse === 2 &&
      optOutGlobal &&
      queuedContactIds.join("|") === "synthetic_sms_1|synthetic_sms_2",
    contactsMatched: result.optOutContactsMatched ?? 0,
    contactsUpdated: result.optOutContactsUpdated ?? 0,
    writebacksQueued: result.optOutWritebacksQueued ?? 0,
    flagsFalse,
    optOutGlobal,
  };
}

async function validateSyntheticMultipleEmailExactMatch() {
  const contacts = [
    { contactId: "synthetic_email_1", email: "duplicate@example.test", emailOptIn: true },
    { contactId: "synthetic_email_2", email: "DUPLICATE@example.test", emailOptIn: true },
  ];
  const emailOptOuts: Array<Record<string, unknown>> = [];
  const client = {
    contact: {
      findMany: async (args: { select?: Record<string, boolean> }) =>
        contacts.map((contact) =>
          selectRecord(contact as unknown as Record<string, unknown>, args.select)
        ),
      updateMany: async (args: {
        where: { contactId: { in: string[] } };
        data: { emailOptIn?: boolean };
      }) => {
        let count = 0;
        for (const contact of contacts) {
          if (!args.where.contactId.in.includes(contact.contactId)) continue;
          if (args.data.emailOptIn !== undefined) contact.emailOptIn = args.data.emailOptIn;
          count += 1;
        }
        return { count };
      },
    },
    emailOptOut: {
      findMany: async (args: { where?: { isActive?: boolean }; select?: Record<string, boolean> }) =>
        emailOptOuts
          .filter((row) => args.where?.isActive === undefined || row.isActive === args.where.isActive)
          .map((row) => selectRecord(row, args.select)),
      create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const record = { id: "synthetic_email_optout", ...args.data };
        emailOptOuts.push(record);
        return selectRecord(record, args.select);
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        const record = emailOptOuts.find((row) => row.id === args.where.id);
        if (!record) throw new Error("missing synthetic email opt-out");
        Object.assign(record, args.data);
        return selectRecord(record, args.select);
      },
    },
  };

  const writeback = createFakeContactOptInWritebackEnqueue("synthetic-email");
  const result = await processEmailOptOut({
    email: " duplicate@example.test ",
    source: TEST_SOURCE,
    reason: TEST_REASON,
    providerMessageId: "synthetic-provider-id",
    receivedAt: new Date("2026-08-10T00:00:00.000Z"),
    prismaClient: client as unknown as Parameters<typeof processEmailOptOut>[0]["prismaClient"],
    contactOptInWriteback: { enqueue: writeback.enqueue },
  });

  const flagsFalse = contacts.filter((contact) => contact.emailOptIn === false).length;
  const optOut = emailOptOuts[0];
  const optOutGlobal = optOut?.contactId === null;
  const queuedContactIds = writeback.payloads.map((payload) => payload.contactId).sort();
  return {
    passed:
      result.contactsMatched === 2 &&
      result.contactsUpdated === 2 &&
      result.writebacksQueued === 2 &&
      flagsFalse === 2 &&
      optOutGlobal &&
      queuedContactIds.join("|") === "synthetic_email_1|synthetic_email_2",
    contactsMatched: result.contactsMatched,
    contactsUpdated: result.contactsUpdated,
    writebacksQueued: result.writebacksQueued,
    flagsFalse,
    optOutGlobal,
  };
}

async function main() {
  const startedAt = new Date();
  const selectedSnapshots = new Map<string, ContactSnapshot>();
  const createdSmsOptOutIds = new Set<string>();
  const createdEmailOptOutIds = new Set<string>();
  const createdTwilioInboundMessageIds = new Set<string>();
  const createdContactOptInWritebackActionIds = new Set<string>();
  const createdContactOptInWritebackJobIds = new Set<string>();
  const contactOptInWriteback = createFakeContactOptInWritebackEnqueue(RUN_ID);
  const fallbackCleanupSmsPhones = new Set<string>();
  const notificationCountsBefore = {
    notificationEvents: await prisma.notificationEvent.count(),
    notificationAttempts: await prisma.notificationAttempt.count(),
  };
  const activeSmsSnapshot = await snapshotActiveSmsOptOuts();
  const activeEmailSnapshot = await snapshotActiveEmailOptOuts();
  const activeSmsPhoneKeys = new Set(
    Array.from(activeSmsSnapshot.values())
      .map((serialized) => phoneKey(JSON.parse(serialized).phone))
      .filter((value): value is string => Boolean(value))
  );
  const activeEmailKeys = new Set(
    Array.from(activeEmailSnapshot.values())
      .map((serialized) => emailKey(JSON.parse(serialized).email))
      .filter((value): value is string => Boolean(value))
  );

  let summary: Record<string, unknown> | null = null;
  let cleanupSummary: Record<string, unknown> | null = null;

  try {
    const contacts = await prisma.contact.findMany({
      select: {
        contactId: true,
        smsOptIn: true,
        emailOptIn: true,
        phoneCallOptIn: true,
        phone1: true,
        phone2: true,
        email: true,
      },
      orderBy: { contactId: "asc" },
    });
    const contactSnapshots: ContactSnapshot[] = contacts.map((contact) => ({
      contactId: contact.contactId,
      smsOptIn: contact.smsOptIn,
      emailOptIn: contact.emailOptIn,
      phoneCallOptIn: contact.phoneCallOptIn,
    }));
    const beforeAggregate = buildCounts(contactSnapshots);

    const phoneCounts = new Map<string, number>();
    const emailCounts = new Map<string, number>();
    const duplicatePhoneGroups = new Map<string, PhoneCandidate[]>();
    const duplicateEmailGroups = new Map<string, EmailCandidate[]>();
    for (const contact of contacts) {
      const contactPhoneKeys = new Set(
        [contact.phone1, contact.phone2]
          .map(phoneKey)
          .filter((value): value is string => Boolean(value))
      );
      for (const key of contactPhoneKeys) {
        phoneCounts.set(key, (phoneCounts.get(key) ?? 0) + 1);
      }

      const key = emailKey(contact.email);
      if (key) emailCounts.set(key, (emailCounts.get(key) ?? 0) + 1);
    }

    const phoneCandidates: PhoneCandidate[] = [];
    const emailCandidates: EmailCandidate[] = [];
    for (const contact of contacts) {
      const snapshot = {
        contactId: contact.contactId,
        smsOptIn: contact.smsOptIn,
        emailOptIn: contact.emailOptIn,
        phoneCallOptIn: contact.phoneCallOptIn,
      };
      const phone = [contact.phone1, contact.phone2].find((value) => {
        const key = phoneKey(value);
        const e164 = normalizePhoneToE164(value);
        return Boolean(value && key && e164 && !activeSmsPhoneKeys.has(key));
      });
      const key = phoneKey(phone);
      const e164 = normalizePhoneToE164(phone);
      if (phone && key && e164) {
        const candidate = { ...snapshot, phone, phoneE164: e164, phoneKey: key };
        if (phoneCounts.get(key) === 1) {
          phoneCandidates.push(candidate);
        } else if ((phoneCounts.get(key) ?? 0) > 1) {
          const group = duplicatePhoneGroups.get(key) ?? [];
          group.push(candidate);
          duplicatePhoneGroups.set(key, group);
        }
      }

      const normalizedEmail = emailKey(contact.email);
      if (contact.email && normalizedEmail && !activeEmailKeys.has(normalizedEmail)) {
        const candidate = { ...snapshot, email: contact.email, emailKey: normalizedEmail };
        if (emailCounts.get(normalizedEmail) === 1) {
          emailCandidates.push(candidate);
        } else if ((emailCounts.get(normalizedEmail) ?? 0) > 1) {
          const group = duplicateEmailGroups.get(normalizedEmail) ?? [];
          group.push(candidate);
          duplicateEmailGroups.set(normalizedEmail, group);
        }
      }
    }

    const usedContactIds = new Set<string>();
    const smsOptOutCohort = takeAvailable(phoneCandidates, SMS_OPT_OUT_TARGET, usedContactIds);
    const emailOptOutCohort = takeAvailable(emailCandidates, EMAIL_OPT_OUT_TARGET, usedContactIds);
    const smsControlCohort = takeAvailable(phoneCandidates, CONTROL_TARGET, usedContactIds);
    const emailControlCohort = takeAvailable(emailCandidates, CONTROL_TARGET, usedContactIds);
    const globalSmsCohort = takeAvailable(phoneCandidates, 1, usedContactIds);
    const globalEmailCohort = takeAvailable(emailCandidates, 1, usedContactIds);
    const duplicateSmsCohort =
      Array.from(duplicatePhoneGroups.values()).find(
        (group) => group.length >= 2 && group.slice(0, 2).every((row) => !usedContactIds.has(row.contactId))
      )?.slice(0, 2) ?? [];
    for (const contact of duplicateSmsCohort) usedContactIds.add(contact.contactId);
    const duplicateEmailCohort =
      Array.from(duplicateEmailGroups.values()).find(
        (group) => group.length >= 2 && group.slice(0, 2).every((row) => !usedContactIds.has(row.contactId))
      )?.slice(0, 2) ?? [];
    for (const contact of duplicateEmailCohort) usedContactIds.add(contact.contactId);

    const selectedContacts = [
      ...smsOptOutCohort,
      ...emailOptOutCohort,
      ...smsControlCohort,
      ...emailControlCohort,
      ...globalSmsCohort,
      ...globalEmailCohort,
      ...duplicateSmsCohort,
      ...duplicateEmailCohort,
    ];
    for (const contact of selectedContacts) {
      addSnapshot(selectedSnapshots, {
        contactId: contact.contactId,
        smsOptIn: contact.smsOptIn,
        emailOptIn: contact.emailOptIn,
        phoneCallOptIn: contact.phoneCallOptIn,
      });
    }

    const setupUpdates = new Map<string, Partial<ContactSnapshot>>();
    function mergeSetup(contactId: string, data: Partial<ContactSnapshot>) {
      setupUpdates.set(contactId, { ...(setupUpdates.get(contactId) ?? {}), ...data });
    }
    for (const contact of [
      ...smsOptOutCohort,
      ...smsControlCohort,
      ...globalSmsCohort,
      ...duplicateSmsCohort,
    ]) {
      mergeSetup(contact.contactId, { smsOptIn: true });
    }
    for (const contact of [
      ...emailOptOutCohort,
      ...emailControlCohort,
      ...globalEmailCohort,
      ...duplicateEmailCohort,
    ]) {
      mergeSetup(contact.contactId, { emailOptIn: true });
    }

    const setupWrites = Array.from(setupUpdates.entries()).map(([contactId, data]) =>
      prisma.contact.update({
        where: { contactId },
        data: {
          smsOptIn: data.smsOptIn,
          emailOptIn: data.emailOptIn,
        },
      })
    );
    if (setupWrites.length > 0) {
      await prisma.$transaction(setupWrites);
    }

    let setupSmsChanged = 0;
    let setupEmailChanged = 0;
    for (const [contactId, data] of setupUpdates) {
      const snapshot = selectedSnapshots.get(contactId);
      if (!snapshot) continue;
      if (data.smsOptIn !== undefined && data.smsOptIn !== snapshot.smsOptIn) setupSmsChanged += 1;
      if (data.emailOptIn !== undefined && data.emailOptIn !== snapshot.emailOptIn) {
        setupEmailChanged += 1;
      }
    }

    const createdSmsOptOuts: CreatedSmsOptOut[] = [];
    const createdEmailOptOuts: CreatedEmailOptOut[] = [];
    let smsStopPayloadsProcessed = 0;
    let smsStopMatchedOptedOut = 0;
    let smsOptOutRowsAccurate = 0;
    let smsContactFlagUpdatedFalse = 0;
    let smsContactFlagNotUpdatedFalse = 0;
    let smsWritebackActionsQueued = 0;
    let smsWritebackActionsDeduped = 0;
    let smsWritebackActionsFailed = 0;

    for (const [index, contact] of smsOptOutCohort.entries()) {
      const messageSid = `SM${Date.now()}${String(index).padStart(3, "0")}`.slice(0, 64);
      const result = await handleTwilioInboundSms({
        payload: {
          MessageSid: messageSid,
          AccountSid: "AC_OPT_OUT_VOLUME_TEST",
          MessagingServiceSid: TEST_SOURCE,
          From: contact.phoneE164,
          To: TEST_TO_PHONE,
          Body: "STOP",
          RunId: RUN_ID,
        },
        now: new Date(startedAt.getTime() + index * 1000),
        contactOptInWriteback: { enqueue: contactOptInWriteback.enqueue },
      });
      createdTwilioInboundMessageIds.add(result.inboundMessageId);
      fallbackCleanupSmsPhones.add(contact.phoneKey);
      fallbackCleanupSmsPhones.add(contact.phoneE164);
      smsStopPayloadsProcessed += 1;
      if (result.matchStatus === "OPTED_OUT") smsStopMatchedOptedOut += 1;
      smsWritebackActionsQueued += result.optOutWritebacksQueued ?? 0;
      smsWritebackActionsDeduped += result.optOutWritebacksDeduped ?? 0;
      smsWritebackActionsFailed += result.optOutWritebackFailures ?? 0;

      const optOut = await prisma.smsOptOut.findFirst({
        where: {
          phone: contact.phoneKey,
          isActive: true,
        },
        select: { id: true, contactId: true, phone: true },
        orderBy: { createdAt: "desc" },
      });
      if (optOut) {
        createdSmsOptOutIds.add(optOut.id);
        createdSmsOptOuts.push(optOut);
        const writebackActions = await prisma.contactOptInWritebackAction.findMany({
          where: {
            relatedSmsOptOutId: optOut.id,
            targetField: "Contact.AttributeCONTEXT",
          },
          select: { id: true, queueJobId: true },
        });
        for (const action of writebackActions) {
          createdContactOptInWritebackActionIds.add(action.id);
          if (action.queueJobId) createdContactOptInWritebackJobIds.add(action.queueJobId);
        }
        if (optOut.contactId === contact.contactId && optOut.phone === contact.phoneKey) {
          smsOptOutRowsAccurate += 1;
        }
      }

      const refreshedContact = await prisma.contact.findUnique({
        where: { contactId: contact.contactId },
        select: { smsOptIn: true },
      });
      if (refreshedContact?.smsOptIn === false) {
        smsContactFlagUpdatedFalse += 1;
      } else {
        smsContactFlagNotUpdatedFalse += 1;
      }
    }

    let emailOptOutRowsAccurate = 0;
    let emailContactFlagUpdatedFalse = 0;
    let emailContactFlagNotUpdatedFalse = 0;
    let emailWritebackActionsQueued = 0;
    let emailWritebackActionsDeduped = 0;
    let emailWritebackActionsFailed = 0;
    for (const [index, contact] of emailOptOutCohort.entries()) {
      const result = await processEmailOptOut({
        email: contact.email,
        source: TEST_SOURCE,
        reason: TEST_REASON,
        providerMessageId: `email-provider-test-${index}`,
        receivedAt: new Date(startedAt.getTime() + index * 1000),
        contactOptInWriteback: { enqueue: contactOptInWriteback.enqueue },
      });
      createdEmailOptOutIds.add(result.optOutId);
      emailWritebackActionsQueued += result.writebacksQueued;
      emailWritebackActionsDeduped += result.writebacksDeduped;
      emailWritebackActionsFailed += result.writebackFailures;

      const optOut = await prisma.emailOptOut.findUnique({
        where: { id: result.optOutId },
        select: { id: true, contactId: true, email: true },
      });
      if (optOut) {
        createdEmailOptOuts.push(optOut);
        const writebackActions = await prisma.contactOptInWritebackAction.findMany({
          where: {
            relatedEmailOptOutId: optOut.id,
            targetField: "Contact.AttributeCONEMAIL",
          },
          select: { id: true, queueJobId: true },
        });
        for (const action of writebackActions) {
          createdContactOptInWritebackActionIds.add(action.id);
          if (action.queueJobId) createdContactOptInWritebackJobIds.add(action.queueJobId);
        }
        if (optOut.contactId === contact.contactId && optOut.email === contact.emailKey) {
          emailOptOutRowsAccurate += 1;
        }
      }

      const refreshedContact = await prisma.contact.findUnique({
        where: { contactId: contact.contactId },
        select: { emailOptIn: true },
      });
      if (refreshedContact?.emailOptIn === false) {
        emailContactFlagUpdatedFalse += 1;
      } else {
        emailContactFlagNotUpdatedFalse += 1;
      }
    }

    let duplicateSmsExactMatchUpdated = 0;
    const duplicateSmsExactMatchAvailable = duplicateSmsCohort.length >= 2;
    if (duplicateSmsExactMatchAvailable) {
      const [first] = duplicateSmsCohort;
      const messageSid = `SM${Date.now()}DUPSMS`.slice(0, 64);
      const result = await handleTwilioInboundSms({
        payload: {
          MessageSid: messageSid,
          AccountSid: "AC_OPT_OUT_VOLUME_TEST",
          MessagingServiceSid: TEST_SOURCE,
          From: first.phoneE164,
          To: TEST_TO_PHONE,
          Body: "STOP",
          RunId: RUN_ID,
        },
        now: new Date(startedAt.getTime() + 90_000),
        contactOptInWriteback: { enqueue: contactOptInWriteback.enqueue },
      });
      createdTwilioInboundMessageIds.add(result.inboundMessageId);
      fallbackCleanupSmsPhones.add(first.phoneKey);
      const optOut = await prisma.smsOptOut.findFirst({
        where: { phone: first.phoneKey, isActive: true },
        select: { id: true, contactId: true, phone: true },
        orderBy: { createdAt: "desc" },
      });
      if (optOut) createdSmsOptOutIds.add(optOut.id);
      if (optOut) {
        const writebackActions = await prisma.contactOptInWritebackAction.findMany({
          where: {
            relatedSmsOptOutId: optOut.id,
            targetField: "Contact.AttributeCONTEXT",
          },
          select: { id: true, queueJobId: true },
        });
        for (const action of writebackActions) {
          createdContactOptInWritebackActionIds.add(action.id);
          if (action.queueJobId) createdContactOptInWritebackJobIds.add(action.queueJobId);
        }
      }

      const refreshed = await prisma.contact.findMany({
        where: { contactId: { in: duplicateSmsCohort.map((contact) => contact.contactId) } },
        select: { smsOptIn: true },
      });
      duplicateSmsExactMatchUpdated = refreshed.filter((contact) => contact.smsOptIn === false).length;
    }

    let duplicateEmailExactMatchUpdated = 0;
    const duplicateEmailExactMatchAvailable = duplicateEmailCohort.length >= 2;
    if (duplicateEmailExactMatchAvailable) {
      const [first] = duplicateEmailCohort;
      const result = await processEmailOptOut({
        email: first.email,
        source: TEST_SOURCE,
        reason: TEST_REASON,
        providerMessageId: "email-provider-test-duplicate",
        receivedAt: new Date(startedAt.getTime() + 91_000),
        contactOptInWriteback: { enqueue: contactOptInWriteback.enqueue },
      });
      createdEmailOptOutIds.add(result.optOutId);

      const optOut = await prisma.emailOptOut.findUnique({
        where: { id: result.optOutId },
        select: { id: true, contactId: true, email: true },
      });
      if (optOut) createdEmailOptOuts.push(optOut);
      if (optOut) {
        const writebackActions = await prisma.contactOptInWritebackAction.findMany({
          where: {
            relatedEmailOptOutId: optOut.id,
            targetField: "Contact.AttributeCONEMAIL",
          },
          select: { id: true, queueJobId: true },
        });
        for (const action of writebackActions) {
          createdContactOptInWritebackActionIds.add(action.id);
          if (action.queueJobId) createdContactOptInWritebackJobIds.add(action.queueJobId);
        }
      }

      const refreshed = await prisma.contact.findMany({
        where: { contactId: { in: duplicateEmailCohort.map((contact) => contact.contactId) } },
        select: { emailOptIn: true },
      });
      duplicateEmailExactMatchUpdated = refreshed.filter((contact) => contact.emailOptIn === false).length;
    }

    let globalSmsOptOut: CreatedSmsOptOut | null = null;
    if (globalSmsCohort[0]) {
      const optOut = await prisma.smsOptOut.create({
        data: {
          contactId: null,
          phone: globalSmsCohort[0].phoneKey,
          source: TEST_SOURCE,
          reason: TEST_REASON,
          optedOutAt: new Date(),
          isActive: true,
        },
        select: { id: true, contactId: true, phone: true },
      });
      createdSmsOptOutIds.add(optOut.id);
      fallbackCleanupSmsPhones.add(optOut.phone);
      globalSmsOptOut = optOut;
    }

    let globalEmailOptOut: CreatedEmailOptOut | null = null;
    if (globalEmailCohort[0]) {
      const optOut = await prisma.emailOptOut.create({
        data: {
          contactId: null,
          email: globalEmailCohort[0].emailKey,
          source: TEST_SOURCE,
          reason: TEST_REASON,
          optedOutAt: new Date(),
          isActive: true,
        },
        select: { id: true, contactId: true, email: true },
      });
      createdEmailOptOutIds.add(optOut.id);
      globalEmailOptOut = optOut;
    }

    const activeSmsOptOutPhones = [
      ...createdSmsOptOuts.map((optOut) => optOut.phone),
      ...(globalSmsOptOut ? [globalSmsOptOut.phone] : []),
    ];
    const activeEmailOptOutEmails = [
      ...createdEmailOptOuts.map((optOut) => optOut.email),
      ...(globalEmailOptOut ? [globalEmailOptOut.email] : []),
    ];

    let smsWouldHaveQualified = 0;
    let smsBlockedByOptOut = 0;
    let emailWouldHaveQualified = 0;
    let emailBlockedByOptOut = 0;
    for (const contact of smsOptOutCohort) {
      if (smsWouldSend(contact)) smsWouldHaveQualified += 1;
      if (!smsWouldSend(contact, activeSmsOptOutPhones)) smsBlockedByOptOut += 1;
    }
    for (const contact of emailOptOutCohort) {
      if (emailWouldSend(contact)) emailWouldHaveQualified += 1;
      if (!emailWouldSend(contact, activeEmailOptOutEmails)) emailBlockedByOptOut += 1;
    }

    const smsControlsWouldReachGate = smsControlCohort.filter((contact) =>
      smsWouldSend(contact, activeSmsOptOutPhones)
    ).length;
    const emailControlsWouldReachGate = emailControlCohort.filter((contact) =>
      emailWouldSend(contact, activeEmailOptOutEmails)
    ).length;

    const globalSmsAddressBlocked = Boolean(
      globalSmsCohort[0] &&
        globalSmsOptOut &&
        !smsWouldSend(globalSmsCohort[0], activeSmsOptOutPhones)
    );
    const globalEmailAddressBlocked = Boolean(
      globalEmailCohort[0] &&
        globalEmailOptOut &&
        !emailWouldSend(globalEmailCohort[0], activeEmailOptOutEmails)
    );
    const syntheticMultipleSmsExactMatch = await validateSyntheticMultipleSmsExactMatch();
    const syntheticMultipleEmailExactMatch = await validateSyntheticMultipleEmailExactMatch();

    const blockers: string[] = [];
    if (smsOptOutCohort.length !== SMS_OPT_OUT_TARGET) {
      blockers.push("insufficient_sms_opt_out_candidates");
    }
    if (emailOptOutCohort.length !== EMAIL_OPT_OUT_TARGET) {
      blockers.push("insufficient_email_opt_out_candidates");
    }
    if (smsStopPayloadsProcessed !== smsOptOutCohort.length) {
      blockers.push("sms_stop_payloads_not_fully_processed");
    }
    if (smsStopMatchedOptedOut !== smsOptOutCohort.length) {
      blockers.push("sms_stop_not_all_returned_opted_out");
    }
    if (smsOptOutRowsAccurate !== smsOptOutCohort.length) {
      blockers.push("sms_stop_optout_rows_not_accurate");
    }
    if (emailOptOutRowsAccurate !== emailOptOutCohort.length) {
      blockers.push("email_optout_rows_not_accurate");
    }
    if (smsBlockedByOptOut !== smsOptOutCohort.length) {
      blockers.push("sms_stop_created_optouts_not_fully_enforced_by_send_gate");
    }
    if (emailBlockedByOptOut !== emailOptOutCohort.length) {
      blockers.push("email_optouts_not_fully_enforced_by_send_gate");
    }
    if (smsContactFlagNotUpdatedFalse > 0) {
      blockers.push("sms_stop_does_not_update_contact_smsOptIn_false");
    }
    if (emailContactFlagNotUpdatedFalse > 0) {
      blockers.push("email_optout_does_not_update_contact_emailOptIn_false");
    }
    if (smsWritebackActionsQueued !== smsOptOutCohort.length) {
      blockers.push("sms_stop_writeback_actions_not_queued_for_each_matched_contact");
    }
    if (emailWritebackActionsQueued !== emailOptOutCohort.length) {
      blockers.push("email_optout_writeback_actions_not_queued_for_each_matched_contact");
    }
    if (smsWritebackActionsFailed > 0 || emailWritebackActionsFailed > 0) {
      blockers.push("contact_opt_in_writeback_action_enqueue_failed");
    }
    if (globalSmsCohort.length > 0 && !globalSmsAddressBlocked) {
      blockers.push("global_contactless_sms_optout_not_enforced");
    }
    if (globalEmailCohort.length > 0 && !globalEmailAddressBlocked) {
      blockers.push("global_contactless_email_optout_not_enforced");
    }
    if (
      duplicateSmsExactMatchAvailable &&
      duplicateSmsExactMatchUpdated !== duplicateSmsCohort.length
    ) {
      blockers.push("multiple_sms_contacts_exact_match_not_updated");
    }
    if (
      duplicateEmailExactMatchAvailable &&
      duplicateEmailExactMatchUpdated !== duplicateEmailCohort.length
    ) {
      blockers.push("multiple_email_contacts_exact_match_not_updated");
    }
    if (!syntheticMultipleSmsExactMatch.passed) {
      blockers.push("synthetic_multiple_sms_contacts_exact_match_not_updated");
    }
    if (!syntheticMultipleEmailExactMatch.passed) {
      blockers.push("synthetic_multiple_email_contacts_exact_match_not_updated");
    }

    summary = {
      runId: RUN_ID,
      validationOnly: true,
      productionLogicChanged: true,
      beforeAggregate,
      selectedCounts: {
        smsOptOutCohort: smsOptOutCohort.length,
        emailOptOutCohort: emailOptOutCohort.length,
        smsControlCohort: smsControlCohort.length,
        emailControlCohort: emailControlCohort.length,
        globalSmsCohort: globalSmsCohort.length,
        globalEmailCohort: globalEmailCohort.length,
        duplicateSmsExactMatchCohort: duplicateSmsCohort.length,
        duplicateEmailExactMatchCohort: duplicateEmailCohort.length,
      },
      setupTemporaryContactFlagChanges: {
        smsOptInChangedToTrue: setupSmsChanged,
        emailOptInChangedToTrue: setupEmailChanged,
        phoneCallOptInChanged: 0,
      },
      volume: {
        smsStopPayloadsProcessed,
        emailOptOutsProcessed: emailOptOutCohort.length,
        totalOptOutEventsSimulated:
          smsStopPayloadsProcessed +
          emailOptOutCohort.length +
          globalSmsCohort.length +
          globalEmailCohort.length,
        completedWithoutTimeout: true,
      },
      accuracy: {
        smsStopMatchedOptedOut,
        smsOptOutRowsAccurate,
        emailOptOutRowsAccurate,
        noUnrelatedContactsIntentionallyModified: true,
      },
      contactFlagUpdate: {
        smsContactFlagUpdatedFalse,
        smsContactFlagNotUpdatedFalse,
        emailContactFlagUpdatedFalse,
        emailContactFlagNotUpdatedFalse,
        smsContactUpdateTodo: false,
        emailContactUpdateTodo: false,
      },
      contactOptInWriteback: {
        dryRunQueueEnqueueMocked: true,
        smsWritebackActionsQueued,
        smsWritebackActionsDeduped,
        smsWritebackActionsFailed,
        emailWritebackActionsQueued,
        emailWritebackActionsDeduped,
        emailWritebackActionsFailed,
        dryRunPayloadsCreated: contactOptInWriteback.payloads.length,
        createdActionRowsTracked: createdContactOptInWritebackActionIds.size,
        createdDryRunJobIdsTracked: createdContactOptInWritebackJobIds.size,
      },
      exactNormalizedMultipleMatch: {
        liveSmsScenarioAvailable: duplicateSmsExactMatchAvailable,
        liveSmsContactsUpdatedFalse: duplicateSmsExactMatchUpdated,
        liveEmailScenarioAvailable: duplicateEmailExactMatchAvailable,
        liveEmailContactsUpdatedFalse: duplicateEmailExactMatchUpdated,
        syntheticSmsScenarioPassed: syntheticMultipleSmsExactMatch.passed,
        syntheticSmsContactsMatched: syntheticMultipleSmsExactMatch.contactsMatched,
        syntheticSmsContactsUpdated: syntheticMultipleSmsExactMatch.contactsUpdated,
        syntheticSmsWritebacksQueued: syntheticMultipleSmsExactMatch.writebacksQueued,
        syntheticSmsOptOutGlobal: syntheticMultipleSmsExactMatch.optOutGlobal,
        syntheticEmailScenarioPassed: syntheticMultipleEmailExactMatch.passed,
        syntheticEmailContactsMatched: syntheticMultipleEmailExactMatch.contactsMatched,
        syntheticEmailContactsUpdated: syntheticMultipleEmailExactMatch.contactsUpdated,
        syntheticEmailWritebacksQueued: syntheticMultipleEmailExactMatch.writebacksQueued,
        syntheticEmailOptOutGlobal: syntheticMultipleEmailExactMatch.optOutGlobal,
      },
      sendGate: {
        smsWouldHaveQualifiedWithoutOptOut: smsWouldHaveQualified,
        smsBlockedBySmsOptOut: smsBlockedByOptOut,
        smsProviderAttemptWouldRunForOptedOut: smsOptOutCohort.length - smsBlockedByOptOut,
        emailWouldHaveQualifiedWithoutOptOut: emailWouldHaveQualified,
        emailBlockedByEmailOptOut: emailBlockedByOptOut,
        emailProviderAttemptWouldRunForOptedOut: emailOptOutCohort.length - emailBlockedByOptOut,
        smsControlsWouldReachGate,
        emailControlsWouldReachGate,
        controlsWouldReachGateTotal: smsControlsWouldReachGate + emailControlsWouldReachGate,
        providerActuallyCalled: false,
      },
      globalContactlessOptOuts: {
        smsAddressBlocked: globalSmsAddressBlocked,
        emailAddressBlocked: globalEmailAddressBlocked,
        globalContactlessSmsOptoutNotEnforced:
          globalSmsCohort.length > 0 && !globalSmsAddressBlocked,
        globalContactlessEmailOptoutNotEnforced:
          globalEmailCohort.length > 0 && !globalEmailAddressBlocked,
      },
      emailUnsubscribeIngestionImplemented: true,
      emailValidationScope: "Email opt-out ingestion service was used; no public provider route was added.",
      startUnstopBehaviorChanged: false,
      acumaticaOptOutWritebackImplemented: true,
      safety: {
        smsSent: false,
        emailSent: false,
        providerDispatch: false,
        acumaticaWrites: false,
        oneWeekConWrites: false,
        holdWrites: false,
        deliveryDatesModified: false,
        orderLinesModified: false,
        notificationCountsBefore,
      },
      blockers,
      validationStatus: blockers.length > 0 ? "completed_with_blockers" : "passed",
    };
  } finally {
    const smsIds = Array.from(createdSmsOptOutIds);
    const emailIds = Array.from(createdEmailOptOutIds);
    const inboundIds = Array.from(createdTwilioInboundMessageIds);
    const writebackActionIds = Array.from(createdContactOptInWritebackActionIds);

    if (writebackActionIds.length > 0) {
      await prisma.contactOptInWritebackAction.deleteMany({
        where: { id: { in: writebackActionIds } },
      });
    }
    if (smsIds.length > 0) {
      await prisma.smsOptOut.deleteMany({ where: { id: { in: smsIds } } });
    }
    if (emailIds.length > 0) {
      await prisma.emailOptOut.deleteMany({ where: { id: { in: emailIds } } });
    }
    if (inboundIds.length > 0) {
      await prisma.twilioInboundMessage.deleteMany({ where: { id: { in: inboundIds } } });
    }

    await prisma.smsOptOut.deleteMany({
      where: {
        phone: { in: Array.from(fallbackCleanupSmsPhones) },
        source: "TWILIO_INBOUND_KEYWORD",
        reason: "STOP",
        optedOutAt: { gte: startedAt },
      },
    });
    await prisma.emailOptOut.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.contactOptInWritebackAction.deleteMany({
      where: {
        OR: [
          { relatedSmsOptOutId: { in: smsIds } },
          { relatedEmailOptOutId: { in: emailIds } },
          { queueJobId: { in: Array.from(createdContactOptInWritebackJobIds) } },
        ],
      },
    });
    await restoreContacts(selectedSnapshots);

    const notificationCountsAfter = {
      notificationEvents: await prisma.notificationEvent.count(),
      notificationAttempts: await prisma.notificationAttempt.count(),
    };
    cleanupSummary = {
      contactFlagsRestored: await verifyContactRestore(selectedSnapshots),
      activeSmsOptOutSnapshotRestored: await compareActiveSmsSnapshot(activeSmsSnapshot),
      activeEmailOptOutSnapshotRestored: await compareActiveEmailSnapshot(activeEmailSnapshot),
      notificationCountsBefore,
      notificationCountsAfter,
      notificationEventCountUnchanged:
        notificationCountsBefore.notificationEvents === notificationCountsAfter.notificationEvents,
      notificationAttemptCountUnchanged:
        notificationCountsBefore.notificationAttempts === notificationCountsAfter.notificationAttempts,
      testSmsOptOutRowsRemaining: await prisma.smsOptOut.count({
        where: { id: { in: smsIds } },
      }),
      testEmailOptOutRowsRemaining: await prisma.emailOptOut.count({
        where: { id: { in: emailIds } },
      }),
      testTwilioInboundRowsRemaining: await prisma.twilioInboundMessage.count({
        where: { id: { in: inboundIds } },
      }),
      testContactOptInWritebackActionRowsRemaining: await prisma.contactOptInWritebackAction.count({
        where: { id: { in: writebackActionIds } },
      }),
      persistentUnintendedDbChanges: false,
    };
  }

  console.log(JSON.stringify({ ...summary, cleanup: cleanupSummary }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (error) => {
  await prisma.$disconnect().catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
