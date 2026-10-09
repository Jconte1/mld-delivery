import {
  InternalNotificationPurpose,
  InternalNotificationStatus,
  type Prisma,
  type PrismaClient,
} from "../generated/prisma/client";
import {
  DeliveryNotificationProviderError,
  type DeliveryNotificationProvider,
  type DeliveryNotificationProviderResult,
} from "./deliveryNotificationProviders";

type Client = Pick<PrismaClient, "internalNotificationEvent">;
type EmailProvider = Pick<DeliveryNotificationProvider, "sendEmail">;

const select = {
  id: true, purpose: true, audienceType: true, recipientEmail: true,
  subject: true, bodyPreview: true, updatedAt: true,
} satisfies Prisma.InternalNotificationEventSelect;

export type InternalDispatchReport = {
  eventId: string;
  outcome: "submitted" | "failed" | "skipped" | "not_claimed" | "reconciliation_required";
  reason: string | null;
  providerName: string | null;
  providerMessageIdMasked: string | null;
};

const CLAIM_REASON = "internal_send_claimed_outcome_unknown_reconcile_before_retry";

// Keep Graph request IDs (not invented message IDs), including on rejected requests.
// This email-only adapter does not use customer routing, SMS, or writeback paths.
export function createInternalEmailProvider(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch
): EmailProvider {
  return {
    async sendEmail(input) {
      const required = (name: string) => {
        const value = env[name]?.trim();
        if (!value) throw new DeliveryNotificationProviderError({
          provider: "ms_graph", providerCode: "INTERNAL_CONFIGURATION_MISSING",
          message: `Missing env var: ${name}`,
        });
        return value;
      };
      const tenant = required("MS_GRAPH_TENANT_ID");
      const client = required("MS_GRAPH_CLIENT_ID");
      const secret = required("MS_GRAPH_CLIENT_SECRET");
      const from = required("MS_GRAPH_FROM_EMAIL");
      let token: string;
      try {
        const response = await request(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: client, client_secret: secret,
            scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }).toString(),
        });
        if (!response.ok) throw new Error("Token rejected");
        const json = await response.json() as { access_token?: unknown };
        if (typeof json.access_token !== "string" || !json.access_token) throw new Error("Token missing");
        token = json.access_token;
      } catch {
        throw new DeliveryNotificationProviderError({ provider: "ms_graph",
          providerCode: "INTERNAL_TOKEN_FAILED_BEFORE_SEND", message: "Graph authentication failed before email submission" });
      }
      const response = await request(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { subject: input.subject,
          body: { contentType: "Text", content: input.textBody },
          toRecipients: [{ emailAddress: { address: input.to } }] }, saveToSentItems: true }),
      });
      const externalMessageId = response.headers.get("request-id");
      if (response.status !== 202) throw new DeliveryNotificationProviderError({
        provider: "ms_graph", providerCode: "INTERNAL_SEND_NOT_ACCEPTED", httpStatus: response.status,
        externalMessageId, message: `Graph internal email response: ${response.status}`,
      });
      return { provider: "ms_graph", externalMessageId, providerCode: "accepted", httpStatus: response.status };
    },
  };
}

function knownRejection(error: unknown) {
  if (!(error instanceof DeliveryNotificationProviderError)) return false;
  return ["INTERNAL_CONFIGURATION_MISSING", "INTERNAL_TOKEN_FAILED_BEFORE_SEND"].includes(error.providerCode ?? "") ||
    (error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408);
}

