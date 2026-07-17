import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";
import { dateKey } from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";

type Args = {
  orderType?: string;
  orderNumber?: string;
  requestedOn?: string;
};

function parseArgs(argv: string[]) {
  const args: Args = {};

  for (const arg of argv) {
    if (arg.startsWith("--order-type=")) args.orderType = arg.slice("--order-type=".length);
    else if (arg.startsWith("--order-number=")) args.orderNumber = arg.slice("--order-number=".length);
    else if (arg.startsWith("--requested-on=")) args.requestedOn = arg.slice("--requested-on=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.orderType?.trim()) throw new Error("--order-type is required");
  if (!args.orderNumber?.trim()) throw new Error("--order-number is required");
  if (!args.requestedOn?.trim()) throw new Error("--requested-on is required");

  return {
    orderType: args.orderType.trim().toUpperCase(),
    orderNumber: args.orderNumber.trim().toUpperCase(),
    requestedOn: args.requestedOn.trim(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await importSalesOrdersForLineRequestedOn(args.requestedOn, {
    orderLookups: [{ orderType: args.orderType, orderNumber: args.orderNumber }],
    includeUnqualifiedOrderLookups: true,
  });

  const order = await prisma.order.findUnique({
    where: {
      orderType_orderNumber: {
        orderType: args.orderType,
        orderNumber: args.orderNumber,
      },
    },
    select: {
      id: true,
      status: true,
      internalLifecycleStatus: true,
      contactId: true,
      deliveryGroups: {
        orderBy: { deliveryDate: "asc" },
        select: {
          id: true,
          deliveryDate: true,
          isActive: true,
          status: true,
          lineCount: true,
        },
      },
    },
  });

  console.log(
    JSON.stringify(
      {
        importResult: result,
        order: order
          ? {
              ...order,
              deliveryGroups: order.deliveryGroups.map((group) => ({
                ...group,
                deliveryDate: dateKey(group.deliveryDate),
              })),
            }
          : null,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
