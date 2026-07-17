import fs from "node:fs";
import path from "node:path";

import { QueueErpClient } from "../lib/erp/queueErpClient";

type Check = {
  name: string;
  passed: boolean;
  details?: unknown;
};

type CapturedRequest = {
  method: string;
  url: string;
  body: unknown;
};

const projectRoot = process.cwd();
const mldQueueRoot = path.resolve(projectRoot, "..", "mld-queue");
const checks: Check[] = [];

function readProjectFile(relativePath: string) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function readMldQueueFile(relativePath: string) {
  return fs.readFileSync(path.join(mldQueueRoot, relativePath), "utf8");
}

function addCheck(name: string, passed: boolean, details?: unknown) {
  checks.push({ name, passed, details });
}

function assertNoPattern(params: {
  label: string;
  source: string;
  patterns: Array<{ name: string; pattern: RegExp }>;
}) {
  const matches = params.patterns
    .filter(({ pattern }) => pattern.test(params.source))
    .map(({ name }) => name);

  addCheck(`${params.label} has no forbidden routing/provider/writeback references`, matches.length === 0, {
    forbiddenMatches: matches,
  });
}

function assertContains(params: {
  label: string;
  source: string;
  patterns: Array<{ name: string; pattern: RegExp }>;
}) {
  const missing = params.patterns
    .filter(({ pattern }) => !pattern.test(params.source))
    .map(({ name }) => name);

  addCheck(`${params.label} contains expected delivery routing references`, missing.length === 0, {
    missing,
  });
}

