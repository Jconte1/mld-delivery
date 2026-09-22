import { syncSharePointStockItems } from "@/lib/sharepoint-stock/syncSharepointStockItems";
import {
  SHAREPOINT_STOCK_LIST_KEYS,
  type SharePointStockListKey,
} from "@/lib/sharepoint-stock/regionalStockLists";

function requestedLists(args: string[]): SharePointStockListKey[] {
  if (args.includes("--all")) return [...SHAREPOINT_STOCK_LIST_KEYS];
  const index = args.findIndex((arg) => arg === "--list" || arg.startsWith("--list="));
  if (index < 0) return ["utah_wyoming"];
  const value = args[index].includes("=") ? args[index].split("=", 2)[1] : args[index + 1];
  if (!SHAREPOINT_STOCK_LIST_KEYS.includes(value as SharePointStockListKey)) {
    throw new Error(`--list must be one of ${SHAREPOINT_STOCK_LIST_KEYS.join(", ")}`);
  }
  return [value as SharePointStockListKey];
}

async function main() {
  const results = [];
  for (const stockListKey of requestedLists(process.argv.slice(2))) {
    results.push(await syncSharePointStockItems({ stockListKey }));
  }
  console.log(
    JSON.stringify(
      {
        finalStatus: results.every((result) => result.status === "SUCCESS") ? "SUCCESS" : "FAILED",
        results: results.map((result) => ({
          stockListKey: result.stockListKey,
          source: result.source,
          syncRunId: result.syncRunId,
          status: result.status,
          workbookName: result.workbookName,
          worksheetName: result.worksheetName,
          inventoryIdColumn: result.inventoryIdColumn,
          rowsRead: result.rowsRead,
          created: result.itemsCreated,
          updated: result.itemsUpdated,
          deactivated: result.itemsDeactivated,
          skipped: result.itemsSkipped,
          duplicateCount: result.duplicateCount,
          skippedRowsByReason: result.skippedRowsByReason,
          validationErrors: result.validationErrors,
          metadataEndpointWorked: result.metadataEndpointWorked,
          contentEndpointWorked: result.contentEndpointWorked,
        })),
        safety:
          "Only SharePointStockSyncRun and ExternalStockItem are written by this script.",
      },
      null,
      2
    )
  );

  if (results.some((result) => result.status === "FAILED")) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        finalStatus: "FAILED",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
