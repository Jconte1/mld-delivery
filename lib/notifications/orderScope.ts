export type DeliveryOrderScope = {
  orderType: string;
  orderNumber: string;
};

export type DeliveryOrderScopeReport = {
  enabled: boolean;
  orderType: string | null;
  orderNumber: string | null;
  unscopedCount: number;
  scopedCount: number;
  scopedOutCount: number;
};

export function normalizeDeliveryOrderScopeValue(value: string | null | undefined) {
  const normalized = value?.trim().toUpperCase() ?? "";
  return normalized || null;
}

export function normalizeDeliveryOrderScope(params: {
  orderType?: string | null;
  orderNumber?: string | null;
}): DeliveryOrderScope | null {
  const orderType = normalizeDeliveryOrderScopeValue(params.orderType);
  const orderNumber = normalizeDeliveryOrderScopeValue(params.orderNumber);

  if (!orderType && !orderNumber) return null;
  if (!orderType || !orderNumber) {
    throw new Error("--order-type and --order-number must be provided together.");
  }

  return { orderType, orderNumber };
}

export function deliveryOrderMatchesScope(
  order: { orderType?: string | null; orderNumber?: string | null },
  scope: DeliveryOrderScope | null | undefined
) {
  if (!scope) return true;
  return (
    normalizeDeliveryOrderScopeValue(order.orderType) === scope.orderType &&
    normalizeDeliveryOrderScopeValue(order.orderNumber) === scope.orderNumber
  );
}

export function filterByDeliveryOrderScope<T extends { orderType?: string | null; orderNumber?: string | null }>(
  rows: T[],
  scope: DeliveryOrderScope | null | undefined
) {
  return scope ? rows.filter((row) => deliveryOrderMatchesScope(row, scope)) : rows;
}

export function deliveryOrderScopeReport(params: {
  scope: DeliveryOrderScope | null | undefined;
  unscopedCount: number;
  scopedCount: number;
}): DeliveryOrderScopeReport {
  return {
    enabled: Boolean(params.scope),
    orderType: params.scope?.orderType ?? null,
    orderNumber: params.scope?.orderNumber ?? null,
    unscopedCount: params.unscopedCount,
    scopedCount: params.scopedCount,
    scopedOutCount: params.unscopedCount - params.scopedCount,
  };
}

export function describeDeliveryOrderScope(scope: DeliveryOrderScope | null | undefined) {
  return scope ? `${scope.orderType}/${scope.orderNumber}` : "all orders";
}
