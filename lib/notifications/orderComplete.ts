import { mapAcumaticaContactOptIns } from "@/lib/acumatica/contactOptInFields";
import { selectNotificationChannel, type NotificationChannel } from "@/lib/notifications/helpers";
import { normalizeEmailForOptOut, normalizeSmsPhoneForOptOut } from "@/lib/notifications/notificationAddressNormalization";
import type { ActiveNotificationOptOutAddresses } from "@/lib/notifications/notificationOptOutLookup";
import { DeliveryNotificationProviderError, type DeliveryNotificationProvider, type DeliveryNotificationProviderResult } from "@/lib/notifications/deliveryNotificationProviders";
import { renderOrderComplete } from "@/lib/notifications/orderCompleteTemplates";

export const ORDER_COMPLETE_DISCOVERY_BLOCKER = "order_complete_discovery_unproven: queue needs a fully paginated completed-order source with an authoritative completion timestamp";
export const ORDER_COMPLETE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_FRESHNESS_MS = 5 * 60 * 1000;

export type OrderCompleteWindow = { after: Date; through: Date };
export type OrderCompleteCandidate = { orderType: string; orderNumber: string; completedAt: string };
export type OrderCompleteDiscovery = {
  jobId: string;
  complete: boolean;
  candidates: OrderCompleteCandidate[];
};
export type OrderCompleteClaim = OrderCompleteCandidate & {
  contactId: string;
  channel: NotificationChannel;
  recipient: string;
  smsOptIn: boolean;
  emailOptIn: boolean;
  discoveryJobId: string;
  checkedAt: Date;
};
export type OrderCompleteReceipt = {
  provider: string;
  externalMessageId: string | null;
  providerRequestId: string | null;
  providerCode: string | null;
  httpStatus: number | null;
};
export type OrderCompleteStore = {
  exists(candidate: OrderCompleteCandidate): Promise<boolean>;
  // Must atomically insert event AND attempt, unique on (orderType, orderNumber).
  // An existing claim is never reset, expired, or retried, regardless of status.
  claim(input: OrderCompleteClaim): Promise<{ eventId: string; attemptId: string } | null>;
  submitted(attemptId: string, receipt: OrderCompleteReceipt, at: Date): Promise<void>;
  review(attemptId: string, receipt: OrderCompleteReceipt | null, reason: string): Promise<void>;
};
export type OrderCompleteDependencies = {
  discover(window: OrderCompleteWindow): Promise<OrderCompleteDiscovery>;
  erp: {
    fetchDeliverySalesOrderByOrderNumber(number: string, type: string): Promise<unknown[]>;
    fetchDeliveryContactByContactId(id: string): Promise<unknown[]>;
  };
  loadOptOuts(): Promise<ActiveNotificationOptOutAddresses>;
  store: OrderCompleteStore;
  provider: DeliveryNotificationProvider;
  statusCallbackUrl(): string;
  clock(): Date;
};

function field(row: unknown, key: string): string | null {
  if (!row || typeof row !== "object") return null;
  let value = (row as Record<string, unknown>)[key];
  if (value && typeof value === "object" && "value" in value) value = value.value;
  return typeof value === "string" || typeof value === "number" ? String(value).trim() || null : null;
}
function key(value: string | null) { return (value ?? "").trim().toUpperCase(); }
function timestamp(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) throw new Error("completion_timestamp_must_be_utc_instant");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error("invalid_completion_timestamp");
  return parsed;
}
export function orderCompleteWindow(now: Date, launchAt: string): OrderCompleteWindow {
  const launch = timestamp(launchAt);
  if (!Number.isFinite(now.getTime()) || launch > now) throw new Error("invalid_order_complete_launch_time");
  return { after: new Date(Math.max(launch.getTime(), now.getTime() - ORDER_COMPLETE_WINDOW_MS)), through: now };
}
function receipt(result: DeliveryNotificationProviderResult): OrderCompleteReceipt {
  // The shared Graph sendMail adapter returns request-id, NOT a message ID.
  return {
    provider: result.provider,
    externalMessageId: result.provider === "twilio" ? result.externalMessageId : null,
    providerRequestId: result.provider === "ms_graph" ? result.externalMessageId : null,
    providerCode: result.providerCode,
    httpStatus: result.httpStatus,
  };
}
function assertFresh(start: Date, now: Date) {
  const age = now.getTime() - start.getTime();
  if (!Number.isFinite(age) || age < 0 || age > MAX_FRESHNESS_MS) throw new Error("fresh_erp_snapshot_expired");
}

