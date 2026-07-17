import {
  buildDeliveryConfirmationAttributeWritebackPayload,
  DELIVERY_CONFIRMATION_ATTRIBUTE_WRITEBACK_ROUTE,
  DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV,
  enqueueDeliveryConfirmationAttributeWriteback,
  resolveConfirmedWith,
} from "../lib/notifications/deliveryConfirmationAttributeWritebackQueue";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

assertEqual(
  resolveConfirmedWith({ displayName: "Display", companyName: "Company", email: "email@example.com" }),
  "Display",
  "displayName fallback"
);
assertEqual(
  resolveConfirmedWith({ companyName: "Company", firstName: "First", lastName: "Last" }),
  "Company",
  "companyName fallback"
);
assertEqual(
  resolveConfirmedWith({ firstName: "First", lastName: "Last", email: "email@example.com" }),
  "First Last",
  "first last fallback"
);
assertEqual(resolveConfirmedWith({ email: "email@example.com" }), "email@example.com", "email fallback");
assertEqual(resolveConfirmedWith({}), "Customer", "customer fallback");

const payload = buildDeliveryConfirmationAttributeWritebackPayload({
  orderType: "so",
  orderNumber: "so40466",
  deliveryConfirmationId: "dc_123",
  deliveryGroupId: "dg_123",
  deliveryDate: "2026-07-22T00:00:00.000Z",
  contact: { displayName: "Trae Customer" },
});

assertEqual(payload.orderType, "SO", "orderType normalized");
assertEqual(payload.orderNumber, "SO40466", "orderNumber normalized");
assertEqual(payload.confirmedVia, "WEBPAGE", "confirmedVia");
assertEqual(payload.confirmedWith, "Trae Customer", "confirmedWith");
assertEqual(payload.deliveryDate, "2026-07-22", "deliveryDate");
assertEqual(payload.source, "WEBPAGE", "source");
assertEqual(payload.dryRun, true, "dryRun");

const originalDryRunEnv = process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV];
process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV] = "false";
const livePayload = buildDeliveryConfirmationAttributeWritebackPayload({
  orderType: "SO",
  orderNumber: "SO40466",
  deliveryConfirmationId: "dc_40466",
  deliveryGroupId: "dg_40466",
  deliveryDate: "2026-07-22",
  contact: { displayName: "Trae Customer" },
});
const otherLivePayload = buildDeliveryConfirmationAttributeWritebackPayload({
  orderType: "SO",
  orderNumber: "SO40466",
  deliveryConfirmationId: "dc_40466",
  deliveryGroupId: "dg_40466",
  deliveryDate: "2026-07-22",
  contact: { displayName: "Trae Customer" },
});
assertEqual(livePayload.dryRun, false, "dryRun false allows live payload");
assertEqual(otherLivePayload.dryRun, false, "dryRun false allows any order live payload");
if (originalDryRunEnv === undefined) delete process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV];
else process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV] = originalDryRunEnv;

async function main() {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const queued = await enqueueDeliveryConfirmationAttributeWriteback(
    {
      orderType: "SO",
      orderNumber: "SO40466",
      deliveryConfirmationId: "dc_123",
      deliveryGroupId: "dg_123",
      deliveryDate: "2026-07-22",
      contact: { displayName: "Trae Customer" },
    },
    {
      baseUrl: "http://queue.example.test/",
      token: "test-token",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ jobId: "job_123" }), { status: 202 });
      },
    }
  );

  assertEqual(queued.jobId, "job_123", "jobId");
  assertEqual(requests.length, 1, "request count");
  assertEqual(
    requests[0].url,
    `http://queue.example.test${DELIVERY_CONFIRMATION_ATTRIBUTE_WRITEBACK_ROUTE}`,
    "route"
  );
  assertEqual(requests[0].init?.method, "POST", "method");
  assertEqual(
    (requests[0].init?.headers as Record<string, string>).Authorization,
    "Bearer test-token",
    "auth header"
  );
  const requestPayload = JSON.parse(String(requests[0].init?.body)) as typeof payload;
  assertEqual(requestPayload.confirmedVia, "WEBPAGE", "request confirmedVia");
  assertEqual(requestPayload.confirmedWith, "Trae Customer", "request confirmedWith");
  assertEqual(requestPayload.dryRun, true, "request dryRun");

  let failed = false;
  try {
    await enqueueDeliveryConfirmationAttributeWriteback(
      {
        orderType: "SO",
        orderNumber: "SO40466",
        deliveryConfirmationId: "dc_123",
        deliveryGroupId: "dg_123",
        deliveryDate: "2026-07-22",
        contact: { displayName: "Trae Customer" },
      },
      {
        baseUrl: "http://queue.example.test",
        token: "test-token",
        fetchImpl: async () => new Response("queue down", { status: 503 }),
      }
    );
  } catch {
    failed = true;
  }
  assert(failed, "enqueue failure should throw");

  console.log(
    JSON.stringify(
      {
        fallbackCases: 5,
        payload,
        livePayloadDryRun: livePayload.dryRun,
        otherLivePayloadDryRun: otherLivePayload.dryRun,
        enqueueRequestValidated: true,
        enqueueFailureThrows: true,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
