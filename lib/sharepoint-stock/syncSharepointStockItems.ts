import {
  SharePointStockSyncRunStatus,
  type Prisma,
} from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { SHAREPOINT_STOCK_SOURCE } from "@/lib/sharepoint-stock/stockInventoryNormalization";
import {
  loadSharePointStockWorkbookFromEnv,
  safeSharePointStockWorkbookErrors,
  type SharePointStockWorkbookExtraction,
} from "@/lib/sharepoint-stock/sharepointStockWorkbook";

type SharePointStockSyncClient = {
  sharePointStockSyncRun: Pick<
    Prisma.TransactionClient["sharePointStockSyncRun"],
    "create" | "update"
  >;
  externalStockItem: Pick<
    Prisma.TransactionClient["externalStockItem"],
    "findMany" | "upsert" | "updateMany"
  >;
};

export type SharePointStockSyncSummary = {
  syncRunId: string;
  status: "SUCCESS" | "FAILED";
  workbookName: string | null;
  worksheetName: string | null;
  inventoryIdColumn: string | null;
  rowsRead: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsDeactivated: number;
  itemsSkipped: number;
  duplicateCount: number;
  skippedRowsByReason: Record<string, number>;
  validationErrors: string[];
  metadataEndpointWorked: string | null;
  contentEndpointWorked: string | null;
};

export type SyncSharePointStockItemsOptions = {
  client?: SharePointStockSyncClient;
  loadWorkbook?: () => Promise<SharePointStockWorkbookExtraction>;
  now?: Date;
};

function countSkippedRowsByReason(rows: SharePointStockWorkbookExtraction["skippedRows"]) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  }
  return counts;
}

function errorsJson(params: {
  duplicateCount: number;
  skippedRowsByReason: Record<string, number>;
  validationErrors: string[];
}) {
  return {
    duplicateCount: params.duplicateCount,
    skippedRowsByReason: params.skippedRowsByReason,
    validationErrors: params.validationErrors,
  };
}

function workbookLastModifiedAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function syncSharePointStockItems(
  options: SyncSharePointStockItemsOptions = {}
): Promise<SharePointStockSyncSummary> {
  const client = options.client ?? prisma;
  const startedAt = options.now ?? new Date();
  const loadWorkbook = options.loadWorkbook ?? (() => loadSharePointStockWorkbookFromEnv());
  const run = await client.sharePointStockSyncRun.create({
    data: {
      status: SharePointStockSyncRunStatus.RUNNING,
      startedAt,
      workbookSiteId: process.env.SHAREPOINT_SITE_ID?.trim() || null,
      workbookDriveId: process.env.SHAREPOINT_DRIVE_ID?.trim() || null,
      workbookFileId: process.env.SHAREPOINT_FILE_ID?.trim() || null,
    },
    select: { id: true },
  });

  try {
    const workbook = await loadWorkbook();
    const skippedRowsByReason = countSkippedRowsByReason(workbook.skippedRows);
    const seenIds = workbook.rows.map((row) => row.normalizedInventoryId);
    const existing = await client.externalStockItem.findMany({
      where: {
        source: SHAREPOINT_STOCK_SOURCE,
        normalizedInventoryId: { in: seenIds },
      },
      select: {
        normalizedInventoryId: true,
      },
    });
    const existingIds = new Set(existing.map((item) => item.normalizedInventoryId));
    let itemsCreated = 0;
    let itemsUpdated = 0;

    for (const row of workbook.rows) {
      const exists = existingIds.has(row.normalizedInventoryId);
      await client.externalStockItem.upsert({
        where: {
          source_normalizedInventoryId: {
            source: SHAREPOINT_STOCK_SOURCE,
            normalizedInventoryId: row.normalizedInventoryId,
          },
        },
        create: {
          inventoryId: row.inventoryId,
          normalizedInventoryId: row.normalizedInventoryId,
          source: SHAREPOINT_STOCK_SOURCE,
          sourceRowNumber: row.rowNumber,
          sourceWorkbookId: workbook.metadata.id ?? process.env.SHAREPOINT_FILE_ID?.trim() ?? null,
          lastSeenAt: startedAt,
          lastSyncedAt: startedAt,
          isActive: true,
        },
        update: {
          inventoryId: row.inventoryId,
          sourceRowNumber: row.rowNumber,
          sourceWorkbookId: workbook.metadata.id ?? process.env.SHAREPOINT_FILE_ID?.trim() ?? null,
          lastSeenAt: startedAt,
          lastSyncedAt: startedAt,
          isActive: true,
        },
      });

      if (exists) itemsUpdated += 1;
      else itemsCreated += 1;
    }

    const deactivated = await client.externalStockItem.updateMany({
      where: {
        source: SHAREPOINT_STOCK_SOURCE,
        isActive: true,
        normalizedInventoryId: { notIn: seenIds },
      },
      data: {
        isActive: false,
        lastSyncedAt: startedAt,
      },
    });
    const validationErrors: string[] = [];

    await client.sharePointStockSyncRun.update({
      where: { id: run.id },
      data: {
        status: SharePointStockSyncRunStatus.SUCCESS,
        completedAt: startedAt,
        workbookName: workbook.metadata.name,
        workbookETag: workbook.metadata.eTag ?? workbook.metadata.cTag,
        workbookLastModifiedAt: workbookLastModifiedAt(workbook.metadata.lastModifiedDateTime),
        rowsRead: workbook.rowsRead,
        itemsCreated,
        itemsUpdated,
        itemsDeactivated: deactivated.count,
        itemsSkipped: workbook.skippedRows.length,
        errorsJson: errorsJson({
          duplicateCount: workbook.duplicateCount,
          skippedRowsByReason,
          validationErrors,
        }),
      },
    });

    return {
      syncRunId: run.id,
      status: "SUCCESS",
      workbookName: workbook.metadata.name,
      worksheetName: workbook.worksheetName,
      inventoryIdColumn: workbook.inventoryIdColumn,
      rowsRead: workbook.rowsRead,
      itemsCreated,
      itemsUpdated,
      itemsDeactivated: deactivated.count,
      itemsSkipped: workbook.skippedRows.length,
      duplicateCount: workbook.duplicateCount,
      skippedRowsByReason,
      validationErrors,
      metadataEndpointWorked: workbook.metadataEndpointWorked,
      contentEndpointWorked: workbook.contentEndpointWorked,
    };
  } catch (error) {
    const validationErrors = safeSharePointStockWorkbookErrors(error);
    const skippedRowsByReason: Record<string, number> = {};

    await client.sharePointStockSyncRun.update({
      where: { id: run.id },
      data: {
        status: SharePointStockSyncRunStatus.FAILED,
        completedAt: startedAt,
        errorsJson: errorsJson({
          duplicateCount: 0,
          skippedRowsByReason,
          validationErrors,
        }),
      },
    });

    return {
      syncRunId: run.id,
      status: "FAILED",
      workbookName: null,
      worksheetName: null,
      inventoryIdColumn: null,
      rowsRead: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsDeactivated: 0,
      itemsSkipped: 0,
      duplicateCount: 0,
      skippedRowsByReason,
      validationErrors,
      metadataEndpointWorked: null,
      contentEndpointWorked: null,
    };
  }
}
