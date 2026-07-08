import {
  detectContactChanges,
  detectOrderAddressChanges,
  detectOrderChanges,
  detectOrderLineAllocationChanges,
  detectOrderLineChanges,
  detectOrderTotalChanges,
  type ErpChangeDetectionResult,
} from "@/lib/erp/detectErpChanges";
import { createErpClientFromEnv } from "@/lib/erp/erpClient";
import { prisma } from "@/lib/prisma";

export type ImportSalesOrdersResult = {
  requestedOn: string;
  qualifyingOrdersFetched: number;
  fullOrdersFetched: number;
  contactsUpserted: number;
  ordersCreated: number;
  ordersUpdated: number;
  totalsUpserted: number;
  linesUpserted: number;
  allocationsUpserted: number;
  addressesUpserted: number;
  deliveryGroupsUpserted: number;
  changeEventsDetected: number;
  changeEventsCreated: number;
  changeEventsDeduped: number;
  skippedOrders: number;
  failedOrders: number;
  errors: Array<{
    orderNumber?: string;
    orderType?: string;
    reason: string;
  }>;
};

type ImportDeltas = Pick<
  ImportSalesOrdersResult,
  | "contactsUpserted"
  | "ordersCreated"
  | "ordersUpdated"
  | "totalsUpserted"
  | "linesUpserted"
  | "allocationsUpserted"
  | "addressesUpserted"
  | "deliveryGroupsUpserted"
  | "changeEventsDetected"
  | "changeEventsCreated"
  | "changeEventsDeduped"
>;

type ImportError = ImportSalesOrdersResult["errors"][number];

type OrderIdentity = {
  orderNumber: string;
  orderType: string | null;
};

const DEFAULT_ERP_IMPORT_TRANSACTION_TIMEOUT_MS = 30_000;
const DELETE_CHUNK_SIZE = 500;

