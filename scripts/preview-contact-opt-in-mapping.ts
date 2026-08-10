import { createAcumaticaClientFromEnv } from "@/lib/acumatica/client/acumaticaClient";
import {
  CONTACT_EMAIL_OPT_IN_FIELD_PATH,
  CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH,
  CONTACT_SMS_OPT_IN_FIELD_PATH,
  getAcumaticaNestedField,
  mapAcumaticaContactOptIns,
} from "@/lib/acumatica/contactOptInFields";
import type { DeliveryErpClient } from "@/lib/erp/erpClient";
import { createQueueErpClientFromEnv } from "@/lib/erp/queueErpClient";
import { prisma } from "@/lib/prisma";

type PreviewCounts = {
  true: number;
  false: number;
};

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

function hasNonNullValue(row: unknown, path: readonly string[]) {
  const value = unwrapValue(getAcumaticaNestedField(row, path));
  return value !== null && value !== undefined && value !== "";
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

function createPreviewClient(): { mode: "direct" | "queue"; client: DeliveryErpClient } {
  if (process.argv.slice(2).includes("--queue")) {
    return {
      mode: "queue",
      client: createQueueErpClientFromEnv(),
    };
  }

  return {
    mode: "direct",
    client: createAcumaticaClientFromEnv(),
  };
}

async function main() {
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

  const { mode, client } = createPreviewClient();
  const proposedSmsOptIn = emptyCounts();
  const proposedEmailOptIn = emptyCounts();
  const proposedPhoneCallOptIn = emptyCounts();

  const currentSmsOptIn = emptyCounts();
  const currentEmailOptIn = emptyCounts();
  const currentPhoneCallOptIn = emptyCounts();

  let fetchSuccesses = 0;
  let fetchFailures = 0;
  let missingContactRows = 0;
  let smsOptInWouldChange = 0;
  let emailOptInWouldChange = 0;
  let phoneCallOptInWouldChange = 0;
  let nonNullSmsSourceValues = 0;
  let nonNullEmailSourceValues = 0;
  let nonNullPhoneCallSourceValues = 0;
  let customContactPresentRows = 0;
  let customContactMissingRows = 0;
  let missingOrNullSmsSourceValues = 0;
  let missingOrNullEmailSourceValues = 0;
  let missingOrNullPhoneCallSourceValues = 0;
  let presentSmsSourceFields = 0;
  let presentEmailSourceFields = 0;
  let presentPhoneCallSourceFields = 0;
  let testContact129387:
    | {
        fetched: boolean;
        hasCustomContact: boolean;
        fieldsPresent: {
          AttributeCONTEXT: boolean;
          AttributeCONEMAIL: boolean;
          AttributeCONPHONE: boolean;
        };
        mapped: {
          smsOptIn: boolean;
          emailOptIn: boolean;
          phoneCallOptIn: boolean;
        };
        mapsTrueTrueTrue: boolean;
      }
    | {
        fetched: false;
      }
    | null = null;

  try {
    for (const contact of contacts) {
      addBooleanCount(currentSmsOptIn, contact.smsOptIn);
      addBooleanCount(currentEmailOptIn, contact.emailOptIn);
      addBooleanCount(currentPhoneCallOptIn, contact.phoneCallOptIn);

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
      const rowHasCustomContact = hasCustomContact(row);
      if (rowHasCustomContact) {
        customContactPresentRows += 1;
      } else {
        customContactMissingRows += 1;
      }

      addBooleanCount(proposedSmsOptIn, proposed.smsOptIn);
      addBooleanCount(proposedEmailOptIn, proposed.emailOptIn);
      addBooleanCount(proposedPhoneCallOptIn, proposed.phoneCallOptIn);

      if (proposed.smsOptIn !== contact.smsOptIn) smsOptInWouldChange += 1;
      if (proposed.emailOptIn !== contact.emailOptIn) emailOptInWouldChange += 1;
      if (proposed.phoneCallOptIn !== contact.phoneCallOptIn) phoneCallOptInWouldChange += 1;

      const smsFieldPresent = hasPath(row, CONTACT_SMS_OPT_IN_FIELD_PATH);
      const emailFieldPresent = hasPath(row, CONTACT_EMAIL_OPT_IN_FIELD_PATH);
      const phoneCallFieldPresent = hasPath(row, CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH);
      const smsFieldNonNull = hasNonNullValue(row, CONTACT_SMS_OPT_IN_FIELD_PATH);
      const emailFieldNonNull = hasNonNullValue(row, CONTACT_EMAIL_OPT_IN_FIELD_PATH);
      const phoneCallFieldNonNull = hasNonNullValue(row, CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH);

      if (smsFieldPresent) presentSmsSourceFields += 1;
      if (emailFieldPresent) presentEmailSourceFields += 1;
      if (phoneCallFieldPresent) presentPhoneCallSourceFields += 1;
      if (smsFieldNonNull) {
        nonNullSmsSourceValues += 1;
      } else {
        missingOrNullSmsSourceValues += 1;
      }
      if (emailFieldNonNull) {
        nonNullEmailSourceValues += 1;
      } else {
        missingOrNullEmailSourceValues += 1;
      }
      if (phoneCallFieldNonNull) {
        nonNullPhoneCallSourceValues += 1;
      } else {
        missingOrNullPhoneCallSourceValues += 1;
      }

      if (contact.contactId === TEST_CONTACT_ID) {
        testContact129387 = {
          fetched: true,
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

    console.log(
      JSON.stringify(
        {
          mode,
          totalContactsChecked: contacts.length,
          fetchSuccesses,
          fetchFailures,
          missingContactRows,
          currentSmsOptIn,
          currentEmailOptIn,
          currentPhoneCallOptIn,
          proposedSmsOptIn,
          proposedEmailOptIn,
          proposedPhoneCallOptIn,
          smsOptInWouldChange,
          emailOptInWouldChange,
          phoneCallOptInWouldChange,
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
          nonNullSourceValues: {
            AttributeCONTEXT: nonNullSmsSourceValues,
            AttributeCONEMAIL: nonNullEmailSourceValues,
            AttributeCONPHONE: nonNullPhoneCallSourceValues,
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
          testContact129387: testContact129387 ?? { fetched: false },
          dbUpdated: false,
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
