import { randomUUID } from "node:crypto";
import { createQueueErpClientFromEnv } from "../lib/erp/queueErpClient";
import { getOrderIdentity, importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import { withExplicitDeliveryOrders, type ExplicitDeliveryOrder } from "../lib/notifications/explicitDeliveryRun";
import { denverDateTimeParts } from "./run-scheduled-delivery-interval";
import { deliveryIntervalConfirmationPhrase, preflightDeliveryInterval, runDeliveryInterval,
  type DeliveryIntervalRunOptions } from "./run-delivery-interval";
import { run42DayNoResponseCommand } from "./run-42-day-confirmation-no-response";
import { addDays, dateFromKey, dateKey } from "../lib/notifications/helpers";
import { recipientContactSelect, selectDeliveryRecipient } from "../lib/notifications/deliveryRecipient";
import { loadActiveNotificationOptOutAddresses } from "../lib/notifications/notificationOptOutLookup";
import { deliveryAddressGroupingKey } from "../lib/notifications/deliveryNotificationGrouping";
import { buildDeliveryConfirmationLink } from "../lib/notifications/deliveryConfirmationLinks";
import { buildDeliveryDetailsLink } from "../lib/notifications/deliveryDetailsLinks";
import { buildDeliveryNotificationGroupLink } from "../lib/notifications/deliveryNotificationGroupCustomer";
import { prisma } from "../lib/prisma";
import { DEFAULT_ALLOWED_SHIP_VIA, DEFAULT_ALLOWED_STATUSES, DEFAULT_EXCLUDED_ORDER_TYPES } from "../lib/acumatica/client/acumaticaClient";

export function demoDiscoveryBlockReason(row: unknown) {
  const field = (name: string) => {
    const value = (row as Record<string, unknown>)[name];
    return String(value && typeof value === "object" && "value" in value ? value.value ?? "" : value ?? "").trim().toUpperCase();
  };
  if (DEFAULT_EXCLUDED_ORDER_TYPES.includes(field("OrderType"))) return "excluded_order_type";
  if (!DEFAULT_ALLOWED_SHIP_VIA.includes(field("ShipVia"))) return "ship_via_not_delivery_eligible";
  if (!DEFAULT_ALLOWED_STATUSES.some(status => status.toUpperCase() === field("Status"))) return "order_status_not_discovery_eligible";
  return null;
}

export function parseDemoArgs(args: string[], now = new Date()) {
  const [action, ...rest] = args;
  if (action !== "followup") deliveryIntervalConfirmationPhrase(action ?? "");
  const orders: string[] = [];
  let runDate = denverDateTimeParts(now).date;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--run-date") {
      runDate = rest[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate ?? "") || dateKey(dateFromKey(runDate)) !== runDate) {
        throw new Error("--run-date requires YYYY-MM-DD");
      }
    } else if (/^(?:[A-Z0-9]{1,5}\/)?[A-Z0-9][A-Z0-9-]{1,29}$/i.test(rest[i])) {
      orders.push(rest[i].toUpperCase());
    } else throw new Error(`Unknown demo argument: ${rest[i]}`);
  }
  if (!orders.length || orders.length > 10 || new Set(orders).size !== orders.length) {
    throw new Error("Provide 1-10 distinct orders: npm run demo -- 42 SO12345 [PL02718]");
  }
  // Multi-order presentation currently demonstrates confirmation and its follow-ups, not multiple holds.
  if (orders.length > 1 && action !== "42" && action !== "followup") {
    throw new Error("Multi-order demo supports 42 or followup; run payment scenarios one order at a time.");
  }
  return { action, orders, runDate };
}

export async function resolveDemoOrder(input: string, fetchOrder?: (
  number: string, type?: string | null
) => Promise<unknown[]>): Promise<ExplicitDeliveryOrder> {
  const [type, number] = input.includes("/") ? input.split("/") : [null, input];
  const erp = fetchOrder ? null : createQueueErpClientFromEnv();
  const rows = await (fetchOrder ?? ((number, type) => erp!.fetchDeliverySalesOrderByOrderNumber(number, type)))(number, type);
  const matches = rows.filter(row => {
    const o = getOrderIdentity(row);
    return o.orderNumber?.toUpperCase() === number && (!type || o.orderType?.toUpperCase() === type);
  });
  if (matches.length !== 1 || !getOrderIdentity(matches[0]).orderType) {
    throw new Error(`Order ${input} missing or ambiguous; use an explicit type such as SO/SO12345.`);
  }
  const blocked = demoDiscoveryBlockReason(matches[0]);
  if (blocked) throw new Error(`${input}: ${blocked}; no messages sent`);
  return { orderType: getOrderIdentity(matches[0]).orderType!.toUpperCase(), orderNumber: number };
}