function allocationLookupKey(orderLineId: string, splitLineNbr: number) {
  return `${orderLineId}:${splitLineNbr}`;
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function getPositiveIntegerEnv(name: string, defaultValue: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid env var ${name}: expected a positive integer`);
  }

  return value;
}

function emptyResult(requestedOn: string): ImportSalesOrdersResult {
  return {
    requestedOn,
    qualifyingOrdersFetched: 0,
    fullOrdersFetched: 0,
    contactsUpserted: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    totalsUpserted: 0,
    linesUpserted: 0,
    allocationsUpserted: 0,
    addressesUpserted: 0,
    deliveryGroupsUpserted: 0,
    changeEventsDetected: 0,
    changeEventsCreated: 0,
    changeEventsDeduped: 0,
    skippedOrders: 0,
    failedOrders: 0,
    errors: [],
  };
}

function emptyDeltas(): ImportDeltas {
  return {
    contactsUpserted: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    totalsUpserted: 0,
    linesUpserted: 0,
    allocationsUpserted: 0,
    addressesUpserted: 0,
    deliveryGroupsUpserted: 0,
    changeEventsDetected: 0,
    changeEventsCreated: 0,
    changeEventsDeduped: 0,
  };
}

function addDeltas(result: ImportSalesOrdersResult, deltas: ImportDeltas) {
  result.contactsUpserted += deltas.contactsUpserted;
  result.ordersCreated += deltas.ordersCreated;
  result.ordersUpdated += deltas.ordersUpdated;
  result.totalsUpserted += deltas.totalsUpserted;
  result.linesUpserted += deltas.linesUpserted;
  result.allocationsUpserted += deltas.allocationsUpserted;
  result.addressesUpserted += deltas.addressesUpserted;
  result.deliveryGroupsUpserted += deltas.deliveryGroupsUpserted;
  result.changeEventsDetected += deltas.changeEventsDetected;
  result.changeEventsCreated += deltas.changeEventsCreated;
  result.changeEventsDeduped += deltas.changeEventsDeduped;
}

function addChangeDeltas(deltas: ImportDeltas, changes: ErpChangeDetectionResult) {
  deltas.changeEventsDetected += changes.detected;
  deltas.changeEventsCreated += changes.created;
  deltas.changeEventsDeduped += changes.deduped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getField(record: unknown, key: string) {
  if (!isRecord(record)) return undefined;
  return record[key];
}

function getNestedField(record: unknown, keys: string[]) {
  let current = record;
  for (const key of keys) {
    current = getField(getValue(current), key);
  }
  return current;
}

function getValue(field: unknown): unknown {
  if (isRecord(field) && "value" in field) {
    return field.value ?? null;
  }
  return field ?? null;
}

function getString(field: unknown): string | null {
  const value = getValue(field);
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function getInteger(field: unknown): number | null {
  const value = getValue(field);
  if (typeof value === "number" && Number.isInteger(value)) return value;

  const stringValue = getString(value);
  if (!stringValue) return null;

  const parsed = Number(stringValue);
  return Number.isInteger(parsed) ? parsed : null;
}

function getDecimalValue(field: unknown): string | null {
  const value = getValue(field);

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/,/g, "");
  return Number.isFinite(Number(normalized)) ? normalized : null;
}

function getBooleanValue(field: unknown): boolean | null {
  const value = getValue(field);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

function getArray(field: unknown): unknown[] {
  const value = getValue(field);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.value)) return value.value;
  return [];
}

function getFirstRecord(field: unknown): Record<string, unknown> | null {
  const value = getValue(field);
  if (Array.isArray(value)) {
    return value.find(isRecord) ?? null;
  }
  return isRecord(value) ? value : null;
}

function dateFromKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isValidDateKey(key: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && dateFromKey(key).toISOString().slice(0, 10) === key;
}

function dateKeyFromValue(value: unknown): string | null {
  const unwrapped = getValue(value);
  if (unwrapped instanceof Date) {
    const key = unwrapped.toISOString().slice(0, 10);
    return isValidDateKey(key) ? key : null;
  }

  if (typeof unwrapped === "string") {
    const trimmed = unwrapped.trim();
    if (!trimmed) return null;

    const dateOnlyMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateOnlyMatch?.[1] && isValidDateKey(dateOnlyMatch[1])) {
      return dateOnlyMatch[1];
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      const key = parsed.toISOString().slice(0, 10);
      return isValidDateKey(key) ? key : null;
    }
  }

  if (typeof unwrapped === "number") {
    const parsed = new Date(unwrapped);
    if (!Number.isNaN(parsed.getTime())) {
      const key = parsed.toISOString().slice(0, 10);
      return isValidDateKey(key) ? key : null;
    }
  }

  return null;
}

function normalizeRequestedOn(value: Date | string) {
  const key = dateKeyFromValue(value);
  if (!key) {
    throw new Error(`Invalid requestedOn date: ${String(value)}`);
  }
  return key;
}

function getDateValue(field: unknown): Date | null {
  const key = dateKeyFromValue(field);
  return key ? dateFromKey(key) : null;
}

function getOrderIdentity(row: unknown) {
  return {
    orderNumber: getString(getField(row, "OrderNbr")),
    orderType: getString(getField(row, "OrderType")),
  };
}

function firstString(...values: Array<string | null>) {
  return values.find((value) => value !== null) ?? null;
}

function firstStringField(record: unknown, keys: string[]) {
  return firstString(...keys.map((key) => getString(getField(record, key))));
}

function getBuyerGroup(fullOrder: unknown) {
  return firstString(
    getString(getNestedField(fullOrder, ["custom", "Document", "AttributeBUYERGROUP"])),
    firstStringField(fullOrder, [
      "BuyerGroup",
      "AttributeBUYERGROUP",
      "SOOrder_AttributeBUYERGROUP",
      "SOOrder.AttributeBUYERGROUP",
    ])
  );
}

function activeStatusFromContact(contact: unknown) {
  const status = getString(getField(contact, "Status"));
  if (status) return status;

  const active = getBooleanValue(getField(contact, "Active"));
  if (active === true) return "Active";
  if (active === false) return "Inactive";
  return null;
}

function emailOptInFromContact(contact: unknown) {
  const doNotEmail = getBooleanValue(getField(contact, "DoNotEmail"));
  if (doNotEmail === true) return false;
  if (doNotEmail === false) return true;
  return null;
}

function findContactRow(rows: unknown[], contactId: string) {
  return (
    rows.find((row) => getString(getField(row, "ContactID")) === contactId) ??
    rows[0] ??
    null
  );
}

function errorFor(
  reason: string,
  context: { orderNumber?: string | null; orderType?: string | null } = {}
): ImportError {
  return {
    ...(context.orderNumber ? { orderNumber: context.orderNumber } : {}),
    ...(context.orderType ? { orderType: context.orderType } : {}),
    reason,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function orderKey(orderType: string | null, orderNumber: string) {
  return `${orderType ?? ""}:${orderNumber}`;
}

function fullOrderMatchesLookup(row: unknown, lookup: OrderIdentity) {
  const identity = getOrderIdentity(row);
  if (identity.orderNumber !== lookup.orderNumber) return false;
  return !lookup.orderType || identity.orderType === lookup.orderType;
}

export async function importSalesOrdersForLineRequestedOn(
  requestedOn: Date | string
): Promise<ImportSalesOrdersResult> {
  const requestedOnKey = normalizeRequestedOn(requestedOn);
  const result = emptyResult(requestedOnKey);
  const client = createErpClientFromEnv();
  const transactionTimeoutMs = getPositiveIntegerEnv(
    "ERP_IMPORT_TRANSACTION_TIMEOUT_MS",
    DEFAULT_ERP_IMPORT_TRANSACTION_TIMEOUT_MS
  );

  const qualifyingRows = await client.fetchQualifyingSalesOrdersByLineRequestedOn(requestedOn);
  result.qualifyingOrdersFetched = qualifyingRows.length;

  const qualifyingOrders = new Map<string, OrderIdentity>();
  for (const row of qualifyingRows) {
    const identity = getOrderIdentity(row);
    if (!identity.orderNumber) {
      result.skippedOrders += 1;
      result.errors.push(
        errorFor("Step 1 qualifying SalesOrder is missing OrderNbr", {
          orderType: identity.orderType,
        })
      );
      continue;
    }

    qualifyingOrders.set(orderKey(identity.orderType, identity.orderNumber), {
      orderNumber: identity.orderNumber,
      orderType: identity.orderType,
    });
  }

  const processedFullOrderKeys = new Set<string>();
  const contactFetchCache = new Map<string, Promise<unknown | null>>();

  function fetchContactForImport(contactId: string) {
    const cached = contactFetchCache.get(contactId);
    if (cached) return cached;

    const request = client
      .fetchDeliveryContactByContactId(contactId)
      .then((rows) => findContactRow(rows, contactId));
    contactFetchCache.set(contactId, request);
    return request;
  }

  for (const lookup of qualifyingOrders.values()) {
    let fullRows: unknown[];

    try {
      fullRows = await client.fetchDeliverySalesOrderByOrderNumber(
        lookup.orderNumber,
        lookup.orderType
      );
      result.fullOrdersFetched += fullRows.length;
    } catch (error) {
      result.failedOrders += 1;
      result.errors.push(
        errorFor(`Step 2 full SalesOrder fetch failed: ${errorMessage(error)}`, lookup)
      );
      continue;
    }

    const matchingRows = fullRows.filter((row) => fullOrderMatchesLookup(row, lookup));
    if (matchingRows.length === 0) {
      result.failedOrders += 1;
      result.errors.push(errorFor("Step 2 did not return a matching full SalesOrder", lookup));
      continue;
    }

    for (const fullOrder of matchingRows) {
      const identity = getOrderIdentity(fullOrder);
      const contactId = getString(getField(fullOrder, "ContactID"));

      if (!identity.orderNumber) {
        result.skippedOrders += 1;
        result.errors.push(
          errorFor("Full SalesOrder payload is missing OrderNbr", {
            orderType: identity.orderType,
          })
        );
        continue;
      }

      if (!identity.orderType) {
        result.skippedOrders += 1;
        result.errors.push(
          errorFor("Full SalesOrder payload is missing OrderType", {
            orderNumber: identity.orderNumber,
          })
        );
        continue;
      }

      if (!contactId) {
        result.skippedOrders += 1;
        result.errors.push(
          errorFor("Full SalesOrder payload is missing required ContactID", {
            orderNumber: identity.orderNumber,
            orderType: identity.orderType,
          })
        );
        continue;
      }

      const orderNumber = identity.orderNumber;
      const orderType = identity.orderType;
      const processedKey = orderKey(orderType, orderNumber);
      if (processedFullOrderKeys.has(processedKey)) {
        continue;
      }
      processedFullOrderKeys.add(processedKey);

      let contactRecord: unknown | null = null;
      try {
        contactRecord = await fetchContactForImport(contactId);
      } catch (error) {
        result.errors.push(
          errorFor(`Contact fetch failed; using SalesOrder contact fallback: ${errorMessage(error)}`, {
            orderNumber,
            orderType,
          })
        );
      }

      try {
        const transactionResult = await prisma.$transaction(
          async (tx) => {
            const importAt = new Date();
            const deltas = emptyDeltas();
            const errors: ImportError[] = [];

            const status = getString(getField(fullOrder, "Status"));
            const customerDescription = firstStringField(fullOrder, [
              "CustomerDescription",
              "CustomerName",
              "CustomerIDDescription",
              "CustomerID_Description",
            ]);
            const locationDescription = firstStringField(fullOrder, [
              "LocationDescription",
              "LocationName",
              "LocationIDDescription",
              "LocationID_Description",
            ]);
            const contactDisplayName = firstString(
              getString(getField(contactRecord, "DisplayName")),
              getString(getField(fullOrder, "ContactDisplayName")),
              getString(getField(fullOrder, "ContactName")),
              getString(getField(fullOrder, "DisplayName")),
              customerDescription
            );

            const existingContact = await tx.contact.findUnique({
              where: { contactId },
              select: {
                id: true,
                status: true,
                companyName: true,
                displayName: true,
                firstName: true,
                lastName: true,
                email: true,
                phone1: true,
                phone2: true,
                emailOptIn: true,
              },
            });

            const importedEmailOptIn = contactRecord ? emailOptInFromContact(contactRecord) : null;
            const contactData = {
              status: firstString(
                activeStatusFromContact(contactRecord),
                getString(getField(fullOrder, "ContactStatus"))
              ),
              companyName: getString(getField(contactRecord, "CompanyName")),
              displayName: contactDisplayName,
              firstName: firstString(
                getString(getField(contactRecord, "FirstName")),
                getString(getField(fullOrder, "FirstName"))
              ),
              lastName: firstString(
                getString(getField(contactRecord, "LastName")),
                getString(getField(fullOrder, "LastName"))
              ),
              email: firstString(
                getString(getField(contactRecord, "Email")),
                getString(getField(fullOrder, "Email"))
              ),
              phone1: firstString(
                getString(getField(contactRecord, "Phone1")),
                getString(getField(fullOrder, "Phone1"))
              ),
              phone2: firstString(
                getString(getField(contactRecord, "Phone2")),
                getString(getField(fullOrder, "Phone2"))
              ),
              emailOptIn: importedEmailOptIn ?? true,
              lastSyncedAt: importAt,
            };

            const contactUpdateData = {
              status: contactData.status ?? undefined,
              companyName: contactData.companyName ?? undefined,
              displayName: contactData.displayName ?? undefined,
              firstName: contactData.firstName ?? undefined,
              lastName: contactData.lastName ?? undefined,
              email: contactData.email ?? undefined,
              phone1: contactData.phone1 ?? undefined,
              phone2: contactData.phone2 ?? undefined,
              emailOptIn: importedEmailOptIn ?? undefined,
              lastSyncedAt: importAt,
            };

            if (existingContact) {
              addChangeDeltas(
                deltas,
                await detectContactChanges(tx, {
                  existing: existingContact,
                  incoming: {
                    status: contactData.status ?? existingContact.status,
                    companyName: contactData.companyName ?? existingContact.companyName,
                    displayName: contactData.displayName ?? existingContact.displayName,
                    firstName: contactData.firstName ?? existingContact.firstName,
                    lastName: contactData.lastName ?? existingContact.lastName,
                    email: contactData.email ?? existingContact.email,
                    phone1: contactData.phone1 ?? existingContact.phone1,
                    phone2: contactData.phone2 ?? existingContact.phone2,
                    emailOptIn: importedEmailOptIn ?? existingContact.emailOptIn,
                  },
                  contactId,
                  entityId: existingContact.id,
                })
              );
            }

            await tx.contact.upsert({
              where: { contactId },
              create: {
                contactId,
                ...contactData,
              },
              update: contactUpdateData,
            });
            deltas.contactsUpserted += 1;

            const existingOrder = await tx.order.findUnique({
              where: {
                orderType_orderNumber: {
                  orderType,
                  orderNumber,
                },
              },
              select: {
                id: true,
                status: true,
                customerId: true,
                customerDescription: true,
                contactId: true,
                locationId: true,
                locationDescription: true,
                buyerGroup: true,
                shipVia: true,
              },
            });

            const orderData = {
              shipVia: getString(getField(fullOrder, "ShipVia")),
              status,
              headerRequestedOn: getDateValue(getField(fullOrder, "RequestedOn")),
              customerId: getString(getField(fullOrder, "CustomerID")),
              customerDescription,
              contactId,
              locationId: getString(getField(fullOrder, "LocationID")),
              locationDescription,
              buyerGroup: getBuyerGroup(fullOrder),
              turnInDate: getDateValue(getField(fullOrder, "Date")),
              noteId: getString(getField(fullOrder, "NoteID")),
              lastSyncedAt: importAt,
            };

            if (existingOrder) {
              addChangeDeltas(
                deltas,
                await detectOrderChanges(tx, {
                  existing: existingOrder,
                  incoming: orderData,
                  orderId: existingOrder.id,
                  orderType,
                  orderNumber,
                })
              );
            }

            const order = await tx.order.upsert({
              where: {
                orderType_orderNumber: {
                  orderType,
                  orderNumber,
                },
              },
              create: {
                orderType,
                orderNumber,
                ...orderData,
              },
              update: orderData,
            });

            if (existingOrder) {
              deltas.ordersUpdated += 1;
            } else {
              deltas.ordersCreated += 1;
            }

            const totals = getFirstRecord(getField(fullOrder, "Totals"));
            const totalData = {
              orderNumber,
              unpaidBalance: getDecimalValue(getField(totals, "UnpaidBalance")),
              orderTotal: firstString(
                getDecimalValue(getField(fullOrder, "OrderTotal")),
                getDecimalValue(getField(totals, "OrderTotal"))
              ),
              taxTotal: getDecimalValue(getField(totals, "TaxTotal")),
              lineTotalAmount: getDecimalValue(getField(totals, "LineTotalAmount")),
              unbilledAmount: getDecimalValue(getField(totals, "UnbilledAmount")),
              unbilledQty: getDecimalValue(getField(totals, "UnbilledQty")),
              paymentTerms: getString(getField(fullOrder, "Terms")),
              lastSyncedAt: importAt,
            };

            const existingTotal = await tx.orderTotal.findUnique({
              where: { orderId: order.id },
              select: {
                id: true,
                unpaidBalance: true,
                orderTotal: true,
                taxTotal: true,
                lineTotalAmount: true,
                unbilledAmount: true,
                unbilledQty: true,
                paymentTerms: true,
              },
            });

            if (existingTotal) {
              addChangeDeltas(
                deltas,
                await detectOrderTotalChanges(tx, {
                  existing: existingTotal,
                  incoming: totalData,
                  entityId: existingTotal.id,
                  orderId: order.id,
                  orderType,
                  orderNumber,
                })
              );
            }

            await tx.orderTotal.upsert({
              where: { orderId: order.id },
              create: {
                orderId: order.id,
                ...totalData,
              },
              update: totalData,
            });
            deltas.totalsUpserted += 1;

            const details = getArray(getField(fullOrder, "Details"));
            const existingOrderLines = await tx.orderLine.findMany({
              where: { orderId: order.id },
              select: {
                id: true,
                lineNbr: true,
                requestedOn: true,
                eta: true,
                inventoryId: true,
                lineDescription: true,
                warehouseId: true,
                orderQty: true,
                openQty: true,
                discountedUnitPrice: true,
              },
            });
            const existingOrderLinesByLineNbr = new Map(
              existingOrderLines.map((line) => [line.lineNbr, line])
            );
            const existingOrderLineIds = existingOrderLines.map((line) => line.id);
            const existingAllocations =
              existingOrderLineIds.length > 0
                ? await tx.orderLineAllocation.findMany({
                    where: { orderLineId: { in: existingOrderLineIds } },
                    select: {
                      id: true,
                      orderLineId: true,
                      allocated: true,
                      completed: true,
                      qty: true,
                      inventoryId: true,
                      lineNbr: true,
                      splitLineNbr: true,
                    },
                  })
                : [];
            const existingAllocationsByLineAndSplit = new Map(
              existingAllocations.map((allocation) => [
                allocationLookupKey(allocation.orderLineId, allocation.splitLineNbr),
                allocation,
              ])
            );

            const requestedDateKeys = new Set<string>();
            const incomingLineNbrs = new Set<number>();
            const retainedOrderLineIds = new Set<string>();
            const incomingAllocationKeys = new Set<string>();

            for (const detail of details) {
              const lineNbr = getInteger(getField(detail, "LineNbr"));
              if (lineNbr === null) {
                errors.push(
                  errorFor("SalesOrder detail is missing LineNbr; line skipped", {
                    orderNumber,
                    orderType,
                  })
                );
                continue;
              }
              incomingLineNbrs.add(lineNbr);

              const requestedDate = getDateValue(getField(detail, "RequestedOn"));
              const requestedDateKey = requestedDate ? dateKeyFromValue(requestedDate) : null;
              if (requestedDateKey) {
                requestedDateKeys.add(requestedDateKey);
              }

              const lineData = {
                orderType,
                orderNumber,
                requestedOn: requestedDate,
                lineNbr,
                inventoryId: getString(getField(detail, "InventoryID")),
                lineDescription: getString(getField(detail, "LineDescription")),
                eta: getDateValue(getField(detail, "ETA")),
                orderQty: getDecimalValue(getField(detail, "OrderQty")),
                openQty: getDecimalValue(getField(detail, "OpenQty")),
                discountedUnitPrice: getDecimalValue(getField(detail, "DiscountedUnitPrice")),
                warehouseId: getString(getField(detail, "WarehouseID")),
                lastSyncedAt: importAt,
              };

              const existingOrderLine = existingOrderLinesByLineNbr.get(lineNbr) ?? null;

              if (existingOrderLine) {
                addChangeDeltas(
                  deltas,
                  await detectOrderLineChanges(tx, {
                    existing: existingOrderLine,
                    incoming: lineData,
                    entityId: existingOrderLine.id,
                    orderId: order.id,
                    orderType,
                    orderNumber,
                    lineNbr,
                    deliveryDate: requestedDate,
                  })
                );
              }

              const orderLine = await tx.orderLine.upsert({
                where: {
                  orderId_lineNbr: {
                    orderId: order.id,
                    lineNbr,
                  },
                },
                create: {
                  orderId: order.id,
                  ...lineData,
                },
                update: lineData,
              });
              deltas.linesUpserted += 1;
              retainedOrderLineIds.add(orderLine.id);

              for (const allocation of getArray(getField(detail, "Allocations"))) {
                const splitLineNbr = getInteger(getField(allocation, "SplitLineNbr"));
                if (splitLineNbr === null) {
                  errors.push(
                    errorFor("SalesOrder allocation is missing SplitLineNbr; allocation skipped", {
                      orderNumber,
                      orderType,
                    })
                  );
                  continue;
                }
                incomingAllocationKeys.add(allocationLookupKey(orderLine.id, splitLineNbr));

                const allocationData = {
                  orderType,
                  orderNumber,
                  lineNbr: getInteger(getField(allocation, "LineNbr")) ?? lineNbr,
                  splitLineNbr,
                  inventoryId: getString(getField(allocation, "InventoryID")),
                  allocated: getBooleanValue(getField(allocation, "Allocated")) ?? false,
                  completed: getBooleanValue(getField(allocation, "Completed")) ?? false,
                  qty: getDecimalValue(getField(allocation, "Qty")),
                  lastSyncedAt: importAt,
                };

                const existingAllocation =
                  existingOrderLine === null
                    ? null
                    : existingAllocationsByLineAndSplit.get(
                        allocationLookupKey(existingOrderLine.id, splitLineNbr)
                      ) ?? null;

                if (existingAllocation) {
                  addChangeDeltas(
                    deltas,
                    await detectOrderLineAllocationChanges(tx, {
                      existing: existingAllocation,
                      incoming: allocationData,
                      entityId: existingAllocation.id,
                      orderId: order.id,
                      orderType,
                      orderNumber,
                      orderLineId: orderLine.id,
                      lineNbr: allocationData.lineNbr,
                      splitLineNbr,
                    })
                  );
                }

                await tx.orderLineAllocation.upsert({
                  where: {
                    orderLineId_splitLineNbr: {
                      orderLineId: orderLine.id,
                      splitLineNbr,
                    },
                  },
                  create: {
                    orderLineId: orderLine.id,
                    ...allocationData,
                  },
                  update: allocationData,
                });
                deltas.allocationsUpserted += 1;
              }
            }

            const staleAllocationIds = existingAllocations
              .filter(
                (allocation) =>
                  retainedOrderLineIds.has(allocation.orderLineId) &&
                  !incomingAllocationKeys.has(
                    allocationLookupKey(allocation.orderLineId, allocation.splitLineNbr)
                  )
              )
              .map((allocation) => allocation.id);
            for (const staleAllocationIdChunk of chunkValues(staleAllocationIds, DELETE_CHUNK_SIZE)) {
              await tx.orderLineAllocation.deleteMany({
                where: { id: { in: staleAllocationIdChunk } },
              });
            }

            const staleOrderLineIds = existingOrderLines
              .filter((line) => !incomingLineNbrs.has(line.lineNbr))
              .map((line) => line.id);
            for (const staleOrderLineIdChunk of chunkValues(staleOrderLineIds, DELETE_CHUNK_SIZE)) {
              await tx.orderLine.deleteMany({
                where: { id: { in: staleOrderLineIdChunk } },
              });
            }

            const shipToAddress = getFirstRecord(getField(fullOrder, "ShipToAddress"));
            if (shipToAddress) {
              const addressData = {
                addressLine1: getString(getField(shipToAddress, "AddressLine1")),
                addressLine2: getString(getField(shipToAddress, "AddressLine2")),
                city: getString(getField(shipToAddress, "City")),
                country: getString(getField(shipToAddress, "Country")),
                postalCode: getString(getField(shipToAddress, "PostalCode")),
                state: getString(getField(shipToAddress, "State")),
                lastSyncedAt: importAt,
              };

              const existingAddress = await tx.orderAddress.findUnique({
                where: { orderId: order.id },
                select: {
                  id: true,
                  addressLine1: true,
                  addressLine2: true,
                  city: true,
                  state: true,
                  postalCode: true,
                  country: true,
                },
              });

              if (existingAddress) {
                addChangeDeltas(
                  deltas,
                  await detectOrderAddressChanges(tx, {
                    existing: existingAddress,
                    incoming: addressData,
                    entityId: existingAddress.id,
                    orderId: order.id,
                    orderType,
                    orderNumber,
                  })
                );
              }

              await tx.orderAddress.upsert({
                where: { orderId: order.id },
                create: {
                  orderId: order.id,
                  ...addressData,
                },
                update: addressData,
              });
              deltas.addressesUpserted += 1;
            }

            const requestedDeliveryDates = [...requestedDateKeys].map(dateFromKey);
            for (const deliveryDate of requestedDeliveryDates) {
              const deliveryGroupData = {
                orderNumber,
                orderType,
                deliveryDate,
                status,
                lastSyncedAt: importAt,
              };

              await tx.orderDeliveryGroup.upsert({
                where: {
                  orderId_deliveryDate: {
                    orderId: order.id,
                    deliveryDate,
                  },
                },
                create: {
                  orderId: order.id,
                  ...deliveryGroupData,
                },
                update: deliveryGroupData,
              });
              deltas.deliveryGroupsUpserted += 1;
            }

            await tx.orderDeliveryGroup.deleteMany({
              where: {
                orderId: order.id,
                ...(requestedDeliveryDates.length > 0
                  ? { deliveryDate: { notIn: requestedDeliveryDates } }
                  : {}),
              },
            });

            return { deltas, errors };
          },
          { timeout: transactionTimeoutMs }
        );

        addDeltas(result, transactionResult.deltas);
        result.errors.push(...transactionResult.errors);
      } catch (error) {
        result.failedOrders += 1;
        result.errors.push(
          errorFor(`SalesOrder import failed: ${errorMessage(error)}`, {
            orderNumber: identity.orderNumber,
            orderType: identity.orderType,
          })
        );
      }
    }
  }

  return result;
}
