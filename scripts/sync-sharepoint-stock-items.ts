import { syncSharePointStockItems } from "@/lib/sharepoint-stock/syncSharepointStockItems";

async function main() {
  const result = await syncSharePointStockItems();
  console.log(
    JSON.stringify(
      {
        syncRunId: result.syncRunId,
        finalStatus: result.status,
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
        safety:
          "Only SharePointStockSyncRun and ExternalStockItem are written by this script.",
      },
      null,
      2
    )
  );

  if (result.status === "FAILED") {
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
