import { AsyncLocalStorage } from "node:async_hooks";

export type ExplicitDeliveryOrder = { orderType: string; orderNumber: string };
type RunScope = { orders: ExplicitDeliveryOrder[] };
const storage = new AsyncLocalStorage<RunScope>();
const key = (order: { orderType?: string | null; orderNumber?: string | null }) =>
  `${order.orderType?.trim().toUpperCase()}/${order.orderNumber?.trim().toUpperCase()}`;

export function explicitDeliveryOrders() { return storage.getStore()?.orders; }

export function withExplicitDeliveryOrders<T>(orders: ExplicitDeliveryOrder[], run: () => T): T {
  if (!orders.length || orders.length > 10 || orders.some(o => !o.orderType || !o.orderNumber) ||
      new Set(orders.map(key)).size !== orders.length) throw new Error("invalid_explicit_order_scope");
  return storage.run({ orders: orders.map(o => ({
    orderType: o.orderType.trim().toUpperCase(), orderNumber: o.orderNumber.trim().toUpperCase(),
  })) }, run);
}

export function matchesExplicitDeliveryOrder(order: { orderType?: string | null; orderNumber?: string | null }) {
  const orders = explicitDeliveryOrders();
  return !orders || orders.some(o => key(o) === key(order));
}

export function explicitDeliveryOrderWhere() {
  const orders = explicitDeliveryOrders();
  return orders ? { OR: orders.map(o => ({ ...o })) } : {};
}

export function assertExplicitDeliveryOrders(rows: Array<{ orderType?: string | null; orderNumber?: string | null }>) {
  if (rows.some(row => !matchesExplicitDeliveryOrder(row))) throw new Error("outside_explicit_order_scope");
}

export function assertExplicitDeliveryGroup(groups: Array<{ members: ExplicitDeliveryOrder[] }>) {
  const orders = explicitDeliveryOrders();
  assertExplicitDeliveryOrders(groups.flatMap(g => g.members));
  if (orders && orders.length > 1 && (groups.length !== 1 || groups[0].members.length !== orders.length ||
      new Set(groups[0].members.map(key)).size !== orders.length ||
      orders.some(o => !groups[0].members.some(m => key(m) === key(o))))) {
    throw new Error("demo_orders_not_one_compatible_group: all named orders must qualify for the same contact, recipient/channel, delivery date, address and stage; no messages sent");
  }
}