export async function assertDemoMultiOrderCompatibility(orders: ExplicitDeliveryOrder[], action: string, runDate: string) {
  if (orders.length < 2) return;
  const rows = await prisma.order.findMany({ where: { OR: orders }, include: {
    address: true, contact: { select: recipientContactSelect },
    deliveryGroups: { where: { isActive: true, deliveryGroupLines: { some: { isActive: true } },
      deliveryDate: action === "followup" ? { gte: dateFromKey(runDate), lte: addDays(runDate, 41) }
        : dateFromKey(dateKey(addDays(runDate, 42))) } },
  } });
  if (rows.length !== orders.length) throw new Error("demo_fresh_orders_missing");
  const optOuts = await loadActiveNotificationOptOutAddresses(prisma);
  const keys = rows.map(order => {
    const selected = selectDeliveryRecipient("DAY_42", order, optOuts).channel;
    const address = deliveryAddressGroupingKey(order.address);
    if (!order.primaryContactFetchSucceeded || !selected.selectedChannel || !address || order.deliveryGroups.length !== 1) {
      throw new Error(`${order.orderType}/${order.orderNumber}: grouped demo requires a freshly fetched eligible contact, complete address and one active delivery in the selected window`);
    }
    return JSON.stringify([order.contactId, selected.selectedChannel,
      selected.selectedChannel === "SMS" ? selected.recipientPhone : selected.recipientEmail,
      address, dateKey(order.deliveryGroups[0].deliveryDate)]);
  });
  if (new Set(keys).size !== 1) throw new Error("demo_group_mismatch: contacts, recipients/channels, addresses or delivery dates differ; no messages sent");
}

