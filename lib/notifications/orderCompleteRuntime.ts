import { QueueErpClient } from "@/lib/erp/queueErpClient";
import { buildTwilioStatusCallbackUrl, createDeliveryNotificationProvider } from "@/lib/notifications/deliveryNotificationProviders";
import { prisma } from "@/lib/prisma";
import type { OrderCompleteDependencies } from "./orderComplete";
import { createOrderCompleteStore } from "./orderCompleteStore";

// Not wired until discovery's ERP completion timestamp and pagination are proven.
export function createOrderCompleteDependencies(discover: OrderCompleteDependencies["discover"]): OrderCompleteDependencies {
  return {
    discover,
    erp: new QueueErpClient(),
    store: createOrderCompleteStore(prisma),
    provider: createDeliveryNotificationProvider(),
    statusCallbackUrl: () => buildTwilioStatusCallbackUrl(),
    clock: () => new Date(),
    async loadOptOuts() {
      // No permissive empty-result fallback when lookup delegates are unavailable.
      const phones = await prisma.smsOptOut.findMany({ where: { isActive: true }, select: { phone: true } });
      const emails = await prisma.emailOptOut.findMany({ where: { isActive: true }, select: { email: true } });
      return { activeSmsOptOutPhones: phones.map(row => row.phone), activeEmailOptOutEmails: emails.map(row => row.email) };
    },
  };
}
