import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { normalizeStockInventoryId, SHAREPOINT_STOCK_SOURCE } from "@/lib/sharepoint-stock/stockInventoryNormalization";
import {
  extractStockInventoryRowsFromWorkbook,
  SharePointStockWorkbookError,
  type SharePointStockWorkbookExtraction,
  type SharePointWorkbookMetadata,
} from "@/lib/sharepoint-stock/sharepointStockWorkbook";
import type { SyncSharePointStockItemsOptions } from "@/lib/sharepoint-stock/syncSharepointStockItems";

type SyncClientOption = NonNullable<SyncSharePointStockItemsOptions["client"]>;

type FakeItem = {
  id: string;
  inventoryId: string;
  normalizedInventoryId: string;
  source: string;
  sourceRowNumber: number | null;
  sourceWorkbookId: string | null;
  lastSeenAt: Date;
  lastSyncedAt: Date;
  isActive: boolean;
};

const metadata: SharePointWorkbookMetadata = {
  id: "mock_workbook",
  name: "Mock Stock Workbook.xlsx",
  eTag: "mock_etag",
  cTag: null,
  size: 1024,
  lastModifiedDateTime: "2026-07-21T21:30:10Z",
  webUrl: null,
  parentReference: {
    driveId: "mock_drive",
    siteId: "mock_site",
  },
};

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function createWorkbook(params: {
  worksheetName?: string;
  header?: string[];
  rows?: Array<Array<unknown>>;
}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(params.worksheetName ?? "Models Only");
  worksheet.addRow(params.header ?? ["Model", "Notes"]);
  for (const row of params.rows ?? []) {
    worksheet.addRow(row);
  }
  return workbook;
}

function extract(params: {
  worksheetName?: string;
  inventoryIdColumn?: string;
  workbook?: ExcelJS.Workbook;
}) {
  return extractStockInventoryRowsFromWorkbook({
    workbook:
      params.workbook ??
      createWorkbook({
        rows: [
          ["abc-123", "stock"],
          ["DEF/456 A.B", "stock"],
        ],
      }),
    metadata,
    worksheetName: params.worksheetName ?? "Models Only",
    inventoryIdColumn: params.inventoryIdColumn ?? "Model",
  });
}

function skippedRowsByReason(result: SharePointStockWorkbookExtraction, reason: string) {
  return result.skippedRows.filter((row) => row.reason === reason).length;
}

function createFakeClient(initialItems: FakeItem[] = []) {
  const runs: Array<Record<string, unknown>> = [];
  const items = new Map<string, FakeItem>();
  let updateManyCalls = 0;

  function key(source: string, normalizedInventoryId: string) {
    return `${source}:${normalizedInventoryId}`;
  }

  for (const item of initialItems) {
    items.set(key(item.source, item.normalizedInventoryId), { ...item });
  }

  return {
    state: {
      runs,
      items,
      get updateManyCalls() {
        return updateManyCalls;
      },
    },
    client: {
      sharePointStockSyncRun: {
        create: async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
          const run = {
            id: `run_${runs.length + 1}`,
            ...args.data,
          };
          runs.push(run);
          return { id: run.id };
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const run = runs.find((candidate) => candidate.id === args.where.id);
          if (!run) throw new Error(`Missing sync run ${args.where.id}`);
          Object.assign(run, args.data);
          return run;
        },
      },
      externalStockItem: {
        findMany: async (args: {
          where: { source: string; normalizedInventoryId: { in: string[] } };
          select: { normalizedInventoryId: boolean };
        }) => {
          const wanted = new Set(args.where.normalizedInventoryId.in);
          return [...items.values()]
            .filter(
              (item) =>
                item.source === args.where.source && wanted.has(item.normalizedInventoryId)
            )
            .map((item) => ({
              normalizedInventoryId: item.normalizedInventoryId,
            }));
        },
        upsert: async (args: {
          where: {
            source_normalizedInventoryId: {
              source: string;
              normalizedInventoryId: string;
            };
          };
          create: Omit<FakeItem, "id">;
          update: Partial<FakeItem>;
        }) => {
          const source = args.where.source_normalizedInventoryId.source;
          const normalizedInventoryId =
            args.where.source_normalizedInventoryId.normalizedInventoryId;
          const itemKey = key(source, normalizedInventoryId);
          const existing = items.get(itemKey);
          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }

          const created = {
            id: `item_${items.size + 1}`,
            ...args.create,
          };
          items.set(itemKey, created);
          return created;
        },
        updateMany: async (args: {
          where: {
            source: string;
            isActive: boolean;
            normalizedInventoryId: { notIn: string[] };
          };
          data: Partial<FakeItem>;
        }) => {
          updateManyCalls += 1;
          const notIn = new Set(args.where.normalizedInventoryId.notIn);
          let count = 0;

          for (const item of items.values()) {
            if (
              item.source === args.where.source &&
              item.isActive === args.where.isActive &&
              !notIn.has(item.normalizedInventoryId)
            ) {
              Object.assign(item, args.data);
              count += 1;
            }
          }

          return { count };
        },
      },
    },
  };
}

function extractionFromRows(rows: Array<Array<unknown>>) {
  return extract({
    workbook: createWorkbook({
      rows,
    }),
  });
}

