import fs from "node:fs";
import path from "node:path";

import {
  REQUESTED_DELIVERY_DATE_REASON_CODES,
  REQUESTED_DELIVERY_DATE_RULES,
  determineRequestedDeliveryDateRule,
  validateRequestedDeliveryDateEligibility,
} from "../lib/notifications/deliveryDateEligibility";
import { render42DaySmsConfirmationMessage } from "../lib/notifications/deliveryConfirmationSms";

type Check = {
  name: string;
  passed: boolean;
  details?: unknown;
};

const checks: Check[] = [];
const projectRoot = process.cwd();
const now = new Date("2026-07-21T12:00:00.000Z");
const currentDeliveryDate = "2026-09-03";
const link = "https://delivery.example.test/confirm/abc123";

function readProjectFile(relativePath: string) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function addCheck(name: string, passed: boolean, details?: unknown) {
  checks.push({ name, passed, details });
}

function assertAllowed(name: string, params: Parameters<typeof validateRequestedDeliveryDateEligibility>[0]) {
  const result = validateRequestedDeliveryDateEligibility({ ...params, now });
  addCheck(name, result.allowed, result);
}

function assertRejected(
  name: string,
  params: Parameters<typeof validateRequestedDeliveryDateEligibility>[0],
  reason: string,
  messageIncludes?: string
) {
  const result = validateRequestedDeliveryDateEligibility({ ...params, now });
  addCheck(
    name,
    !result.allowed &&
      result.reason === reason &&
      (!messageIncludes || result.customerMessage.includes(messageIncludes)),
    result
  );
}

function smsFor(address?: { state?: string | null; postalCode?: string | null }) {
  return render42DaySmsConfirmationMessage({
    contactName: "James",
    buyerGroup: "Appliance",
    jobName: "Kent Construction",
    deliveryDate: "2026-09-03",
    link,
    deliveryAddress: address,
  });
}

function sourceContains(relativePath: string, pattern: RegExp) {
  return pattern.test(readProjectFile(relativePath));
}

