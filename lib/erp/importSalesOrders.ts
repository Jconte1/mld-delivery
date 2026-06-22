import { createAcumaticaClientFromEnv } from "@/lib/acumatica/client/acumaticaClient";
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
>;

type ImportError = ImportSalesOrdersResult["errors"][number];

type OrderIdentity = {
  orderNumber: string;
  orderType: string | null;
};

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getField(record: unknown, key: string) {
  if (!isRecord(record)) return undefined;
  return record[key];
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
  const client = createAcumaticaClientFromEnv();

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

  for (const lookup of qualifyingOrders.values()) {
    let fullRows: unknown[];

    try {
      fullRows = await client.fetchDeliverySalesOrderByOrderNumber(lookup.orderNumber);
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

      try {
        const transactionResult = await prisma.$transaction(async (tx) => {
          const importAt = new Date();
          const deltas = emptyDeltas();
          const errors: ImportError[] = [];

          const status = getString(getField(fullOrder, "Status"));
          const customerDescription = getString(getField(fullOrder, "CustomerDescription"));
          const contactDisplayName = firstString(
            getString(getField(fullOrder, "ContactDisplayName")),
            getString(getField(fullOrder, "ContactName")),
            getString(getField(fullOrder, "DisplayName")),
            customerDescription
          );

          await tx.contact.upsert({
            where: { contactId },
            create: {
              contactId,
              status: getString(getField(fullOrder, "ContactStatus")),
              displayName: contactDisplayName,
              firstName: getString(getField(fullOrder, "FirstName")),
              lastName: getString(getField(fullOrder, "LastName")),
              email: getString(getField(fullOrder, "Email")),
              phone1: getString(getField(fullOrder, "Phone1")),
              phone2: getString(getField(fullOrder, "Phone2")),
              lastSyncedAt: importAt,
            },
            update: {
              status: getString(getField(fullOrder, "ContactStatus")) ?? undefined,
              displayName: contactDisplayName ?? undefined,
              firstName: getString(getField(fullOrder, "FirstName")) ?? undefined,
              lastName: getString(getField(fullOrder, "LastName")) ?? undefined,
              email: getString(getField(fullOrder, "Email")) ?? undefined,
              phone1: getString(getField(fullOrder, "Phone1")) ?? undefined,
              phone2: getString(getField(fullOrder, "Phone2")) ?? undefined,
              lastSyncedAt: importAt,
            },
          });
          deltas.contactsUpserted += 1;

          const existingOrder = await tx.order.findUnique({
            where: {
              orderType_orderNumber: {
                orderType,
                orderNumber,
              },
            },
            select: { id: true },
          });

          const orderData = {
            shipVia: getString(getField(fullOrder, "ShipVia")),
            status,
            headerRequestedOn: getDateValue(getField(fullOrder, "RequestedOn")),
            customerId: getString(getField(fullOrder, "CustomerID")),
            customerDescription,
            contactId,
            locationId: getString(getField(fullOrder, "LocationID")),
            locationDescription: getString(getField(fullOrder, "LocationDescription")),
            turnInDate: getDateValue(getField(fullOrder, "Date")),
            noteId: getString(getField(fullOrder, "NoteID")),
            lastSyncedAt: importAt,
          };

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
            lastSyncedAt: importAt,
          };

          await tx.orderTotal.upsert({
            where: { orderId: order.id },
            create: {
              orderId: order.id,
              ...totalData,
            },
            update: totalData,
          });
          deltas.totalsUpserted += 1;

          const requestedDateKeys = new Set<string>();
          for (const detail of getArray(getField(fullOrder, "Details"))) {
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
              orderQty: getDecimalValue(getField(detail, "OrderQty")),
              openQty: getDecimalValue(getField(detail, "OpenQty")),
              discountedUnitPrice: getDecimalValue(getField(detail, "DiscountedUnitPrice")),
              warehouseId: getString(getField(detail, "WarehouseID")),
              lastSyncedAt: importAt,
            };

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

          for (const deliveryDateKey of requestedDateKeys) {
            const deliveryDate = dateFromKey(deliveryDateKey);
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

          return { deltas, errors };
        });

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