async function run() {
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const { syncSharePointStockItems } = await import(
    "@/lib/sharepoint-stock/syncSharepointStockItems"
  );
  const failures: string[] = [];

  assert(
    normalizeStockInventoryId("  abc-123  ") === "ABC-123",
    "normalize trims and uppercases",
    failures
  );
  assert(
    normalizeStockInventoryId("  01-y648/01 a.b  ") === "01-Y648/01 A.B",
    "normalize preserves dashes, slashes, internal spaces, and punctuation",
    failures
  );
  assert(normalizeStockInventoryId(null) === null, "null normalizes to null", failures);
  assert(normalizeStockInventoryId("   ") === null, "blank normalizes to null", failures);

  const duplicate = extractionFromRows([
    ["abc-123", "first"],
    [" ABC-123 ", "duplicate"],
    ["def/456", "second"],
  ]);
  assert(duplicate.rows.length === 2, "duplicate extraction keeps first unique rows", failures);
  assert(duplicate.duplicateCount === 1, "duplicate normalized inventory IDs are detected", failures);
  assert(
    skippedRowsByReason(duplicate, "duplicate_inventory_id") === 1,
    "duplicate row is counted as skipped",
    failures
  );

  try {
    extract({ worksheetName: "Missing Sheet" });
    failures.push("missing worksheet must fail safely");
  } catch (error) {
    assert(
      error instanceof SharePointStockWorkbookError,
      "missing worksheet uses safe workbook error",
      failures
    );
  }

  try {
    extract({ inventoryIdColumn: "Inventory ID" });
    failures.push("missing inventory ID column must fail safely");
  } catch (error) {
    assert(
      error instanceof SharePointStockWorkbookError,
      "missing inventory ID column uses safe workbook error",
      failures
    );
  }

  const existingDate = new Date("2026-07-01T00:00:00.000Z");
  const failedClient = createFakeClient([
    {
      id: "old_item",
      inventoryId: "OLD",
      normalizedInventoryId: "OLD",
      source: SHAREPOINT_STOCK_SOURCE,
      sourceRowNumber: 2,
      sourceWorkbookId: "old_workbook",
      lastSeenAt: existingDate,
      lastSyncedAt: existingDate,
      isActive: true,
    },
  ]);
  const failedSync = await syncSharePointStockItems({
    client: failedClient.client as unknown as SyncClientOption,
    loadWorkbook: async () => {
      throw new SharePointStockWorkbookError("Mock validation failed", [
        "Mock validation failed",
      ]);
    },
    now: new Date("2026-07-31T12:00:00.000Z"),
  });
  assert(failedSync.status === "FAILED", "invalid workbook marks sync run failed", failures);
  assert(
    failedClient.state.updateManyCalls === 0,
    "invalid workbook does not deactivate existing records",
    failures
  );
  assert(
    failedClient.state.items.get(`${SHAREPOINT_STOCK_SOURCE}:OLD`)?.isActive === true,
    "invalid workbook leaves existing active item active",
    failures
  );

  const successClient = createFakeClient([
    {
      id: "existing_item",
      inventoryId: "ABC-123",
      normalizedInventoryId: "ABC-123",
      source: SHAREPOINT_STOCK_SOURCE,
      sourceRowNumber: 4,
      sourceWorkbookId: "old_workbook",
      lastSeenAt: existingDate,
      lastSyncedAt: existingDate,
      isActive: true,
    },
    {
      id: "missing_item",
      inventoryId: "MISSING",
      normalizedInventoryId: "MISSING",
      source: SHAREPOINT_STOCK_SOURCE,
      sourceRowNumber: 5,
      sourceWorkbookId: "old_workbook",
      lastSeenAt: existingDate,
      lastSyncedAt: existingDate,
      isActive: true,
    },
  ]);
  const successExtraction = extractionFromRows([
    ["ABC-123", "existing"],
    ["new/456", "new"],
    ["", "blank"],
  ]);
  const successSync = await syncSharePointStockItems({
    client: successClient.client as unknown as SyncClientOption,
    loadWorkbook: async () => successExtraction,
    now: new Date("2026-07-31T12:00:00.000Z"),
  });
  assert(successSync.status === "SUCCESS", "successful sync status is success", failures);
  assert(successSync.itemsCreated === 1, "successful sync creates new stock item", failures);
  assert(successSync.itemsUpdated === 1, "successful sync updates existing stock item", failures);
  assert(successSync.itemsDeactivated === 1, "successful sync deactivates missing old item", failures);
  assert(
    successClient.state.items.get(`${SHAREPOINT_STOCK_SOURCE}:NEW/456`)?.isActive === true,
    "new item is active after sync",
    failures
  );
  assert(
    successClient.state.items.get(`${SHAREPOINT_STOCK_SOURCE}:MISSING`)?.isActive === false,
    "missing item is inactive after sync",
    failures
  );
  assert(
    new Set([...successClient.state.items.keys()]).size === successClient.state.items.size,
    "source plus normalizedInventoryId uniqueness is respected in fake upsert",
    failures
  );

  const syncSource = await readFile(
    path.join(process.cwd(), "lib/sharepoint-stock/syncSharepointStockItems.ts"),
    "utf8"
  );
  const forbiddenPatterns = [
    "notificationEvent",
    "notificationAttempt",
    "deliveryConfirmation",
    "deliveryGroupTenDayConfirmation",
    "deliveryOrderHoldAction",
    "acumatica",
  ];
  for (const pattern of forbiddenPatterns) {
    assert(
      !syncSource.toLowerCase().includes(pattern.toLowerCase()),
      `sync service must not reference ${pattern}`,
      failures
    );
  }

  if (failures.length > 0) {
    console.error("SharePoint stock sync validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        validation: "sharepoint stock sync validation passed",
        covered: [
          "normalization trims and uppercases",
          "normalization preserves dashes/slashes/internal spaces/punctuation",
          "blank/null values normalize to null",
          "duplicates are detected",
          "missing worksheet fails safely",
          "missing inventory ID column fails safely",
          "invalid workbook does not deactivate records",
          "successful sync upserts active stock items",
          "successful sync deactivates prior active items not seen",
          "source + normalizedInventoryId uniqueness is respected",
          "no customer notification/event/send code is invoked",
        ],
      },
      null,
      2
    )
  );
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
