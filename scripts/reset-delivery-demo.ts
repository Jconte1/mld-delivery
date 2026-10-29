import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../lib/prisma";
import type { Prisma } from "../lib/generated/prisma/client";

type Order = { orderType: string; orderNumber: string };
type Client = Pick<Prisma.TransactionClient, "order" | "notificationEvent" | "deliveryConfirmation" |
  "deliveryNotificationGroup" | "deliveryNotificationGroupMember" | "deliveryNotificationGroupAttempt" |
  "deliveryOrderHoldAction" | "deliveryGroupTenDayConfirmation" | "internalNotificationEvent" |
  "deliveryDetailsLink" | "twilioMessageStatusCallback">;
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseDemoResetArgs(args: string[]) {
  const apply = args.includes("--apply");
  const inputs = args.filter(arg => arg !== "--apply" && arg !== "--preview").map(arg => arg.toUpperCase());
  if (!inputs.length || inputs.length > 10 || new Set(inputs).size !== inputs.length ||
      inputs.some(arg => !/^(?:[A-Z0-9]{1,5}\/)?[A-Z0-9][A-Z0-9-]{1,29}$/.test(arg)) ||
      (args.includes("--preview") && apply)) throw new Error("Usage: npm run demo:reset -- SO38056 [PL02718] [--apply]");
  return { apply, inputs };
}

export async function resolveDemoResetOrders(inputs: string[], client: Pick<Client, "order"> = prisma): Promise<Order[]> {
  const orders: Order[] = [];
  for (const input of inputs) {
    const [type, number] = input.includes("/") ? input.split("/") : [undefined, input];
    const matches = await client.order.findMany({ where: { orderType: type, orderNumber: number },
      select: { orderType: true, orderNumber: true } });
    if (matches.length !== 1) throw new Error(`${input}: local order missing or ambiguous; use TYPE/NUMBER.`);
    orders.push(matches[0]);
  }
  if (new Set(orders.map(o => `${o.orderType}/${o.orderNumber}`)).size !== orders.length) throw new Error("Duplicate resolved orders");
  return orders;
}

export async function buildDemoResetPlan(orders: Order[], client: Client = prisma) {
  if (!orders.length) throw new Error("Explicit reset orders required");
  const events = await client.notificationEvent.findMany({ where: { AND: [{ OR: orders }, { OR: [
    { attempts: { some: { testRunId: { startsWith: "demo_" } } } },
    { notificationGroupMember: { is: { group: { runId: { startsWith: "demo_" } } } } },
  ] }] }, include: { attempts: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } });
  const eventIds = ids(events);
  const scopes = events.map(e => ({ deliveryGroupId: e.deliveryGroupId, deliveryDate: e.deliveryDate }));
  const localScopes = scopes.map(s => ({ orderDeliveryGroupId: s.deliveryGroupId, deliveryDate: s.deliveryDate }));
  const groups = await client.deliveryNotificationGroup.findMany({ where: {
    members: { some: { notificationEventId: { in: eventIds } } },
  }, include: { members: { orderBy: { id: "asc" } }, attempts: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } });
  const foreignEvents = await client.notificationEvent.findMany({ where: {
    OR: scopes, id: { notIn: eventIds },
  }, select: { id: true, orderType: true, orderNumber: true }, orderBy: { id: "asc" } });
  const confirmations = await client.deliveryConfirmation.findMany({ where: { AND: [{ OR: orders }, { OR: scopes }] }, orderBy: { id: "asc" } });
  const holds = await client.deliveryOrderHoldAction.findMany({ where: { OR: localScopes }, orderBy: { id: "asc" } });
  const clearances = await client.deliveryGroupTenDayConfirmation.findMany({ where: { OR: localScopes }, orderBy: { id: "asc" } });
  const internalEvents = await client.internalNotificationEvent.findMany({ where: { OR: localScopes }, orderBy: { id: "asc" } });
  const links = await client.deliveryDetailsLink.findMany({ where: { OR: localScopes }, orderBy: { id: "asc" } });
  const blockers = demoResetBlockers({ orders, events, groups, foreignEvents, confirmations, holds, clearances, internalEvents, links });
  const jobIds = [...new Set([
    ...confirmations.flatMap(c => [c.confirmationWritebackJobId, c.requestedDateWritebackJobId]),
    ...holds.map(h => h.queueJobId), ...clearances.map(c => c.acumaticaWritebackJobId),
  ].filter((id): id is string => Boolean(id)))].sort();
  return { orders, events, groups, confirmations, holds, clearances, internalEvents, links, blockers, jobIds };
}

