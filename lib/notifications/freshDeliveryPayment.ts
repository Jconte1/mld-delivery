import { createQueueErpClientFromEnv } from "../erp/queueErpClient";
import type { importSalesOrdersForLineRequestedOn } from "../erp/importSalesOrders";
import { getDeliveryGroupPaymentEvaluation } from "../delivery-payment/deliveryGroupPayment";
import type { DeliveryErpClient } from "../erp/erpClient";

export type PaymentOrderScope = { orderType: string; orderNumber: string; deliveryDate: Date | string };

export async function refreshDeliveryPaymentOrder(scope: PaymentOrderScope, ports: {
  erpClient?: DeliveryErpClient; importOrders?: typeof importSalesOrdersForLineRequestedOn;
} = {}) {
  const erp = ports.erpClient ?? createQueueErpClientFromEnv();
  // Refresh exactly this order through the normal importer, without rediscovering an entire date.
  const importOrders = ports.importOrders ?? (await import("../erp/importSalesOrders")).importSalesOrdersForLineRequestedOn;
  const result = await importOrders(scope.deliveryDate, {
    orderLookups: [{ orderType: scope.orderType, orderNumber: scope.orderNumber }],
    includeUnqualifiedOrderLookups: true,
    erpClient: {
      fetchQualifyingSalesOrdersByLineRequestedOn: async () => [],
      fetchDeliverySalesOrderByOrderNumber: (number, type) => erp.fetchDeliverySalesOrderByOrderNumber(number, type),
      fetchDeliveryContactByContactId: id => erp.fetchDeliveryContactByContactId(id),
    },
  });
  if (!result.successfullyRefreshedOrders?.some(order => order.orderType === scope.orderType &&
      order.orderNumber === scope.orderNumber) || result.failedOrders || result.errors.length) {
    throw new Error("fresh_payment_import_failed");
  }
  return result;
}

export async function getFreshDeliveryGroupPaymentEvaluation(deliveryGroupId: string) {
  const { prisma } = await import("../prisma");
  const group = await prisma.orderDeliveryGroup.findUniqueOrThrow({ where: { id: deliveryGroupId } });
  if (!group.isActive) throw new Error("payment_delivery_group_inactive");
  await refreshDeliveryPaymentOrder(group);
  const payment = await getDeliveryGroupPaymentEvaluation(deliveryGroupId);
  if (payment.paymentStatus === "calculation_blocked") throw new Error("fresh_payment_balance_unavailable");
  return { ...payment, paymentRefreshedAt: new Date().toISOString() };
}
