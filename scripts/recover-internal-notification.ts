import { prisma } from "../lib/prisma";
import { dispatchInternalNotifications } from "../lib/notifications/internalNotificationDispatcher";

const phrase = "RETRY ONE REJECTED INTERNAL EMAIL";

async function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let send = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--send") { send = true; continue; }
    if (!["--event-id", "--order-type", "--order-number", "--expected-updated-at", "--confirm"].includes(args[i]) ||
        !args[i + 1] || args[i + 1].startsWith("--") || values.has(args[i])) throw new Error("Invalid or duplicate argument");
    values.set(args[i], args[++i]);
  }
  const eventId = values.get("--event-id");
  if (!eventId?.trim()) throw new Error("--event-id is required; default mode is read-only inspection");
  const event = await prisma.internalNotificationEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error("Internal event not found");
  const eligible = event.status === "FAILED" && event.providerName === "ms_graph" && !event.sentAt &&
    !event.reasonSkipped && event.reasonFailed === "internal_provider_rejected_no_automatic_retry";
  // Retain this output as the before/after operator audit; never erase or release an uncertain claim.
  console.log(JSON.stringify({ phase: "recovery_inspection", eventId, orderType: event.orderType,
    orderNumber: event.orderNumber, purpose: event.purpose, status: event.status,
    updatedAt: event.updatedAt.toISOString(), reason: event.reasonFailed ?? event.reasonSkipped,
    recipientConfigured: Boolean(event.recipientEmail), subject: event.subject,
    previousProviderIdMasked: event.providerMessageId ? `***${event.providerMessageId.slice(-6)}` : null,
    retryEligible: eligible, sends: 0,
    nextAction: eligible ? "Review order relevance, recipient and content before explicit retry" : "Reconcile manually; this command cannot retry accepted, uncertain, skipped, or in-flight events" }));
  if (!send) return;
  if (values.get("--confirm") !== phrase) throw new Error(`--confirm must equal "${phrase}"`);
  if (!eligible) throw new Error("Retry blocked: provider non-acceptance is not proven");
  if (values.get("--order-type") !== event.orderType || values.get("--order-number") !== event.orderNumber ||
      values.get("--expected-updated-at") !== event.updatedAt.toISOString()) throw new Error("Exact reviewed order and updatedAt are required");
  const result = await dispatchInternalNotifications({ eventIds: [event.id], purposes: [event.purpose],
    orderScope: { orderType: event.orderType, orderNumber: event.orderNumber },
    retryRejected: { expectedUpdatedAt: event.updatedAt } });
  console.log(JSON.stringify({ phase: "recovery_result", ...result }));
  if (!result.ok || result.providerAcceptedCount !== 1) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Recovery failed" }));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
