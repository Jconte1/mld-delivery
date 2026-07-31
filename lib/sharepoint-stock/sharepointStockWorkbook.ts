import ExcelJS from "exceljs";

import { normalizeStockInventoryId } from "@/lib/sharepoint-stock/stockInventoryNormalization";

export const REQUIRED_SHAREPOINT_STOCK_SYNC_ENV_VARS = [
  "SHAREPOINT_TENANT_ID",
  "SHAREPOINT_CLIENT_ID",
  "SHAREPOINT_CLIENT_SECRET",
  "SHAREPOINT_SITE_ID",
  "SHAREPOINT_DRIVE_ID",
  "SHAREPOINT_FILE_ID",
  "SHAREPOINT_STOCK_WORKSHEET_NAME",
  "SHAREPOINT_STOCK_INVENTORY_ID_COLUMN",
] as const;

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MAX_HEADER_ROWS_TO_SCAN = 20;
const MAX_INVENTORY_ID_LENGTH = 128;

export type SharePointStockSyncEnvName =
  (typeof REQUIRED_SHAREPOINT_STOCK_SYNC_ENV_VARS)[number];

export type SharePointStockSyncEnv = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteId: string;
  driveId: string;
  fileId: string;
  worksheetName: string;
  inventoryIdColumn: string;
};

export type SharePointWorkbookMetadata = {
  id: string | null;
  name: string | null;
  eTag: string | null;
  cTag: string | null;
  size: number | null;
  lastModifiedDateTime: string | null;
  webUrl: string | null;
  parentReference: {
    driveId: string | null;
    siteId: string | null;
  };
};

export type SharePointStockWorkbookRow = {
  rowNumber: number;
  inventoryId: string;
  normalizedInventoryId: string;
};

export type SharePointStockWorkbookSkippedRow = {
  rowNumber: number;
  reason: "blank_inventory_id" | "duplicate_inventory_id" | "inventory_id_too_long";
};

export type SharePointStockWorkbookExtraction = {
  metadata: SharePointWorkbookMetadata;
  metadataEndpointWorked: string;
  contentEndpointWorked: string;
  worksheetName: string;
  inventoryIdColumn: string;
  headerRowNumber: number;
  inventoryColumnNumber: number;
  rowsRead: number;
  rows: SharePointStockWorkbookRow[];
  skippedRows: SharePointStockWorkbookSkippedRow[];
  duplicateCount: number;
};

export class SharePointStockWorkbookError extends Error {
  readonly safeErrors: string[];

  constructor(message: string, safeErrors: string[] = [message]) {
    super(message);
    this.name = "SharePointStockWorkbookError";
    this.safeErrors = safeErrors;
  }
}

function envValue(name: string, env: NodeJS.ProcessEnv) {
  return env[name]?.trim() ?? "";
}

export function validateSharePointStockSyncEnv(env: NodeJS.ProcessEnv = process.env) {
  const missing = REQUIRED_SHAREPOINT_STOCK_SYNC_ENV_VARS.filter((name) => !envValue(name, env));
  return {
    ok: missing.length === 0,
    missing,
    found: REQUIRED_SHAREPOINT_STOCK_SYNC_ENV_VARS.filter((name) => envValue(name, env)),
  };
}

export function requireSharePointStockSyncEnv(
  env: NodeJS.ProcessEnv = process.env
): SharePointStockSyncEnv {
  const validation = validateSharePointStockSyncEnv(env);
  if (!validation.ok) {
    throw new SharePointStockWorkbookError(
      `Missing SharePoint stock sync env vars: ${validation.missing.join(", ")}`,
      validation.missing.map((name) => `Missing env var: ${name}`)
    );
  }

  return {
    tenantId: envValue("SHAREPOINT_TENANT_ID", env),
    clientId: envValue("SHAREPOINT_CLIENT_ID", env),
    clientSecret: envValue("SHAREPOINT_CLIENT_SECRET", env),
    siteId: envValue("SHAREPOINT_SITE_ID", env),
    driveId: envValue("SHAREPOINT_DRIVE_ID", env),
    fileId: envValue("SHAREPOINT_FILE_ID", env),
    worksheetName: envValue("SHAREPOINT_STOCK_WORKSHEET_NAME", env),
    inventoryIdColumn: envValue("SHAREPOINT_STOCK_INVENTORY_ID_COLUMN", env),
  };
}

