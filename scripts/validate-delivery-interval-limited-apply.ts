import { readFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(source.includes(pattern), message, failures);
}

function assertNotIncludes(source: string, pattern: string, message: string, failures: string[]) {
  assert(!source.includes(pattern), message, failures);
}

function assertBefore(
  source: string,
  earlier: string,
  later: string,
  message: string,
  failures: string[]
) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert(
    earlierIndex >= 0 && laterIndex >= 0 && earlierIndex < laterIndex,
    message,
    failures
  );
}

function main() {
  const failures: string[] = [];
  const harness = read("scripts/run-production-style-delivery-full-interval-test.ts");
  const pkg = read("package.json");

  assertIncludes(
    pkg,
    "validate:delivery-interval-limited-apply",
    "package.json exposes limited apply validation",
    failures
  );

  assertIncludes(
    harness,
    'const APPLY_CONFIRM_PHRASE = "CREATE LIMITED CONTROLLED TEST EVENTS ONLY";',
    "harness has the explicit limited-apply confirmation phrase",
    failures
  );
  assertIncludes(
    harness,
    'throw new Error("--all-intervals is not supported',
    "harness refuses explicit --all-intervals usage",
    failures
  );
  assertIncludes(
    harness,
    "--apply-runtime-events requires explicit --interval <I>.",
    "apply refuses without explicit interval",
    failures
  );
  assertIncludes(
    harness,
    "--apply-runtime-events requires explicit --run-date <YYYY-MM-DD>.",
    "apply refuses without explicit run date",
    failures
  );
  assertIncludes(
    harness,
    "--apply-runtime-events requires explicit --max-per-interval-channel 1.",
    "apply refuses unless max-per-interval-channel is explicitly one",
    failures
  );
  assertIncludes(
    harness,
    'rawValue.toLowerCase() === "all"',
    "preview selection accepts --max-per-interval-channel all",
    failures
  );
  assertIncludes(
    harness,
    "--max-per-interval-channel must be a positive integer or all.",
    "invalid max-per-interval-channel values explain the all option",
    failures
  );
  assertIncludes(
    harness,
    'if (max === "all")',
    "all selection returns every channel-eligible preview candidate",
    failures
  );
  assertIncludes(
    harness,
    `--apply-runtime-events requires --confirm-apply "\${APPLY_CONFIRM_PHRASE}".`,
    "apply refuses without the exact confirmation phrase",
    failures
  );
  assertIncludes(
    harness,
    "--send-test-recipients is not supported by this harness",
    "harness refuses provider-send flags",
    failures
  );

  assertIncludes(
    harness,
    "function applyCandidateRows",
    "harness has a selected-candidate apply gate",
    failures
  );
  assertIncludes(
    harness,
    "if (count > 1)",
    "apply refuses more than one selected candidate per channel",
    failures
  );
  assertIncludes(
    harness,
    "if (selected.length > 2)",
    "apply refuses more than two selected candidates total",
    failures
  );
  assertIncludes(
    harness,
    "uniqueDedupeKeys.size !== selected.length",
    "apply refuses duplicate selected dedupe keys",
    failures
  );
  assertIncludes(
    harness,
    "selectedPreviewSmsExample === true",
    "apply uses the preview-selected SMS candidate",
    failures
  );
  assertIncludes(
    harness,
    "selectedPreviewEmailExample === true",
    "apply uses the preview-selected email candidate",
    failures
  );
  assertBefore(
    harness,
    "candidate.row.freshImportSuccess !== true",
    "createSelectedNotificationEvent({",
    "fresh_import_failed candidates are refused before event creation",
    failures
  );
  assertBefore(
    harness,
    "selectedChannel.selectedChannel !== candidate.channel",
    "createSelectedNotificationEvent({",
    "apply rechecks real contact and opt-out channel eligibility before event creation",
    failures
  );

  assertIncludes(
    harness,
    "tx.notificationEvent.create",
    "apply creates NotificationEvent rows only after the selected-candidate gate",
    failures
  );
  assertNotIncludes(
    harness,
    "notificationAttempt.create",
    "harness never creates NotificationAttempt rows",
    failures
  );
  assertNotIncludes(
    harness,
    "sendSms",
    "harness does not call SMS provider helpers",
    failures
  );
  assertNotIncludes(
    harness,
    "sendEmail",
    "harness does not call email provider helpers",
    failures
  );
  assertNotIncludes(
    harness,
    "twilio.messages.create",
    "harness does not call Twilio provider sends",
    failures
  );

  for (const intervalType of [
    "DAY_30",
    "DAY_14",
    "DAY_12",
    "DAY_10",
    "DAY_8",
    "DAY_2",
  ]) {
    assertIncludes(
      harness,
      `NotificationIntervalType.${intervalType}`,
      `details-link apply support includes ${intervalType}`,
      failures
    );
  }

  assertIncludes(
    harness,
    "ensurePendingDeliveryConfirmation",
    "42-day limited apply can create/update only the selected DeliveryConfirmation",
    failures
  );
  assertIncludes(
    harness,
    "newDeliveryConfirmationLinkToken",
    "42-day limited apply creates a confirmation link token only for the selected event",
    failures
  );
  assertIncludes(
    harness,
    "params.config.intervalType === NotificationIntervalType.DAY_42",
    "42-day confirmation work is scoped to the selected 42-day candidate",
    failures
  );

  assertIncludes(
    harness,
    'envSafetyRow("DELIVERY_PREPAYMENT_HOLD_DRY_RUN", "true", "required"',
    "8-day hold dry-run flag is required by preflight",
    failures
  );
  assertIncludes(
    harness,
    "holdActionCreated: false",
    "limited apply reports no live 8-day hold action creation",
    failures
  );
  assertIncludes(
    harness,
    '"deliveryOrderHoldActions"',
    "runtime safety asserts deliveryOrderHoldAction count remains unchanged",
    failures
  );

  assertIncludes(
    harness,
    "existing.status === NotificationEventStatus.SCHEDULED",
    "dedupe reuse is restricted to scheduled existing events",
    failures
  );
  assertIncludes(
    harness,
    "existing._count.attempts === 0",
    "dedupe reuse refuses existing events with attempts",
    failures
  );
  assertIncludes(
    harness,
    "existing_event_has_attempts",
    "dedupe reporting explains non-reusable attempted events",
    failures
  );
  assertIncludes(
    harness,
    "existing_event_channel_mismatch",
    "dedupe reporting explains channel mismatches",
    failures
  );

  assertIncludes(
    harness,
    "dispatchPreviewCommand",
    "workbook/manifest includes dispatcher preview commands for created/reused events",
    failures
  );
  assertIncludes(
    harness,
    "controlledSendCommand",
    "workbook/manifest includes controlled send command templates for created/reused events",
    failures
  );
  assertIncludes(
    harness,
    'addSheet(workbook, "Apply Results", params.applyRows)',
    "workbook includes an Apply Results sheet",
    failures
  );
  assertIncludes(
    harness,
    "assertNoRuntimeRowsCreated(before, after)",
    "preview mode still asserts no runtime rows were created",
    failures
  );
  assertIncludes(
    harness,
    "assertLimitedApplyRuntimeRowsAllowed(before, after, applyRows)",
    "apply mode asserts only allowed runtime rows changed",
    failures
  );

  if (failures.length > 0) {
    console.error("Limited apply validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("Limited apply validation passed for production-style interval harness.");
}

main();
