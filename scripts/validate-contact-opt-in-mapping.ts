import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CONTACT_EMAIL_OPT_IN_FIELD_PATH,
  CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH,
  CONTACT_SMS_OPT_IN_FIELD_PATH,
  DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
  getAcumaticaCustomBoolean,
  mapAcumaticaContactOptIns,
  parseAcumaticaBoolean,
} from "../lib/acumatica/contactOptInFields";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  assert(
    Object.is(actual, expected),
    `${message}: expected ${String(expected)}, got ${String(actual)}`
  );
}

function assertIncludes(source: string, expected: string, message: string) {
  assert(source.includes(expected), `${message}: expected ${expected}`);
}

function field(value: unknown) {
  return { type: "CustomBooleanField", value };
}

function contact(params: {
  sms?: unknown;
  phone?: unknown;
  email?: unknown;
  doNotEmail?: unknown;
  omitSms?: boolean;
  omitPhone?: boolean;
  omitEmail?: boolean;
}) {
  const contactFields: Record<string, unknown> = {};
  if (!params.omitSms) contactFields.AttributeCONTEXT = field(params.sms ?? null);
  if (!params.omitPhone) contactFields.AttributeCONPHONE = field(params.phone ?? null);
  if (!params.omitEmail) contactFields.AttributeCONEMAIL = field(params.email ?? null);

  return {
    ...(params.doNotEmail === undefined ? {} : { DoNotEmail: { value: params.doNotEmail } }),
    custom: {
      Contact: contactFields,
    },
  };
}

