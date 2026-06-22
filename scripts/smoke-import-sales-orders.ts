import { importSalesOrdersForLineRequestedOn } from "../lib/erp/importSalesOrders";

async function main() {
  const result = await importSalesOrdersForLineRequestedOn("2026-07-22T09:19:00.000Z");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
