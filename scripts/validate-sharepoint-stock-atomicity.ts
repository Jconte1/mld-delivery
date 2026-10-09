import assert from "node:assert/strict";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client";
import type { SyncSharePointStockItemsOptions } from "../lib/sharepoint-stock/syncSharepointStockItems";
import type { SharePointStockWorkbookExtraction } from "../lib/sharepoint-stock/sharepointStockWorkbook";
import { SHAREPOINT_STOCK_SOURCES } from "../lib/sharepoint-stock/regionalStockLists";

type SyncClient = NonNullable<SyncSharePointStockItemsOptions["client"]>;
type Transaction = Parameters<Parameters<SyncClient["$transaction"]>[0]>[0];

function workbook(...ids: string[]): SharePointStockWorkbookExtraction {
  return {
    metadata: { id: "isolated-workbook", name: "Isolated.xlsx", eTag: null, cTag: null,
      size: 1, lastModifiedDateTime: null, webUrl: null, parentReference: { driveId: null, siteId: null } },
    worksheetName: "Models", inventoryIdColumn: "Model", rowsRead: ids.length,
    headerRowNumber: 1, inventoryColumnNumber: 1,
    rows: ids.map((id, i) => ({ inventoryId: id, normalizedInventoryId: id, rowNumber: i + 2 })),
    skippedRows: [], duplicateCount: 0, metadataEndpointWorked: "fixture", contentEndpointWorked: "fixture",
  };
}

async function main() {
  const url = new URL(process.env.TEST_DELIVERY_GROUP_DATABASE_URL ?? "http://invalid");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
      !url.pathname.startsWith("/delivery_group_validation") || url.search) {
    throw new Error("Explicit isolated loopback TEST_DELIVERY_GROUP_DATABASE_URL required");
  }
  process.env.DATABASE_URL = url.toString();
  globalThis.fetch = async () => { throw new Error("No network providers allowed in validation"); };
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const { syncSharePointStockItems: sync } = await import("../lib/sharepoint-stock/syncSharepointStockItems");
  const sources = Object.values(SHAREPOINT_STOCK_SOURCES);
  let ownsFixtures = false;
  let release = () => {};
  let running: Promise<unknown> | undefined;
  try {
    assert.equal(await db.externalStockItem.count({ where: { source: { in: sources } } }), 0, "Stock fixtures must start empty");
    assert.equal(await db.sharePointStockSyncRun.count({ where: { source: { in: sources } } }), 0, "Sync fixtures must start empty");
    ownsFixtures = true;
    const run = (ids: string[], client: NonNullable<SyncSharePointStockItemsOptions["client"]> = db) =>
      sync({ client, loadWorkbook: async () => workbook(...ids) });
    assert.equal((await run(["OLD", "KEEP"])).status, "SUCCESS");
    const snapshot = async () => JSON.stringify(await db.externalStockItem.findMany({
      where: { source: SHAREPOINT_STOCK_SOURCES.utah_wyoming }, orderBy: { normalizedInventoryId: "asc" },
    }));
    const original = await snapshot();
    const failClient = (phase: "upsert" | "success") => ({
      sharePointStockSyncRun: db.sharePointStockSyncRun,
      $transaction: async <T>(work: (tx: Transaction) => Promise<T>) =>
        db.$transaction(async tx => {
          let calls = 0;
          return work({ ...tx,
            externalStockItem: { ...tx.externalStockItem, upsert: async (args: Parameters<typeof tx.externalStockItem.upsert>[0]) => {
              if (phase === "upsert" && ++calls === 2) throw new Error("Injected row failure");
              return tx.externalStockItem.upsert(args);
            } } as unknown as typeof tx.externalStockItem,
            sharePointStockSyncRun: { ...tx.sharePointStockSyncRun, update: async () => {
              if (phase === "success") throw new Error("Injected success-record failure after deactivation");
              throw new Error("Unexpected success update");
            } } as typeof tx.sharePointStockSyncRun,
          });
        }, { timeout: 20_000 }),
    });
    for (const phase of ["upsert", "success"] as const) {
      assert.equal((await run(["NEW", "KEEP"], failClient(phase))).status, "FAILED");
      assert.equal(await snapshot(), original, "All row changes and deactivations roll back");
      assert.equal(await db.sharePointStockSyncRun.count({ where: { status: "SUCCESS" } }), 1);
    }
    let entered = () => {};
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pausedClient: SyncClient = {
      sharePointStockSyncRun: db.sharePointStockSyncRun,
      $transaction: async <T>(work: (tx: Transaction) => Promise<T>) => db.$transaction(async tx => {
        let first = true;
        return work({ ...tx, externalStockItem: { ...tx.externalStockItem,
          upsert: async (args: Parameters<typeof tx.externalStockItem.upsert>[0]) => {
            const result = await tx.externalStockItem.upsert(args);
            if (first) { first = false; entered(); await gate; }
            return result;
          },
        } as unknown as typeof tx.externalStockItem });
      }, { timeout: 20_000 }),
    };
    running = sync({ client: pausedClient, loadWorkbook: async () => workbook("NEW", "KEEP") });
    await ready;
    let competingDownloads = 0;
    const competitor = await sync({ client: db, loadWorkbook: async () => {
      competingDownloads++; return workbook("WRONG");
    } });
    assert.equal(competitor.status, "FAILED");
    assert.equal(competingDownloads, 0, "Contender rejected before workbook download");
    assert.equal(await snapshot(), original, "Readers retain last committed snapshot while refresh is in progress");
    assert.equal((await sync({ client: db, stockListKey: "idaho", loadWorkbook: async () => workbook("IDAHO") })).status, "SUCCESS");
    release();
    assert.equal((await running as { status: string }).status, "SUCCESS");
    assert.deepEqual((await db.externalStockItem.findMany({ where: { source: SHAREPOINT_STOCK_SOURCES.utah_wyoming, isActive: true },
      orderBy: { normalizedInventoryId: "asc" } })).map(r => r.normalizedInventoryId), ["KEEP", "NEW"]);
    assert.equal((await run(["FINAL"])).status, "SUCCESS", "Lock releases after commit and rollback");
    console.log(JSON.stringify({ ok: true, tested: ["mid-row rollback", "success-record rollback", "same-region exclusion before download",
      "reader visibility", "independent-region concurrency", "lock release"], productionWrites: 0, sharePointCalls: 0 }));
  } finally {
    release();
    await running;
    if (ownsFixtures) {
      await db.externalStockItem.deleteMany({ where: { source: { in: sources } } });
      await db.sharePointStockSyncRun.deleteMany({ where: { source: { in: sources } } });
    }
    await db.$disconnect();
    const { prisma } = await import("../lib/prisma");
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