function staticDeliveryIntervalChecks() {
  const intervalFiles = [
    "lib/notifications/create180DayDeliveryReminderEvents.ts",
    "lib/notifications/create90DayDeliveryReminderEvents.ts",
    "lib/notifications/create60DayDeliveryReminderEvents.ts",
    "lib/notifications/createDeliveryReminderEvents.ts",
    "scripts/create-180-day-notification-events.ts",
    "scripts/create-90-day-notification-events.ts",
    "scripts/create-60-day-notification-events.ts",
  ];

  const forbidden = [
    { name: "specbooks queue literal", pattern: /specbooks-jobs/i },
    { name: "delivery confirmation writeback job", pattern: /ERP_UPDATE_DELIVERY_CONFIRMATION_ATTRIBUTES/ },
    { name: "confirmation via custom attribute", pattern: /CONFIRMVIA|CONFIRMWTH|CONFIRMWITH/i },
    { name: "writeback queue helper", pattern: /deliveryConfirmationAttributeWritebackQueue/ },
    { name: "direct Acumatica client creation", pattern: /createAcumaticaClientFromEnv|new\s+AcumaticaClient/i },
    { name: "provider dispatch", pattern: /TWILIO|MS_GRAPH|sendMail|Messages\.json/i },
    { name: "notification attempt mutation", pattern: /notificationAttempt\.(create|createMany|upsert|update)/ },
  ];

  for (const relativePath of intervalFiles) {
    const source = readProjectFile(relativePath);
    assertNoPattern({ label: relativePath, source, patterns: forbidden });
  }

  const reminderSource = readProjectFile("lib/notifications/createDeliveryReminderEvents.ts");
  addCheck(
    "shared 180/90/60 reminder service reads persisted delivery DB state only",
    /prisma\.orderDeliveryGroup\.findMany/.test(reminderSource) &&
      !/createErpClientFromEnv|QueueErpClient|fetch\(/.test(reminderSource)
  );
  addCheck(
    "shared 180/90/60 reminder service creates notification_events only, not notification_attempts",
    /prisma\.notificationEvent\.create/.test(reminderSource) &&
      !/notificationAttempt\.(create|createMany|upsert|update)/.test(reminderSource)
  );

  const erpClientSource = readProjectFile("lib/erp/erpClient.ts");
  assertContains({
    label: "shared delivery ERP client selector",
    source: erpClientSource,
    patterns: [
      { name: "queue base URL config", pattern: /MLD_QUEUE_BASE_URL/ },
      { name: "queue token config", pattern: /MLD_QUEUE_TOKEN/ },
      { name: "queue client creation", pattern: /createQueueErpClientFromEnv/ },
    ],
  });
}

async function mockedQueueErpClientChecks() {
  const originalFetch = globalThis.fetch;
  const previousEnv = {
    MLD_QUEUE_BASE_URL: process.env.MLD_QUEUE_BASE_URL,
    MLD_QUEUE_TOKEN: process.env.MLD_QUEUE_TOKEN,
    MLD_QUEUE_JOB_POLL_INTERVAL_MS: process.env.MLD_QUEUE_JOB_POLL_INTERVAL_MS,
  };
  const captured: CapturedRequest[] = [];

  process.env.MLD_QUEUE_BASE_URL = "https://mld-queue.example.test";
  process.env.MLD_QUEUE_TOKEN = "test-token";
  process.env.MLD_QUEUE_JOB_POLL_INTERVAL_MS = "1";

  let jobCounter = 0;
  const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    captured.push({ method, url, body });

    if (method === "POST") {
      jobCounter += 1;
      return new Response(JSON.stringify({ jobId: `mock-job-${jobCounter}` }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        jobId: `mock-job-${jobCounter}`,
        status: "succeeded",
        result: { rows: [] },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  try {
    globalThis.fetch = mockFetch as typeof fetch;
    const client = new QueueErpClient();

    await client.fetchQualifyingSalesOrdersByLineRequestedOn("2026-07-22T09:19:00.000Z");
    await client.fetchDeliverySalesOrderByOrderNumber("SO37860", "SO");
    await client.fetchDeliveryContactByContactId("156581");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.MLD_QUEUE_BASE_URL = previousEnv.MLD_QUEUE_BASE_URL;
    process.env.MLD_QUEUE_TOKEN = previousEnv.MLD_QUEUE_TOKEN;
    process.env.MLD_QUEUE_JOB_POLL_INTERVAL_MS = previousEnv.MLD_QUEUE_JOB_POLL_INTERVAL_MS;
  }

  const postPaths = captured
    .filter((request) => request.method === "POST")
    .map((request) => new URL(request.url).pathname);

  addCheck("shared delivery ERP queue client posts only to delivery gateway routes", postPaths.every((route) => route.startsWith("/api/erp/jobs/delivery/")), {
    postPaths,
  });
  addCheck(
    "shared delivery ERP queue client posts expected delivery job routes",
    [
      "/api/erp/jobs/delivery/sales-orders/by-line-requested-on",
      "/api/erp/jobs/delivery/sales-orders/full",
      "/api/erp/jobs/delivery/contacts",
    ].every((route) => postPaths.includes(route)),
    { postPaths }
  );
  addCheck(
    "shared delivery ERP queue client does not call Acumatica or specbooks endpoints",
    captured.every(
      (request) =>
        !/acumatica/i.test(request.url) &&
        !/\/api\/specbooks/i.test(request.url) &&
        !/specbooks-jobs/i.test(JSON.stringify(request.body))
    ),
    { requestCount: captured.length }
  );
}

function staticMldQueueChecks() {
  const gatewayEnv = readMldQueueFile("gateway/src/lib/env.ts");
  const workerEnv = readMldQueueFile("worker/src/lib/env.ts");
  const deliveryRoutes = [
    "gateway/src/app/api/erp/jobs/delivery/sales-orders/by-line-requested-on/route.ts",
    "gateway/src/app/api/erp/jobs/delivery/sales-orders/full/route.ts",
    "gateway/src/app/api/erp/jobs/delivery/contacts/route.ts",
  ];
  const confirmationRoute =
    "gateway/src/app/api/erp/jobs/delivery/confirmation-attributes/route.ts";

  assertContains({
    label: "mld-queue gateway env",
    source: gatewayEnv,
    patterns: [{ name: "MLD_QUEUE_DELIVERY_QUEUE_NAME", pattern: /MLD_QUEUE_DELIVERY_QUEUE_NAME/ }],
  });
  assertContains({
    label: "mld-queue worker env",
    source: workerEnv,
    patterns: [{ name: "MLD_QUEUE_WORKER_QUEUE_NAME", pattern: /MLD_QUEUE_WORKER_QUEUE_NAME/ }],
  });

  for (const relativePath of deliveryRoutes) {
    const source = readMldQueueFile(relativePath);
    assertContains({
      label: relativePath,
      source,
      patterns: [
        { name: "deliveryQueueName helper", pattern: /deliveryQueueName\(\)/ },
        { name: "enqueueJob queueName override", pattern: /queueName:\s*deliveryQueueName\(\)/ },
      ],
    });
    assertNoPattern({
      label: relativePath,
      source,
      patterns: [{ name: "specbooks queue literal", pattern: /specbooks-jobs/i }],
    });
  }

  const confirmationRouteSource = readMldQueueFile(confirmationRoute);
  assertContains({
    label: confirmationRoute,
    source: confirmationRouteSource,
    patterns: [
      { name: "deliveryQueueName helper", pattern: /deliveryQueueName\(\)/ },
      { name: "enqueueJob queueName override", pattern: /queueName:\s*deliveryQueueName\(\)/ },
    ],
  });
}

async function main() {
  staticDeliveryIntervalChecks();
  await mockedQueueErpClientChecks();
  staticMldQueueChecks();

  const failed = checks.filter((check) => !check.passed);
  const summary = {
    passed: failed.length === 0,
    checksPassed: checks.length - failed.length,
    checksFailed: failed.length,
    checks,
    notes: [
      "Validation is read-only: no database writes, provider sends, public gateway calls, or Acumatica calls are performed.",
      "180/90/60 reminder flows currently use persisted delivery DB rows and do not enqueue ERP work themselves.",
      "Any delivery ERP import/read work used by interval preparation should use QueueErpClient delivery gateway routes when USE_QUEUE_ERP=true.",
    ],
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
