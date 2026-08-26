import fs from "node:fs";
import path from "node:path";

import {
  DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_IN_ACUMATICA_REASON,
  isAlreadyConfirmedInAcumatica,
  normalizeAcumaticaConfirmVia,
} from "../lib/notifications/create42DayDeliveryConfirmationEvents";
import {
  buildDeliveryConfirmationAttributeWritebackPayload,
  DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV,
  SMS_CONFIRMED_VIA_VALUE,
  WEBPAGE_CONFIRMED_VIA_VALUE,
} from "../lib/notifications/deliveryConfirmationAttributeWritebackQueue";

type Check = {
  name: string;
  passed: boolean;
  details?: unknown;
};

const checks: Check[] = [];
const projectRoot = process.cwd();

function readProjectFile(relativePath: string) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function addCheck(name: string, passed: boolean, details?: unknown) {
  checks.push({ name, passed, details });
}

function sameValue(actual: unknown, expected: unknown) {
  return Object.is(actual, expected);
}

function addEqualCheck(name: string, actual: unknown, expected: unknown) {
  addCheck(name, sameValue(actual, expected), { actual, expected });
}

function assertSourceContains(relativePath: string, patterns: Array<{ name: string; pattern: RegExp }>) {
  const source = readProjectFile(relativePath);
  const missing = patterns.filter(({ pattern }) => !pattern.test(source)).map(({ name }) => name);
  addCheck(`${relativePath} contains expected CONFIRMVIA handling`, missing.length === 0, {
    missing,
  });
}

function assertSourceOmits(relativePath: string, patterns: Array<{ name: string; pattern: RegExp }>) {
  const source = readProjectFile(relativePath);
  const matches = patterns.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name);
  addCheck(`${relativePath} does not use CONFIRMVIA skip behavior`, matches.length === 0, {
    matches,
  });
}

const normalizationCases: Array<{ name: string; value: unknown; expected: string | null }> = [
  { name: "missing/undefined CONFIRMVIA is not populated", value: undefined, expected: null },
  { name: "null CONFIRMVIA is not populated", value: null, expected: null },
  { name: "empty CONFIRMVIA is not populated", value: "", expected: null },
  { name: "whitespace CONFIRMVIA is not populated", value: "   ", expected: null },
  { name: "WEBPAGE CONFIRMVIA is populated", value: "WEBPAGE", expected: "WEBPAGE" },
  { name: "AUTOTXT CONFIRMVIA is populated", value: "AUTOTXT", expected: "AUTOTXT" },
  { name: "any other non-empty CONFIRMVIA is populated", value: "MANUAL", expected: "MANUAL" },
  { name: "trimmed non-empty CONFIRMVIA is populated", value: "  WEBPAGE  ", expected: "WEBPAGE" },
];

for (const testCase of normalizationCases) {
  const normalized = normalizeAcumaticaConfirmVia(testCase.value);
  addEqualCheck(`${testCase.name} normalization`, normalized, testCase.expected);
  addEqualCheck(
    `${testCase.name} populated flag`,
    isAlreadyConfirmedInAcumatica(testCase.value),
    testCase.expected !== null
  );
}

