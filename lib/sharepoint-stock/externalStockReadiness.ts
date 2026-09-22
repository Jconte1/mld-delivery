import { SharePointStockSyncRunStatus, type Prisma } from "@/lib/generated/prisma/client";
import { normalizeStockInventoryId } from "@/lib/sharepoint-stock/stockInventoryNormalization";
import {
  SHAREPOINT_STOCK_SOURCES,
  stockMatchKey,
  stockSourceForWarehouse,
} from "@/lib/sharepoint-stock/regionalStockLists";

export type SharePointStockFreshnessStaleReason =
  | "no_successful_sync"
  | "missing_completed_at"
  | "stale"
  | null;

export type SharePointStockSyncFreshness = {
  source: string;
  latestSyncId: string | null;
  completedAt: Date | null;
  freshnessDays: number;
  isFresh: boolean;
  staleReason: SharePointStockFreshnessStaleReason;
};

export type ExternalStockLineIdentity = { inventoryId: unknown; warehouseId?: unknown };

type ExternalStockReadinessClient = {
  sharePointStockSyncRun: Pick<Prisma.TransactionClient["sharePointStockSyncRun"], "findFirst">;
  externalStockItem: Pick<Prisma.TransactionClient["externalStockItem"], "findMany">;
};

export type ExternalStockReadinessOptions = {
  client?: ExternalStockReadinessClient;
  now?: Date;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_SHAREPOINT_STOCK_FRESHNESS_DAYS = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function getReadinessPrisma(client?: ExternalStockReadinessClient) {
  if (client) return client;
  const { prisma } = await import("@/lib/prisma");
  return prisma;
}

export function getSharePointStockFreshnessDays(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number(env.SHAREPOINT_STOCK_FRESHNESS_DAYS?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHAREPOINT_STOCK_FRESHNESS_DAYS;
}

export async function getLatestSharePointStockSyncFreshness(
  options: ExternalStockReadinessOptions & { source?: string } = {}
): Promise<SharePointStockSyncFreshness> {
  const db = await getReadinessPrisma(options.client);
  const source = options.source ?? SHAREPOINT_STOCK_SOURCES.utah_wyoming;
  const freshnessDays = getSharePointStockFreshnessDays(options.env);
  const now = options.now ?? new Date();
  const latest = await db.sharePointStockSyncRun.findFirst({
    where: { source, status: SharePointStockSyncRunStatus.SUCCESS },
    orderBy: [{ completedAt: "desc" }, { startedAt: "desc" }],
    select: { id: true, completedAt: true },
  });

  if (!latest) {
    return { source, latestSyncId: null, completedAt: null, freshnessDays, isFresh: false, staleReason: "no_successful_sync" };
  }
  if (!latest.completedAt) {
    return { source, latestSyncId: latest.id, completedAt: null, freshnessDays, isFresh: false, staleReason: "missing_completed_at" };
  }
  const isFresh = latest.completedAt.getTime() >= now.getTime() - freshnessDays * MS_PER_DAY;
  return {
    source,
    latestSyncId: latest.id,
    completedAt: latest.completedAt,
    freshnessDays,
    isFresh,
    staleReason: isFresh ? null : "stale",
  };
}

export function externalStockMatchKeyForLine(line: ExternalStockLineIdentity) {
  const source = stockSourceForWarehouse(line.warehouseId);
  const inventoryId = normalizeStockInventoryId(line.inventoryId);
  return source && inventoryId ? stockMatchKey(source, inventoryId) : null;
}

export function externalStockMatchesLine(matches: Set<string> | undefined, line: ExternalStockLineIdentity) {
  const key = externalStockMatchKeyForLine(line);
  return Boolean(matches && key && matches.has(key));
}

export async function getFreshExternalStockMatchesForLines(
  lines: ExternalStockLineIdentity[],
  options: ExternalStockReadinessOptions = {}
): Promise<Set<string>> {
  const requestedBySource = new Map<string, Set<string>>();
  for (const line of lines) {
    const source = stockSourceForWarehouse(line.warehouseId);
    const inventoryId = normalizeStockInventoryId(line.inventoryId);
    if (!source || !inventoryId) continue;
    const ids = requestedBySource.get(source) ?? new Set<string>();
    ids.add(inventoryId);
    requestedBySource.set(source, ids);
  }
  if (requestedBySource.size === 0) return new Set();

  const db = await getReadinessPrisma(options.client);
  const matches = new Set<string>();
  for (const [source, ids] of requestedBySource) {
    const freshness = await getLatestSharePointStockSyncFreshness({ ...options, client: db, source });
    if (!freshness.isFresh) continue;
    const rows = await db.externalStockItem.findMany({
      where: { source, isActive: true, normalizedInventoryId: { in: [...ids] } },
      select: { normalizedInventoryId: true },
    });
    for (const row of rows) matches.add(stockMatchKey(source, row.normalizedInventoryId));
  }
  return matches;
}

// Kept for existing Utah/Wyoming inspection scripts.
export async function getFreshExternalStockMatchesForInventoryIds(
  inventoryIds: unknown[],
  options: ExternalStockReadinessOptions = {}
) {
  return getFreshExternalStockMatchesForLines(
    inventoryIds.map((inventoryId) => ({ inventoryId, warehouseId: "SALT LAKE SHOWROOM" })),
    options
  );
}
