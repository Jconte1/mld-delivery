import {
  get42DayEmailNoReplyNotice,
  render42DayEmailConfirmationBody,
  render42DayEmailConfirmationMessage,
  render42DayEmailConfirmationSubject,
} from "../lib/notifications/deliveryConfirmationEmail";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertIncludes(value: string, expected: string, label: string) {
  if (!value.includes(expected)) {
    throw new Error(`${label}: expected content to include "${expected}"`);
  }
}

function assertNotIncludes(value: string, unexpected: string, label: string) {
  if (value.includes(unexpected)) {
    throw new Error(`${label}: expected content not to include "${unexpected}"`);
  }
}

function assertNoCustomerFacingPlaceholders(value: string, label: string) {
  for (const unexpected of ["null", "undefined", "MAIN"]) {
    assertNotIncludes(value, unexpected, label);
  }
}

const deliveryDate = "2027-01-04";
const link = "https://delivery.example.test/confirm/abc123";
const jobName = "Kent Construction / QUINNILD RESIDENCE";
const jobAddress = "6726 East Whispering Way, Kamas UT 84036";

const subject = render42DayEmailConfirmationSubject({
  buyerGroup: "Appliance",
  jobName,
  deliveryDate,
});
assertIncludes(subject, "ACTION REQUIRED", "subject action required");
assertIncludes(subject, "Appliance delivery confirmation", "subject buyerGroup");
assertIncludes(subject, jobName, "subject jobName");
assertIncludes(subject, "Monday, January 4, 2027", "subject deliveryDate");

assertEqual(
  render42DayEmailConfirmationSubject({ buyerGroup: null, jobName, deliveryDate }),
  `ACTION REQUIRED: Delivery confirmation: ${jobName} - Monday, January 4, 2027`,
  "subject buyerGroup fallback"
);
assertEqual(
  render42DayEmailConfirmationSubject({
    buyerGroup: "Appliance",
    jobName: "your delivery",
    deliveryDate,
  }),
  "ACTION REQUIRED: Appliance delivery confirmation - Monday, January 4, 2027",
  "subject jobName fallback"
);
assertEqual(
  render42DayEmailConfirmationSubject({
    buyerGroup: null,
    jobName: null,
    deliveryDate,
  }),
  "ACTION REQUIRED: Delivery confirmation - Monday, January 4, 2027",
  "subject final fallback"
);

const body = render42DayEmailConfirmationBody({
  contactName: "James",
  buyerGroup: "Appliance",
  jobName,
  jobAddress,
  deliveryDate,
  link,
});
assertIncludes(body, "Hello James", "body contact greeting");
assertIncludes(body, "Appliance delivery", "body buyerGroup");
assertIncludes(body, jobName, "body jobName");
assertIncludes(body, "Monday, January 4, 2027", "body deliveryDate");
assertIncludes(body, `Delivery address: ${jobAddress}`, "body jobAddress");
assertIncludes(body, link, "body main link");
assertIncludes(body, get42DayEmailNoReplyNotice(), "body no-reply notice");
assertNotIncludes(body.toLowerCase(), "full item list", "body no item list");
assertNotIncludes(body.toLowerCase(), "eta table", "body no ETA table");
assertNotIncludes(body.toLowerCase(), "payment", "body no payment wording");
assertNotIncludes(body.toLowerCase(), "balance", "body no balance wording");
assertNotIncludes(body.toLowerCase(), "click here to confirm", "body no direct confirm link");
assertNotIncludes(body.toLowerCase(), "click here to change", "body no direct change link");
assertNoCustomerFacingPlaceholders(body, "body placeholder safety");

const fallbackBody = render42DayEmailConfirmationBody({
  contactName: "James",
  buyerGroup: null,
  jobName: "Kent Construction",
  jobAddress: "MAIN",
  deliveryDate,
  link,
});
assertIncludes(fallbackBody, "Your delivery for Kent Construction", "body buyerGroup fallback");
assertIncludes(fallbackBody, "Delivery address: the job site", "body jobAddress fallback");
assertNoCustomerFacingPlaceholders(fallbackBody, "fallback body placeholder safety");

const message = render42DayEmailConfirmationMessage({
  contactName: "James",
  buyerGroup: "Appliance",
  jobName,
  jobAddress,
  deliveryDate,
  link,
});
assertEqual(message.subject, subject, "combined message subject");
assertEqual(message.body, body, "combined message body");

console.log(
  JSON.stringify(
    {
      subjectIncludesActionRequired: true,
      subjectFallbacksVerified: 3,
      bodyIncludesGreeting: true,
      bodyIncludesBuyerGroup: true,
      bodyIncludesJobName: true,
      bodyIncludesDeliveryDate: true,
      bodyIncludesJobAddress: true,
      bodyIncludesMainLink: true,
      bodyIncludesNoReplyNotice: true,
      bodyExcludesItemEtaPaymentBalanceDetails: true,
      bodyExcludesDirectActionLinks: true,
      placeholderSafetyVerified: true,
    },
    null,
    2
  )
);
