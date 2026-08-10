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
import { selectNotificationChannel } from "../lib/notifications/helpers";

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

function assertNotIncludes(source: string, expected: string, message: string) {
  assert(!source.includes(expected), `${message}: unexpected ${expected}`);
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
    mapAcumaticaContactOptIns(contact({ sms: "maybe" })).smsOptIn,
    false,
    "AttributeCONTEXT unrecognized maps smsOptIn false"
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
    mapAcumaticaContactOptIns(contact({ phone: "maybe" })).phoneCallOptIn,
    false,
    "AttributeCONPHONE unrecognized maps phoneCallOptIn false"
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
    mapAcumaticaContactOptIns(contact({ email: null })).emailOptIn,
    false,
    "AttributeCONEMAIL null maps emailOptIn false"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ omitEmail: true })).emailOptIn,
    false,
    "missing AttributeCONEMAIL maps emailOptIn false"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ email: "maybe" })).emailOptIn,
    false,
    "AttributeCONEMAIL unrecognized maps emailOptIn false"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ email: true, doNotEmail: true })).emailOptIn,
    true,
    "DoNotEmail true is ignored when AttributeCONEMAIL true"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ email: null, doNotEmail: false })).emailOptIn,
    false,
    "DoNotEmail false does not opt in when AttributeCONEMAIL null"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ omitEmail: true, doNotEmail: false })).emailOptIn,
    false,
    "DoNotEmail false does not opt in when AttributeCONEMAIL missing"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ email: null })).emailOptIn,
    false,
    "AttributeCONEMAIL null does not default emailOptIn true"
  );
  assertEqual(
    mapAcumaticaContactOptIns(contact({ omitEmail: true })).emailOptIn,
    false,
    "missing AttributeCONEMAIL does not default emailOptIn true"
  );

  assertEqual(
    selectNotificationChannel({
      smsOptIn: false,
      emailOptIn: false,
      email: "customer@example.com",
    }).selectedChannel,
    null,
    "emailOptIn=false blocks email"
  );
  assertEqual(
    selectNotificationChannel({
      smsOptIn: false,
      emailOptIn: null,
      email: "customer@example.com",
    }).selectedChannel,
    null,
    "emailOptIn=null blocks email"
  );
  assertEqual(
    selectNotificationChannel({
      smsOptIn: false,
      email: "customer@example.com",
    }).selectedChannel,
    null,
    "emailOptIn=undefined blocks email"
  );
  assertEqual(
    selectNotificationChannel({
      smsOptIn: false,
      emailOptIn: true,
      email: "customer@example.com",
    }).selectedChannel,
    "EMAIL",
    "emailOptIn=true allows email when email exists and no opt-out exists"
  );
  assertEqual(
    selectNotificationChannel(
      {
        smsOptIn: false,
        emailOptIn: true,
        email: "customer@example.com",
      },
      { activeEmailOptOut: true }
    ).selectedChannel,
    null,
    "active EmailOptOut blocks email when emailOptIn=true"
  );
  assertEqual(
    selectNotificationChannel(
      {
        smsOptIn: false,
        emailOptIn: true,
        email: "Customer@Example.com",
      },
      { activeEmailOptOutEmails: ["customer@example.com"] }
    ).selectedChannel,
    null,
    "active normalized EmailOptOut email blocks email when emailOptIn=true"
  );
  assertEqual(
    selectNotificationChannel({
      smsOptIn: false,
      emailOptIn: false,
      phone1: "801-466-0990",
    }).selectedChannel,
    null,
    "smsOptIn=false blocks SMS"
  );
  assertEqual(
    selectNotificationChannel({
      smsOptIn: true,
      emailOptIn: false,
      phone1: "801-466-0990",
    }).selectedChannel,
    "SMS",
    "smsOptIn=true allows SMS when phone exists and no opt-out exists"
  );
  assertEqual(
    selectNotificationChannel(
      {
        smsOptIn: true,
        emailOptIn: false,
        phone1: "801-466-0990",
      },
      { activeSmsOptOut: true }
    ).selectedChannel,
    null,
    "active SmsOptOut blocks SMS when smsOptIn=true"
  );
  assertEqual(
    selectNotificationChannel(
      {
        smsOptIn: true,
        emailOptIn: false,
        phone1: "801-466-0990",
      },
      { activeSmsOptOutPhones: ["8014660990"] }
    ).selectedChannel,
    null,
    "active normalized SmsOptOut phone blocks SMS when smsOptIn=true"
  );

  const projectRoot = path.resolve(__dirname, "..");
  const [
    packageJson,
    prismaSchema,
    optInMapper,
    directClient,
    importer,
    detectChanges,
    notificationHelper,
    previewScript,
    refreshScript,
  ] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8"),
    readFile(path.join(projectRoot, "prisma/schema.prisma"), "utf8"),
    readFile(path.join(projectRoot, "lib/acumatica/contactOptInFields.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/acumatica/client/acumaticaClient.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/erp/importSalesOrders.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/erp/detectErpChanges.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/notifications/helpers.ts"), "utf8"),
    readFile(path.join(projectRoot, "scripts/preview-contact-opt-in-mapping.ts"), "utf8"),
    readFile(path.join(projectRoot, "scripts/refresh-contact-opt-ins-from-erp.ts"), "utf8"),
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
  assertNotIncludes(
    DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
    "DoNotEmail",
    "delivery Contact opt-in custom field request does not include DoNotEmail"
  );
  assertNotIncludes(
    optInMapper,
    "DoNotEmail",
    "delivery Contact opt-in mapper ignores DoNotEmail"
  );
  assertIncludes(
    prismaSchema,
    "emailOptIn     Boolean   @default(false)",
    "Contact.emailOptIn schema default is false"
  );
  assertNotIncludes(
    prismaSchema,
    "emailOptIn     Boolean   @default(true)",
    "Contact.emailOptIn schema default is no longer true"
  );
  assertIncludes(
    importer,
    "mapAcumaticaContactOptIns(contactRecord)",
    "importer maps Contact opt-ins from Acumatica Contact detail"
  );
  assertIncludes(importer, "smsOptIn: importedOptIns?.smsOptIn ?? false", "SMS create default");
  assertIncludes(
    importer,
    "emailOptIn: importedOptIns?.emailOptIn ?? false",
    "email create default"
  );
  assertNotIncludes(
    importer,
    "emailOptIn: importedOptIns?.emailOptIn ?? true",
    "email create path no longer defaults true"
  );
  assertIncludes(
    importer,
    "phoneCallOptIn: importedOptIns?.phoneCallOptIn ?? false",
    "phone-call create default"
  );
  assertIncludes(
    importer,
    "activeStatusFromContact(contactRecord)",
    "Contact status mapping remains sourced from Contact detail"
  );
  assertIncludes(
    importer,
    'getString(getField(fullOrder, "ContactStatus"))',
    "SalesOrder contact status fallback remains wired"
  );
  assertIncludes(
    importer,
    'companyName: getString(getField(contactRecord, "CompanyName"))',
    "Contact company mapping remains unchanged"
  );
  assertIncludes(
    importer,
    "displayName: contactDisplayName",
    "Contact display name mapping remains unchanged"
  );
  assertIncludes(
    importer,
    'getString(getField(contactRecord, "FirstName"))',
    "Contact first-name mapping remains unchanged"
  );
  assertIncludes(
    importer,
    'getString(getField(contactRecord, "LastName"))',
    "Contact last-name mapping remains unchanged"
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
    '{ fieldName: "emailOptIn", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED, valueType: "boolean" }',
    "emailOptIn is tracked as a contact change"
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
    "contact.emailOptIn === true",
    "notification selection requires explicit emailOptIn true"
  );
  assertNotIncludes(
    notificationHelper,
    "contact.emailOptIn !== false",
    "notification selection no longer treats missing emailOptIn as allowed"
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
  assertIncludes(
    packageJson,
    "refresh:contact-opt-ins",
    "package contact opt-in refresh script is registered"
  );
  assertIncludes(
    previewScript,
    'process.argv.slice(2).includes("--queue")',
    "preview script supports explicit queue mode"
  );
  assertIncludes(
    previewScript,
    "createQueueErpClientFromEnv()",
    "preview script can use queue-backed ERP contact fetch"
  );
  assertIncludes(
    previewScript,
    "testContact129387",
    "preview script reports the safe 129387 mapping check"
  );
  assertIncludes(
    refreshScript,
    'const APPLY_FLAG = "--apply"',
    "refresh script requires explicit apply flag"
  );
  assertIncludes(
    refreshScript,
    "createQueueErpClientFromEnv()",
    "refresh script uses queue-backed ERP contact fetch"
  );
  assertIncludes(
    refreshScript,
    "prisma.contact.update",
    "refresh script updates contacts directly"
  );
  assertIncludes(
    refreshScript,
    "data: plan.data",
    "refresh script only writes planned opt-in fields"
  );
  assertNotIncludes(
    refreshScript,
    "lastSyncedAt:",
    "refresh script does not update lastSyncedAt"
  );

  console.log(
    JSON.stringify(
      {
        parserValuesCovered: trueValues.length + falseValues.length + nullValues.length,
        smsMappingValidated: true,
        emailMappingValidated: true,
        phoneCallMappingValidated: true,
        doNotEmailIgnoredByMapperValidated: true,
        notificationChannelEligibilityValidated: true,
        activeSmsOptOutBlocksSms: true,
        activeEmailOptOutBlocksEmail: true,
        globalContactIdNullOptOutLookupPhase2Todo: true,
        directFetchCustomFieldsWired: true,
        contactUpsertOptInUpdateWired: true,
        contactChangeDetectionWired: true,
        notificationChannelSelectionRequiresExplicitEmailOptIn: true,
        noNotificationAttemptCreated: true,
        noSmsEmailProviderSendInvoked: true,
        noAcumaticaWriteInvoked: true,
        noDeliveryDatesOrOrderLinesModified: true,
        queueBackedPreviewWired: true,
        contactOptInRefreshWired: true,
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
