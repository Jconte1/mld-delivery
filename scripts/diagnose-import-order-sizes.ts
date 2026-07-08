import { createAcumaticaClientFromEnv } from "../lib/acumatica/client/acumaticaClient";
import { prisma } from "../lib/prisma";

const orders = [
  { orderType: "CB", orderNumber: "CB00533" },
  { orderType: "PG", orderNumber: "PG02724" },
  { orderType: "PG", orderNumber: "PG04145" },
  { orderType: "PG", orderNumber: "PG04327" },
  { orderType: "PL", orderNumber: "PL02299" },
  { orderType: "BQ", orderNumber: "BQ00892" },
] as const;

type OrderKey = (typeof orders)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rawValue(value: unknown): unknown {
  if (isRecord(value) && "value" in value) return value.value ?? null;
  return value ?? null;
}

function getField(row: unknown, fieldName: string): unknown {
  if (!isRecord(row)) return undefined;
  return rawValue(row[fieldName]);
}

function getArray(value: unknown): unknown[] {
  const raw = rawValue(value);
  return Array.isArray(raw) ? raw : [];
}

function dateKey(value: unknown): string | null {
  const raw = rawValue(value);
  if (!raw) return null;

  const parsed = new Date(String(raw));
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return String(raw).slice(0, 10) || null;
}

function dbKey(order: OrderKey) {
  return `${order.orderType}:${order.orderNumber}`;
}

async function main() {
  const client = createAcumaticaClientFromEnv();
  const dbOrders = await prisma.order.findMany({
    where: {
      OR: orders.map((order) => ({ orderType: order.orderType, orderNumber: order.orderNumber })),
    },
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      lines: {
        select: {
          id: true,
          allocations: { select: { id: true } },
        },
      },
      deliveryGroups: { select: { id: true } },
      address: { select: { id: true } },
      total: { select: { id: true } },
    },
  });
  const dbByKey = new Map(
    dbOrders.map((order) => [`${order.orderType}:${order.orderNumber}`, order])
  );

  const results = [];
  for (const order of orders) {
    const rows = await client.fetchDeliverySalesOrderByOrderNumber(
      order.orderNumber,
      order.orderType
    );
    const row =
      rows.find(
        (candidate) =>
          getField(candidate, "OrderType") === order.orderType &&
          getField(candidate, "OrderNbr") === order.orderNumber
      ) ?? rows[0];

    const details = getArray(getField(row, "Details"));
    let allocationCount = 0;
    const requestedDates = new Set<string>();

    for (const detail of details) {
      allocationCount += getArray(getField(detail, "Allocations")).length;
      const key = dateKey(getField(detail, "RequestedOn"));
      if (key) requestedDates.add(key);
    }

    const dbOrder = dbByKey.get(dbKey(order));
    const dbLineCount = dbOrder?.lines.length ?? 0;
    const dbAllocationCount =
      dbOrder?.lines.reduce((sum, line) => sum + line.allocations.length, 0) ?? 0;

    const estimatedMinimumDbOps =
      2 + // contact find/upsert
      2 + // order find/upsert
      2 + // total find/upsert
      2 + // address find/upsert
      details.length * 2 + // line find/upsert
      allocationCount * 2 + // allocation find/upsert
      requestedDates.size; // delivery group upsert

    results.push({
      orderType: order.orderType,
      orderNumber: order.orderNumber,
      acumaticaRowsReturned: rows.length,
      contactIdPresent: Boolean(getField(row, "ContactID")),
      details: details.length,
      allocations: allocationCount,
      deliveryGroups: requestedDates.size,
      estimatedMinimumDbOps,
      dbCurrentState: {
        exists: Boolean(dbOrder),
        lines: dbLineCount,
        allocations: dbAllocationCount,
        deliveryGroups: dbOrder?.deliveryGroups.length ?? 0,
        hasTotal: Boolean(dbOrder?.total),
        hasAddress: Boolean(dbOrder?.address),
      },
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
