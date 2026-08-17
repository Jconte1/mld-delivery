import { redirect } from "next/navigation";

import { DeliveryConfirmationStatus } from "@/lib/generated/prisma/client";
import { getDeliveryGroupPaymentEvaluation } from "@/lib/delivery-payment/deliveryGroupPayment";
import { getDeliveryGroupReadiness } from "@/lib/delivery-readiness/orderLineReadiness";
import { DELIVERY_MANUAL_REVIEW_REASONS } from "@/lib/notifications/deliveryConfirmationManualReview";
import {
  confirmDeliveryFromWebpage,
  guardDeliveryConfirmationWebAction,
} from "@/lib/notifications/confirmDeliveryFromWebpage";
import {
  getRequestedDeliveryDateWebInstruction,
  getRequestedDeliveryDateWebMessageForCode,
  parseDateInputValue,
  validateRequestedDeliveryDateEligibility,
  type DeliveryDateEligibilityAddress,
} from "@/lib/notifications/deliveryDateEligibility";
import {
  dateFromKey,
  dateKey,
  formatCustomerFriendlyDate,
  formatJobAddress,
  formatJobName,
} from "@/lib/notifications/helpers";
import { getActiveSalespersonContact } from "@/lib/notifications/salespersonContactCache";
import { prisma } from "@/lib/prisma";
import { DeliveryItemsForThisDelivery } from "../../components/DeliveryItemsForThisDelivery";
import { DeliveryPaymentSummary } from "../../components/DeliveryPaymentSummary";
import { SalespersonContactBlock } from "../../components/SalespersonContactBlock";
import { DeliveryConfirmationActions } from "./DeliveryConfirmationActions";

type PageProps = {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ error?: string; updated?: string }>;
};

async function loadConfirmation(token: string) {
  const confirmation = await prisma.deliveryConfirmation.findUnique({
    where: { linkToken: token },
    include: {
      orderDeliveryGroup: {
        include: {
          order: {
            include: {
              address: true,
              contact: true,
            },
          },
        },
      },
    },
  });

  if (!confirmation) return null;

  const salespersonContact = await getActiveSalespersonContact(
    confirmation.orderDeliveryGroup.order.salespersonNumber
  );

  return {
    ...confirmation,
    salespersonContact,
    isExpired: Boolean(
      confirmation.linkExpiredAt ||
        (confirmation.linkExpiresAt && confirmation.linkExpiresAt.getTime() < Date.now())
    ),
  };
}

function titleCaseStatus(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function nextDateKey(value: Date | string) {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return dateKey(date);
}

function isFinalConfirmationStatus(value: DeliveryConfirmationStatus) {
  return (
    value === DeliveryConfirmationStatus.CONFIRMED ||
    value === DeliveryConfirmationStatus.NEW_DATE_REQUESTED
  );
}

function requestDateErrorMessage(value: string | undefined) {
  return getRequestedDeliveryDateWebMessageForCode(value);
}

function actionStateMessage(value: string | undefined) {
  if (value === "already_confirmed_in_acumatica") {
    return "This delivery has already been confirmed. Please contact Mountain Land Design if you need to make a change.";
  }
  if (value === "stale" || value === "expired") {
    return "This confirmation link is no longer valid. Please use the latest confirmation link or contact Mountain Land Design for help.";
  }
  if (value === "refresh_failed") {
    return "We could not verify the latest delivery details. Please contact Mountain Land Design before confirming or requesting a new date.";
  }
  return null;
}

function redirectToConfirmation(token: string, params: Record<string, string>): never {
  const query = new URLSearchParams(params).toString();
  redirect(`/delivery/confirm/${encodeURIComponent(token)}${query ? `?${query}` : ""}`);
}

function InfoState({ title, message }: { title: string; message: string }) {
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-12 text-zinc-950">
      <section className="mx-auto max-w-2xl rounded-lg bg-white p-8 shadow-sm ring-1 ring-zinc-200">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-4 text-base leading-7 text-zinc-700">{message}</p>
      </section>
    </main>
  );
}