async function main() {
  const trueValues = [true, "true", "1", 1, "yes", "y", "on", " TRUE "];
  const falseValues = [false, "false", "0", 0, "no", "n", "off", " FALSE "];
  const nullValues = [null, undefined, "", " ", "maybe", 2, {}, []];

  for (const value of trueValues) {
    assertEqual(parseAcumaticaBoolean(value), true, `parse true value ${String(value)}`);
    assertEqual(parseAcumaticaBoolean({ value }), true, `parse wrapped true value ${String(value)}`);
  }

  for (const value of falseValues) {
    assertEqual(parseAcumaticaBoolean(value), false, `parse false value ${String(value)}`);
    assertEqual(
      parseAcumaticaBoolean({ value }),
      false,
      `parse wrapped false value ${String(value)}`
    );
  }

  for (const value of nullValues) {
    assertEqual(parseAcumaticaBoolean(value), null, `parse null value ${String(value)}`);
  }

  assertEqual(
    getAcumaticaCustomBoolean(contact({ sms: true }), CONTACT_SMS_OPT_IN_FIELD_PATH),
    true,
    "custom SMS path parses true"
  );
  assertEqual(
    getAcumaticaCustomBoolean(contact({ phone: true }), CONTACT_PHONE_CALL_OPT_IN_FIELD_PATH),
    true,
    "custom phone path parses true"
  );
  assertEqual(
    getAcumaticaCustomBoolean(contact({ email: true }), CONTACT_EMAIL_OPT_IN_FIELD_PATH),
    true,
    "custom email path parses true"
  );

  assertEqual(
    mapAcumaticaContactOptIns(contact({ sms: true })).smsOptIn,
    true,
    "AttributeCONTEXT true maps smsOptIn true"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ sms: false })).smsOptIn,
    false,
    "AttributeCONTEXT false maps smsOptIn false"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ sms: null })).smsOptIn,
    false,
    "AttributeCONTEXT null maps smsOptIn false"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ omitSms: true })).smsOptIn,
    false,
    "missing AttributeCONTEXT maps smsOptIn false"
  );

  assertEqual(
    mapAcumaticaContactOptIns(contact({ phone: true })).phoneCallOptIn,
    true,
    "AttributeCONPHONE true maps phoneCallOptIn true"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ phone: false })).phoneCallOptIn,
    false,
    "AttributeCONPHONE false maps phoneCallOptIn false"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ phone: null })).phoneCallOptIn,
    false,
    "AttributeCONPHONE null maps phoneCallOptIn false"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ omitPhone: true })).phoneCallOptIn,
    false,
    "missing AttributeCONPHONE maps phoneCallOptIn false"
  );

  assertEqual(
    mapAcumaticaContactOptIns(contact({ email: true })).emailOptIn,
    true,
    "AttributeCONEMAIL true maps emailOptIn true"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ email: false })).emailOptIn,
    false,
    "AttributeCONEMAIL false maps emailOptIn false"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ email: null, doNotEmail: false })).emailOptIn,
    true,
    "AttributeCONEMAIL null falls back to DoNotEmail inverse"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ omitEmail: true })).emailOptIn,
    true,
    "missing AttributeCONEMAIL defaults emailOptIn true"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ email: true, doNotEmail: true })).emailOptIn,
    false,
    "DoNotEmail true overrides AttributeCONEMAIL true"
  );

  const projectRoot = path.resolve(__dirname, "..");
  const [
    packageJson,
    directClient,
    importer,
    detectChanges,
    notificationHelper,
  ] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8"),
    readFile(path.join(projectRoot, "lib/acumatica/client/acumaticaClient.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/erp/importSalesOrders.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/erp/detectErpChanges.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/notifications/helpers.ts"), "utf8"),
  ]);

  assertIncludes(
    DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
    "Contact.AttributeCONTEXT,Contact.AttributeCONPHONE,Contact.AttributeCONEMAIL",
    "custom fields use Contact-qualified Acumatica paths"
  );
  assertIncludes(
    directClient,
    "$custom: DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS",
    "direct Contact fetch requests opt-in custom fields"
  );
  assertIncludes(
    importer,
    "mapAcumaticaContactOptIns(contactRecord)",
    "importer maps Contact opt-ins from Acumatica Contact detail"
  );
  assertIncludes(importer, "smsOptIn: importedOptIns?.smsOptIn ?? false", "SMS create default");
  assertIncludes(
    importer,
    "phoneCallOptIn: importedOptIns?.phoneCallOptIn ?? false",
    "phone-call create default"
  );
  assertIncludes(
    importer,
    "smsOptIn: importedOptIns?.smsOptIn ?? undefined",
    "SMS update only when Contact detail fetched"
  );
  assertIncludes(
    importer,
    "phoneCallOptIn: importedOptIns?.phoneCallOptIn ?? undefined",
    "phone-call update only when Contact detail fetched"
  );
  assertIncludes(importer, "where: { contactId }", "upsert remains keyed by ContactID");
  assertIncludes(importer, 'getString(getField(fullOrder, "Email"))', "SalesOrder email fallback");
  assertIncludes(importer, 'getString(getField(fullOrder, "Phone1"))', "SalesOrder phone1 fallback");
  assertIncludes(importer, 'getString(getField(fullOrder, "Phone2"))', "SalesOrder phone2 fallback");
  assertIncludes(
    detectChanges,
    '{ fieldName: "smsOptIn", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED, valueType: "boolean" }',
    "smsOptIn is tracked as a contact change"
  );
  assertIncludes(
    detectChanges,
    'fieldName: "phoneCallOptIn"',
    "phoneCallOptIn is tracked as a contact change"
  );
  assertIncludes(
    notificationHelper,
    "contact.smsOptIn === true",
    "notification selection still uses smsOptIn"
  );
  assertIncludes(
    notificationHelper,
    "contact.emailOptIn !== false",
    "notification selection still uses emailOptIn"
  );
  assertIncludes(
    packageJson,
    "validate:contact-opt-in-mapping",
    "package validation script is registered"
  );
  assertIncludes(
    packageJson,
    "preview:contact-opt-in-mapping",
    "package preview script is registered"
  );

  console.log(
    JSON.stringify(
      {
        parserValuesCovered: trueValues.length + falseValues.length + nullValues.length,
        smsMappingValidated: true,
        emailMappingValidated: true,
        phoneCallMappingValidated: true,
        doNotEmailSafetyOverrideValidated: true,
        directFetchCustomFieldsWired: true,
        contactUpsertOptInUpdateWired: true,
        contactChangeDetectionWired: true,
        notificationChannelSelectionUnchanged: true,
        noSmsEmailProviderSendInvoked: true,
        noAcumaticaWriteInvoked: true,
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
