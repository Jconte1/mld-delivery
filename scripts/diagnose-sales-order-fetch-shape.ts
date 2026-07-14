import { createAcumaticaClientFromEnv } from "../lib/acumatica/client/acumaticaClient";

type CapturedResponse = {
  path: string;
  httpStatus: number;
  ok: boolean;
  contentType: string | null;
  textLength: number;
  parseError: string | null;
  bodySummary: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getValue(field: unknown) {
  if (isRecord(field) && "value" in field) return field.value ?? null;
  return field ?? null;
}

function getField(record: unknown, key: string) {
  return isRecord(record) ? record[key] : undefined;
}

function getArray(field: unknown): unknown[] | null {
  const value = getValue(field);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.value)) return value.value;
  return null;
}

function summarizeItem(item: unknown) {
  const details = getArray(getField(item, "Details"));
  const contactField = getField(item, "ContactID");
  const contactValue = getValue(contactField);

  return {
    topLevelKeys: isRecord(item) ? Object.keys(item).sort() : [],
    hasOrderNbr: getValue(getField(item, "OrderNbr")) !== null,
    orderNbrValue: getValue(getField(item, "OrderNbr")),
    hasOrderType: getValue(getField(item, "OrderType")) !== null,
    orderTypeValue: getValue(getField(item, "OrderType")),
    hasContactID: contactValue !== null,
    contactIDType: contactValue === null ? "null" : typeof contactValue,
    contactIDKeys: isRecord(contactField) ? Object.keys(contactField).sort() : null,
    hasDetailsField: isRecord(item) && Object.prototype.hasOwnProperty.call(item, "Details"),
    detailsIsArray: Array.isArray(details),
    detailsLength: details?.length ?? null,
    firstDetailKeys:
      details && details.length > 0 && isRecord(details[0])
        ? Object.keys(details[0]).sort()
        : [],
    hasKdtf324ppaLine: Boolean(
      details?.some((detail) => getValue(getField(detail, "InventoryID")) === "KDTF324PPA")
    ),
    kdtf324ppaLines:
      details
        ?.filter((detail) => getValue(getField(detail, "InventoryID")) === "KDTF324PPA")
        .map((detail) => ({
          lineNbr: getValue(getField(detail, "LineNbr")),
          inventoryId: getValue(getField(detail, "InventoryID")),
          lineDescription: getValue(getField(detail, "LineDescription")),
          itemType: getValue(getField(detail, "ItemType")),
          itemClass: getValue(getField(detail, "ItemClass")),
          requestedOn: getValue(getField(detail, "RequestedOn")),
          eta: getValue(getField(detail, "ETA")),
          orderQty: getValue(getField(detail, "OrderQty")),
          openQty: getValue(getField(detail, "OpenQty")),
          warehouseId: getValue(getField(detail, "WarehouseID")),
          allocationsCompact:
            getArray(getField(detail, "Allocations"))?.map(
              (allocation) =>
                `[${String(getValue(getField(allocation, "Allocated")))}/${String(
                  getValue(getField(allocation, "Completed"))
                )}/${String(getValue(getField(allocation, "Qty")))}]`
            ) ?? [],
        })) ?? [],
  };
}

function summarizeBody(parsed: unknown, text: string) {
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.value)
      ? parsed.value
      : null;

  return {
    topLevelType: Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed,
    topLevelKeys: isRecord(parsed) ? Object.keys(parsed).sort() : [],
    arrayLength: Array.isArray(parsed) ? parsed.length : null,
    valueArrayLength: isRecord(parsed) && Array.isArray(parsed.value) ? parsed.value.length : null,
    hasErrorField:
      isRecord(parsed) &&
      ("error" in parsed || "message" in parsed || "ExceptionMessage" in parsed || "Message" in parsed),
    errorKeys: isRecord(parsed)
      ? ["error", "message", "ExceptionMessage", "Message"].filter((key) => key in parsed)
      : [],
    textLength: text.length,
    firstItem: rows && rows.length > 0 ? summarizeItem(rows[0]) : null,
  };
}

function summarizeRows(rows: unknown[]) {
  return {
    rowCount: rows.length,
    firstItem: rows.length > 0 ? summarizeItem(rows[0]) : null,
  };
}

async function captureResponse(response: Response, path: string, text: string): Promise<CapturedResponse> {
  let parsed: unknown = null;
  let parseError: string | null = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  return {
    path,
    httpStatus: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    textLength: text.length,
    parseError,
    bodySummary: parseError
      ? { topLevelType: "non_json", textLength: text.length }
      : summarizeBody(parsed, text),
  };
}

function safePath(input: URL | RequestInfo) {
  const raw =
    input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : "";

  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

async function main() {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const captured: CapturedResponse[] = [];

  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const path = safePath(input);
    if (path.includes("/entity/DeliverySalesOrder/") && path.includes("/SalesOrder")) {
      const text = await response.text();
      captured.push(await captureResponse(response, path, text));
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  };

  const client = createAcumaticaClientFromEnv();
  const orders = [
    { orderType: "SO", orderNumber: "SO40278" },
    { orderType: "SO", orderNumber: "SO40064" },
  ];
  const results = [];

  for (const order of orders) {
    const capturedBefore = captured.length;
    try {
      const rows = await client.fetchDeliverySalesOrderByOrderNumber(
        order.orderNumber,
        order.orderType
      );
      results.push({
        ...order,
        success: true,
        rows: summarizeRows(rows),
        capturedResponses: captured.slice(capturedBefore),
      });
    } catch (error) {
      results.push({
        ...order,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        capturedResponses: captured.slice(capturedBefore),
      });
    }
  }

  console.log(JSON.stringify({ mode: "direct_acumatica", results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
