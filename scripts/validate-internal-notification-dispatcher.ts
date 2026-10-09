import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  InternalNotificationPurpose as Purpose,
  InternalNotificationStatus as Status,
  type InternalNotificationEvent,
} from "../lib/generated/prisma/client";
import { DeliveryNotificationProviderError, type DeliveryNotificationProviderResult } from "../lib/notifications/deliveryNotificationProviders";
import { createInternalEmailProvider, dispatchInternalNotifications } from "../lib/notifications/internalNotificationDispatcher";

type Options = Parameters<typeof dispatchInternalNotifications>[0];
const at = new Date("2026-10-07T12:00:00Z");
const accepted: DeliveryNotificationProviderResult = {
  provider: "ms_graph", externalMessageId: "real-graph-request-id", httpStatus: 202, providerCode: "accepted",
};
function row(id: string, overrides: Partial<InternalNotificationEvent> = {}): InternalNotificationEvent {
  return { id, orderId: "order", orderDeliveryGroupId: "group", deliveryOrderHoldActionId: null,
    orderType: "SO", orderNumber: "123", deliveryDate: at,
    purpose: Purpose.DELIVERY_CONFIRMATION_NO_RESPONSE, audienceType: "SALESPERSON",
    recipientEmail: "salesperson@example.invalid", recipientName: "Salesperson", subject: "Internal escalation",
    bodyPreview: "Please follow up on this order.", messageSummary: "Internal escalation",
    status: Status.PENDING, reasonSkipped: null, reasonFailed: null,
    providerName: null, providerMessageId: null, sentAt: null, createdAt: at, updatedAt: at, ...overrides };
}
function matches(record: InternalNotificationEvent, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    const actual = record[key as keyof InternalNotificationEvent];
    if (value instanceof Date) return actual instanceof Date && +actual === +value;
    if (value && typeof value === "object") {
      const filter = value as { in?: unknown[]; gte?: Date };
      if (filter.in) return filter.in.includes(actual);
      if (filter.gte) return actual instanceof Date && actual >= filter.gte;
      throw new Error(`Unsupported mock filter ${key}`);
    }
    return actual === value;
  });
}
function fixture(rows: InternalNotificationEvent[], send?: Options["provider"], failPersistence = 0) {
  let reads = 0;
  let writes = 0;
  const sent: unknown[] = [];
  const client = { internalNotificationEvent: {
    async findMany({ where }: { where: Record<string, unknown> }) {
      reads++;
      assert.ok(Array.isArray((where.id as { in: string[] }).in), "Every read is explicitly ID scoped");
      return rows.filter(record => matches(record, where)).map(record => ({ ...record }));
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Partial<InternalNotificationEvent> }) {
      writes++;
      assert.equal(typeof where.id, "string", "Every write targets a single event");
      if (where.status === Status.SCHEDULED && failPersistence-- > 0) throw new Error("Simulated DB outage");
      const matching = rows.filter(record => matches(record, where));
      for (const record of matching) Object.assign(record, data, { updatedAt: new Date(+record.updatedAt + 1) });
      return { count: matching.length };
    },
  } } as unknown as NonNullable<Options["client"]>;
  const provider = send ?? { async sendEmail(input) { sent.push(input); return accepted; } };
  return { rows, client, provider, sent, reads: () => reads, writes: () => writes };
}
async function dispatch(f: ReturnType<typeof fixture>, extra: Partial<Options> = {}) {
  return dispatchInternalNotifications({ eventIds: f.rows.map(record => record.id),
    purposes: Object.values(Purpose), client: f.client, provider: f.provider, now: () => at, ...extra });
}