async function refreshDemoOrders(orders: ExplicitDeliveryOrder[], runDate: string) {
  const result = await importSalesOrdersForLineRequestedOn(runDate, { orderLookups: orders, explicitOrdersOnly: true });
  if (result.failedOrders || result.errors.length || orders.some(o => !result.successfullyRefreshedOrders?.some(
    refreshed => refreshed.orderType === o.orderType && refreshed.orderNumber === o.orderNumber))) {
    throw new Error(`fresh_import_failed: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

async function executeDemo(options: DeliveryIntervalRunOptions, followup: boolean) {
  if (!followup) return runDeliveryInterval(options);
  return run42DayNoResponseCommand({ runDate: options.runDate, mode: "send",
    confirmPhrase: "RUN REAL 42 DAY NO RESPONSE FOLLOW UPS", testRunId: options.runId,
    orderType: options.orderType, orderNumber: options.orderNumber, orderScope: options.orderScope });
}

async function demoOrderSnapshot(orders: ExplicitDeliveryOrder[], runDate: string) {
  const rows = await prisma.order.findMany({ where: { OR: orders }, select: {
    orderType: true, orderNumber: true, status: true, contactId: true, confirmVia: true,
    confirmWith: true, acumaticaOneWeekConfirmed: true,
    total: { select: { paymentTerms: true, unpaidBalance: true } },
    deliveryGroups: { where: { isActive: true }, select: {
      deliveryDate: true, _count: { select: { deliveryGroupLines: { where: { isActive: true } } } },
    } },
  } });
  return rows.map(row => ({ order: `${row.orderType}/${row.orderNumber}`, status: row.status,
    contactId: row.contactId, confirmVia: row.confirmVia, confirmWith: row.confirmWith,
    oneWeekConfirmed: row.acumaticaOneWeekConfirmed, paymentTerms: row.total?.paymentTerms,
    unpaidBalance: row.total?.unpaidBalance?.toString(), deliveries: row.deliveryGroups.map(group => ({
      deliveryDate: dateKey(group.deliveryDate),
      daysOut: Math.round((group.deliveryDate.getTime() - dateFromKey(runDate).getTime()) / 86_400_000),
      activeLines: group._count.deliveryGroupLines,
    })) }));
}

async function demoLinks(runId: string, orders: ExplicitDeliveryOrder[], eventIds: string[]) {
  const events = await prisma.notificationEvent.findMany({ where: { OR: orders, id: { in: eventIds } },
    select: { id: true, orderType: true, orderNumber: true, deliveryGroupId: true, deliveryDate: true,
      detailsLink: { select: { token: true } } } });
  const confirmations = await prisma.deliveryConfirmation.findMany({ where: {
    AND: [{ OR: orders }, { OR: events.map(e => ({ deliveryGroupId: e.deliveryGroupId, deliveryDate: e.deliveryDate })) }],
    linkToken: { not: null },
  }, select: { orderType: true, orderNumber: true, linkToken: true } });
  const groups = await prisma.deliveryNotificationGroup.findMany({ where: { runId }, select: { linkToken: true } });
  return { confirmationLinks: confirmations.map(c => ({ order: `${c.orderType}/${c.orderNumber}`,
    url: buildDeliveryConfirmationLink(c.linkToken!) })), groupedLinks: groups.map(g => buildDeliveryNotificationGroupLink(g.linkToken)),
    detailsLinks: events.flatMap(e => e.detailsLink ? [{ order: `${e.orderType}/${e.orderNumber}`,
      url: buildDeliveryDetailsLink(e.detailsLink.token, e.id) }] : []) };
}

export async function runDeliveryDemo(args: string[], dependencies: {
  now?: Date;
  preflight?: typeof preflightDeliveryInterval;
  resolve?: typeof resolveDemoOrder;
  refresh?: typeof refreshDemoOrders;
  checkGroup?: typeof assertDemoMultiOrderCompatibility;
  snapshot?: typeof demoOrderSnapshot;
  execute?: typeof executeDemo;
  links?: typeof demoLinks;
  log?: (value: unknown) => void;
} = {}) {
  const parsed = parseDemoArgs(args, dependencies.now);
  const followup = parsed.action === "followup";
  const interval = (followup ? "42" : parsed.action) as DeliveryIntervalRunOptions["interval"];
  const options: DeliveryIntervalRunOptions = { interval, runDate: parsed.runDate, send: true,
    confirmPhrase: deliveryIntervalConfirmationPhrase(interval!), runId: `demo_${randomUUID()}`,
    orderType: null, orderNumber: null, orderScope: null, channel: "both", verifyPackageAndMigrations: true };
  (dependencies.preflight ?? preflightDeliveryInterval)(options);
  const orders: ExplicitDeliveryOrder[] = [];
  for (const input of parsed.orders) orders.push(await (dependencies.resolve ?? resolveDemoOrder)(input));
  const log = dependencies.log ?? ((value: unknown) => console.log(JSON.stringify(value, null, 2)));
  return withExplicitDeliveryOrders(orders, async () => {
    if (orders.length === 1) {
      options.orderScope = orders[0]; options.orderType = orders[0].orderType; options.orderNumber = orders[0].orderNumber;
    }
    log({ phase: "demo_starting", orders, action: parsed.action, runDate: parsed.runDate,
      realSends: true, realWritebacks: true, automaticSchedulerBypassed: true,
      eligibilityBypassed: false, broadErpDiscovery: false, runId: options.runId });
    const refreshed = await (dependencies.refresh ?? refreshDemoOrders)(orders, parsed.runDate);
    log({ phase: "demo_fresh_import_completed", orders, refreshed: refreshed.successfullyRefreshedOrders });
    const snapshot = await (dependencies.snapshot ?? demoOrderSnapshot)(orders, parsed.runDate);
    log({ phase: "demo_current_erp_import_state", snapshot });
    await (dependencies.checkGroup ?? assertDemoMultiOrderCompatibility)(orders, parsed.action, parsed.runDate);
    const result = await (dependencies.execute ?? executeDemo)(options, followup);
    return { phase: "demo_completed", orders, action: parsed.action, runDate: parsed.runDate,
      snapshot, result, ...(await (dependencies.links ?? demoLinks)(options.runId!, orders, demoEventIds(result))),
      note: "Provider acceptance is not delivery. Review callbacks and ERP readback/writeback results. Links are private customer access links." };
  });
}

export function demoEventIds(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const ids = record.currentRunCreatedEventIds ?? record.currentRunDispatchableReminderEventIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

if (typeof require !== "undefined" && require.main === module) {
  runDeliveryDemo(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.result.ok) process.exitCode = 1;
  }).catch(error => {
    console.error(JSON.stringify({ ok: false, phase: "demo_failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}
