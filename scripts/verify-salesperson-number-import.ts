import { createAcumaticaClientFromEnv } from "../lib/acumatica/client/acumaticaClient";
import {
  getSalespersonNumber,
  importSalesOrdersForLineRequestedOn,
} from "../lib/erp/importSalesOrders";
import { getActiveSalespersonContact } from "../lib/notifications/salespersonContactCache";
import { getSalespersonContactDisplay } from "../lib/notifications/salespersonContactDisplay";
import { dateKey } from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";

type Args = {
  orderNumber: string;
  orderType?: string;
  requestedOn?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};

  for (const arg of argv) {
    if (arg.startsWith("--order-number=")) {
      args.orderNumber = arg.slice("--order-number=".length).trim().toUpperCase();
      continue;
    }
    if (arg.startsWith("--order-type=")) {
      args.orderType = arg.slice("--order-type=".length).trim().toUpperCase();
      continue;
    }
    if (arg.startsWith("--requested-on=")) {
      args.requestedOn = arg.slice("--requested-on=".length).trim();
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.orderNumber) {
    throw new Error("--order-number is required");
  }

  return args as Args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getValue(field: unknown): unknown {
  if (isRecord(field) && "value" in field) {
    return field.value ?? null;
  }
  return field ?? null;
}

function getField(record: unknown, key: string) {
  if (!isRecord(record)) return undefined;
  return record[key];
}

function getString(field: unknown): string | null {
  const value = getValue(field);
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function getRows(field: unknown): unknown[] {
  const value = getValue(field);
  if (Array.isArray(value)) return value;
  return [];
}

function findRequestedOn(fullOrder: unknown) {
  const direct = getString(getField(fullOrder, "LineRequestedOn")) ?? getString(getField(fullOrder, "RequestedOn"));
  if (direct) return direct;

  const detail = getRows(getField(fullOrder, "Details")).find((row) =>
    Boolean(getString(getField(row, "RequestedOn")))
  );
  return getString(getField(detail, "RequestedOn"));
}

function matchesOrderType(fullOrder: unknown, orderType?: string) {
  if (!orderType) return true;
  return getString(getField(fullOrder, "OrderType"))?.toUpperCase() === orderType;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const directClient = createAcumaticaClientFromEnv();
  const directRows = await directClient.fetchDeliverySalesOrderByOrderNumber(
    args.orderNumber,
    args.orderType
  );
  const fullOrder = directRows.find((row) => matchesOrderType(row, args.orderType)) ?? directRows[0];

  if (!fullOrder) {
    throw new Error(`Acumatica SalesOrder not found for ${args.orderNumber}`);
  }

  const orderType = getString(getField(fullOrder, "OrderType"));
  if (!orderType) {
    throw new Error(`Acumatica SalesOrder ${args.orderNumber} is missing OrderType`);
  }

  const directSalespersonNumber = getString(getField(fullOrder, "SalespersonNumber"));
  const mappedSalespersonNumber = getSalespersonNumber(fullOrder);
  const requestedOn = args.requestedOn ?? findRequestedOn(fullOrder) ?? new Date().toISOString();

  const importResult = await importSalesOrdersForLineRequestedOn(requestedOn, {
    orderLookups: [{ orderType, orderNumber: args.orderNumber }],
    includeUnqualifiedOrderLookups: true,
  });

  const order = await prisma.order.findUnique({
    where: {
      orderType_orderNumber: {
        orderType,
        orderNumber: args.orderNumber,
      },
    },
    select: {
      orderType: true,
      orderNumber: true,
      salespersonNumber: true,
      deliveryGroups: {
        orderBy: { deliveryDate: "asc" },
        select: {
          deliveryDate: true,
          isActive: true,
        },
      },
    },
  });

  const salespersonContact = await getActiveSalespersonContact(order?.salespersonNumber ?? null);
  const display = getSalespersonContactDisplay(salespersonContact);

  console.log(
    JSON.stringify(
      {
        orderNumber: args.orderNumber,
        orderType,
        requestedOnUsed: requestedOn,
        acumaticaDirectSalespersonNumber: directSalespersonNumber,
        mappedSalespersonNumber,
        orderSalespersonNumberStored: order?.salespersonNumber ?? null,
        storedMatchesMapped: Boolean(order?.salespersonNumber && order.salespersonNumber === mappedSalespersonNumber),
        directSalespersonNumberWins: Boolean(
          directSalespersonNumber && mappedSalespersonNumber === directSalespersonNumber
        ),
        deliveryGroups: (order?.deliveryGroups ?? []).map((group) => ({
          deliveryDate: dateKey(group.deliveryDate),
          isActive: group.isActive,
        })),
        hasActiveSalespersonContact: Boolean(display),
        hasSalespersonEmail: Boolean(display?.email),
        hasSalespersonPhone: Boolean(display?.phone),
        importResult: {
          requestedOn: importResult.requestedOn,
          qualifyingOrdersFetched: importResult.qualifyingOrdersFetched,
          fullOrdersFetched: importResult.fullOrdersFetched,
          ordersCreated: importResult.ordersCreated,
          ordersUpdated: importResult.ordersUpdated,
          failedOrders: importResult.failedOrders,
          skippedOrders: importResult.skippedOrders,
          errors: importResult.errors.map((error) => ({
            orderNumber: error.orderNumber,
            orderType: error.orderType,
            reason: error.reason,
          })),
        },
        safety: {
          noSmsSent: true,
          noEmailSent: true,
          noAcumaticaWritePerformed: true,
          noCustomerRecipientUsed: true,
        },
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
