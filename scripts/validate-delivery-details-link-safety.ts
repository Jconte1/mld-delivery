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

function assertNotIncludes(
  source: string,
  pattern: string,
  message: string,
  failures: string[]
) {
  assert(!source.includes(pattern), message, failures);
}

function main() {
  const failures: string[] = [];
  const schema = read("prisma/schema.prisma");
  const helper = read("lib/notifications/deliveryDetailsLinks.ts");
  const detailsPage = read("app/delivery/details/[token]/page.tsx");
  const confirmationPage = read("app/delivery/confirm/[token]/page.tsx");
  const migration = read(
    "prisma/migrations/20260723103000_add_delivery_details_links/migration.sql"
  );

  assertIncludes(schema, "model DeliveryDetailsLink", "schema has DeliveryDetailsLink model", failures);
  assertIncludes(schema, "detailsLinkId", "NotificationEvent has nullable detailsLinkId", failures);
  assertIncludes(
    schema,
    "@@unique([orderDeliveryGroupId, deliveryDate])",
    "details links are unique by delivery group/date",
    failures
  );
  assertIncludes(
    migration,
    "CREATE TABLE \"delivery_details_links\"",
    "migration creates delivery_details_links table",
    failures
  );
  assertIncludes(
    helper,
    "dd_",
    "details links use a separate dd_ token prefix",
    failures
  );
  assertIncludes(
    helper,
    "TODO: Decide and enforce delivery details link expiration policy after later interval flows are complete.",
    "expiration policy TODO is present",
    failures
  );
  for (const forbidden of [
    "prisma.deliveryConfirmation",
    "deliveryConfirmation.create",
    "deliveryConfirmation.update",
    "newDeliveryConfirmationLinkToken",
    "buildDeliveryConfirmationLink",
  ]) {
    assertNotIncludes(
      helper,
      forbidden,
      `details-link helper must not use confirmation state: ${forbidden}`,
      failures
    );
  }
  assertNotIncludes(
    helper,
    "enqueueDeliveryConfirmationAttributeWriteback",
    "details-link helper does not enqueue Acumatica writeback",
    failures
  );

  assertIncludes(
    detailsPage,
    "export default async function DeliveryDetailsPage",
    "details route source loaded",
    failures
  );
  assertIncludes(
    detailsPage,
    "getDeliveryGroupReadiness(group.id)",
    "details page renders latest readiness at page view time",
    failures
  );
  assertIncludes(
    detailsPage,
    "getDeliveryGroupPaymentEvaluation(group.id)",
    "details page renders latest payment state at page view time",
    failures
  );
  assertIncludes(
    detailsPage,
    "group.lastSeenAt ?? group.lastSyncedAt ?? order.lastSyncedAt",
    "details page uses expected last-updated fallback order",
    failures
  );
  assertIncludes(
    detailsPage,
    "do not update lastViewedAt",
    "details page documents no-write lastViewedAt choice",
    failures
  );

  for (const forbidden of [
    "DeliveryConfirmationActions",
    "confirmDeliveryFromWebpage",
    "requestDifferentDate",
    "deliveryConfirmation.update",
    "enqueueDeliveryConfirmationAttributeWriteback",
    "Confirm Delivery",
    "Request Different Date",
    "input type=\"date\"",
    "Reply Y",
  ]) {
    assertNotIncludes(
      detailsPage,
      forbidden,
      `details page must not include confirmation behavior: ${forbidden}`,
      failures
    );
  }

  assertIncludes(
    confirmationPage,
    "DeliveryConfirmationActions",
    "42-day confirmation page still renders confirmation actions",
    failures
  );
  assertIncludes(
    confirmationPage,
    "confirmDeliveryFromWebpage",
    "42-day confirmation page still uses webpage confirmation writeback path",
    failures
  );
  assertIncludes(
    confirmationPage,
    "requestDifferentDate",
    "42-day confirmation page still supports request-different-date",
    failures
  );

  if (failures.length > 0) {
    console.error("Delivery details link safety validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("Delivery details link safety validation passed.");
}

main();