async function confirmDelivery(formData: FormData) {
  "use server";

  const token = String(formData.get("token") ?? "");
  if (!token) redirect("/delivery/confirm/invalid");

  const result = await confirmDeliveryFromWebpage({ linkToken: token });
  if (result.outcome === "not_found") redirect("/delivery/confirm/invalid");

  if (result.outcome === "already_final") {
    redirectToConfirmation(token, { updated: "already_final" });
  }

  if (result.outcome === "already_confirmed_in_acumatica") {
    redirectToConfirmation(token, { updated: "already_confirmed_in_acumatica" });
  }

  if (
    result.outcome === "expired" ||
    result.outcome === "stale" ||
    result.outcome === "refresh_failed"
  ) {
    redirectToConfirmation(token, { updated: result.outcome });
  }

  if (result.outcome === "confirmed") {
    if (result.writeback.error) {
      console.error("[delivery-confirmation-writeback] enqueue failed after confirmation saved", {
        deliveryConfirmationId: result.confirmation.id,
        orderType: result.confirmation.orderType,
        orderNumber: result.confirmation.orderNumber,
        error: result.writeback.error,
      });
    } else {
      console.info("[delivery-confirmation-writeback] queued confirmation attribute job", {
        jobId: result.writeback.jobId,
        deliveryConfirmationId: result.confirmation.id,
        orderType: result.confirmation.orderType,
        orderNumber: result.confirmation.orderNumber,
        dryRun: result.writeback.payload.dryRun,
      });
    }
  }

  redirect(`/delivery/confirm/${encodeURIComponent(token)}?updated=confirmed`);
}

async function requestDifferentDate(formData: FormData) {
  "use server";

  const token = String(formData.get("token") ?? "");
  const requestedNewDateRaw = String(formData.get("requestedNewDate") ?? "").trim();
  if (!token) redirect("/delivery/confirm/invalid");

  const guard = await guardDeliveryConfirmationWebAction({
    linkToken: token,
  });
  if (guard.outcome === "not_found") redirect("/delivery/confirm/invalid");
  if (guard.outcome !== "eligible") {
    redirectToConfirmation(token, { updated: guard.outcome });
  }

  const confirmation = guard.confirmation;
  const parsed = parseDateInputValue(requestedNewDateRaw);
  const validation = validateRequestedDeliveryDateEligibility({
    requestedDate: parsed.valid ? parsed.date : null,
    currentDeliveryDate: confirmation.deliveryDate,
    address: confirmation.orderDeliveryGroup.order.address,
  });
  if (!validation.allowed) {
    redirectToConfirmation(token, { error: validation.reason });
  }

  const now = new Date();
  await prisma.deliveryConfirmation.update({
    where: { id: confirmation.id },
    data: {
      status: DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
      changeRequestedAt: now,
      requestedNewDate: validation.date,
      requestedNewDateRaw,
      requestedNewDateAt: now,
      manualReviewRequired: true,
      manualReviewReason: DELIVERY_MANUAL_REVIEW_REASONS.NEW_DATE_REQUESTED,
      manualReviewMarkedAt: now,
      manualReviewNotes:
        "Customer requested a different delivery date through the webpage confirmation link.",
    },
  });

  redirect(`/delivery/confirm/${encodeURIComponent(token)}?updated=change_requested`);
}

