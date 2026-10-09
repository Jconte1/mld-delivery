import { isMeaningfulDeliveryPaymentAmount, type DeliveryGroupPaymentEvaluation } from "../delivery-payment/deliveryGroupPayment";

export function customerPaymentVisible(interval: string | null | undefined) {
  return ["DAY_30", "DAY_14", "DAY_12", "DAY_10", "DAY_8"].includes(interval ?? "");
}

export function currentCustomerPaymentAmount(payment: DeliveryGroupPaymentEvaluation) {
  if (payment.paymentStatus !== "balance_due" || payment.calculationWarnings.length ||
      !isMeaningfulDeliveryPaymentAmount(payment.amountDueNowRounded)) {
    throw new Error("payment_amount_not_due_or_calculation_blocked");
  }
  return payment.amountDueNowRounded!;
}