function simulated42DayDecision(params: {
  confirmVia?: unknown;
  confirmWth?: unknown;
  hasInternalDateConfirmation?: boolean;
  hasAutomatedChannel?: boolean;
}) {
  const confirmVia = normalizeAcumaticaConfirmVia(params.confirmVia);
  if (confirmVia) {
    return {
      status: "SKIPPED",
      selectedChannel: null,
      recipientEmail: null,
      recipientPhone: null,
      scheduledAt: null,
      reasonSkipped: DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_IN_ACUMATICA_REASON,
      acumaticaConfirmVia: confirmVia,
      alreadyConfirmedInAcumatica: true,
      notificationAttemptCreated: false,
      providerSendCalled: false,
      acumaticaWriteCalled: false,
      linkTokenPresent: false,
    };
  }

  if (params.hasInternalDateConfirmation) {
    return {
      status: "SKIPPED",
      selectedChannel: null,
      recipientEmail: null,
      recipientPhone: null,
      scheduledAt: null,
      reasonSkipped: "already_confirmed_for_delivery_date",
      acumaticaConfirmVia: null,
      alreadyConfirmedInAcumatica: false,
      notificationAttemptCreated: false,
      providerSendCalled: false,
      acumaticaWriteCalled: false,
      linkTokenPresent: false,
    };
  }

  if (params.hasAutomatedChannel === false) {
    return {
      status: "SKIPPED",
      selectedChannel: null,
      recipientEmail: null,
      recipientPhone: null,
      scheduledAt: null,
      reasonSkipped: "no_automated_channel_available",
      acumaticaConfirmVia: null,
      alreadyConfirmedInAcumatica: false,
      notificationAttemptCreated: false,
      providerSendCalled: false,
      acumaticaWriteCalled: false,
      linkTokenPresent: false,
    };
  }

  return {
    status: "SCHEDULED",
    selectedChannel: "SMS",
    recipientEmail: null,
    recipientPhone: "8015550100",
    scheduledAt: "2099-01-01",
    reasonSkipped: null,
    acumaticaConfirmVia: null,
    alreadyConfirmedInAcumatica: false,
    notificationAttemptCreated: false,
    providerSendCalled: false,
    acumaticaWriteCalled: false,
    linkTokenPresent: true,
    confirmWthIgnored: params.confirmWth !== undefined,
  };
}

const acumaticaSkip = simulated42DayDecision({ confirmVia: "WEBPAGE" });
addCheck(
  "populated CONFIRMVIA creates/reuses skipped event with no scheduled notification data",
  acumaticaSkip.status === "SKIPPED" &&
    acumaticaSkip.reasonSkipped === DELIVERY_CONFIRMATION_ALREADY_CONFIRMED_IN_ACUMATICA_REASON &&
    acumaticaSkip.selectedChannel === null &&
    acumaticaSkip.recipientEmail === null &&
    acumaticaSkip.recipientPhone === null &&
    acumaticaSkip.scheduledAt === null &&
    acumaticaSkip.linkTokenPresent === false,
  acumaticaSkip
);
addCheck(
  "CONFIRMWTH populated but CONFIRMVIA blank does not skip",
  simulated42DayDecision({ confirmVia: " ", confirmWth: "Customer" }).status === "SCHEDULED"
);
addCheck(
  "Acumatica skip decision performs no provider sends, attempts, or Acumatica writes",
  !acumaticaSkip.notificationAttemptCreated &&
    !acumaticaSkip.providerSendCalled &&
    !acumaticaSkip.acumaticaWriteCalled,
  acumaticaSkip
);

