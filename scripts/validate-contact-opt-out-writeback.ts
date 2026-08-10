import {
  ContactOptInWritebackChannel,
  ContactOptInWritebackStatus,
} from "@/lib/generated/prisma/client";
import {
  recordAndEnqueueContactOptInWriteback,
  selectNotificationChannelWithOptOutRepair,
} from "@/lib/notifications/contactOptInWritebackActions";
import {
  buildContactOptInWritebackPayload,
  type EnqueueContactOptInWritebackParams,
  type EnqueueContactOptInWritebackResult,
} from "@/lib/notifications/contactOptInWritebackQueue";
import { selectNotificationChannel } from "@/lib/notifications/helpers";

type FakeContact = {
  contactId: string;
  phone1: string | null;
  phone2: string | null;
  email: string | null;
  smsOptIn: boolean;
  emailOptIn: boolean;
  phoneCallOptIn: boolean;
};

type FakeAction = {
  id: string;
  dedupeKey: string;
  contactId: string;
  channel: ContactOptInWritebackChannel;
  targetField: string;
  targetValue: boolean;
  source: string;
  reason: string;
  status: ContactOptInWritebackStatus;
  queueJobId: string | null;
  errorMessage: string | null;
  resultSummary: unknown;
  relatedSmsOptOutId: string | null;
  relatedEmailOptOutId: string | null;
  queuedAt: Date | null;
  completedAt: Date | null;
};

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function selectRecord<T extends Record<string, unknown>>(
  record: T,
  select?: Record<string, boolean>
) {
  if (!select) return record;
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, include]) => include)
      .map(([key]) => [key, record[key]])
  );
}

function createFakeEnqueue(options: { fail?: boolean } = {}) {
  const payloads: Array<ReturnType<typeof buildContactOptInWritebackPayload>> = [];
  const enqueue = async (
    params: EnqueueContactOptInWritebackParams
  ): Promise<EnqueueContactOptInWritebackResult> => {
    if (options.fail) throw new Error("synthetic queue failure");
    const payload = buildContactOptInWritebackPayload({ ...params, dryRun: true });
    payloads.push(payload);
    return {
      jobId: `dry-run-contact-opt-in-${String(payloads.length).padStart(3, "0")}`,
      payload,
    };
  };

  return { enqueue, payloads };
}

function createFakeClient(contacts: FakeContact[]) {
  const actions: FakeAction[] = [];
  const client = {
    contact: {
      findMany: async (args: { select?: Record<string, boolean> }) =>
        contacts.map((contact) =>
          selectRecord(contact as unknown as Record<string, unknown>, args.select)
        ),
      updateMany: async (args: {
        where: { contactId: { in: string[] } };
        data: { smsOptIn?: false; emailOptIn?: false };
      }) => {
        let count = 0;
        for (const contact of contacts) {
          if (!args.where.contactId.in.includes(contact.contactId)) continue;
          if (args.data.smsOptIn !== undefined) contact.smsOptIn = args.data.smsOptIn;
          if (args.data.emailOptIn !== undefined) contact.emailOptIn = args.data.emailOptIn;
          count += 1;
        }
        return { count };
      },
    },
    contactOptInWritebackAction: {
      findUnique: async (args: { where: { dedupeKey: string }; select?: Record<string, boolean> }) => {
        const action = actions.find((row) => row.dedupeKey === args.where.dedupeKey) ?? null;
        return action ? selectRecord(action as unknown as Record<string, unknown>, args.select) : null;
      },
      create: async (args: { data: Omit<FakeAction, "id" | "queueJobId" | "errorMessage" | "resultSummary" | "queuedAt" | "completedAt"> & Partial<FakeAction>; select?: Record<string, boolean> }) => {
        const action: FakeAction = {
          id: `action-${actions.length + 1}`,
          dedupeKey: args.data.dedupeKey,
          contactId: args.data.contactId,
          channel: args.data.channel,
          targetField: args.data.targetField,
          targetValue: args.data.targetValue,
          source: args.data.source,
          reason: args.data.reason,
          status: args.data.status,
          queueJobId: null,
          errorMessage: null,
          resultSummary: null,
          relatedSmsOptOutId: args.data.relatedSmsOptOutId ?? null,
          relatedEmailOptOutId: args.data.relatedEmailOptOutId ?? null,
          queuedAt: null,
          completedAt: null,
        };
        actions.push(action);
        return selectRecord(action as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<FakeAction>; select?: Record<string, boolean> }) => {
        const action = actions.find((row) => row.id === args.where.id);
        if (!action) throw new Error("missing synthetic writeback action");
        Object.assign(action, args.data);
        return selectRecord(action as unknown as Record<string, unknown>, args.select);
      },
    },
  };

  return { client, contacts, actions };
}

