import type { DeliveryGroupPaymentEvaluation } from "../delivery-payment/deliveryGroupPayment";

export function paymentLifecycleBlockReason(order: {
  confirmVia?: string | null;
  confirmWith?: string | null;
  acumaticaOneWeekConfirmed?: boolean | null;
}) {
  if (!order.confirmVia?.trim() || !order.confirmWith?.trim()) return "six_week_confirmation_incomplete";
  if (order.acumaticaOneWeekConfirmed === true) return "one_week_confirmation_already_true";
  return null;
}

export function paymentIsCleared(payment: DeliveryGroupPaymentEvaluation) {
  return Boolean(payment.paymentTerms) && payment.calculationWarnings.length === 0 &&
    (payment.paymentStatus === "not_applicable" || payment.paymentStatus === "no_balance_due");
}

export function clearanceSourceAllowed(interval: string) {
  return ["DAY_14", "DAY_12", "DAY_10"].includes(interval);
}
