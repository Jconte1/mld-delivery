import ExcelJS from "exceljs";

const REQUIRED_ENV_VARS = [
  "SHAREPOINT_TENANT_ID",
  "SHAREPOINT_CLIENT_ID",
  "SHAREPOINT_CLIENT_SECRET",
  "SHAREPOINT_SITE_ID",
  "SHAREPOINT_DRIVE_ID",
  "SHAREPOINT_FILE_ID",
] as const;

const OPTIONAL_MAPPING_ENV_VARS = [
  "SHAREPOINT_STOCK_WORKSHEET_NAME",
  "SHAREPOINT_STOCK_INVENTORY_ID_COLUMN",
  "SHAREPOINT_STOCK_FRESHNESS_DAYS",
] as const;

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MAX_CANDIDATE_ROWS_TO_SCAN = 20;
const MAX_CANDIDATE_HEADERS_TO_REPORT = 5;
const MAX_HEADINGS_TO_REPORT = 40;

type RequiredEnvName = (typeof REQUIRED_ENV_VARS)[number];
type OptionalMappingEnvName = (typeof OPTIONAL_MAPPING_ENV_VARS)[number];

type EnvSummary = {
  requiredFound: RequiredEnvName[];
  requiredMissing: RequiredEnvName[];
  optionalFound: OptionalMappingEnvName[];
  optionalMissing: OptionalMappingEnvName[];
};

type GraphResult<T> =
  | {
      ok: true;
      label: string;
      endpoint: string;
      status: number;
      data: T;
    }
  | {
      ok: false;
      label: string;
      endpoint: string;
      status: number | null;
      error: string;
    };