function payloadsContainNoTrueValues(payloads: unknown[]) {
  const serialized = JSON.stringify(payloads);
  return (
    !serialized.includes("\"smsOptIn\":true") &&
    !serialized.includes("\"emailOptIn\":true") &&
    !serialized.includes("\"phoneCallOptIn\":true") &&
    !serialized.includes("\"value\":true")
  );
}

async function main() {
  const failures: string[] = [];

  const phoneOnly = selectNotificationChannel({
    smsOptIn: false,
    emailOptIn: false,
    phoneCallOptIn: true,
    phone1: "801-555-0101",
    email: "phone-only@example.test",
  });
  assert(phoneOnly.selectedChannel === null, "phone-call-only contact gets no automated channel", failures);

  const smsControl = selectNotificationChannel({
    smsOptIn: true,
    emailOptIn: false,
    phone1: "801-555-0102",
    email: null,
  });
  assert(smsControl.selectedChannel === "SMS", "SMS true/no opt-out reaches dry-run send gate", failures);

  const emailControl = selectNotificationChannel({
    smsOptIn: false,
    emailOptIn: true,
    phone1: null,
    email: "email-control@example.test",
  });
  assert(emailControl.selectedChannel === "EMAIL", "email true/no opt-out reaches dry-run send gate", failures);

  const smsOptedOut = createFakeClient([
    {
      contactId: "contact-sms-opted-out",
      phone1: "801-555-0200",
      phone2: null,
      email: null,
      smsOptIn: true,
      emailOptIn: false,
      phoneCallOptIn: false,
    },
  ]);
  const smsQueue = createFakeEnqueue();
  const smsRepair = await selectNotificationChannelWithOptOutRepair({
    client: smsOptedOut.client,
    contact: smsOptedOut.contacts[0],
    optOutState: { activeSmsOptOutPhones: ["8015550200"] },
    dispatchOptions: { enqueue: smsQueue.enqueue },
  });
  assert(smsRepair.channel.selectedChannel === null, "SMS opted-out phone is not selected", failures);
  assert(smsOptedOut.contacts[0].smsOptIn === false, "SMS opted-out contact is repaired false locally", failures);
  assert(smsRepair.smsWritebacksQueued === 1, "SMS false writeback is queued dry-run", failures);

  const emailOptedOut = createFakeClient([
    {
      contactId: "contact-email-opted-out",
      phone1: null,
      phone2: null,
      email: "Email.Opted.Out@example.test",
      smsOptIn: false,
      emailOptIn: true,
      phoneCallOptIn: false,
    },
  ]);
  const emailQueue = createFakeEnqueue();
  const emailRepair = await selectNotificationChannelWithOptOutRepair({
    client: emailOptedOut.client,
    contact: emailOptedOut.contacts[0],
    optOutState: { activeEmailOptOutEmails: ["email.opted.out@example.test"] },
    dispatchOptions: { enqueue: emailQueue.enqueue },
  });
  assert(emailRepair.channel.selectedChannel === null, "email opted-out address is not selected", failures);
  assert(emailOptedOut.contacts[0].emailOptIn === false, "email opted-out contact is repaired false locally", failures);
  assert(emailRepair.emailWritebacksQueued === 1, "email false writeback is queued dry-run", failures);

  const smsFallback = createFakeClient([
    {
      contactId: "contact-sms-fallback",
      phone1: "801-555-0300",
      phone2: null,
      email: "sms-fallback@example.test",
      smsOptIn: true,
      emailOptIn: true,
      phoneCallOptIn: false,
    },
  ]);
  const smsFallbackQueue = createFakeEnqueue();
  const fallbackRepair = await selectNotificationChannelWithOptOutRepair({
    client: smsFallback.client,
    contact: smsFallback.contacts[0],
    optOutState: { activeSmsOptOutPhones: ["8015550300"] },
    dispatchOptions: { enqueue: smsFallbackQueue.enqueue },
  });
  assert(fallbackRepair.channel.selectedChannel === "EMAIL", "email fallback is allowed when only SMS is opted out", failures);
  assert(smsFallback.contacts[0].smsOptIn === false, "SMS fallback scenario repairs smsOptIn false", failures);
  assert(smsFallback.contacts[0].emailOptIn === true, "SMS fallback scenario leaves emailOptIn true", failures);
  assert(fallbackRepair.smsWritebacksQueued === 1, "SMS fallback queues SMS false writeback", failures);

  const bothOptedOut = createFakeClient([
    {
      contactId: "contact-both-opted-out",
      phone1: "801-555-0400",
      phone2: null,
      email: "both-opted-out@example.test",
      smsOptIn: true,
      emailOptIn: true,
      phoneCallOptIn: false,
    },
  ]);
  const bothQueue = createFakeEnqueue();
  const bothRepair = await selectNotificationChannelWithOptOutRepair({
    client: bothOptedOut.client,
    contact: bothOptedOut.contacts[0],
    optOutState: {
      activeSmsOptOutPhones: ["8015550400"],
      activeEmailOptOutEmails: ["both-opted-out@example.test"],
    },
    dispatchOptions: { enqueue: bothQueue.enqueue },
  });
  assert(bothRepair.channel.selectedChannel === null, "both opted out selects no automated channel", failures);
  assert(bothOptedOut.contacts[0].smsOptIn === false, "both opted out repairs smsOptIn false", failures);
  assert(bothOptedOut.contacts[0].emailOptIn === false, "both opted out repairs emailOptIn false", failures);
  assert(bothRepair.smsWritebacksQueued === 1 && bothRepair.emailWritebacksQueued === 1, "both opted out queues both false writebacks", failures);

  const globalSms = createFakeClient([
    {
      contactId: "contact-global-sms",
      phone1: "801-555-0500",
      phone2: null,
      email: null,
      smsOptIn: true,
      emailOptIn: false,
      phoneCallOptIn: false,
    },
  ]);
  const globalSmsQueue = createFakeEnqueue();
  const globalSmsRepair = await selectNotificationChannelWithOptOutRepair({
    client: globalSms.client,
    contact: globalSms.contacts[0],
    optOutState: { activeSmsOptOutPhones: ["8015550500"] },
    dispatchOptions: { enqueue: globalSmsQueue.enqueue },
  });
  assert(globalSmsRepair.channel.selectedChannel === null, "contactless/global SMS opt-out blocks", failures);
  assert(globalSmsRepair.smsContactsMatched === 1, "global SMS opt-out repairs identifiable contact", failures);
  assert(globalSmsRepair.smsWritebacksQueued === 1, "global SMS opt-out queues matching contact writeback", failures);

  const globalEmail = createFakeClient([
    {
      contactId: "contact-global-email",
      phone1: null,
      phone2: null,
      email: "global-email@example.test",
      smsOptIn: false,
      emailOptIn: true,
      phoneCallOptIn: false,
    },
  ]);
  const globalEmailQueue = createFakeEnqueue();
  const globalEmailRepair = await selectNotificationChannelWithOptOutRepair({
    client: globalEmail.client,
    contact: globalEmail.contacts[0],
    optOutState: { activeEmailOptOutEmails: ["global-email@example.test"] },
    dispatchOptions: { enqueue: globalEmailQueue.enqueue },
  });
  assert(globalEmailRepair.channel.selectedChannel === null, "contactless/global email opt-out blocks", failures);
  assert(globalEmailRepair.emailContactsMatched === 1, "global email opt-out repairs identifiable contact", failures);
  assert(globalEmailRepair.emailWritebacksQueued === 1, "global email opt-out queues matching contact writeback", failures);

  const noMatchSms = createFakeClient([]);
  const noMatchSmsQueue = createFakeEnqueue();
  const noMatchSmsRepair = await selectNotificationChannelWithOptOutRepair({
    client: noMatchSms.client,
    contact: {
      contactId: null,
      phone1: "801-555-0600",
      phone2: null,
      email: null,
      smsOptIn: true,
      emailOptIn: false,
    },
    optOutState: { activeSmsOptOutPhones: ["8015550600"] },
    dispatchOptions: { enqueue: noMatchSmsQueue.enqueue },
  });
  assert(noMatchSmsRepair.channel.selectedChannel === null, "global SMS no-match still blocks", failures);
  assert(noMatchSmsRepair.smsContactsMatched === 0, "global SMS no-match finds no contacts", failures);
  assert(noMatchSmsRepair.smsWritebacksQueued === 0, "global SMS no-match does not enqueue writeback", failures);

  const noMatchEmail = createFakeClient([]);
  const noMatchEmailQueue = createFakeEnqueue();
  const noMatchEmailRepair = await selectNotificationChannelWithOptOutRepair({
    client: noMatchEmail.client,
    contact: {
      contactId: null,
      phone1: null,
      phone2: null,
      email: "no-match@example.test",
      smsOptIn: false,
      emailOptIn: true,
    },
    optOutState: { activeEmailOptOutEmails: ["no-match@example.test"] },
    dispatchOptions: { enqueue: noMatchEmailQueue.enqueue },
  });
  assert(noMatchEmailRepair.channel.selectedChannel === null, "global email no-match still blocks", failures);
  assert(noMatchEmailRepair.emailContactsMatched === 0, "global email no-match finds no contacts", failures);
  assert(noMatchEmailRepair.emailWritebacksQueued === 0, "global email no-match does not enqueue writeback", failures);

  const repeat = createFakeClient([]);
  const repeatQueue = createFakeEnqueue();
  const first = await recordAndEnqueueContactOptInWriteback({
    client: repeat.client,
    contactId: "repeat-contact",
    channel: ContactOptInWritebackChannel.SMS,
    target: "smsOptIn",
    source: "twilio_stop",
    reason: "customer_sms_opt_out",
    dispatchOptions: { enqueue: repeatQueue.enqueue },
  });
  const second = await recordAndEnqueueContactOptInWriteback({
    client: repeat.client,
    contactId: "repeat-contact",
    channel: ContactOptInWritebackChannel.SMS,
    target: "smsOptIn",
    source: "twilio_stop",
    reason: "customer_sms_opt_out",
    dispatchOptions: { enqueue: repeatQueue.enqueue },
  });
  assert(first.status === "queued", "first repeat scenario queues writeback", failures);
  assert(second.status === "deduped", "repeat scenario dedupes existing action", failures);
  assert(repeat.actions.length === 1, "repeat scenario stores one active action", failures);
  assert(repeatQueue.payloads.length === 1, "repeat scenario enqueues one job", failures);

  const failingWriteback = createFakeClient([
    {
      contactId: "contact-failing-writeback",
      phone1: "801-555-0700",
      phone2: null,
      email: null,
      smsOptIn: true,
      emailOptIn: false,
      phoneCallOptIn: false,
    },
  ]);
  const failingRepair = await selectNotificationChannelWithOptOutRepair({
    client: failingWriteback.client,
    contact: failingWriteback.contacts[0],
    optOutState: { activeSmsOptOutPhones: ["8015550700"] },
    dispatchOptions: { enqueue: createFakeEnqueue({ fail: true }).enqueue },
  });
  assert(failingRepair.channel.selectedChannel === null, "writeback failure still blocks opted-out SMS", failures);
  assert(failingWriteback.contacts[0].smsOptIn === false, "writeback failure still repairs local smsOptIn false", failures);
  assert(failingRepair.smsWritebackFailures === 1, "writeback failure is counted", failures);
  assert(failingWriteback.actions[0]?.status === ContactOptInWritebackStatus.FAILED, "failed writeback action is recorded", failures);

  const allPayloads = [
    ...smsQueue.payloads,
    ...emailQueue.payloads,
    ...smsFallbackQueue.payloads,
    ...bothQueue.payloads,
    ...globalSmsQueue.payloads,
    ...globalEmailQueue.payloads,
    ...repeatQueue.payloads,
  ];
  assert(allPayloads.every((payload) => payload.dryRun === true), "all synthetic writeback payloads are dry-run", failures);
  assert(payloadsContainNoTrueValues(allPayloads), "synthetic writeback payloads contain no true values", failures);
  assert(!JSON.stringify(allPayloads).includes("DoNotEmail"), "synthetic writeback payloads do not include DoNotEmail", failures);

  if (failures.length > 0) {
    console.error("Contact opt-out writeback validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        validationStatus: "passed",
        providerActuallyCalled: false,
        acumaticaWrites: false,
        oneWeekConWrites: false,
        holdWrites: false,
        deliveryDatesModified: false,
        orderLinesModified: false,
        scenarios: {
          phoneCallOnlyNoAutomatedNotification: true,
          smsTrueNoOptOutWouldReachDryRunGate: true,
          smsTrueOptOutBlocksRepairsAndQueues: true,
          emailTrueNoOptOutWouldReachDryRunGate: true,
          emailTrueOptOutBlocksRepairsAndQueues: true,
          smsOptedOutEmailFallbackAllowed: true,
          bothOptedOutBlocksBothAndQueuesBoth: true,
          globalSmsOptOutBlocksAndRepairsMatchingContact: true,
          globalEmailOptOutBlocksAndRepairsMatchingContact: true,
          noMatchGlobalOptOutBlocksWithoutWriteback: true,
          repeatOptOutDedupesWritebackAction: true,
          writebackFailureDoesNotUnblockSend: true,
        },
        writebackPayloadsCreated: allPayloads.length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