export default async function DeliveryConfirmationPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const search = searchParams ? await searchParams : {};
  const confirmation = await loadConfirmation(token);

  if (!confirmation) {
    return (
      <InfoState
        title="This delivery link is not valid"
        message="The confirmation link could not be found. Please contact Mountain Land Design if you need help with your delivery."
      />
    );
  }

  if (confirmation.isExpired) {
    return (
      <InfoState
        title="This delivery link has expired"
        message="This confirmation link is no longer active. Please contact Mountain Land Design if you need to confirm or change your delivery."
      />
    );
  }

  const group = confirmation.orderDeliveryGroup;
  const order = group.order;

  if (!group.isActive) {
    return (
      <InfoState
        title="This delivery date has changed"
        message="This delivery group is no longer active. Please use the latest confirmation link or contact Mountain Land Design for the current delivery details."
      />
    );
  }

  const deliveryDate = dateKey(group.deliveryDate);
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const jobAddress = formatJobAddress(order.address ?? {}) || "the job site";
  const readiness = await getDeliveryGroupReadiness(group.id);
  const payment = await getDeliveryGroupPaymentEvaluation(group.id);
  const statusLabel = titleCaseStatus(confirmation.status);
  const scheduledDateLabel = formatCustomerFriendlyDate(group.deliveryDate);
  const requestedNewDateLabel = confirmation.requestedNewDate
    ? formatCustomerFriendlyDate(confirmation.requestedNewDate)
    : null;
  const isFinalStatus = isFinalConfirmationStatus(confirmation.status);
  const minimumRequestedDate = nextDateKey(new Date());
  const deliveryAddress: DeliveryDateEligibilityAddress | null = order.address;
  const requestedDateInstruction = getRequestedDeliveryDateWebInstruction(deliveryAddress);
  const errorMessage = requestDateErrorMessage(search.error);
  const actionMessage = actionStateMessage(search.updated);
  const headerDateLine =
    confirmation.status === DeliveryConfirmationStatus.CONFIRMED
      ? `${order.buyerGroup ? `${order.buyerGroup} delivery` : "Delivery"} confirmed for ${scheduledDateLabel}`
      : confirmation.status === DeliveryConfirmationStatus.NEW_DATE_REQUESTED &&
          requestedNewDateLabel
        ? `New delivery date requested for ${requestedNewDateLabel}`
        : confirmation.status === DeliveryConfirmationStatus.AWAITING_NEW_DATE
          ? `New delivery date request started for ${scheduledDateLabel}`
          : `${order.buyerGroup ? `${order.buyerGroup} delivery` : "Delivery"} scheduled for ${scheduledDateLabel}`;

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <section className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-zinc-200">
          <p className="text-sm font-medium text-zinc-500">Delivery confirmation</p>
          <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{jobName}</h1>
              <p className="mt-2 text-lg text-zinc-700">{headerDateLine}</p>
            </div>
            <div className="rounded-md bg-zinc-100 px-4 py-3 text-sm text-zinc-700">
              <div>Order #: {group.orderNumber}</div>
              <div>Status: {statusLabel}</div>
            </div>
          </div>

          <SalespersonContactBlock contact={confirmation.salespersonContact} />

          {search.updated ? (
            <div className="mt-5 rounded-md bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 ring-1 ring-emerald-200">
              {actionMessage ?? "Your response was saved."}
            </div>
          ) : null}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <section className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-zinc-200">
            <h2 className="text-lg font-semibold">Delivery Details</h2>
            <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-medium text-zinc-500">Customer</dt>
                <dd className="mt-1 font-semibold text-zinc-900">
                  {order.customerDescription ?? "Not provided"}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-zinc-500">Job</dt>
                <dd className="mt-1 font-semibold text-zinc-900">
                  {order.locationDescription ?? "Not provided"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-medium text-zinc-500">Address</dt>
                <dd className="mt-1 font-semibold text-zinc-900">{jobAddress}</dd>
              </div>
              {requestedNewDateLabel ? (
                <>
                  <div>
                    <dt className="font-medium text-zinc-500">Current Scheduled Delivery Date</dt>
                    <dd className="mt-1 text-zinc-900">{scheduledDateLabel}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-zinc-500">Requested New Delivery Date</dt>
                    <dd className="mt-1 font-semibold text-zinc-900">{requestedNewDateLabel}</dd>
                  </div>
                </>
              ) : (
                <div className="sm:col-span-2">
                  <dt className="font-medium text-zinc-500">Requested Delivery Date</dt>
                  <dd className="mt-1 font-semibold text-zinc-900">{scheduledDateLabel}</dd>
                </div>
              )}
            </dl>

            <DeliveryConfirmationActions
              token={token}
              status={confirmation.status}
              scheduledDateLabel={scheduledDateLabel}
              requestedNewDateLabel={requestedNewDateLabel}
              minimumRequestedDate={minimumRequestedDate}
              currentDeliveryDate={deliveryDate}
              deliveryAddressState={deliveryAddress?.state ?? null}
              deliveryAddressPostalCode={deliveryAddress?.postalCode ?? null}
              requestedDateInstruction={requestedDateInstruction}
              isLocked={isFinalStatus}
              errorMessage={errorMessage}
              confirmDeliveryAction={confirmDelivery}
              requestDifferentDateAction={requestDifferentDate}
            />
          </section>

          <DeliveryPaymentSummary payment={payment} />
        </div>

        <DeliveryItemsForThisDelivery
          lines={readiness.lines}
          includedLineCount={readiness.includedLineCount}
          hasActionableIssues={readiness.hasActionableIssues}
        />
      </section>
    </main>
  );
}
