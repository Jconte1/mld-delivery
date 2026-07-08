import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";

function requestedOnFromArgs(argv: string[]) {
  for (const arg of argv) {
    if (arg.startsWith("--requested-on=")) {
      return arg.slice("--requested-on=".length);
    }
    if (arg.startsWith("--requestedOn=")) {
      return arg.slice("--requestedOn=".length);
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return "2026-07-22T09:19:00.000Z";
}

async function main() {
  const result = await importSalesOrdersForLineRequestedOn(requestedOnFromArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
