import { renderDeliveryReminderMessage } from "@/lib/notifications/helpers";
import {
  renderSalespersonEmailFooterText,
  type SalespersonContactInput,
} from "@/lib/notifications/salespersonContactDisplay";

type DeliveryReminderMessageParams = Parameters<typeof renderDeliveryReminderMessage>[0];

export function renderDeliveryReminderEmailBody(
  params: DeliveryReminderMessageParams & {
    salespersonContact?: SalespersonContactInput | null;
  }
) {
  const body = renderDeliveryReminderMessage(params);
  const salespersonFooter = renderSalespersonEmailFooterText(params.salespersonContact);

  return salespersonFooter ? [body, "", salespersonFooter].join("\n") : body;
}
