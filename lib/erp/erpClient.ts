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
  return raw === "true";
}

export function createErpClientFromEnv(): DeliveryErpClient {
  if (shouldUseQueueErp()) {
    return createQueueErpClientFromEnv();
  }

  return createAcumaticaClientFromEnv();
}