function redactedGraphError(text: string, env: SharePointStockSyncEnv) {
  let result = text.replace(/\s+/g, " ").trim();
  for (const [name, value] of Object.entries({
    SHAREPOINT_TENANT_ID: env.tenantId,
    SHAREPOINT_CLIENT_ID: env.clientId,
    SHAREPOINT_CLIENT_SECRET: env.clientSecret,
    SHAREPOINT_SITE_ID: env.siteId,
    SHAREPOINT_DRIVE_ID: env.driveId,
    SHAREPOINT_FILE_ID: env.fileId,
  })) {
    if (value.length >= 6) {
      result = result.replaceAll(value, `[redacted:${name}]`);
      result = result.replaceAll(encodeURIComponent(value), `[redacted:${name}]`);
    }
  }

  return result.replace(/[A-Za-z0-9._-]{80,}/g, "[redacted-long-token]").slice(0, 500);
}

async function graphAccessToken(env: SharePointStockSyncEnv) {
  const body = new URLSearchParams();
  body.set("client_id", env.clientId);
  body.set("client_secret", env.clientSecret);
  body.set("scope", "https://graph.microsoft.com/.default");
  body.set("grant_type", "client_credentials");

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(env.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );

  if (!response.ok) {
    throw new SharePointStockWorkbookError(
      `Graph token request failed: ${response.status}`,
      [`Graph token request failed: ${response.status} ${redactedGraphError(await response.text(), env)}`]
    );
  }

  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new SharePointStockWorkbookError("Graph token response did not include access_token");
  }

  return json.access_token;
}

async function graphGetJson<T>(params: {
  token: string;
  endpoint: string;
  label: string;
  env: SharePointStockSyncEnv;
}) {
  const response = await fetch(params.endpoint, {
    headers: { Authorization: `Bearer ${params.token}` },
  });

  if (!response.ok) {
    throw new SharePointStockWorkbookError(
      `Graph ${params.label} request failed: ${response.status}`,
      [
        `Graph ${params.label} request failed: ${response.status} ${redactedGraphError(
          await response.text(),
          params.env
        )}`,
      ]
    );
  }

  return (await response.json()) as T;
}

