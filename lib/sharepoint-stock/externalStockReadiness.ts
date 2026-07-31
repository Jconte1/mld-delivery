import {
  SharePointStockSyncRunStatus,
  type Prisma,
} from "@/lib/generated/prisma/client";
import {
  normalizeStockInventoryId,
  SHAREPOINT_STOCK_SOURCE,
} from "@/lib/sharepoint-stock/stockInventoryNormalization";

export type SharePointStockFreshnessStaleReason =
  | "no_successful_sync"
  | "missing_completed_at"
  | "stale"
  | null;

export type SharePointStockSyncFreshness = {
  latestSyncId: string | null;
  completedAt: Date | null;
  freshnessDays: number;
  isFresh: boolean;
  staleReason: SharePointStockFreshnessStaleReason;
};

type ExternalStockReadinessClient = {
  sharePointStockSyncRun: Pick<
    Prisma.TransactionClient["sharePointStockSyncRun"],
    "findFirst"
  >;
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

export function getSharePointStockFreshnessDays(
  env: NodeJS.ProcessEnv = process.env
) {
  const raw = env.SHAREPOINT_STOCK_FRESHNESS_DAYS?.trim();
  if (!raw) return DEFAULT_SHAREPOINT_STOCK_FRESHNESS_DAYS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SHAREPOINT_STOCK_FRESHNESS_DAYS;
  }

  return parsed;
}

export async function getLatestSharePointStockSyncFreshness(
  options: ExternalStockReadinessOptions = {}
): Promise<SharePointStockSyncFreshness> {
  const db = await getReadinessPrisma(options.client);
  const freshnessDays = getSharePointStockFreshnessDays(options.env);
  const now = options.now ?? new Date();
  const latest = await db.sharePointStockSyncRun.findFirst({
    where: {
      status: SharePointStockSyncRunStatus.SUCCESS,
    },
    orderBy: [{ completedAt: "desc" }, { startedAt: "desc" }],
    select: {
      id: true,
      completedAt: true,
    },
  });

  if (!latest) {
    return {
      latestSyncId: null,
      completedAt: null,
      freshnessDays,
      isFresh: false,
      staleReason: "no_successful_sync",
    };
  }

  if (!latest.completedAt) {
    return {
      latestSyncId: latest.id,
      completedAt: null,
      freshnessDays,
      isFresh: false,
      staleReason: "missing_completed_at",
    };
  }

  const oldestFreshTime = now.getTime() - freshnessDays * MS_PER_DAY;
  const isFresh = latest.completedAt.getTime() >= oldestFreshTime;
  return {
    latestSyncId: latest.id,
    completedAt: latest.completedAt,
    freshnessDays,
    isFresh,
    staleReason: isFresh ? null : "stale",
  };
}

export function normalizeStockInventoryIds(inventoryIds: unknown[]) {
  return [
    ...new Set(
      inventoryIds
        .map((inventoryId) => normalizeStockInventoryId(inventoryId))
        .filter((inventoryId): inventoryId is string => Boolean(inventoryId))
    ),
  ];
}

export async function getFreshExternalStockMatchesForInventoryIds(
  inventoryIds: unknown[],
  options: ExternalStockReadinessOptions = {}
): Promise<Set<string>> {
  const normalizedInventoryIds = normalizeStockInventoryIds(inventoryIds);
  if (normalizedInventoryIds.length === 0) return new Set();

  const db = await getReadinessPrisma(options.client);
  const freshness = await getLatestSharePointStockSyncFreshness({
    ...options,
    client: db,
  });
  if (!freshness.isFresh) return new Set();

  const matches = await db.externalStockItem.findMany({
    where: {
      source: SHAREPOINT_STOCK_SOURCE,
      isActive: true,
      normalizedInventoryId: { in: normalizedInventoryIds },
    },
    select: {
      normalizedInventoryId: true,
    },
  });

  return new Set(matches.map((match) => match.normalizedInventoryId));
}
