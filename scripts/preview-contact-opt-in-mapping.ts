import { createAcumaticaClientFromEnv } from "@/lib/acumatica/client/acumaticaClient";
import {
  CONTACT_EMAIL_OPT_IN_FIELD_PATH,
  CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH,
  CONTACT_SMS_OPT_IN_FIELD_PATH,
  getAcumaticaNestedField,
  mapAcumaticaContactOptIns,
} from "@/lib/acumatica/contactOptInFields";
import { prisma } from "@/lib/prisma";

type PreviewCounts = {
  true: number;
  false: number;
};

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

  const client = createAcumaticaClientFromEnv();
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

      addBooleanCount(proposedSmsOptIn, proposed.smsOptIn);
      addBooleanCount(proposedEmailOptIn, proposed.emailOptIn);
      addBooleanCount(proposedPhoneCallOptIn, proposed.phoneCallOptIn);

      if (proposed.smsOptIn !== contact.smsOptIn) smsOptInWouldChange += 1;
      if (proposed.emailOptIn !== contact.emailOptIn) emailOptInWouldChange += 1;
      if (proposed.phoneCallOptIn !== contact.phoneCallOptIn) phoneCallOptInWouldChange += 1;

      if (hasNonNullValue(row, CONTACT_SMS_OPT_IN_FIELD_PATH)) nonNullSmsSourceValues += 1;
      if (hasNonNullValue(row, CONTACT_EMAIL_OPT_IN_FIELD_PATH)) nonNullEmailSourceValues += 1;
      if (hasNonNullValue(row, CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH)) {
        nonNullPhoneCallSourceValues += 1;
      }
    }

    console.log(
      JSON.stringify(
        {
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
          nonNullSourceValues: {
            AttributeCONTEXT: nonNullSmsSourceValues,
            AttributeCONEMAIL: nonNullEmailSourceValues,
            AttributeCONPHONE: nonNullPhoneCallSourceValues,
          },
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