async function run() {
  let cases = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("NETWORK FORBIDDEN in mock validation"); };
  try {
    const empty = fixture([row("backlog")]);
    assert.equal((await dispatch(empty, { eventIds: [] })).requestedCount, 0);
    assert.equal(empty.reads(), 0);
    assert.equal(empty.writes(), 0);
    await assert.rejects(dispatch(empty, { eventIds: undefined as unknown as string[] }), /explicit/);
    await assert.rejects(dispatch(empty, { purposes: [] }), /purposes/);
    cases++;

    const scoped = fixture([row("current"), row("old"), row("wrong-purpose", { purpose: Purpose.PAYMENT_ENFORCEMENT_HOLD_FAILED }),
      row("wrong-order", { orderNumber: "999" }), row("predates-run", { createdAt: new Date(+at - 1) })]);
    const scopedResult = await dispatch(scoped, { eventIds: ["current", "current", "wrong-purpose", "wrong-order", "predates-run", "missing"],
      purposes: [Purpose.DELIVERY_CONFIRMATION_NO_RESPONSE], orderScope: { orderType: "SO", orderNumber: "123" }, createdSince: at });
    assert.equal(scopedResult.providerAcceptedCount, 1);
    assert.equal(scoped.sent.length, 1);
    assert.equal(scoped.rows[0].providerMessageId, accepted.externalMessageId);
    assert.equal(scoped.rows[0].sentAt, at);
    assert.ok(scoped.rows.slice(1).every(record => record.status === Status.PENDING));
    assert.equal((await dispatch(scoped, { eventIds: ["current"] })).providerAcceptedCount, 0);
    cases++;

    const race = fixture([row("race")]);
    const competing = await Promise.all(Array.from({ length: 8 }, () => dispatch(race)));
    assert.equal(race.sent.length, 1);
    assert.equal(competing.reduce((n, result) => n + result.providerAcceptedCount, 0), 1);
    cases++;

    const evidence = fixture([
      ...[Status.SCHEDULED, Status.SENT, Status.FAILED, Status.SKIPPED].map(status => row(status, { status })),
      row("provider-name", { providerName: "ms_graph" }), row("provider-id", { providerMessageId: "old-id" }),
      row("sent-at", { sentAt: at }), row("failed-reason", { reasonFailed: "uncertain" }), row("skipped-reason", { reasonSkipped: "no recipient" }),
    ]);
    await dispatch(evidence);
    assert.equal(evidence.sent.length, 0);
    assert.equal(evidence.writes(), 0);
    cases++;

    const invalid = fixture([row("no-recipient", { recipientEmail: null }), row("bad-recipient", { recipientEmail: "one@example.invalid;two@example.invalid" }),
      row("no-body", { bodyPreview: " " }), row("no-subject", { subject: null })]);
    await dispatch(invalid);
    assert.equal(invalid.sent.length, 0);
    assert.ok(invalid.rows.every(record => record.status === Status.SKIPPED && record.reasonSkipped && !record.providerName));
    cases++;

    for (const purpose of Object.values(Purpose)) {
      const internal = fixture([row(purpose, { purpose, audienceType: "FALLBACK", recipientEmail: "ops@example.invalid" })]);
      assert.equal((await dispatch(internal)).providerAcceptedCount, 1);
      assert.deepEqual(internal.sent, [{ to: "ops@example.invalid", subject: "Internal escalation", textBody: "Please follow up on this order." }]);
    }
    cases++;

    for (const httpStatus of [400, 403, 429, 408, 500, null]) {
      let sends = 0;
      const failed = fixture([row(`failed-${httpStatus}`)], { async sendEmail() {
        sends++;
        throw new DeliveryNotificationProviderError({ provider: "ms_graph", externalMessageId: "failure-request-id", httpStatus, message: "Provider failure" });
      } });
      const result = await dispatch(failed);
      assert.equal(result.ok, false);
      assert.equal(result.reconciliationRequiredCount, httpStatus === null || httpStatus === 408 || httpStatus >= 500 ? 1 : 0);
      assert.equal(failed.rows[0].status, Status.FAILED);
      assert.equal(failed.rows[0].providerMessageId, "failure-request-id");
      assert.equal(failed.rows[0].sentAt, null);
      await dispatch(failed);
      assert.equal(sends, 1);
    }
    cases++;

    const timeout = fixture([row("timeout")], { async sendEmail() { throw new Error("socket closed after send"); } });
    assert.equal((await dispatch(timeout)).reconciliationRequiredCount, 1);
    assert.match(timeout.rows[0].reasonFailed!, /outcome_unknown/);
    assert.equal(timeout.rows[0].providerMessageId, null);
    assert.equal((await dispatch(timeout)).providerAcceptedCount, 0);
    cases++;

    for (const failWrites of [1, 2]) {
      const persistence = fixture([row(`persistence-${failWrites}`)], undefined, failWrites);
      const result = await dispatch(persistence);
      assert.equal(result.reconciliationRequiredCount, 1);
      assert.equal(persistence.rows[0].status, Status.SCHEDULED);
      if (failWrites === 1) assert.equal(persistence.rows[0].providerMessageId, accepted.externalMessageId);
      assert.equal(result.reports[0].providerMessageIdMasked, "***est-id");
      await dispatch(persistence);
      assert.equal(persistence.sent.length, 1);
    }
    cases++;

    const noId = fixture([row("no-id")], { async sendEmail() { return { ...accepted, externalMessageId: null }; } });
    assert.equal((await dispatch(noId)).providerAcceptedCount, 1);
    assert.equal(noId.rows[0].providerMessageId, null, "Never invent a provider ID");
    const unexpected = fixture([row("unexpected")], { async sendEmail() { return { ...accepted, httpStatus: 200 }; } });
    assert.equal((await dispatch(unexpected)).reconciliationRequiredCount, 1);
    cases++;

    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MS_GRAPH_TENANT_ID: "mock", MS_GRAPH_CLIENT_ID: "mock", MS_GRAPH_CLIENT_SECRET: "mock", MS_GRAPH_FROM_EMAIL: "sender@example.invalid" };
    for (const status of [202, 403, 503]) {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const request = (async (url, init) => {
        requests.push({ url: String(url), init });
        return requests.length === 1
          ? new Response(JSON.stringify({ access_token: "mock-token" }), { status: 200 })
          : new Response(null, { status, headers: { "request-id": `graph-${status}` } });
      }) as typeof fetch;
      const provider = createInternalEmailProvider(env, request);
      const f = fixture([row(`graph-${status}`)], provider);
      const result = await dispatch(f);
      assert.equal(f.rows[0].providerMessageId, `graph-${status}`);
      assert.equal(result.providerAcceptedCount, status === 202 ? 1 : 0);
      assert.equal(requests.length, 2);
      assert.match(requests[1].url, /\/sendMail$/);
      const payload = JSON.parse(String(requests[1].init?.body));
      assert.deepEqual(payload.message.toRecipients, [{ emailAddress: { address: "salesperson@example.invalid" } }]);
    }
    cases++;

    const configuration = fixture([row("configuration")], createInternalEmailProvider({ NODE_ENV: "test" }));
    assert.equal((await dispatch(configuration)).providerFailedCount, 1);
    const auth = fixture([row("auth")], createInternalEmailProvider(env, async () => new Response(null, { status: 503 })));
    assert.equal((await dispatch(auth)).providerFailedCount, 1);
    cases++;

    const retryOptions = { orderScope: { orderType: "SO", orderNumber: "123" },
      retryRejected: { expectedUpdatedAt: at } };
    const rejectedRow = () => row("retry", { status: Status.FAILED, providerName: "ms_graph",
      providerMessageId: "rejected-request-id", reasonFailed: "internal_provider_rejected_no_automatic_retry" });
    const retry = fixture([rejectedRow()]);
    const retries = await Promise.all([dispatch(retry, retryOptions), dispatch(retry, retryOptions)]);
    assert.equal(retries.reduce((sum, r) => sum + r.providerAcceptedCount, 0), 1);
    assert.equal(retry.sent.length, 1);
    assert.equal((await dispatch(retry, retryOptions)).providerAcceptedCount, 0);
    for (const patch of [
      { reasonFailed: "internal_provider_outcome_unknown_reconcile_before_retry" },
      { status: Status.SCHEDULED }, { status: Status.SENT }, { sentAt: at },
      { updatedAt: new Date(+at + 1) }, { orderNumber: "other" },
    ]) {
      const blocked = fixture([{ ...rejectedRow(), ...patch }]);
      assert.equal((await dispatch(blocked, retryOptions)).providerAcceptedCount, 0);
      assert.equal(blocked.sent.length, 0);
    }
    const scopeMissing = fixture([rejectedRow()]);
    await assert.rejects(dispatch(scopeMissing, { retryRejected: { expectedUpdatedAt: at } }), /exact order scope/);
    assert.equal(scopeMissing.writes(), 0);
    cases++;

    const runner39 = readFileSync(new URL("./run-42-day-confirmation-no-response.ts", import.meta.url), "utf8");
    assert.match(runner39, /eventIds: options.mode === "send" \? summary.internalEscalationEventIdsCreatedThisRun : \[\]/);
    assert.match(runner39, /senderIntegrated: true/);
    const runner8 = readFileSync(new URL("./run-delivery-interval.ts", import.meta.url), "utf8");
    assert.ok(runner8.indexOf("const internalDispatch = await dispatchInternalNotifications") < runner8.indexOf("if (scheduledEvents.length === 0)"));
    assert.match(runner8, /eventIds: config.interval === "8" \? explicitInternalIds \?\? \[\] : \[\]/);
    assert.doesNotMatch(runner8, /internalReportIds/);
    cases++;
    console.log(JSON.stringify({ ok: true, cases, realProviderCalls: 0, databaseWrites: 0 }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
