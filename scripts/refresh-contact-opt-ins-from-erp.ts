import {
  CONTACT_EMAIL_OPT_IN_FIELD_PATH,
  CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH,
  CONTACT_SMS_OPT_IN_FIELD_PATH,
  getAcumaticaNestedField,
  mapAcumaticaContactOptIns,
} from "@/lib/acumatica/contactOptInFields";
import { createQueueErpClientFromEnv } from "@/lib/erp/queueErpClient";
import { prisma } from "@/lib/prisma";

type PreviewCounts = {
  true: number;
  false: number;
};

type ContactOptIns = {
  smsOptIn: boolean;
  emailOptIn: boolean;
  phoneCallOptIn: boolean;
};

type ContactOptInUpdateData = Partial<ContactOptIns>;

type UpdatePlan = {
  contactId: string;
  data: ContactOptInUpdateData;
};

const APPLY_FLAG = "--apply";
const TEST_CONTACT_ID = "129387";

function emptyCounts(): PreviewCounts {
  return { true: 0, false: 0 };
}

function addBooleanCount(counts: PreviewCounts, value: boolean) {
  if (value) {
    counts.true += 1;
  } else {
    counts.false += 1;
  }
}

function unwrapValue(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return (value as { value?: unknown }).value ?? null;
  }
  return value ?? null;
}

function hasPath(row: unknown, path: readonly string[]) {
  let current = row;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

function hasNonNullValue(row: unknown, path: readonly string[]) {
  const value = unwrapValue(getAcumaticaNestedField(row, path));
  return value !== null && value !== undefined && value !== "";
}

function hasCustomContact(row: unknown) {
  const customContact = getAcumaticaNestedField(row, ["custom", "Contact"]);
  return Boolean(customContact && typeof customContact === "object" && !Array.isArray(customContact));
}

function findContactRow(rows: unknown[], contactId: string) {
  return (
    rows.find((row) => {
      const value = unwrapValue(getAcumaticaNestedField(row, ["ContactID"]));
      return String(value ?? "").trim() === contactId;
    }) ??
    rows[0] ??
    null
  );
}

function buildUpdateData(current: ContactOptIns, proposed: ContactOptIns): ContactOptInUpdateData {
  const data: ContactOptInUpdateData = {};
  if (current.smsOptIn !== proposed.smsOptIn) data.smsOptIn = proposed.smsOptIn;
  if (current.emailOptIn !== proposed.emailOptIn) data.emailOptIn = proposed.emailOptIn;
  if (current.phoneCallOptIn !== proposed.phoneCallOptIn) {
    data.phoneCallOptIn = proposed.phoneCallOptIn;
  }
  return data;
}

function hasUpdateData(data: ContactOptInUpdateData) {
  return (
    data.smsOptIn !== undefined ||
    data.emailOptIn !== undefined ||
    data.phoneCallOptIn !== undefined
  );
}

async function notificationCounts() {
  const [events, attempts] = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationAttempt.count(),
  ]);

  return {
    notificationEvents: events,
    notificationAttempts: attempts,
  };
}

async function contactOptInCounts() {
  const contacts = await prisma.contact.findMany({
    select: {
      contactId: true,
      smsOptIn: true,
      emailOptIn: true,
      phoneCallOptIn: true,
    },
    orderBy: {
      contactId: "asc",
    },
  });

  const smsOptIn = emptyCounts();
  const emailOptIn = emptyCounts();
  const phoneCallOptIn = emptyCounts();
  let testContact129387: ContactOptIns | null = null;

  for (const contact of contacts) {
    addBooleanCount(smsOptIn, contact.smsOptIn);
    addBooleanCount(emailOptIn, contact.emailOptIn);
    addBooleanCount(phoneCallOptIn, contact.phoneCallOptIn);
    if (contact.contactId === TEST_CONTACT_ID) {
      testContact129387 = {
        smsOptIn: contact.smsOptIn,
        emailOptIn: contact.emailOptIn,
        phoneCallOptIn: contact.phoneCallOptIn,
      };
    }
  }

  return {
    totalContacts: contacts.length,
    smsOptIn,
    emailOptIn,
    phoneCallOptIn,
    testContact129387,
  };
}