async function graphDownloadContent(params: {
  token: string;
  endpoint: string;
  label: string;
  env: SharePointStockSyncEnv;
}) {
  const response = await fetch(params.endpoint, {
    headers: { Authorization: `Bearer ${params.token}` },
  });

  if (!response.ok) {
    throw new SharePointStockWorkbookError(
      `Graph ${params.label} request failed: ${response.status}`,
      [
        `Graph ${params.label} request failed: ${response.status} ${redactedGraphError(
          await response.text(),
          params.env
        )}`,
      ]
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

function textOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeWorkbookMetadata(raw: Record<string, unknown>): SharePointWorkbookMetadata {
  const parentReference =
    raw.parentReference && typeof raw.parentReference === "object"
      ? (raw.parentReference as Record<string, unknown>)
      : {};

  return {
    id: textOrNull(raw.id),
    name: textOrNull(raw.name),
    eTag: textOrNull(raw.eTag),
    cTag: textOrNull(raw.cTag),
    size: numberOrNull(raw.size),
    lastModifiedDateTime: textOrNull(raw.lastModifiedDateTime),
    webUrl: textOrNull(raw.webUrl),
    parentReference: {
      driveId: textOrNull(parentReference.driveId),
      siteId: textOrNull(parentReference.siteId),
    },
  };
}

function normalizedHeading(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizedComparison(value: string | null | undefined) {
  return normalizedHeading(value ?? "").toLowerCase();
}

function cellText(cell: ExcelJS.Cell) {
  return normalizedHeading(cell.text ?? "");
}

function rowColumnTexts(row: ExcelJS.Row) {
  const values: Array<{ column: number; text: string }> = [];
  row.eachCell({ includeEmpty: false }, (cell, column) => {
    const text = cellText(cell);
    if (text) values.push({ column, text });
  });
  return values;
}

function worksheetByName(workbook: ExcelJS.Workbook, name: string) {
  return (
    workbook.worksheets.find(
      (worksheet) => normalizedComparison(worksheet.name) === normalizedComparison(name)
    ) ?? null
  );
}

function findInventoryHeader(params: { worksheet: ExcelJS.Worksheet; inventoryIdColumn: string }) {
  const maxRow = Math.min(params.worksheet.rowCount, MAX_HEADER_ROWS_TO_SCAN);
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = params.worksheet.getRow(rowNumber);
    const columns = rowColumnTexts(row);
    const match = columns.find(
      (column) => normalizedComparison(column.text) === normalizedComparison(params.inventoryIdColumn)
    );
    if (match) {
      return { rowNumber, columnNumber: match.column };
    }
  }

  return null;
}

export function extractStockInventoryRowsFromWorkbook(params: {
  workbook: ExcelJS.Workbook;
  metadata: SharePointWorkbookMetadata;
  metadataEndpointWorked?: string;
  contentEndpointWorked?: string;
  worksheetName: string;
  inventoryIdColumn: string;
}): SharePointStockWorkbookExtraction {
  const worksheet = worksheetByName(params.workbook, params.worksheetName);
  if (!worksheet) {
    throw new SharePointStockWorkbookError(`Configured worksheet was not found`, [
      `Worksheet not found: ${params.worksheetName}`,
    ]);
  }

  const header = findInventoryHeader({
    worksheet,
    inventoryIdColumn: params.inventoryIdColumn,
  });
  if (!header) {
    throw new SharePointStockWorkbookError(`Configured inventory ID column was not found`, [
      `Inventory ID column not found on worksheet ${worksheet.name}: ${params.inventoryIdColumn}`,
    ]);
  }

  const rows: SharePointStockWorkbookRow[] = [];
  const skippedRows: SharePointStockWorkbookSkippedRow[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  let rowsRead = 0;

  for (let rowNumber = header.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    rowsRead += 1;
    const raw = cellText(worksheet.getRow(rowNumber).getCell(header.columnNumber));
    const normalizedInventoryId = normalizeStockInventoryId(raw);

    if (!normalizedInventoryId) {
      skippedRows.push({ rowNumber, reason: "blank_inventory_id" });
      continue;
    }

    if (normalizedInventoryId.length > MAX_INVENTORY_ID_LENGTH) {
      skippedRows.push({ rowNumber, reason: "inventory_id_too_long" });
      continue;
    }

    if (seen.has(normalizedInventoryId)) {
      duplicateCount += 1;
      skippedRows.push({ rowNumber, reason: "duplicate_inventory_id" });
      continue;
    }

    seen.add(normalizedInventoryId);
    rows.push({
      rowNumber,
      inventoryId: raw.trim(),
      normalizedInventoryId,
    });
  }

  if (rows.length === 0) {
    throw new SharePointStockWorkbookError("Workbook produced zero usable inventory IDs", [
      `No usable inventory IDs found on worksheet ${worksheet.name} column ${params.inventoryIdColumn}`,
    ]);
  }

  return {
    metadata: params.metadata,
    metadataEndpointWorked: params.metadataEndpointWorked ?? "mocked",
    contentEndpointWorked: params.contentEndpointWorked ?? "mocked",
    worksheetName: worksheet.name,
    inventoryIdColumn: params.inventoryIdColumn,
    headerRowNumber: header.rowNumber,
    inventoryColumnNumber: header.columnNumber,
    rowsRead,
    rows,
    skippedRows,
    duplicateCount,
  };
}

async function parseWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

export async function loadSharePointStockWorkbookFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<SharePointStockWorkbookExtraction> {
  const syncEnv = requireSharePointStockSyncEnv(env);
  const token = await graphAccessToken(syncEnv);
  const metadataEndpoint = `${GRAPH_BASE_URL}/drives/${encodeURIComponent(
    syncEnv.driveId
  )}/items/${encodeURIComponent(syncEnv.fileId)}`;
  const contentEndpoint = `${metadataEndpoint}/content`;

  const metadata = safeWorkbookMetadata(
    await graphGetJson<Record<string, unknown>>({
      token,
      endpoint: metadataEndpoint,
      label: "drive-item metadata",
      env: syncEnv,
    })
  );
  const workbook = await parseWorkbook(
    await graphDownloadContent({
      token,
      endpoint: contentEndpoint,
      label: "drive-item content",
      env: syncEnv,
    })
  );

  return extractStockInventoryRowsFromWorkbook({
    workbook,
    metadata,
    metadataEndpointWorked: "drive-item",
    contentEndpointWorked: "drive-item-content",
    worksheetName: syncEnv.worksheetName,
    inventoryIdColumn: syncEnv.inventoryIdColumn,
  });
}

export function safeSharePointStockWorkbookErrors(error: unknown) {
  if (error instanceof SharePointStockWorkbookError) return error.safeErrors;
  if (error instanceof Error) return [error.message.slice(0, 500)];
  return [String(error).slice(0, 500)];
}
