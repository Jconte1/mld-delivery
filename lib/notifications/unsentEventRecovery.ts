import type { Prisma } from "@/lib/generated/prisma/client";
import type { prisma } from "@/lib/prisma";
import type { ImportSalesOrdersResult } from "@/lib/erp/importSalesOrders";
import type { DeliveryIntervalFreshImportResult } from "./freshDeliveryIntervalImport";

export type UnsentEventRecoverySummary = {
  recoveredEventIds: string[];
  currentRunEligibleEventIds: string[];
};

type Context = {
  dryRun: boolean;
  targetDeliveryDate: string;
  importResult?: ImportSalesOrdersResult | null;
  freshImport?: DeliveryIntervalFreshImportResult;
};

function sameOrder(a: { orderType?: string | null; orderNumber?: string | null },
  b: { orderType: string; orderNumber: string }) {
  return a.orderType?.trim().toUpperCase() === b.orderType.trim().toUpperCase() &&
    a.orderNumber?.trim().toUpperCase() === b.orderNumber.trim().toUpperCase();
}

/** Local to one creator invocation. A hidden dedupe match must traverse the normal
 * eligibility/channel path before create can conditionally refresh that same row.
 * No deletes, retries, or scans of an older run's events are performed.
 */
export function createUnsentEventRecovery<T extends Pick<typeof prisma, "notificationEvent">>(
  source: T,
  context: () => Context,
  runStartedAt = new Date(),
) {
  const delegate = source.notificationEvent;
  const originalFindUnique = delegate.findUnique.bind(delegate) as typeof delegate.findUnique;
  const originalFindFirst = typeof delegate.findFirst === "function"
    ? delegate.findFirst.bind(delegate) as typeof delegate.findFirst : null;
  const originalUpdateMany = typeof delegate.updateMany === "function"
    ? delegate.updateMany.bind(delegate) as typeof delegate.updateMany : null;
  const originalFindUniqueOrThrow = typeof delegate.findUniqueOrThrow === "function"
    ? delegate.findUniqueOrThrow.bind(delegate) as typeof delegate.findUniqueOrThrow : null;
  const originalCreate = delegate.create.bind(delegate) as typeof delegate.create;
  const candidates = new Map<string, {
    id: string;
    updatedAt: Date;
    orderType: string;
    orderNumber: string;
  }>();
  const recoveredEventIds: string[] = [];
  const currentRunEligibleEventIds: string[] = [];
  const replacedEventIds: string[] = [];

  function untouched(): Prisma.NotificationEventWhereInput {
    return {
      status: "SCHEDULED", triggeredAt: null, sentAt: null,
      provider: null, externalMessageId: null, reasonFailed: null,
      attempts: { none: {} },
      // Even a prepared group owns its membership. Recovery never moves it.
      notificationGroupMember: { is: null },
      order: { lastSyncedAt: { gte: runStartedAt }, primaryContactFetchSucceeded: true },
    };
  }

  const findUnique = (async (args: Prisma.NotificationEventFindUniqueArgs) => {
    const existing = await originalFindUnique(args);
    const ctx = context();
    if (!existing || !args.where.dedupeKey || ctx.dryRun) return existing;
    const imported = ctx.freshImport ? ctx.freshImport.importResult : ctx.importResult;
    if (!imported || (ctx.freshImport && (!ctx.freshImport.performed || ctx.freshImport.globalFailed))) return existing;
    if (!originalFindFirst || !originalUpdateMany || !originalFindUniqueOrThrow) return existing;
    const candidate = await originalFindFirst({
      where: { ...untouched(), dedupeKey: args.where.dedupeKey,
        deliveryDate: new Date(`${ctx.targetDeliveryDate}T00:00:00.000Z`) },
      select: { id: true, updatedAt: true, orderType: true, orderNumber: true },
    });
    if (!candidate || !imported.successfullyRefreshedOrders?.some(order => sameOrder(order, candidate)) ||
      imported.errors.some(error => error.orderNumber?.trim().toUpperCase() === candidate.orderNumber.trim().toUpperCase() &&
        (!error.orderType || sameOrder(error, candidate)))) return existing;
    candidates.set(args.where.dedupeKey, candidate);
    return null;
  }) as unknown as typeof delegate.findUnique;

  const create = (async (args: Prisma.NotificationEventCreateArgs) => {
    const candidate = candidates.get(args.data.dedupeKey);
    let event;
    if (candidate) {
      if (!originalUpdateMany || !originalFindUniqueOrThrow) {
        throw new Error("unsent_event_recovery_client_incomplete");
      }
      if (!sameOrder(candidate, {
        orderType: String(args.data.orderType),
        orderNumber: String(args.data.orderNumber),
      })) {
        throw new Error("unsent_event_recovery_identity_mismatch");
      }
      // Compare-and-set prevents a concurrent claim or edit from being overwritten.
      const result = await originalUpdateMany({
        where: { ...untouched(), id: candidate.id, updatedAt: candidate.updatedAt },
        data: args.data as Prisma.NotificationEventUncheckedUpdateManyInput,
      });
      if (result.count !== 1) throw new Error("unsent_event_recovery_conflict");
      candidates.delete(args.data.dedupeKey);
      replacedEventIds.push(candidate.id);
      const readArgs: Prisma.NotificationEventFindUniqueOrThrowArgs = args.select
        ? { where: { id: candidate.id }, select: args.select }
        : args.include
          ? { where: { id: candidate.id }, include: args.include }
          : { where: { id: candidate.id } };
      event = await originalFindUniqueOrThrow(readArgs);
    } else {
      event = await originalCreate(args);
    }
    if (args.data.status === "SCHEDULED" && args.data.selectedChannel) {
      currentRunEligibleEventIds.push(event.id);
      if (candidate) recoveredEventIds.push(event.id);
    }
    return event;
  }) as unknown as typeof delegate.create;

  const wrappedDelegate = new Proxy({}, {
    get(_target, property) {
      if (property === "findUnique") return findUnique;
      if (property === "create") return create;
      const value = Reflect.get(delegate, property);
      return typeof value === "function" ? value.bind(delegate) : value;
    },
  });
  const client = new Proxy({}, {
    get(_target, property) {
      if (property === "notificationEvent") return wrappedDelegate;
      const value = Reflect.get(source, property);
      return typeof value === "function" ? value.bind(source) : value;
    },
  }) as T;
  return { client, recoveredEventIds, currentRunEligibleEventIds, replacedEventIds };
}
