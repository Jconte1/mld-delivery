import fs from "node:fs";
import path from "node:path";

import {
  DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN_ENV,
  DELIVERY_REQUESTED_DATE_WRITEBACK_ROUTE,
  buildDeliveryRequestedDateWritebackPayload,
  loadDeliveryRequestedDateWritebackLineNumbers,
  shouldDryRunDeliveryRequestedDateWriteback,
} from "../lib/notifications/deliveryRequestedDateWritebackQueue";

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

async function main() {
  const previousDryRun = process.env[DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN_ENV];
  try {
    delete process.env[DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN_ENV];
    addCheck("default requested-date writeback is dry-run", shouldDryRunDeliveryRequestedDateWriteback());

    process.env[DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN_ENV] = "false";
    addCheck(
      "requested-date writeback can be made live only with explicit false",
      shouldDryRunDeliveryRequestedDateWriteback() === false
    );
  } finally {
    if (previousDryRun === undefined) {
      delete process.env[DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN_ENV];
    } else {
      process.env[DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN_ENV] = previousDryRun;
    }
  }

  const payload = buildDeliveryRequestedDateWritebackPayload({
    orderType: " so ",
    orderNumber: " so40466 ",
    deliveryConfirmationId: "dc_123",
    deliveryGroupId: "dg_123",
    originalDeliveryDate: "2026-10-07",
    requestedDeliveryDate: "2026-10-14",
    lineNumbers: [3, 1, 3],
    source: "WEBPAGE",
    requestedAt: "2026-08-27T12:00:00.000Z",
    contact: {
      displayName: "Fixture Customer",
      email: "fixture@example.test",
    },
  });
  addCheck("payload normalizes order type and number", payload.orderType === "SO" && payload.orderNumber === "SO40466", payload);
  addCheck("payload normalizes dates to date keys", payload.originalDeliveryDate === "2026-10-07" && payload.requestedDeliveryDate === "2026-10-14", payload);
  addCheck("payload dedupes and sorts delivery-group line numbers", JSON.stringify(payload.lineNumbers) === JSON.stringify([1, 3]), payload);
  addCheck("payload carries requestedBy context when available", payload.requestedBy?.displayName === "Fixture Customer", payload);
  addCheck("delivery queue route is requested-date route", DELIVERY_REQUESTED_DATE_WRITEBACK_ROUTE === "/api/erp/jobs/delivery/requested-date");

  const lineNumbers = await loadDeliveryRequestedDateWritebackLineNumbers({
    deliveryGroupId: "dg_123",
    client: {
      orderDeliveryGroupLine: {
        findMany: async () => [{ lineNbr: 2 }, { lineNbr: 4 }],
      },
    },
  });
  addCheck("line resolver returns active delivery-group member line numbers", JSON.stringify(lineNumbers) === JSON.stringify([2, 4]), lineNumbers);

  let missingLinesBlocked = false;
  try {
    await loadDeliveryRequestedDateWritebackLineNumbers({
      deliveryGroupId: "dg_empty",
      client: {
        orderDeliveryGroupLine: {
          findMany: async () => [],
        },
      },
    });
  } catch {
    missingLinesBlocked = true;
  }
  addCheck("line resolver blocks delivery groups with no line memberships", missingLinesBlocked);

  let missingLineNbrBlocked = false;
  try {
    await loadDeliveryRequestedDateWritebackLineNumbers({
      deliveryGroupId: "dg_missing",
      client: {
        orderDeliveryGroupLine: {
          findMany: async () => [{ lineNbr: null }],
        },
      },
    });
  } catch {
    missingLineNbrBlocked = true;
  }
  addCheck("line resolver blocks missing lineNbr", missingLineNbrBlocked);

  const pageSource = readProjectFile("app/delivery/confirm/[token]/page.tsx");
  const smsSource = readProjectFile("lib/notifications/handleTwilioInboundSms.ts");
  const helperSource = readProjectFile("lib/notifications/deliveryRequestedDateWritebackQueue.ts");
  addCheck("web requested-date path queues requested-date writeback", /enqueueDeliveryRequestedDateWriteback/.test(pageSource));
  addCheck("SMS requested-date path queues requested-date writeback", /enqueueDeliveryRequestedDateWriteback/.test(smsSource));
  addCheck("web requested-date path resolves delivery-group line numbers", /loadDeliveryRequestedDateWritebackLineNumbers/.test(pageSource));
  addCheck("SMS requested-date path resolves delivery-group line numbers", /loadDeliveryRequestedDateWritebackLineNumbers/.test(smsSource));
  addCheck("requested-date helper does not write CONFIRMVIA or CONFIRMWTH", !/CONFIRMVIA|CONFIRMWTH/.test(helperSource));
  addCheck("requested-date helper does not mutate local delivery group dates", !/orderDeliveryGroup\.update|deliveryDate:\s*params\.requestedDeliveryDate/.test(helperSource));

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

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