export async function dispatchInternalNotifications(options: {
  eventIds: string[];
  purposes: InternalNotificationPurpose[];
  orderScope?: { orderType: string; orderNumber: string } | null;
  createdSince?: Date;
  client?: Client;
  provider?: EmailProvider;
  now?: () => Date;
  // Operator-only recovery: never reset a failed event to PENDING or scan a backlog.
  retryRejected?: { expectedUpdatedAt: Date };
}) {
  if (!Array.isArray(options.eventIds) || options.eventIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("Internal dispatch requires explicit nonblank current-run event IDs");
  }
  if (!options.purposes?.length || options.purposes.some(purpose => !Object.values(InternalNotificationPurpose).includes(purpose))) {
    throw new Error("Internal dispatch requires explicit supported purposes");
  }
  const reports: InternalDispatchReport[] = [];
  const ids = [...new Set(options.eventIds)];
  if (options.retryRejected && (ids.length !== 1 || !options.orderScope?.orderType ||
      !options.orderScope.orderNumber || !Number.isFinite(+options.retryRejected.expectedUpdatedAt))) {
    throw new Error("Internal retry requires one event, exact order scope, and reviewed updatedAt");
  }
  const summarize = () => ({
    ok: reports.every(report => !["failed", "reconciliation_required"].includes(report.outcome)),
    requestedCount: ids.length,
    providerAcceptedCount: reports.filter(report => report.outcome === "submitted").length,
    providerFailedCount: reports.filter(report => report.outcome === "failed").length,
    reconciliationRequiredCount: reports.filter(report => report.outcome === "reconciliation_required").length,
    reports,
  });
  // An empty ID list must not initialize a database connection or discover a backlog.
  if (!ids.length) return summarize();
  const client = options.client ?? (await import("../prisma")).prisma;
  const provider = options.provider ?? createInternalEmailProvider();
  const where: Prisma.InternalNotificationEventWhereInput = {
    id: { in: ids }, purpose: { in: options.purposes },
    orderType: options.orderScope?.orderType, orderNumber: options.orderScope?.orderNumber,
    createdAt: options.createdSince ? { gte: options.createdSince } : undefined,
    status: options.retryRejected ? InternalNotificationStatus.FAILED : InternalNotificationStatus.PENDING,
    providerName: options.retryRejected ? "ms_graph" : null,
    providerMessageId: options.retryRejected ? undefined : null,
    updatedAt: options.retryRejected?.expectedUpdatedAt,
    sentAt: null,
    reasonFailed: options.retryRejected ? "internal_provider_rejected_no_automatic_retry" : null,
    reasonSkipped: null,
  };
  const events = await client.internalNotificationEvent.findMany({ where, select });
  const found = new Set(events.map(event => event.id));
  for (const eventId of ids.filter(id => !found.has(id))) reports.push({ eventId,
    outcome: "not_claimed", reason: "not_eligible_pending_current_run_event", providerName: null, providerMessageIdMasked: null });

  for (const event of events) {
    const report: InternalDispatchReport = { eventId: event.id, outcome: "not_claimed", reason: null,
      providerName: null, providerMessageIdMasked: null };
    reports.push(report);
    // SCHEDULED is a durable, non-expiring claim in the existing enum. No retry of
    // SCHEDULED/FAILED is automatic, including after a process crash or timeout.
    const claim = await client.internalNotificationEvent.updateMany({
      where: { ...where, id: event.id, updatedAt: event.updatedAt },
      data: { status: InternalNotificationStatus.SCHEDULED, providerName: "ms_graph", reasonFailed: CLAIM_REASON },
    });
    if (claim.count !== 1) continue;

    const recipient = event.recipientEmail?.trim();
    const invalidReason = !recipient || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(recipient)
      ? "invalid_internal_recipient"
      : !event.subject?.trim() || !event.bodyPreview?.trim() ? "missing_internal_email_content" : null;
    let data: Prisma.InternalNotificationEventUpdateManyMutationInput;
    if (invalidReason) {
      report.outcome = "skipped";
      report.reason = invalidReason;
      data = { status: InternalNotificationStatus.SKIPPED, providerName: null, reasonFailed: null, reasonSkipped: invalidReason };
    } else {
      let result: DeliveryNotificationProviderResult | null = null;
      let failure: unknown;
      try {
        result = await provider.sendEmail({ to: recipient!, subject: event.subject!, textBody: event.bodyPreview! });
      } catch (error) {
        failure = error;
      }
      const accepted = result?.provider === "ms_graph" && result.httpStatus === 202;
      const definiteFailure = !result && knownRejection(failure);
      const evidence = result ?? (failure instanceof DeliveryNotificationProviderError ? failure : null);
      const providerId = evidence?.externalMessageId ?? null;
      report.providerName = evidence?.provider ?? "ms_graph";
      report.providerMessageIdMasked = providerId ? `***${providerId.slice(-6)}` : null;
      report.outcome = accepted ? "submitted" : definiteFailure ? "failed" : "reconciliation_required";
      report.reason = accepted ? null : definiteFailure ? "internal_provider_rejected_no_automatic_retry" : "internal_provider_outcome_unknown_reconcile_before_retry";
      data = { status: accepted ? InternalNotificationStatus.SENT : InternalNotificationStatus.FAILED,
        providerName: report.providerName, providerMessageId: providerId,
        sentAt: accepted ? (options.now?.() ?? new Date()) : null,
        reasonFailed: report.reason, reasonSkipped: null };
    }
    // Persistence errors after acceptance must never be treated as provider failures.
    try {
      const saved = await client.internalNotificationEvent.updateMany({
        where: { id: event.id, status: InternalNotificationStatus.SCHEDULED, reasonFailed: CLAIM_REASON }, data,
      });
      if (saved.count !== 1) throw new Error("Internal claim changed before result persistence");
    } catch {
      report.outcome = "reconciliation_required";
      report.reason = "internal_result_persistence_failed_reconcile_before_retry";
      // Best effort to retain provider evidence without releasing the durable claim.
      try {
        await client.internalNotificationEvent.updateMany({
          where: { id: event.id, status: InternalNotificationStatus.SCHEDULED, reasonFailed: CLAIM_REASON },
          data: { ...data, status: InternalNotificationStatus.SCHEDULED, reasonFailed: report.reason },
        });
      } catch { /* The original claim remains non-retryable when storage is unavailable. */ }
    }
  }
  return summarize();
}
