import {
  getSmsInvalidDateFormatMessage,
  getSmsUnrecognizedResponseMessage,
  parseRequestedDeliveryDate,
  parseSmsConfirmationResponse,
  render42DaySmsConfirmationMessage,
} from "../lib/notifications/deliveryConfirmationSms";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertIncludes(value: string, expected: string, label: string) {
  if (!value.includes(expected)) {
    throw new Error(`${label}: expected message to include "${expected}"`);
  }
}

function assertNotIncludes(value: string, unexpected: string, label: string) {
  if (value.includes(unexpected)) {
    throw new Error(`${label}: expected message not to include "${unexpected}"`);
  }
}

const responseCases = [
  ["Y", "confirmed"],
  ["yes", "confirmed"],
  [" Confirmed ", "confirmed"],
  ["N", "change_requested"],
  ["no", "change_requested"],
  ["reschedule", "change_requested"],
  ["hello", "unrecognized"],
  ["", "unrecognized"],
] as const;

for (const [input, expected] of responseCases) {
  assertEqual(parseSmsConfirmationResponse(input).kind, expected, `response ${JSON.stringify(input)}`);
}

const validDate = parseRequestedDeliveryDate("01/04/2027");
assertEqual(validDate.valid, true, "01/04/2027 validity");
if (validDate.valid) {
  assertEqual(validDate.dateKey, "2027-01-04", "01/04/2027 date key");
}

for (const input of ["1/4/2027", "2027-01-04", "next Friday"]) {
  assertEqual(parseRequestedDeliveryDate(input).valid, false, `date ${JSON.stringify(input)}`);
}

const link = "https://delivery.example.test/confirm/abc123";
const message = render42DaySmsConfirmationMessage({
  contactName: "James",
  buyerGroup: "Appliance",
  jobName: "Kent Construction / QUINNILD RESIDENCE",
  deliveryDate: "2027-01-04",
  link,
});

assertIncludes(message, "Hello James", "message contact name");
assertIncludes(message, "Appliance delivery", "message buyerGroup");
assertIncludes(message, "Kent Construction / QUINNILD RESIDENCE", "message jobName");
assertIncludes(message, "Monday, January 4, 2027", "message deliveryDate");
assertIncludes(message, link, "message link");
assertNotIncludes(message, "6726 East Whispering Way", "message excludes jobAddress");

const fallbackMessage = render42DaySmsConfirmationMessage({
  contactName: "James",
  buyerGroup: null,
  jobName: "Kent Construction",
  deliveryDate: "2027-01-04",
  link,
});
assertIncludes(fallbackMessage, "Your delivery for Kent Construction", "message buyerGroup fallback");

console.log(
  JSON.stringify(
    {
      responseCases: responseCases.length,
      validDate: "2027-01-04",
      invalidDateCases: 3,
      messageIncludesLink: true,
      messageExcludesJobAddress: true,
      invalidDateMessage: getSmsInvalidDateFormatMessage(),
      unrecognizedMessage: getSmsUnrecognizedResponseMessage(),
    },
    null,
    2
  )
);