type Plan = Awaited<ReturnType<typeof buildDemoResetPlan>>;
export function demoResetBlockers(plan: {
  orders: Order[];
  events: Array<Order & { id: string; createdAt: Date; attempts: Array<{ testRunId: string | null; status: string }> }>;
  groups: Array<{ id: string; runId: string; status: string; members: Array<{ notificationEventId: string }>; attempts: Array<{ status: string }> }>;
  foreignEvents: Array<{ id: string }>;
  confirmations: Array<Order & { id: string; notificationEventId: string | null }>;
  holds: Array<Order & { id: string; customerNotificationEventId: string | null; createdAt: Date }>;
  clearances: Array<Order & { id: string; updatedAt: Date }>;
  internalEvents: Array<Order & { id: string; createdAt: Date; reasonSkipped: string | null; reasonFailed: string | null }>;
  links: Array<{ id: string; createdFromNotificationEventId: string | null }>;
}) {
  const blockers: string[] = [];
  const eventIds = new Set(ids(plan.events));
  const earliest = Math.min(...plan.events.map(e => e.createdAt.getTime()));
  const named = new Set(plan.orders.map(o => `${o.orderType}/${o.orderNumber}`));
  for (const row of [...plan.confirmations, ...plan.holds, ...plan.clearances, ...plan.internalEvents]) {
    if (!named.has(`${row.orderType}/${row.orderNumber}`)) blockers.push(`${row.id}: related record is outside named orders`);
  }
  for (const e of plan.events) {
    if (!named.has(`${e.orderType}/${e.orderNumber}`)) blockers.push(`${e.id}: outside named orders`);
    if (e.attempts.some(a => !a.testRunId?.startsWith("demo_"))) blockers.push(`${e.id}: non-demo attempt history exists`);
    if (e.attempts.some(a => ["CREATED", "SUBMITTING", "RECONCILIATION_REQUIRED"].includes(a.status))) blockers.push(`${e.id}: attempt is in flight or needs reconciliation`);
  }
  for (const group of plan.groups) {
    if (!group.runId.startsWith("demo_") || group.members.some(m => !eventIds.has(m.notificationEventId))) {
      blockers.push(`${group.id}: name every order in the demo group; partial or non-demo group reset is forbidden`);
    }
    if (group.attempts.some(a => ["CREATED", "SUBMITTING", "RECONCILIATION_REQUIRED"].includes(a.status)) || group.status === "CLAIMED") {
      blockers.push(`${group.id}: shared provider send is in flight or needs reconciliation`);
    }
  }
  if (plan.foreignEvents.length) blockers.push(`Non-demo/unidentified events share this lifecycle: ${ids(plan.foreignEvents).join(", ")}`);
  if (plan.confirmations.some(c => !c.notificationEventId || !eventIds.has(c.notificationEventId))) blockers.push("A confirmation is not owned by an identified demo event");
  if (plan.holds.some(h => !h.customerNotificationEventId || !eventIds.has(h.customerNotificationEventId))) blockers.push("A hold action is not owned by an identified demo event");
  if (plan.clearances.some(c => c.updatedAt.getTime() < earliest)) blockers.push("Pre-existing clearance record must not be deleted as demo data");
  if (plan.internalEvents.some(e => e.createdAt.getTime() < earliest || /claimed|reconcil/i.test(`${e.reasonSkipped} ${e.reasonFailed}`))) {
    blockers.push("Internal notification predates the demo or has an unresolved provider claim");
  }
  if (plan.links.some(l => !l.createdFromNotificationEventId || !eventIds.has(l.createdFromNotificationEventId))) blockers.push("A details link is not owned by an identified demo event");
  return blockers;
}

