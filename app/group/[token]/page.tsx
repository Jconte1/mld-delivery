import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { loadCustomerNotificationGroup, groupCustomerStateError, respondToNotificationGroup, buildDeliveryNotificationGroupLink } from "@/lib/notifications/deliveryNotificationGroupCustomer";
import { getDeliveryGroupReadiness } from "@/lib/delivery-readiness/orderLineReadiness";
import { getDeliveryGroupPaymentEvaluation } from "@/lib/delivery-payment/deliveryGroupPayment";
import { getActiveSalespersonContact } from "@/lib/notifications/salespersonContactCache";
import { dateKey, formatCustomerFriendlyDate, formatJobAddress } from "@/lib/notifications/helpers";
import { getRequestedDeliveryDateWebInstruction } from "@/lib/notifications/deliveryDateEligibility";
import { DeliveryItemsForThisDelivery } from "@/app/delivery/components/DeliveryItemsForThisDelivery";
import { DeliveryPaymentSummary } from "@/app/delivery/components/DeliveryPaymentSummary";
import { SalespersonContactBlock } from "@/app/delivery/components/SalespersonContactBlock";
import { DeliveryInfoState } from "@/app/delivery/components/DeliveryInfoState";
import { DeliveryConfirmationActions } from "@/app/confirm/[token]/DeliveryConfirmationActions";

export const metadata = { robots: { index: false, follow: false } };

async function respond(form: FormData, action: "CONFIRM" | "REQUEST_DATE") {
  "use server";
  const token = String(form.get("token") ?? "");
  let outcome: string;
  try {
    outcome = (await respondToNotificationGroup({ client: prisma, token, action, source: "WEBPAGE",
      requestedDate: String(form.get("requestedNewDate") ?? "") })).outcome;
  } catch { outcome = "unable_to_process"; }
  const url = new URL(buildDeliveryNotificationGroupLink(token));
  url.searchParams.set("result", outcome);
  redirect(url.toString());
}
async function confirm(form: FormData) { "use server"; await respond(form, "CONFIRM"); }
async function requestDate(form: FormData) { "use server"; await respond(form, "REQUEST_DATE"); }

export default async function GroupDeliveryPage({ params, searchParams }: {
  params: Promise<{ token: string }>; searchParams: Promise<{ result?: string }>;
}) {
  const { token } = await params;
  const search = await searchParams;
  const group = await loadCustomerNotificationGroup(prisma, token);
  if (!group) return <DeliveryInfoState title="Delivery link not found" message="Please contact MLD for current delivery details." />;
  const stateError = groupCustomerStateError(group);
  if (stateError) return <DeliveryInfoState title="Delivery details have changed" message="This link is no longer current. Please use your latest delivery link or contact MLD." />;
  const first = group.members[0].notificationEvent.order;
  const isConfirmation = group.intervalType === "DAY_42";
  const showPayment = ["DAY_30", "DAY_14", "DAY_12", "DAY_10", "DAY_8"].includes(group.intervalType);
  const nextDay = new Date(group.deliveryDate); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const confirmations = isConfirmation ? await prisma.deliveryConfirmation.findMany({
    where: { id: { in: group.members.flatMap(m => m.deliveryConfirmationId ? [m.deliveryConfirmationId] : []) } },
  }) : [];
  const responseProblems = confirmations.some(c => [c.confirmationWritebackStatus, c.requestedDateWritebackStatus].some(s =>
    s === "enqueue_failed" || s === "enqueue_pending" || s === "failed"));
  const blocks = [];
  for (const member of group.members) {
    const event = member.notificationEvent;
    const readiness = await getDeliveryGroupReadiness(event.deliveryGroupId);
    const payment = showPayment ? await getDeliveryGroupPaymentEvaluation(event.deliveryGroupId) : null;
    const salesperson = await getActiveSalespersonContact(event.order.salespersonNumber);
    blocks.push(<section key={member.id} className="border-t border-zinc-200 py-6 space-y-5">
      <h2 className="text-xl font-semibold">Order {event.orderNumber}</h2>
      <SalespersonContactBlock contact={salesperson} />
      <DeliveryItemsForThisDelivery lines={readiness.lines} includedLineCount={readiness.includedLineCount} hasActionableIssues={readiness.hasActionableIssues} />
      {payment ? <DeliveryPaymentSummary payment={payment} /> : null}
    </section>);
  }
  return <main className="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950"><div className="mx-auto max-w-6xl space-y-6">
    <header className="space-y-3">
      <h1 className="text-2xl font-semibold">{isConfirmation ? "Delivery confirmation" : "Your delivery"}</h1>
      <p className="font-semibold break-words">Orders: {group.members.map(m => m.notificationEvent.orderNumber).join(", ")}</p>
      <p>{formatCustomerFriendlyDate(group.deliveryDate)}</p><p>{formatJobAddress(first.address ?? {})}</p>
      {responseProblems || search.result === "unable_to_process" || search.result === "writeback_attention_required" ?
        <p role="alert" className="text-red-800">We could not complete every update. Please contact MLD to verify each order before relying on a changed date.</p> : null}
    </header>
    {isConfirmation ? <DeliveryConfirmationActions token={token}
      status={group.responseAction === "CONFIRM" ? "CONFIRMED" : group.responseAction === "REQUEST_DATE" ? "NEW_DATE_REQUESTED" : "PENDING"}
      scheduledDateLabel={formatCustomerFriendlyDate(group.deliveryDate)} requestedNewDateLabel={group.responseDate ? formatCustomerFriendlyDate(group.responseDate) : null}
      minimumRequestedDate={dateKey(nextDay)} currentDeliveryDate={dateKey(group.deliveryDate)}
      deliveryAddressState={first.address?.state ?? null} deliveryAddressPostalCode={first.address?.postalCode ?? null}
      requestedDateInstruction={getRequestedDeliveryDateWebInstruction(first.address)}
      isLocked={Boolean(group.responseAt)} errorMessage={null} confirmDeliveryAction={confirm} requestDifferentDateAction={requestDate} /> : null}
    {blocks}
  </div></main>;
}