type WorkbookMetadata = {
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

type CandidateHeader = {
  rowNumber: number;
  score: number;
  nonEmptyCellCount: number;
  headings: string[];
  roughCandidateDataRowCount: number;
};

type WorksheetSummary = {
  name: string;
  rowCount: number;
  actualRowCount: number;
  columnCount: number;
  actualColumnCount: number;
  firstNonEmptyRow: {
    rowNumber: number;
    nonEmptyCellCount: number;
    firstColumn: number | null;
    lastColumn: number | null;
  } | null;
  candidateHeaders: CandidateHeader[];
};

type TableSummary = {
  worksheetName: string;
  tableName: string;
  ref: string | null;
  columnHeadings: string[];
  roughCandidateDataRowCount: number | null;
};

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function buildEnvSummary(): EnvSummary {
  return {
    requiredFound: REQUIRED_ENV_VARS.filter((name) => envValue(name)),
    requiredMissing: REQUIRED_ENV_VARS.filter((name) => !envValue(name)),
    optionalFound: OPTIONAL_MAPPING_ENV_VARS.filter((name) => envValue(name)),
    optionalMissing: OPTIONAL_MAPPING_ENV_VARS.filter((name) => !envValue(name)),
  };
}

function requireEnv(name: RequiredEnvName) {
  const value = envValue(name);
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function redactSensitiveValues(value: string) {
  let result = value;
  for (const name of REQUIRED_ENV_VARS) {
    const raw = envValue(name);
    if (raw.length >= 6) {
      result = result.replaceAll(raw, `[redacted:${name}]`);
      result = result.replaceAll(encodeURIComponent(raw), `[redacted:${name}]`);
    }
  }
  return result.replace(/[A-Za-z0-9._-]{80,}/g, "[redacted-long-token]");
}

function responseSummaryText(text: string) {
  return redactSensitiveValues(text.replace(/\s+/g, " ").trim()).slice(0, 500);
}

function safeGraphResultSummary<T>(result: GraphResult<T>) {
  return {
    ok: result.ok,
    label: result.label,
    endpoint: redactSensitiveValues(result.endpoint),
    status: result.status,
    error: result.ok ? null : result.error,
  };
}

async function getGraphAccessToken() {
  const tenantId = requireEnv("SHAREPOINT_TENANT_ID");
  const body = new URLSearchParams();
  body.set("client_id", requireEnv("SHAREPOINT_CLIENT_ID"));
  body.set("client_secret", requireEnv("SHAREPOINT_CLIENT_SECRET"));
  body.set("scope", "https://graph.microsoft.com/.default");
  body.set("grant_type", "client_credentials");

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Graph token request failed: ${response.status} ${responseSummaryText(await response.text())}`
    );
  }

  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Graph token response did not include access_token");
  }

  return json.access_token;
}

async function graphGetJson<T>(params: {
  label: string;
  endpoint: string;
  token: string;
}): Promise<GraphResult<T>> {
  try {
    const response = await fetch(params.endpoint, {
      headers: { Authorization: `Bearer ${params.token}` },
    });

    if (!response.ok) {
      return {
        ok: false,
        label: params.label,
        endpoint: params.endpoint,
        status: response.status,
        error: responseSummaryText(await response.text()),
      };
    }

    return {
      ok: true,
      label: params.label,
      endpoint: params.endpoint,
      status: response.status,
      data: (await response.json()) as T,
    };
  } catch (error) {
    return {
      ok: false,
      label: params.label,
      endpoint: params.endpoint,
      status: null,
      error: responseSummaryText(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function graphDownloadContent(params: {
  label: string;
  endpoint: string;
  token: string;
}): Promise<GraphResult<Buffer>> {
  try {
    const response = await fetch(params.endpoint, {
      headers: { Authorization: `Bearer ${params.token}` },
    });

    if (!response.ok) {
      return {
        ok: false,
        label: params.label,
        endpoint: params.endpoint,
        status: response.status,
        error: responseSummaryText(await response.text()),
      };
    }

    return {
      ok: true,
      label: params.label,
      endpoint: params.endpoint,
      status: response.status,
      data: Buffer.from(await response.arrayBuffer()),
    };
  } catch (error) {
    return {
      ok: false,
      label: params.label,
      endpoint: params.endpoint,
      status: null,
      error: responseSummaryText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function textOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeWorkbookMetadata(raw: Record<string, unknown>): WorkbookMetadata {
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

function rowTexts(row: ExcelJS.Row) {
  const values: Array<{ column: number; text: string }> = [];
  row.eachCell({ includeEmpty: false }, (cell, column) => {
    const text = cellText(cell);
    if (text) values.push({ column, text });
  });
  return values;
}

function isNumericLike(value: string) {
  return /^[$,\d.\-/%\s]+$/.test(value);
}

function headerKeywordScore(value: string) {
  const normalized = normalizedComparison(value);
  const keywords = [
    "inventory",
    "inventory id",
    "inventoryid",
    "item",
    "item id",
    "sku",
    "part",
    "part number",
    "model",
    "description",
    "qty",
    "quantity",
    "stock",
    "available",
    "on hand",
    "warehouse",
    "location",
    "bin",
    "notes",
  ];

  return keywords.filter((keyword) => normalized.includes(keyword)).length;
}

function scoreCandidateHeader(params: {
  values: string[];
  rowNumber: number;
  firstNonEmptyRowNumber: number | null;
}) {
  const values = params.values;
  if (values.length < 2) return 0;

  const shortTextCount = values.filter((value) => value.length <= 80).length;
  const numericLikeCount = values.filter(isNumericLike).length;
  const keywordScore = values.reduce((sum, value) => sum + headerKeywordScore(value), 0);
  const keywordCellCount = values.filter((value) => headerKeywordScore(value) > 0).length;
  const uniqueCount = new Set(values.map(normalizedComparison)).size;

  if (keywordScore === 0) return 0;
  if (keywordCellCount < 2 && params.rowNumber !== params.firstNonEmptyRowNumber) return 0;
  if (shortTextCount < Math.max(2, values.length - 1)) return 0;

  return keywordScore * 5 + uniqueCount - numericLikeCount * 3;
}

function firstNonEmptyRow(worksheet: ExcelJS.Worksheet) {
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const values = rowTexts(worksheet.getRow(rowNumber));
    if (values.length === 0) continue;

    return {
      rowNumber,
      nonEmptyCellCount: values.length,
      firstColumn: values[0]?.column ?? null,
      lastColumn: values[values.length - 1]?.column ?? null,
    };
  }

  return null;
}

function candidateHeaders(worksheet: ExcelJS.Worksheet): CandidateHeader[] {
  const candidates: CandidateHeader[] = [];
  const maxRow = Math.min(worksheet.rowCount, MAX_CANDIDATE_ROWS_TO_SCAN);
  const firstNonEmptyRowNumber = firstNonEmptyRow(worksheet)?.rowNumber ?? null;

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const headings = rowTexts(worksheet.getRow(rowNumber)).map((value) => value.text);
    const score = scoreCandidateHeader({ values: headings, rowNumber, firstNonEmptyRowNumber });
    if (score <= 0) continue;

    candidates.push({
      rowNumber,
      score,
      nonEmptyCellCount: headings.length,
      headings: headings.slice(0, MAX_HEADINGS_TO_REPORT),
      roughCandidateDataRowCount: Math.max(0, worksheet.actualRowCount - rowNumber),
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.rowNumber - right.rowNumber)
    .slice(0, MAX_CANDIDATE_HEADERS_TO_REPORT);
}

function tableSummaries(worksheet: ExcelJS.Worksheet): TableSummary[] {
  const getTables = (worksheet as unknown as { getTables?: () => unknown[] }).getTables;
  const tables = typeof getTables === "function" ? getTables.call(worksheet) : [];

  return tables.map((table) => {
    const model =
      table && typeof table === "object" && "model" in table
        ? (table as { model: Record<string, unknown> }).model
        : (table as Record<string, unknown>);
    const columns = Array.isArray(model.columns) ? model.columns : [];
    const columnHeadings = columns
      .map((column) => {
        if (typeof column === "string") return normalizedHeading(column);
        if (column && typeof column === "object" && "name" in column) {
          return normalizedHeading(String((column as { name?: unknown }).name ?? ""));
        }
        return "";
      })
      .filter(Boolean)
      .slice(0, MAX_HEADINGS_TO_REPORT);
    const ref = textOrNull(model.ref);

    return {
      worksheetName: worksheet.name,
      tableName: textOrNull(model.name) ?? "Unnamed table",
      ref,
      columnHeadings,
      roughCandidateDataRowCount: ref ? roughRowCountFromRange(ref) : null,
    };
  });
}

function roughRowCountFromRange(ref: string) {
  const cleaned = ref.replace(/\$/g, "");
  const match = cleaned.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;

  const startRow = Number(match[2]);
  const endRow = Number(match[4]);
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || endRow < startRow) return null;

  return Math.max(0, endRow - startRow);
}

function worksheetSummaries(workbook: ExcelJS.Workbook): WorksheetSummary[] {
  return workbook.worksheets.map((worksheet) => ({
    name: worksheet.name,
    rowCount: worksheet.rowCount,
    actualRowCount: worksheet.actualRowCount,
    columnCount: worksheet.columnCount,
    actualColumnCount: worksheet.actualColumnCount,
    firstNonEmptyRow: firstNonEmptyRow(worksheet),
    candidateHeaders: candidateHeaders(worksheet),
  }));
}

function allTableSummaries(workbook: ExcelJS.Workbook): TableSummary[] {
  return workbook.worksheets.flatMap((worksheet) => tableSummaries(worksheet));
}

function inventoryHeadingRank(value: string) {
  const normalized = normalizedComparison(value);
  const ranks: Record<string, number> = {
    "inventory id": 100,
    inventoryid: 95,
    inventory: 90,
    sku: 85,
    "item id": 80,
    item: 70,
    "part number": 65,
    part: 60,
    model: 45,
  };
  return ranks[normalized] ?? (normalized.includes("inventory") ? 50 : 0);
}

function recommendMapping(worksheets: WorksheetSummary[], tables: TableSummary[]) {
  const tableCandidates = tables
    .flatMap((table) =>
      table.columnHeadings.map((heading) => ({
        worksheetName: table.worksheetName,
        heading,
        score: inventoryHeadingRank(heading) + 10,
      }))
    )
    .filter((candidate) => candidate.score > 10);
  const worksheetCandidates = worksheets.flatMap((worksheet) =>
    worksheet.candidateHeaders.flatMap((header) =>
      header.headings.map((heading) => ({
        worksheetName: worksheet.name,
        heading,
        score: inventoryHeadingRank(heading) + header.score,
      }))
    )
  );
  const candidates = [...tableCandidates, ...worksheetCandidates]
    .filter((candidate) => inventoryHeadingRank(candidate.heading) > 0)
    .sort((left, right) => right.score - left.score);
  const best = candidates[0] ?? null;

  return {
    worksheetName: best?.worksheetName ?? worksheets[0]?.name ?? null,
    inventoryIdColumn: best?.heading ?? null,
    needsConfirmation: true,
  };
}

function configuredWorksheetReport(worksheets: WorksheetSummary[]) {
  const configured = envValue("SHAREPOINT_STOCK_WORKSHEET_NAME");
  if (!configured) {
    return { configured: null, exists: null };
  }

  return {
    configured,
    exists: worksheets.some(
      (worksheet) => normalizedComparison(worksheet.name) === normalizedComparison(configured)
    ),
  };
}

function configuredInventoryColumnReport(params: {
  worksheets: WorksheetSummary[];
  tables: TableSummary[];
  recommendedWorksheetName: string | null;
}) {
  const configured = envValue("SHAREPOINT_STOCK_INVENTORY_ID_COLUMN");
  if (!configured) {
    return { configured: null, exists: null, checkedWorksheet: params.recommendedWorksheetName };
  }

  const configuredWorksheet = envValue("SHAREPOINT_STOCK_WORKSHEET_NAME");
  const checkedWorksheet = configuredWorksheet || params.recommendedWorksheetName;
  const tableHeadings = params.tables
    .filter((table) => !checkedWorksheet || table.worksheetName === checkedWorksheet)
    .flatMap((table) => table.columnHeadings);
  const worksheetHeadings = params.worksheets
    .filter((worksheet) => !checkedWorksheet || worksheet.name === checkedWorksheet)
    .flatMap((worksheet) => worksheet.candidateHeaders.flatMap((header) => header.headings));
  const headings = [...tableHeadings, ...worksheetHeadings];

  return {
    configured,
    exists: headings.some(
      (heading) => normalizedComparison(heading) === normalizedComparison(configured)
    ),
    checkedWorksheet,
  };
}

async function parseWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

async function main() {
  const env = buildEnvSummary();
  if (env.requiredMissing.length > 0) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          env,
          error: "Missing required SharePoint connection env vars.",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const driveId = requireEnv("SHAREPOINT_DRIVE_ID");
  const fileId = requireEnv("SHAREPOINT_FILE_ID");
  const siteId = requireEnv("SHAREPOINT_SITE_ID");
  const token = await getGraphAccessToken();

  const metadataEndpoints = [
    {
      label: "drive-item",
      endpoint: `${GRAPH_BASE_URL}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(fileId)}`,
    },
    {
      label: "site-drive-item",
      endpoint: `${GRAPH_BASE_URL}/sites/${encodeURIComponent(siteId)}/drives/${encodeURIComponent(
        driveId
      )}/items/${encodeURIComponent(fileId)}`,
    },
  ];
  const metadataResults = await Promise.all(
    metadataEndpoints.map((endpoint) =>
      graphGetJson<Record<string, unknown>>({ ...endpoint, token })
    )
  );
  const metadataResult = metadataResults.find((result) => result.ok);

  if (!metadataResult?.ok) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          env,
          metadataEndpointResults: metadataResults.map(safeGraphResultSummary),
          error: "Workbook metadata could not be fetched.",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const contentEndpoints = [
    {
      label: "drive-item-content",
      endpoint: `${GRAPH_BASE_URL}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(
        fileId
      )}/content`,
    },
    {
      label: "site-drive-item-content",
      endpoint: `${GRAPH_BASE_URL}/sites/${encodeURIComponent(siteId)}/drives/${encodeURIComponent(
        driveId
      )}/items/${encodeURIComponent(fileId)}/content`,
    },
  ];
  const contentResults: Array<GraphResult<Buffer>> = [];
  for (const endpoint of contentEndpoints) {
    const result = await graphDownloadContent({ ...endpoint, token });
    contentResults.push(result);
    if (result.ok) break;
  }
  const contentResult = contentResults.find((result) => result.ok);

  if (!contentResult?.ok) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          env,
          metadataEndpointResults: metadataResults.map(safeGraphResultSummary),
          contentEndpointResults: contentResults.map(safeGraphResultSummary),
          workbookMetadata: safeWorkbookMetadata(metadataResult.data),
          error: "Workbook content could not be downloaded.",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  let workbook: ExcelJS.Workbook;
  try {
    workbook = await parseWorkbook(contentResult.data);
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          env,
          metadataEndpointWorked: metadataResult.label,
          contentEndpointWorked: contentResult.label,
          workbookMetadata: safeWorkbookMetadata(metadataResult.data),
          error: `Workbook parse failed: ${responseSummaryText(
            error instanceof Error ? error.message : String(error)
          )}`,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const worksheets = worksheetSummaries(workbook);
  const tables = allTableSummaries(workbook);
  const recommended = recommendMapping(worksheets, tables);

  console.log(
    JSON.stringify(
      {
        ok: true,
        env,
        metadataEndpointResults: metadataResults.map(safeGraphResultSummary),
        metadataEndpointWorked: metadataResult.label,
        contentEndpointWorked: contentResult.label,
        workbookMetadata: safeWorkbookMetadata(metadataResult.data),
        downloadedContentBytes: contentResult.data.length,
        worksheets,
        tables,
        configuredWorksheet: configuredWorksheetReport(worksheets),
        configuredInventoryIdColumn: configuredInventoryColumnReport({
          worksheets,
          tables,
          recommendedWorksheetName: recommended.worksheetName,
        }),
        recommendedMapping: recommended,
        notes: [
          "No workbook row data was printed.",
          "Column headings are discovery metadata and still need business confirmation before sync.",
          "No database writes, notification jobs, provider sends, Acumatica writes, ONEWEEKCON writes, or holds were performed.",
        ],
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: responseSummaryText(error instanceof Error ? error.message : String(error)),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