export async function runOrderComplete(
  options: { send: boolean; launchAt: string; now?: Date; env?: NodeJS.ProcessEnv },
  deps: OrderCompleteDependencies,
) {
  const env = options.env ?? process.env;
  if (options.send && env.DELIVERY_REAL_CUSTOMER_SEND_ENABLED?.trim().toLowerCase() !== "true") throw new Error("real_customer_send_disabled");
  const window = orderCompleteWindow(options.now ?? deps.clock(), options.launchAt);
  const report = await deps.discover(window);
  if (!report.complete || !report.jobId?.trim() || !Array.isArray(report.candidates)) throw new Error("incomplete_order_complete_discovery");
  // Validate the entire discovery batch before allowing any side effect.
  const candidates = new Map<string, OrderCompleteCandidate>();
  for (const row of report.candidates) {
    const orderType = key(row.orderType), orderNumber = key(row.orderNumber);
    if (!/^[A-Z0-9_-]{1,16}$/.test(orderType) || !/^[A-Z0-9_-]{1,64}$/.test(orderNumber)) throw new Error("invalid_order_identity");
    const completedAt = timestamp(row.completedAt);
    if (completedAt <= window.after || completedAt > window.through) continue;
    const id = `${orderType}:${orderNumber}`;
    const candidate = { orderType, orderNumber, completedAt: completedAt.toISOString() };
    const prior = candidates.get(id);
    if (prior && prior.completedAt !== candidate.completedAt) throw new Error("conflicting_completion_timestamps");
    candidates.set(id, candidate);
  }
  const results: Array<{ orderType: string; orderNumber: string; outcome: string; reason?: string }> = [];
  for (const candidate of candidates.values()) {
    const identity = { orderType: candidate.orderType, orderNumber: candidate.orderNumber };
    try {
      if (await deps.store.exists(candidate)) { results.push({ ...identity, outcome: "deduped" }); continue; }
      const started = deps.clock();
      const orders = await deps.erp.fetchDeliverySalesOrderByOrderNumber(candidate.orderNumber, candidate.orderType);
      const matches = orders.filter(row => key(field(row, "OrderType")) === candidate.orderType && key(field(row, "OrderNbr")) === candidate.orderNumber);
      if (matches.length !== 1) throw new Error("fresh_order_not_uniquely_matched");
      const order = matches[0];
      if (key(field(order, "Status")) !== "COMPLETED") {
        results.push({ ...identity, outcome: "skipped", reason: "order_not_completed" }); continue;
      }
      const contactId = field(order, "ContactID");
      // ERP ContactID is numeric. Never accept generated TEMP identities or DeliveryContact.
      if (!contactId || !/^[1-9]\d*$/.test(contactId)) throw new Error("real_primary_contact_id_missing");
      const contacts = await deps.erp.fetchDeliveryContactByContactId(contactId);
      const matched = contacts.filter(row => field(row, "ContactID") === contactId);
      if (matched.length !== 1) throw new Error("fresh_primary_contact_not_uniquely_matched");
      const contact = matched[0];
      if (key(field(contact, "Status")) !== "ACTIVE") throw new Error("primary_contact_not_active");
      const optIns = mapAcumaticaContactOptIns(contact);
      const email = normalizeEmailForOptOut(field(contact, "Email"));
      const fresh = {
        ...optIns,
        email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
        phone1: normalizeSmsPhoneForOptOut(field(contact, "Phone1")),
        phone2: normalizeSmsPhoneForOptOut(field(contact, "Phone2")),
      };
      // Query active opt-outs for ALL addresses, including entries linked to other contacts.
      const optOuts = await deps.loadOptOuts();
      if (!Array.isArray(optOuts?.activeSmsOptOutPhones) || !Array.isArray(optOuts?.activeEmailOptOutEmails)) throw new Error("opt_out_lookup_unavailable");
      const selected = selectNotificationChannel(fresh, optOuts);
      assertFresh(started, deps.clock());
      if (!selected.selectedChannel) { results.push({ ...identity, outcome: "skipped", reason: selected.channelReason }); continue; }
      if (!options.send) { results.push({ ...identity, outcome: "previewed" }); continue; }
      const recipient = selected.selectedChannel === "SMS" ? selected.recipientPhone : selected.recipientEmail;
      const rendered = renderOrderComplete(candidate, selected.selectedChannel);
      const statusCallbackUrl = selected.selectedChannel === "SMS" ? deps.statusCallbackUrl() : "";
      const claimed = await deps.store.claim({ ...candidate, ...optIns, contactId, channel: selected.selectedChannel, recipient, discoveryJobId: report.jobId, checkedAt: deps.clock() });
      if (!claimed) { results.push({ ...identity, outcome: "deduped" }); continue; }
      let providerResult: DeliveryNotificationProviderResult;
      try {
        assertFresh(started, deps.clock());
        providerResult = selected.selectedChannel === "SMS"
          ? await deps.provider.sendSms({ to: recipient, body: rendered.textBody, statusCallbackUrl })
          : await deps.provider.sendEmail({ to: recipient, ...rendered });
      } catch (error) {
        const details = error instanceof DeliveryNotificationProviderError ? receipt(error) : null;
        await deps.store.review(claimed.attemptId, details, "provider_outcome_unknown_no_retry");
        results.push({ ...identity, outcome: "review", reason: "provider_outcome_unknown_no_retry" }); continue;
      }
      const details = receipt(providerResult);
      const expectedProvider = selected.selectedChannel === "SMS" ? "twilio" : "ms_graph";
      if (providerResult.provider !== expectedProvider || !providerResult.externalMessageId?.trim() || !providerResult.httpStatus || providerResult.httpStatus < 200 || providerResult.httpStatus >= 300) {
        await deps.store.review(claimed.attemptId, details, "provider_acceptance_unproven_no_retry");
        results.push({ ...identity, outcome: "review", reason: "provider_acceptance_unproven_no_retry" }); continue;
      }
      // Persistence failure must NOT release the claim or cause a second provider call.
      await deps.store.submitted(claimed.attemptId, details, deps.clock());
      results.push({ ...identity, outcome: "submitted" });
    } catch {
      results.push({ ...identity, outcome: "failed_closed", reason: "order_complete_processing_failed" });
    }
  }
  return { ok: !results.some(row => ["review", "failed_closed"].includes(row.outcome)), window: { after: window.after.toISOString(), through: window.through.toISOString() }, discoveryJobId: report.jobId, results };
}

export async function runScheduledOrderComplete(params: { now?: Date; send?: boolean } = {}) {
  if (process.env.DELIVERY_ORDER_COMPLETE_ENABLED?.trim().toLowerCase() !== "true") return { ok: true, phase: "disabled" } as const;
  // No speculative endpoint, Thank You report fallback, or local completed-order broadcast.
  // Replace only after the queue contract and timestamp provenance have been verified.
  void params;
  return { ok: false, phase: "blocked", reason: ORDER_COMPLETE_DISCOVERY_BLOCKER } as const;
}
