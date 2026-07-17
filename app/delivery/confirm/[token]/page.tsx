import { redirect } from "next/navigation";

import {
  DeliveryConfirmationStatus,
  type OrderLine,
} from "@/lib/generated/prisma/client";
import { getDeliveryGroupPaymentEvaluation } from "@/lib/delivery-payment/deliveryGroupPayment";
import { getDeliveryGroupReadiness } from "@/lib/delivery-readiness/orderLineReadiness";
import { confirmDeliveryFromWebpage } from "@/lib/notifications/confirmDeliveryFromWebpage";
import {
  dateFromKey,
  dateKey,
  formatCurrencyAmount,
  formatCustomerFriendlyDate,
  formatJobAddress,
  formatJobName,
} from "@/lib/notifications/helpers";
import { prisma } from "@/lib/prisma";
import { DeliveryConfirmationActions } from "./DeliveryConfirmationActions";

type PageProps = {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ error?: string; updated?: string }>;
};

type DeliveryLine = Pick<
  OrderLine,
  | "lineNbr"
  | "inventoryId"
  | "lineDescription"
  | "eta"
  | "orderQty"
  | "openQty"
  | "activeAllocatedQty"
  | "displayStatus"
  | "readinessStatus"
>;

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
              lines: {
                orderBy: { lineNbr: "asc" },
              },
            },
          },
        },
      },
    },
  });

  if (!confirmation) return null;

  return {
    ...confirmation,
    isExpired: Boolean(
      confirmation.linkExpiresAt && confirmation.linkExpiresAt.getTime() < Date.now()
    ),
  };
}

function quantity(value: { toString(): string } | null | undefined) {
  if (value === null || value === undefined) return "";
  const numeric = Number(value.toString());
  if (!Number.isFinite(numeric)) return value.toString();
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
}