export async function assertResetJobsFinished(jobIds: string[], request: typeof fetch = fetch) {
  if (!jobIds.length) return;
  const base = process.env.MLD_QUEUE_BASE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MLD_QUEUE_TOKEN?.trim();
  if (!base || !token) throw new Error("Cannot verify outstanding ERP writebacks: queue URL/token missing");
  for (const id of jobIds) {
    const response = await request(`${base}/api/erp/jobs/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`${id}: cannot verify writeback job (${response.status}); nothing deleted`);
    const job = await response.json() as { status?: string };
    if (!["succeeded", "failed", "resolved"].includes(job.status ?? "")) throw new Error(`${id}: writeback job still ${job.status}; wait before resetting`);
  }
}

export function summarizeDemoReset(plan: Plan) {
  return { orders: plan.orders, blockers: plan.blockers, queueJobIdsToVerify: plan.jobIds,
    counts: { events: plan.events.length, attempts: plan.events.reduce((n, e) => n + e.attempts.length, 0),
      groups: plan.groups.length, sharedAttempts: plan.groups.reduce((n, g) => n + g.attempts.length, 0),
      confirmations: plan.confirmations.length, detailsLinks: plan.links.length,
      holdActions: plan.holds.length, clearanceRecords: plan.clearances.length, internalEvents: plan.internalEvents.length },
    eventIds: ids(plan.events), erpChanged: false, queueJobsDeleted: false, contactsOrOptOutsChanged: false,
    warning: "Old demo links will stop working. ERP confirmations, dates, balances and holds remain unchanged. Do not reset between no-response touches." };
}

export async function deleteDemoResetPlan(client: Client, plan: Plan) {
  if (plan.blockers.length) throw new Error(plan.blockers.join("; "));
  // Preserve callback/inbound audit rows. The other callback relations use ON DELETE SET NULL.
  await client.twilioMessageStatusCallback.updateMany({ where: { groupAttemptId: { in: plan.groups.flatMap(g => ids(g.attempts)) } }, data: { groupAttemptId: null } });
  await client.deliveryNotificationGroupMember.deleteMany({ where: { id: { in: plan.groups.flatMap(g => ids(g.members)) } } });
  await client.deliveryNotificationGroupAttempt.deleteMany({ where: { id: { in: plan.groups.flatMap(g => ids(g.attempts)) } } });
  await client.deliveryNotificationGroup.deleteMany({ where: { id: { in: ids(plan.groups) } } });
  await client.internalNotificationEvent.deleteMany({ where: { id: { in: ids(plan.internalEvents) } } });
  await client.deliveryOrderHoldAction.deleteMany({ where: { id: { in: ids(plan.holds) } } });
  await client.deliveryGroupTenDayConfirmation.deleteMany({ where: { id: { in: ids(plan.clearances) } } });
  await client.deliveryConfirmation.deleteMany({ where: { id: { in: ids(plan.confirmations) } } });
  await client.notificationEvent.deleteMany({ where: { id: { in: ids(plan.events) } } });
  await client.deliveryDetailsLink.deleteMany({ where: { id: { in: ids(plan.links) } } });
}

async function main() {
  const options = parseDemoResetArgs(process.argv.slice(2));
  const orders = await resolveDemoResetOrders(options.inputs);
  const plan = await buildDemoResetPlan(orders);
  console.log(JSON.stringify({ phase: "demo_reset_preview", ...summarizeDemoReset(plan) }, null, 2));
  if (!options.apply || !plan.events.length) return;
  if (plan.blockers.length) throw new Error(plan.blockers.join("; "));
  await assertResetJobsFinished(plan.jobIds);
  const directory = path.resolve("artifacts/delivery-demo-resets");
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, `${Date.now()}-${randomUUID()}.json`);
  await writeFile(archive, JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
  await prisma.$transaction(async tx => {
    const current = await buildDemoResetPlan(orders, tx);
    if (hash(plan) !== hash(current)) throw new Error("Demo state changed since preview; nothing deleted. Run reset again after activity settles.");
    await deleteDemoResetPlan(tx, current);
  }, { isolationLevel: "Serializable", timeout: 60000 });
  console.log(JSON.stringify({ phase: "demo_reset_completed", archive, ...summarizeDemoReset(plan) }, null, 2));
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
