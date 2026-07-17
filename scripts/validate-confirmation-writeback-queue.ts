import {
  buildDeliveryConfirmationAttributeWritebackPayload,
  DELIVERY_CONFIRMATION_ATTRIBUTE_WRITEBACK_ROUTE,
  DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV,
  DELIVERY_CONFIRMATION_WRITEBACK_LIVE_TEST_ORDER_ENV,
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
const originalLiveOrderEnv = process.env[DELIVERY_CONFIRMATION_WRITEBACK_LIVE_TEST_ORDER_ENV];
process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV] = "false";
process.env[DELIVERY_CONFIRMATION_WRITEBACK_LIVE_TEST_ORDER_ENV] = "SO37860";
const liveTestPayload = buildDeliveryConfirmationAttributeWritebackPayload({
  orderType: "SO",
  orderNumber: "SO37860",
  deliveryConfirmationId: "dc_37860",
  deliveryGroupId: "dg_37860",
  deliveryDate: "2026-07-22",
  contact: { displayName: "Trae Customer" },
});
const nonMatchingLiveTestPayload = buildDeliveryConfirmationAttributeWritebackPayload({
  orderType: "SO",
  orderNumber: "SO40466",
  deliveryConfirmationId: "dc_40466",
  deliveryGroupId: "dg_40466",
  deliveryDate: "2026-07-22",
  contact: { displayName: "Trae Customer" },
});
assertEqual(liveTestPayload.dryRun, false, "SO37860 live-test dryRun override");
assertEqual(nonMatchingLiveTestPayload.dryRun, true, "non-matching live-test order stays dryRun");
if (originalDryRunEnv === undefined) delete process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV];
else process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV] = originalDryRunEnv;
if (originalLiveOrderEnv === undefined) delete process.env[DELIVERY_CONFIRMATION_WRITEBACK_LIVE_TEST_ORDER_ENV];
else process.env[DELIVERY_CONFIRMATION_WRITEBACK_LIVE_TEST_ORDER_ENV] = originalLiveOrderEnv;

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
        liveTestPayloadDryRun: liveTestPayload.dryRun,
        nonMatchingLiveTestPayloadDryRun: nonMatchingLiveTestPayload.dryRun,
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