function requestDifferentDateSource() {
  const source = readProjectFile("app/delivery/confirm/[token]/page.tsx");
  const start = source.indexOf("async function requestDifferentDate");
  const end = source.indexOf("export default async function DeliveryConfirmationPage");
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

assertAllowed("1. WY + Tuesday allowed", {
  requestedDate: "2026-09-01",
  currentDeliveryDate,
  address: { state: "WY", postalCode: "82001" },
});
assertRejected(
  "2. WY + Monday rejected with Wyoming Tuesday-only message",
  {
    requestedDate: "2026-08-31",
    currentDeliveryDate,
    address: { state: "WY", postalCode: "82001" },
  },
  REQUESTED_DELIVERY_DATE_REASON_CODES.WYOMING_TUESDAY_ONLY,
  "Wyoming on Tuesdays only"
);
assertAllowed("3. Wyoming full state name + Tuesday allowed", {
  requestedDate: "2026-09-01",
  currentDeliveryDate,
  address: { state: "Wyoming", postalCode: "82001" },
});
assertRejected(
  "4. Wyoming full state name + Wednesday rejected",
  {
    requestedDate: "2026-09-02",
    currentDeliveryDate,
    address: { state: "Wyoming", postalCode: "82001" },
  },
  REQUESTED_DELIVERY_DATE_REASON_CODES.WYOMING_TUESDAY_ONLY
);
assertAllowed("5. ZIP 83638 + Monday allowed", {
  requestedDate: "2026-08-31",
  currentDeliveryDate,
  address: { state: "ID", postalCode: "83638" },
});
assertRejected(
  "6. ZIP 83638 + Tuesday rejected with McCall Monday-only message",
  {
    requestedDate: "2026-09-01",
    currentDeliveryDate,
    address: { state: "ID", postalCode: "83638" },
  },
  REQUESTED_DELIVERY_DATE_REASON_CODES.MCCALL_MONDAY_ONLY,
  "McCall, Idaho on Mondays only"
);
assertAllowed("7. ZIP 83635 + Monday allowed", {
  requestedDate: "2026-08-31",
  currentDeliveryDate,
  address: { state: "ID", postalCode: "83635" },
});
assertRejected(
  "8. ZIP 83635 + Friday rejected",
  {
    requestedDate: "2026-09-04",
    currentDeliveryDate,
    address: { state: "ID", postalCode: "83635" },
  },
  REQUESTED_DELIVERY_DATE_REASON_CODES.MCCALL_MONDAY_ONLY
);
assertAllowed("9. ZIP 83638-1234 + Monday allowed", {
  requestedDate: "2026-08-31",
  currentDeliveryDate,
  address: { state: "ID", postalCode: "83638-1234" },
});
assertAllowed("10. Idaho non-McCall ZIP + any weekday allowed", {
  requestedDate: "2026-09-04",
  currentDeliveryDate,
  address: { state: "ID", postalCode: "83702" },
});
assertAllowed("11. Utah + any weekday allowed", {
  requestedDate: "2026-09-04",
  currentDeliveryDate,
  address: { state: "UT", postalCode: "84101" },
});
assertRejected(
  "12. Standard route + Saturday rejected",
  {
    requestedDate: "2026-08-29",
    currentDeliveryDate,
    address: { state: "UT", postalCode: "84101" },
  },
  REQUESTED_DELIVERY_DATE_REASON_CODES.WEEKEND_NOT_ALLOWED,
  "weekend"
);
assertRejected(
  "13. Standard route + Sunday rejected",
  {
    requestedDate: "2026-08-30",
    currentDeliveryDate,
    address: { state: "UT", postalCode: "84101" },
  },
  REQUESTED_DELIVERY_DATE_REASON_CODES.WEEKEND_NOT_ALLOWED
);
assertRejected(
  "14. Past date rejected",
  {
    requestedDate: "2026-07-20",
    currentDeliveryDate,
    address: { state: "UT", postalCode: "84101" },
  },
  REQUESTED_DELIVERY_DATE_REASON_CODES.DATE_IN_PAST,
  "already passed"
);
assertRejected(
  "15. Same as current delivery date rejected",
  {
    requestedDate: currentDeliveryDate,
    currentDeliveryDate,
    address: { state: "UT", postalCode: "84101" },
  },
  REQUESTED_DELIVERY_DATE_REASON_CODES.SAME_AS_CURRENT_DELIVERY_DATE,
  "current scheduled delivery date"
);

addCheck(
  "16. SMS date reply uses the shared helper",
  sourceContains(
    "lib/notifications/deliveryConfirmationSmsReplies.ts",
    /validateRequestedDeliveryDateEligibility/
  ) &&
    sourceContains("lib/notifications/handleTwilioInboundSms.ts", /address:\s*params\.candidate\.order\.address/)
);
addCheck(
  "17. Webpage request-different-date uses the shared helper",
  sourceContains("app/delivery/confirm/[token]/page.tsx", /validateRequestedDeliveryDateEligibility/)
);
addCheck(
  "18. Valid requested date still sets NEW_DATE_REQUESTED and manualReviewRequired",
  sourceContains("lib/notifications/handleTwilioInboundSms.ts", /status:\s*DeliveryConfirmationStatus\.NEW_DATE_REQUESTED/) &&
    sourceContains("lib/notifications/handleTwilioInboundSms.ts", /manualReviewRequired:\s*true/)
);
addCheck(
  "19. Invalid requested date does not set NEW_DATE_REQUESTED",
  sourceContains("lib/notifications/handleTwilioInboundSms.ts", /if \(!validation\.valid\)[\s\S]*return validation\.responseMessage;/)
);

const requestDifferentSource = requestDifferentDateSource();
addCheck(
  "20. Request Different Date still does not write CONFIRMVIA / CONFIRMWTH",
  !/CONFIRMVIA|CONFIRMWTH|enqueueDeliveryConfirmationAttributeWriteback|confirmDeliveryFromWebpage/.test(
    requestDifferentSource
  )
);
addCheck(
  "21. Delivery confirmation date eligibility does not call Acumatica directly",
  [
    "lib/notifications/deliveryDateEligibility.ts",
    "lib/notifications/deliveryConfirmationSmsReplies.ts",
    "lib/notifications/handleTwilioInboundSms.ts",
    "app/delivery/confirm/[token]/page.tsx",
  ].every((relativePath) => !/createAcumaticaClientFromEnv|AcumaticaClient|ACUMATICA_/i.test(readProjectFile(relativePath)))
);

const standardSms = smsFor({ state: "UT", postalCode: "84101" });
const wyomingSms = smsFor({ state: "WY", postalCode: "82001" });
const mccall83638Sms = smsFor({ state: "ID", postalCode: "83638" });
const mccall83635Sms = smsFor({ state: "ID", postalCode: "83635" });
const idahoStandardSms = smsFor({ state: "ID", postalCode: "83702" });
addCheck(
  "22. Standard 42-day SMS does not include Wyoming/McCall route note",
  !/Wyoming deliveries|McCall deliveries/.test(standardSms),
  { standardSms }
);
addCheck(
  "23. Wyoming 42-day SMS includes Tuesday-only note",
  wyomingSms.includes("Wyoming deliveries are available on Tuesdays only."),
  { wyomingSms }
);
addCheck(
  "24. McCall ZIP 83638 42-day SMS includes Monday-only note",
  mccall83638Sms.includes("McCall deliveries are available on Mondays only."),
  { mccall83638Sms }
);
addCheck(
  "25. McCall ZIP 83635 42-day SMS includes Monday-only note",
  mccall83635Sms.includes("McCall deliveries are available on Mondays only."),
  { mccall83635Sms }
);
addCheck(
  "26. Idaho non-McCall ZIP does not include McCall note",
  !idahoStandardSms.includes("McCall deliveries are available on Mondays only."),
  { idahoStandardSms }
);

addCheck(
  "McCall ZIP rule is more specific than state",
  determineRequestedDeliveryDateRule({ state: "WY", postalCode: "83638" }).ruleName ===
    REQUESTED_DELIVERY_DATE_RULES.MCCALL_MONDAY_ONLY
);

const failed = checks.filter((check) => !check.passed);
console.log(
  JSON.stringify(
    {
      passed: failed.length === 0,
      checksPassed: checks.length - failed.length,
      checksFailed: failed.length,
      checks,
    },
    null,
    2
  )
);

if (failed.length > 0) {
  process.exitCode = 1;
}
