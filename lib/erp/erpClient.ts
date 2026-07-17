import { createAcumaticaClientFromEnv } from "@/lib/acumatica/client/acumaticaClient";
import { createQueueErpClientFromEnv } from "@/lib/erp/queueErpClient";

export type DeliveryErpClient = {
  fetchQualifyingSalesOrdersByLineRequestedOn(requestedOn: Date | string): Promise<unknown[]>;
  fetchDeliverySalesOrderByOrderNumber(
    orderNumber: string,
    orderType?: string | null
  ): Promise<unknown[]>;
  fetchDeliveryContactByContactId(contactId: string): Promise<unknown[]>;
};

function shouldUseQueueErp() {
  const raw = process.env.USE_QUEUE_ERP?.trim().toLowerCase();
  if (!raw) {
    return Boolean(process.env.MLD_QUEUE_BASE_URL?.trim() && process.env.MLD_QUEUE_TOKEN?.trim());
  }

  return ["1", "true", "yes", "y", "on"].includes(raw);
}

export function createErpClientFromEnv(): DeliveryErpClient {
  if (shouldUseQueueErp()) {
    return createQueueErpClientFromEnv();
  }

  return createAcumaticaClientFromEnv();
}