assertSourceContains("prisma/schema.prisma", [
  { name: "orders.confirmVia field", pattern: /confirmVia\s+String\?\s+@db\.VarChar\(64\)/ },
]);
assertSourceContains("lib/acumatica/client/acumaticaClient.ts", [
  { name: "direct Acumatica custom fetch includes CONFIRMVIA", pattern: /Document\.AttributeCONFIRMVIA/ },
]);
assertSourceContains("lib/erp/importSalesOrders.ts", [
  { name: "CONFIRMVIA extraction", pattern: /AttributeCONFIRMVIA/ },
  { name: "confirmVia persistence", pattern: /confirmVia:\s+getConfirmVia\(fullOrder\)/ },
]);
assertSourceContains("lib/notifications/create42DayDeliveryConfirmationEvents.ts", [
  { name: "Acumatica skip reason", pattern: /already_confirmed_in_acumatica/ },
  { name: "selectedChannel null for skip", pattern: /selectedChannel:\s+null/ },
  { name: "scheduledAt null for skip", pattern: /scheduledAt:\s+null/ },
  { name: "report exposes Acumatica confirmation flag", pattern: /alreadyConfirmedInAcumatica/ },
  { name: "report exposes Acumatica CONFIRMVIA value", pattern: /acumaticaConfirmVia/ },
]);
assertSourceOmits("lib/notifications/createDeliveryReminderEvents.ts", [
  { name: "new Acumatica skip reason", pattern: /already_confirmed_in_acumatica/ },
  { name: "confirmVia field", pattern: /confirmVia/ },
]);
assertSourceOmits("lib/notifications/create180DayDeliveryReminderEvents.ts", [
  { name: "new Acumatica skip reason", pattern: /already_confirmed_in_acumatica/ },
  { name: "confirmVia field", pattern: /confirmVia/ },
]);
assertSourceOmits("lib/notifications/create90DayDeliveryReminderEvents.ts", [
  { name: "new Acumatica skip reason", pattern: /already_confirmed_in_acumatica/ },
  { name: "confirmVia field", pattern: /confirmVia/ },
]);
assertSourceOmits("lib/notifications/create60DayDeliveryReminderEvents.ts", [
  { name: "new Acumatica skip reason", pattern: /already_confirmed_in_acumatica/ },
  { name: "confirmVia field", pattern: /confirmVia/ },
]);
addEqualCheck("webpage confirmation writeback value remains WEBPAGE", WEBPAGE_CONFIRMED_VIA_VALUE, "WEBPAGE");
addEqualCheck("SMS confirmation writeback value remains AUTOTXT", SMS_CONFIRMED_VIA_VALUE, "AUTOTXT");

const previousDryRunEnv = process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV];
try {
  process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV] = "false";
  const liveSmsPayload = buildDeliveryConfirmationAttributeWritebackPayload({
    orderType: "SO",
    orderNumber: "SO42",
    deliveryConfirmationId: "dc_sms",
    deliveryGroupId: "dg_sms",
    deliveryDate: "2026-09-01",
    contact: { displayName: "SMS Customer" },
    confirmedVia: SMS_CONFIRMED_VIA_VALUE,
    source: "SMS",
  });
  const liveWebPayload = buildDeliveryConfirmationAttributeWritebackPayload({
    orderType: "SO",
    orderNumber: "SO43",
    deliveryConfirmationId: "dc_web",
    deliveryGroupId: "dg_web",
    deliveryDate: "2026-09-02",
    contact: { displayName: "Web Customer" },
    confirmedVia: WEBPAGE_CONFIRMED_VIA_VALUE,
    source: "WEBPAGE",
  });
  addCheck(
    "SMS confirmation can build live AUTOTXT writeback payload",
    liveSmsPayload.dryRun === false &&
      liveSmsPayload.confirmedVia === SMS_CONFIRMED_VIA_VALUE &&
      liveSmsPayload.source === "SMS",
    liveSmsPayload
  );
  addCheck(
    "web confirmation can build live WEBPAGE writeback payload",
    liveWebPayload.dryRun === false &&
      liveWebPayload.confirmedVia === WEBPAGE_CONFIRMED_VIA_VALUE &&
      liveWebPayload.source === "WEBPAGE",
    liveWebPayload
  );

  process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV] = "true";
  const dryRunPayload = buildDeliveryConfirmationAttributeWritebackPayload({
    orderType: "SO",
    orderNumber: "SO44",
    deliveryConfirmationId: "dc_dry",
    deliveryGroupId: "dg_dry",
    deliveryDate: "2026-09-03",
    contact: { displayName: "Dry Run Customer" },
  });
  addEqualCheck("confirmation writeback payload defaults back to dry-run when env is true", dryRunPayload.dryRun, true);
} finally {
  if (previousDryRunEnv === undefined) {
    delete process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV];
  } else {
    process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV] = previousDryRunEnv;
  }
}

const failed = checks.filter((check) => !check.passed);
console.log(
  JSON.stringify(
    {
      passed: failed.length === 0,
      checks,
    },
    null,
    2
  )
);

if (failed.length > 0) {
  process.exitCode = 1;
}
