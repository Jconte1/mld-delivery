import { formatCurrencyAmount } from "@/lib/notifications/helpers";

export type DeliveryPaymentSummaryInput = {
  paymentStatus: string;
  amountDueNowRounded?: string | null;
  unpaidBalance?: string | null;
  currentDeliveryGroupValue?: string | null;
  calculationWarnings?: string[];
};

export function deliveryHasBalanceDue(payment: DeliveryPaymentSummaryInput) {
  return payment.paymentStatus === "balance_due" && Boolean(payment.amountDueNowRounded);
}

export function DeliveryPaymentSummary({
  payment,
}: {
  payment: DeliveryPaymentSummaryInput;
}) {
  const showAmountDue = deliveryHasBalanceDue(payment);

  return (
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
            <dt className="font-medium text-zinc-500">
              Balance owed prior to scheduling Delivery
            </dt>
            <dd className="mt-1 text-2xl font-semibold">
              {formatCurrencyAmount(payment.amountDueNowRounded)}
            </dd>
          </div>
        ) : null}
        {payment.unpaidBalance ? (
          <div>
            <dt className="font-medium text-zinc-500">Unpaid balance</dt>
            <dd className="mt-1 text-zinc-900">
              {formatCurrencyAmount(payment.unpaidBalance)}
            </dd>
          </div>
        ) : null}
        {payment.currentDeliveryGroupValue ? (
          <div>
            <dt className="font-medium text-zinc-500">Current delivery value</dt>
            <dd className="mt-1 text-zinc-900">
              {formatCurrencyAmount(payment.currentDeliveryGroupValue)}
            </dd>
          </div>
        ) : null}
      </dl>
      {payment.calculationWarnings && payment.calculationWarnings.length > 0 ? (
        <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
          {payment.calculationWarnings.join(" ")}
        </div>
      ) : null}
    </aside>
  );
}
