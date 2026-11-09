import { isMeaningfulDeliveryPaymentAmount } from "@/lib/delivery-payment/deliveryGroupPayment";
import { formatCurrencyAmount } from "@/lib/notifications/helpers";

export type DeliveryPaymentSummaryInput = {
  hasDeliverableItems?: boolean;
  paymentApplicabilityStatus?: string | null;
  paymentStatus: string;
  amountDueNowRounded?: string | null;
  orderTotal?: string | null;
  paidToDate?: string | null;
  unpaidBalance?: string | null;
  currentDeliveryGroupValue?: string | null;
  calculationWarnings?: string[];
};

export function deliveryHasBalanceDue(payment: DeliveryPaymentSummaryInput) {
  return (
    payment.paymentApplicabilityStatus !== "not_applicable_terms" &&
    payment.hasDeliverableItems !== false &&
    payment.paymentStatus === "balance_due" &&
    isMeaningfulDeliveryPaymentAmount(payment.amountDueNowRounded)
  );
}

export function deliveryPaymentCanShowCustomerBalance(payment: DeliveryPaymentSummaryInput) {
  return payment.paymentApplicabilityStatus !== "not_applicable_terms";
}

function availableMoney(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || !/^-?\d+(?:\.\d+)?$/.test(trimmed) || !Number.isFinite(Number(trimmed))) return null;
  return formatCurrencyAmount(trimmed);
}

export function DeliveryPaymentSummary({
  payment,
}: {
  payment: DeliveryPaymentSummaryInput;
}) {
  const showAmountDue = deliveryHasBalanceDue(payment);
  const showOrderAmounts = deliveryPaymentCanShowCustomerBalance(payment) && payment.paymentStatus !== "calculation_blocked";
  const orderTotal = showOrderAmounts ? availableMoney(payment.orderTotal) : null;
  const paidToDate = showOrderAmounts ? availableMoney(payment.paidToDate) : null;

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
        {orderTotal !== null ? (
          <div>
            <dt className="font-medium text-zinc-500">Order Total</dt>
            <dd className="mt-1 font-medium text-zinc-900">{orderTotal}</dd>
          </div>
        ) : null}
        {paidToDate !== null ? (
          <div>
            <dt className="font-medium text-zinc-500">Payments / Credits Applied</dt>
            <dd className="mt-1 font-medium text-emerald-700">{paidToDate}</dd>
          </div>
        ) : null}
        {showAmountDue ? (
          <div>
            <dt className="font-medium text-zinc-500">
              Balance owed prior to scheduling Delivery
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-rose-700">
              {formatCurrencyAmount(payment.amountDueNowRounded)}
            </dd>
            <dd className="mt-2 text-xs leading-5 text-zinc-500">
              Your remaining order balance must be paid in full before delivery
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
