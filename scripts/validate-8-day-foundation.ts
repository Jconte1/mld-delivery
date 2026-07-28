import { readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(__dirname, "..");
const schema = readFileSync(path.join(projectRoot, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  path.join(
    projectRoot,
    "prisma/migrations/20260728110000_add_payment_enforcement_foundation/migration.sql"
  ),
  "utf8"
);
const packageJson = readFileSync(path.join(projectRoot, "package.json"), "utf8");
const envDoc = readFileSync(path.join(projectRoot, "docs/payment-enforcement-env.md"), "utf8");

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function assertIncludes(source: string, expected: string, message: string) {
  assert(source.includes(expected), `${message}: expected ${expected}`);
}

function modelBlock(name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
  assert(Boolean(match), `${name} model must exist`);
  return match?.[0] ?? "";
}

function enumBlock(name: string) {
  const match = schema.match(new RegExp(`enum ${name} \\{[\\s\\S]*?\\n\\}`));
  assert(Boolean(match), `${name} enum must exist`);
  return match?.[0] ?? "";
}

const holdStatus = enumBlock("DeliveryOrderHoldActionStatus");
for (const value of ["PENDING", "QUEUED", "SUCCEEDED", "FAILED", "SKIPPED"]) {
  assertIncludes(holdStatus, value, "hold action status enum");
}

const holdReason = enumBlock("DeliveryOrderHoldActionReason");
assertIncludes(
  holdReason,
  "PAYMENT_NOT_RECEIVED_BY_DEADLINE",
  "hold action reason enum"
);

const audience = enumBlock("InternalNotificationAudienceType");
for (const value of ["SALESPERSON", "FALLBACK", "INTERNAL"]) {
  assertIncludes(audience, value, "internal audience enum");
}

const internalStatus = enumBlock("InternalNotificationStatus");
for (const value of ["PENDING", "SCHEDULED", "SENT", "FAILED", "SKIPPED"]) {
  assertIncludes(internalStatus, value, "internal notification status enum");
}

const purpose = enumBlock("InternalNotificationPurpose");
for (const value of [
  "PAYMENT_ENFORCEMENT_HOLD_SUCCEEDED",
  "PAYMENT_ENFORCEMENT_HOLD_FAILED",
]) {
  assertIncludes(purpose, value, "internal notification purpose enum");
}

const holdAction = modelBlock("DeliveryOrderHoldAction");
for (const field of [
  "orderId",
  "orderDeliveryGroupId",
  "deliveryDate",
  "orderType",
  "orderNumber",
  "customerId",
  "customerDescription",
  "salespersonNumber",
  "amountDueAtTrigger",
  "paymentDeadline",
  "reason",
  "status",
  "queueJobId",
  "errorMessage",
  "acumaticaResponseSummary",
  "customerNotificationEventId String?",
  "queuedAt",
  "completedAt",
]) {
  assertIncludes(holdAction, field, "DeliveryOrderHoldAction field");
}
assertIncludes(
  holdAction,
  "@@unique([orderDeliveryGroupId, deliveryDate, reason])",
  "DeliveryOrderHoldAction dedupe"
);

const internalEvent = modelBlock("InternalNotificationEvent");
for (const field of [
  "orderId                   String?",
  "orderDeliveryGroupId      String?",
  "deliveryOrderHoldActionId String?",
  "purpose",
  "audienceType",
  "recipientEmail",
  "recipientName",
  "subject",
  "bodyPreview",
  "messageSummary",
  "providerName",
  "providerMessageId",
]) {
  assertIncludes(internalEvent, field, "InternalNotificationEvent field");
}

assertIncludes(migration, "CREATE TABLE \"delivery_order_hold_actions\"", "hold migration table");
assertIncludes(migration, "CREATE TABLE \"internal_notification_events\"", "internal migration table");
assertIncludes(
  migration,
  "delivery_order_hold_actions_orderDeliveryGroupId_deliveryDate_reason_key",
  "hold migration dedupe"
);
assertIncludes(packageJson, "validate:8-day-foundation", "package validation script");
assertIncludes(envDoc, "DELIVERY_PREPAYMENT_HOLD_DRY_RUN=true", "delivery dry-run env doc");
assertIncludes(
  envDoc,
  "DELIVERY_PAYMENT_ENFORCEMENT_FALLBACK_EMAIL=",
  "fallback email env doc"
);

console.log(
  JSON.stringify(
    {
      deliveryOrderHoldActionModelExists: true,
      internalNotificationEventModelExists: true,
      holdActionDedupeExists: true,
      customerNotificationEventIdNullable: true,
      internalNotificationAudiences: ["SALESPERSON", "FALLBACK", "INTERNAL"],
      internalNotificationPurposes: [
        "PAYMENT_ENFORCEMENT_HOLD_SUCCEEDED",
        "PAYMENT_ENFORCEMENT_HOLD_FAILED",
      ],
      noDatabaseWritesPerformed: true,
      noNotificationsSent: true,
    },
    null,
    2
  )
);