async function main() {
  const apply = process.argv.slice(2).includes(APPLY_FLAG);
  const client = createQueueErpClientFromEnv();
  const notificationCountsBefore = await notificationCounts();
  const contacts = await prisma.contact.findMany({
    select: {
      contactId: true,
      smsOptIn: true,
      emailOptIn: true,
      phoneCallOptIn: true,
    },
    orderBy: {
      contactId: "asc",
    },
  });

  const currentSmsOptIn = emptyCounts();
  const currentEmailOptIn = emptyCounts();
  const currentPhoneCallOptIn = emptyCounts();
  const proposedSmsOptIn = emptyCounts();
  const proposedEmailOptIn = emptyCounts();
  const proposedPhoneCallOptIn = emptyCounts();
  const updatePlans: UpdatePlan[] = [];

  let fetchSuccesses = 0;
  let fetchFailures = 0;
  let missingContactRows = 0;
  let customContactPresentRows = 0;
  let customContactMissingRows = 0;
  let presentSmsSourceFields = 0;
  let presentEmailSourceFields = 0;
  let presentPhoneCallSourceFields = 0;
  let missingOrNullSmsSourceValues = 0;
  let missingOrNullEmailSourceValues = 0;
  let missingOrNullPhoneCallSourceValues = 0;
  let smsOptInWouldChange = 0;
  let emailOptInWouldChange = 0;
  let phoneCallOptInWouldChange = 0;
  let testContact129387:
    | {
        queueFetched: true;
        hasCustomContact: boolean;
        fieldsPresent: {
          AttributeCONTEXT: boolean;
          AttributeCONEMAIL: boolean;
          AttributeCONPHONE: boolean;
        };
        mapped: ContactOptIns;
        mapsTrueTrueTrue: boolean;
      }
    | {
        queueFetched: false;
      }
    | null = null;

  try {
    for (const contact of contacts) {
      const current = {
        smsOptIn: contact.smsOptIn,
        emailOptIn: contact.emailOptIn,
        phoneCallOptIn: contact.phoneCallOptIn,
      };
      addBooleanCount(currentSmsOptIn, current.smsOptIn);
      addBooleanCount(currentEmailOptIn, current.emailOptIn);
      addBooleanCount(currentPhoneCallOptIn, current.phoneCallOptIn);

      let rows: unknown[];
      try {
        rows = await client.fetchDeliveryContactByContactId(contact.contactId);
      } catch {
        fetchFailures += 1;
        continue;
      }

      const row = findContactRow(rows, contact.contactId);
      if (!row) {
        missingContactRows += 1;
        continue;
      }

      fetchSuccesses += 1;
      const proposed = mapAcumaticaContactOptIns(row);
      const updateData = buildUpdateData(current, proposed);

      addBooleanCount(proposedSmsOptIn, proposed.smsOptIn);
      addBooleanCount(proposedEmailOptIn, proposed.emailOptIn);
      addBooleanCount(proposedPhoneCallOptIn, proposed.phoneCallOptIn);

      if (updateData.smsOptIn !== undefined) smsOptInWouldChange += 1;
      if (updateData.emailOptIn !== undefined) emailOptInWouldChange += 1;
      if (updateData.phoneCallOptIn !== undefined) phoneCallOptInWouldChange += 1;
      if (hasUpdateData(updateData)) {
        updatePlans.push({
          contactId: contact.contactId,
          data: updateData,
        });
      }

      const rowHasCustomContact = hasCustomContact(row);
      if (rowHasCustomContact) {
        customContactPresentRows += 1;
      } else {
        customContactMissingRows += 1;
      }

      const smsFieldPresent = hasPath(row, CONTACT_SMS_OPT_IN_FIELD_PATH);
      const emailFieldPresent = hasPath(row, CONTACT_EMAIL_OPT_IN_FIELD_PATH);
      const phoneCallFieldPresent = hasPath(row, CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH);
      if (smsFieldPresent) presentSmsSourceFields += 1;
      if (emailFieldPresent) presentEmailSourceFields += 1;
      if (phoneCallFieldPresent) presentPhoneCallSourceFields += 1;
      if (!hasNonNullValue(row, CONTACT_SMS_OPT_IN_FIELD_PATH)) missingOrNullSmsSourceValues += 1;
      if (!hasNonNullValue(row, CONTACT_EMAIL_OPT_IN_FIELD_PATH)) {
        missingOrNullEmailSourceValues += 1;
      }
      if (!hasNonNullValue(row, CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH)) {
        missingOrNullPhoneCallSourceValues += 1;
      }

      if (contact.contactId === TEST_CONTACT_ID) {
        testContact129387 = {
          queueFetched: true,
          hasCustomContact: rowHasCustomContact,
          fieldsPresent: {
            AttributeCONTEXT: smsFieldPresent,
            AttributeCONEMAIL: emailFieldPresent,
            AttributeCONPHONE: phoneCallFieldPresent,
          },
          mapped: proposed,
          mapsTrueTrueTrue:
            proposed.smsOptIn === true &&
            proposed.emailOptIn === true &&
            proposed.phoneCallOptIn === true,
        };
      }
    }

    const skippedOrErrorCount = fetchFailures + missingContactRows;
    if (apply && skippedOrErrorCount > 0) {
      throw new Error(
        `Refusing to apply contact opt-in refresh with skipped/error count ${skippedOrErrorCount}`
      );
    }

    let contactsUpdated = 0;
    if (apply && updatePlans.length > 0) {
      await prisma.$transaction(
        updatePlans.map((plan) =>
          prisma.contact.update({
            where: { contactId: plan.contactId },
            data: plan.data,
          })
        )
      );
      contactsUpdated = updatePlans.length;
    }

    const [finalStoredAggregate, notificationCountsAfter] = await Promise.all([
      contactOptInCounts(),
      notificationCounts(),
    ]);

    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "preview",
          applyRequiredFlag: APPLY_FLAG,
          contactsChecked: contacts.length,
          fetchSuccesses,
          fetchFailures,
          missingContactRows,
          skippedOrErrorCount,
          currentSmsOptIn,
          currentEmailOptIn,
          currentPhoneCallOptIn,
          proposedSmsOptIn,
          proposedEmailOptIn,
          proposedPhoneCallOptIn,
          wouldChangeCounts: {
            smsOptIn: smsOptInWouldChange,
            emailOptIn: emailOptInWouldChange,
            phoneCallOptIn: phoneCallOptInWouldChange,
            contactRows: updatePlans.length,
          },
          updatedCounts: {
            smsOptIn: apply ? smsOptInWouldChange : 0,
            emailOptIn: apply ? emailOptInWouldChange : 0,
            phoneCallOptIn: apply ? phoneCallOptInWouldChange : 0,
            contactRows: contactsUpdated,
          },
          finalStoredAggregate,
          customContactRows: {
            present: customContactPresentRows,
            missing: customContactMissingRows,
            allFetchedRowsHaveCustomContact:
              fetchSuccesses > 0 && customContactMissingRows === 0,
          },
          sourceFieldPresence: {
            AttributeCONTEXT: presentSmsSourceFields,
            AttributeCONEMAIL: presentEmailSourceFields,
            AttributeCONPHONE: presentPhoneCallSourceFields,
            allFetchedRowsHaveAllThreeFields:
              fetchSuccesses > 0 &&
              presentSmsSourceFields === fetchSuccesses &&
              presentEmailSourceFields === fetchSuccesses &&
              presentPhoneCallSourceFields === fetchSuccesses,
          },
          missingOrNullSourceValues: {
            AttributeCONTEXT: missingOrNullSmsSourceValues,
            AttributeCONEMAIL: missingOrNullEmailSourceValues,
            AttributeCONPHONE: missingOrNullPhoneCallSourceValues,
            anyMissingOrNull:
              missingOrNullSmsSourceValues > 0 ||
              missingOrNullEmailSourceValues > 0 ||
              missingOrNullPhoneCallSourceValues > 0,
          },
          testContact129387: testContact129387 ?? { queueFetched: false },
          notificationCountsChanged:
            notificationCountsBefore.notificationEvents !==
              notificationCountsAfter.notificationEvents ||
            notificationCountsBefore.notificationAttempts !==
              notificationCountsAfter.notificationAttempts,
          notificationCountsBefore,
          notificationCountsAfter,
          contactOptInFieldsOnly: true,
          lastSyncedAtUpdated: false,
          acumaticaWrites: false,
          notificationSends: false,
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  await prisma.$disconnect().catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