function statusClass(status: string | null | undefined) {
  switch (status) {
    case "ready":
    case "complete":
      return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "eta_pending":
    case "expected_on_time":
      return "bg-amber-50 text-amber-800 ring-amber-200";
    case "backordered":
    case "partially_allocated":
      return "bg-rose-50 text-rose-800 ring-rose-200";
    default:
      return "bg-zinc-100 text-zinc-700 ring-zinc-200";
  }
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

function isWeekendDate(value: Date | string) {
  const day = dateFromKey(value).getUTCDay();
  return day === 0 || day === 6;
}

function parseDateKeyOrNull(value: string) {
  try {
    return dateFromKey(value);
  } catch {
    return null;
  }
}

function isFinalConfirmationStatus(value: DeliveryConfirmationStatus) {
  return (
    value === DeliveryConfirmationStatus.CONFIRMED ||
    value === DeliveryConfirmationStatus.NEW_DATE_REQUESTED
  );
}

function requestDateErrorMessage(value: string | undefined) {
  switch (value) {
    case "missing_date":
      return "Please choose a requested delivery date.";
    case "earlier_date":
      return "Please choose a date later than your current scheduled delivery date.";
    case "weekend_date":
      return "Please choose a weekday delivery date.";
    default:
      return null;
  }
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
  if (result.outcome === "already_final") {
    redirectToConfirmation(token, { updated: "already_final" });
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

  const confirmation = await prisma.deliveryConfirmation.findUnique({
    where: { linkToken: token },
    select: {
      id: true,
      status: true,
      deliveryDate: true,
      requestedNewDate: true,
    },
  });
  if (confirmation) {
    if (isFinalConfirmationStatus(confirmation.status)) {
      redirectToConfirmation(token, { updated: "already_final" });
    }

    if (!requestedNewDateRaw) {
      redirectToConfirmation(token, { error: "missing_date" });
    }

    const requestedNewDate = parseDateKeyOrNull(requestedNewDateRaw);
    if (!requestedNewDate) {
      redirectToConfirmation(token, { error: "missing_date" });
    }

    const currentDate = confirmation.requestedNewDate ?? confirmation.deliveryDate;
    if (requestedNewDate.getTime() <= dateFromKey(currentDate).getTime()) {
      redirectToConfirmation(token, { error: "earlier_date" });
    }

    if (isWeekendDate(requestedNewDate)) {
      redirectToConfirmation(token, { error: "weekend_date" });
    }

    await prisma.deliveryConfirmation.update({
      where: { id: confirmation.id },
      data: {
        status: DeliveryConfirmationStatus.NEW_DATE_REQUESTED,
        changeRequestedAt: new Date(),
        requestedNewDate,
        requestedNewDateRaw,
        requestedNewDateAt: new Date(),
      },
    });
  }

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
  const lines: DeliveryLine[] = order.lines.filter(
    (line) => line.requestedOn && dateKey(line.requestedOn) === deliveryDate
  );
  const readiness = await getDeliveryGroupReadiness(group.id);
  const payment = await getDeliveryGroupPaymentEvaluation(group.id);
  const showAmountDue = payment.paymentStatus === "balance_due" && payment.amountDueNowRounded;
  const statusLabel = titleCaseStatus(confirmation.status);
  const scheduledDateLabel = formatCustomerFriendlyDate(group.deliveryDate);
  const requestedNewDateLabel = confirmation.requestedNewDate
    ? formatCustomerFriendlyDate(confirmation.requestedNewDate)
    : null;
  const isFinalStatus = isFinalConfirmationStatus(confirmation.status);
  const minimumRequestedDate = nextDateKey(confirmation.requestedNewDate ?? group.deliveryDate);
  const errorMessage = requestDateErrorMessage(search.error);
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

          {search.updated ? (
            <div className="mt-5 rounded-md bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 ring-1 ring-emerald-200">
              Your response was saved.
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
              isLocked={isFinalStatus}
              errorMessage={errorMessage}
              confirmDeliveryAction={confirmDelivery}
              requestDifferentDateAction={requestDifferentDate}
            />
          </section>

          <aside className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-zinc-200">
            <h2 className="text-lg font-semibold">Payment</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="font-medium text-zinc-500">Payment status</dt>
                <dd className="mt-1 capitalize text-zinc-900">
                  {payment.paymentStatus.replace(/_/g, " ")}
                </dd>
              </div>
              {showAmountDue ? (
                <div>
                  <dt className="font-medium text-zinc-500">Amount due now</dt>
                  <dd className="mt-1 text-2xl font-semibold">
                    {formatCurrencyAmount(payment.amountDueNowRounded)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="font-medium text-zinc-500">Unpaid balance</dt>
                <dd className="mt-1 text-zinc-900">
                  {formatCurrencyAmount(payment.unpaidBalance)}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-zinc-500">Current delivery value</dt>
                <dd className="mt-1 text-zinc-900">
                  {formatCurrencyAmount(payment.currentDeliveryGroupValue)}
                </dd>
              </div>
            </dl>
            {payment.calculationWarnings.length > 0 ? (
              <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                {payment.calculationWarnings.join(" ")}
              </div>
            ) : null}
          </aside>
        </div>

        <section className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-zinc-200">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Items For This Delivery</h2>
              <p className="mt-1 text-sm text-zinc-600">
                {readiness.includedLineCount} included lines, {readiness.hasActionableIssues ? "some items need review" : "items look ready or complete"}.
              </p>
            </div>
          </div>
          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-200 text-sm">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="py-3 pr-4 font-medium">Line</th>
                  <th className="py-3 pr-4 font-medium">Item</th>
                  <th className="py-3 pr-4 font-medium">Qty</th>
                  <th className="py-3 pr-4 font-medium">Open</th>
                  <th className="py-3 pr-4 font-medium">ETA</th>
                  <th className="py-3 pr-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {lines.map((line) => (
                  <tr key={line.lineNbr} className="align-top">
                    <td className="py-3 pr-4 text-zinc-500">{line.lineNbr}</td>
                    <td className="py-3 pr-4">
                      <div className="font-medium text-zinc-900">{line.inventoryId ?? "Item"}</div>
                      <div className="mt-1 max-w-xl text-zinc-600">{line.lineDescription}</div>
                    </td>
                    <td className="py-3 pr-4">{quantity(line.orderQty)}</td>
                    <td className="py-3 pr-4">{quantity(line.openQty)}</td>
                    <td className="py-3 pr-4">{line.eta ? dateKey(line.eta) : "Pending"}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${statusClass(
                          line.readinessStatus
                        )}`}
                      >
                        {line.displayStatus ?? "Not calculated"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}
