import {
  render30DayDeliveryReminderEmail,
  type Render30DayDeliveryReminderParams,
} from "@/lib/notifications/deliveryReminder30Day";
import {
  formatCurrencyAmount,
  formatCustomerFriendlyDate,
  formatDeliveryDescription,
} from "@/lib/notifications/helpers";

export type Render14DayDeliveryReminderParams = Render30DayDeliveryReminderParams;

export function render14DayDeliveryReminderSms(params: Render14DayDeliveryReminderParams) {
  const deliveryDescription = formatDeliveryDescription(params.buyerGroup);
  const deliveryDate = formatCustomerFriendlyDate(params.deliveryDate);
  const paymentLine = params.paymentDue
    ? `Balance owed prior to scheduling Delivery: ${formatCurrencyAmount(params.amountDueNowRounded)}\n\n`
    : "";

  return `MLD: Order ${params.orderNumber}:\n\nYour ${deliveryDescription} for ${params.jobName} is scheduled for ${deliveryDate}.\n\n${paymentLine}Review delivery details here: ${params.detailsLink}\n\nReply STOP to opt out.`;
}

export function render14DayDeliveryReminderEmail(params: Render14DayDeliveryReminderParams) {
  return render30DayDeliveryReminderEmail(params);
}
