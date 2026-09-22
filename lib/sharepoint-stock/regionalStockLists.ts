export const SHAREPOINT_STOCK_LIST_KEYS = [
  "utah_wyoming",
  "idaho",
  "southwest",
] as const;

export type SharePointStockListKey = (typeof SHAREPOINT_STOCK_LIST_KEYS)[number];

export const SHAREPOINT_STOCK_SOURCES: Record<SharePointStockListKey, string> = {
  utah_wyoming: "sharepoint_stock_list",
  idaho: "sharepoint_stock_idaho",
  southwest: "sharepoint_stock_southwest",
};

const WAREHOUSE_STOCK_LIST = new Map<string, SharePointStockListKey>([
  ["JACKSON SHOWROOM", "utah_wyoming"],
  ["JACKSON WAREHOUSE", "utah_wyoming"],
  ["PROJECT WAREHOUSE", "utah_wyoming"],
  ["PROVO SHOWROOM", "utah_wyoming"],
  ["SALT LAKE APPLIANCES", "utah_wyoming"],
  ["SALT LAKE HARDWARE", "utah_wyoming"],
  ["SALT LAKE INSTALL", "utah_wyoming"],
  ["SALT LAKE PLUMBING", "utah_wyoming"],
  ["SALT LAKE SHOWROOM", "utah_wyoming"],
  ["BOISE PROJECT", "idaho"],
  ["BOISE SHOWROOM", "idaho"],
  ["BOISE WAREHOUSE", "idaho"],
  ["KETCHUM SHOWROOM", "idaho"],
  ["KETCHUM WAREHOUSE", "idaho"],
  ["SOUTHWEST SHOWROOM", "southwest"],
  ["SOUTHWEST WAREHOUSE", "southwest"],
]);

export function normalizeWarehouseId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replace(/\s+/g, " ").toUpperCase();
  return normalized || null;
}

export function stockListKeyForWarehouse(
  warehouseId: unknown
): SharePointStockListKey | null {
  const normalized = normalizeWarehouseId(warehouseId);
  return normalized ? WAREHOUSE_STOCK_LIST.get(normalized) ?? null : null;
}

export function stockSourceForWarehouse(warehouseId: unknown): string | null {
  const key = stockListKeyForWarehouse(warehouseId);
  return key ? SHAREPOINT_STOCK_SOURCES[key] : null;
}

export function stockMatchKey(source: string, normalizedInventoryId: string) {
  return `${source}::${normalizedInventoryId}`;
}

export type RegionalStockListConfig = {
  key: SharePointStockListKey;
  source: string;
  siteIdEnv: string;
  driveIdEnv: string;
  fileIdEnv: string;
  worksheetNameEnv: string;
  inventoryIdColumnEnv: string;
};

export const REGIONAL_STOCK_LIST_CONFIGS: Record<
  SharePointStockListKey,
  RegionalStockListConfig
> = {
  utah_wyoming: {
    key: "utah_wyoming",
    source: SHAREPOINT_STOCK_SOURCES.utah_wyoming,
    siteIdEnv: "SHAREPOINT_SITE_ID",
    driveIdEnv: "SHAREPOINT_DRIVE_ID",
    fileIdEnv: "SHAREPOINT_FILE_ID",
    worksheetNameEnv: "SHAREPOINT_STOCK_WORKSHEET_NAME",
    inventoryIdColumnEnv: "SHAREPOINT_STOCK_INVENTORY_ID_COLUMN",
  },
  idaho: {
    key: "idaho",
    source: SHAREPOINT_STOCK_SOURCES.idaho,
    siteIdEnv: "SHAREPOINT_STOCK_IDAHO_SITE_ID",
    driveIdEnv: "SHAREPOINT_STOCK_IDAHO_DRIVE_ID",
    fileIdEnv: "SHAREPOINT_STOCK_IDAHO_FILE_ID",
    worksheetNameEnv: "SHAREPOINT_STOCK_IDAHO_WORKSHEET_NAME",
    inventoryIdColumnEnv: "SHAREPOINT_STOCK_IDAHO_INVENTORY_ID_COLUMN",
  },
  southwest: {
    key: "southwest",
    source: SHAREPOINT_STOCK_SOURCES.southwest,
    siteIdEnv: "SHAREPOINT_STOCK_SOUTHWEST_SITE_ID",
    driveIdEnv: "SHAREPOINT_STOCK_SOUTHWEST_DRIVE_ID",
    fileIdEnv: "SHAREPOINT_STOCK_SOUTHWEST_FILE_ID",
    worksheetNameEnv: "SHAREPOINT_STOCK_SOUTHWEST_WORKSHEET_NAME",
    inventoryIdColumnEnv: "SHAREPOINT_STOCK_SOUTHWEST_INVENTORY_ID_COLUMN",
  },
};

export function stockListEnv(
  key: SharePointStockListKey,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const config = REGIONAL_STOCK_LIST_CONFIGS[key];
  return {
    ...env,
    SHAREPOINT_SITE_ID: env[config.siteIdEnv],
    SHAREPOINT_DRIVE_ID: env[config.driveIdEnv],
    SHAREPOINT_FILE_ID: env[config.fileIdEnv],
    SHAREPOINT_STOCK_WORKSHEET_NAME: env[config.worksheetNameEnv],
    SHAREPOINT_STOCK_INVENTORY_ID_COLUMN: env[config.inventoryIdColumnEnv],
  };
}
