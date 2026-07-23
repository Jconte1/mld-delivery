import { readFile } from "node:fs/promises";
import path from "node:path";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function field(value: unknown) {
  return { value };
}

function functionSegment(source: string, name: string) {
  const start = source.indexOf(name);
  if (start === -1) return "";
  const nextFunction = source.indexOf("\n  async ", start + name.length);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

async function main() {
  process.env.DATABASE_URL ||= "postgresql://localhost:5432/mock";
  const { getSalespersonNumber } = await import("../lib/erp/importSalesOrders");

  assert(
    getSalespersonNumber({
      SalespersonNumber: field("1250"),
      custom: { Document: { AttributeSALESNEW: field("101") } },
      DefaultSalesperson: field("202"),
      SalespersonID: field("303"),
    }) === "1250",
    "direct SalespersonNumber should win precedence"
  );
  assert(
    getSalespersonNumber({
      custom: { Document: { AttributeSALESNEW: field("101") } },
      DefaultSalesperson: field("202"),
      SalespersonID: field("303"),
    }) === "101",
    "AttributeSALESNEW should win precedence"
  );
  assert(
    getSalespersonNumber({
      DefaultSalesperson: field("202"),
      SalespersonID: field("303"),
    }) === "202",
    "DefaultSalesperson should be second precedence"
  );
  assert(
    getSalespersonNumber({
      SalespersonID: field("303"),
    }) === "303",
    "SalespersonID should be third precedence"
  );
  assert(
    getSalespersonNumber({
      custom: { Document: { AttributeSALESNEW: field(" ") } },
    }) === null,
    "missing salespersonNumber should return null"
  );

  const projectRoot = path.resolve(__dirname, "..");
  const queueRoot = path.resolve(projectRoot, "..", "mld-queue");
  const [
    schema,
    migration,
    directClient,
    importer,
    detectChanges,
    changeTypes,
    queueClient,
  ] = await Promise.all([
    readFile(path.join(projectRoot, "prisma/schema.prisma"), "utf8"),
    readFile(
      path.join(
        projectRoot,
        "prisma/migrations/20260722123000_add_salesperson_contact_cache/migration.sql"
      ),
      "utf8"
    ),
    readFile(path.join(projectRoot, "lib/acumatica/client/acumaticaClient.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/erp/importSalesOrders.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/erp/detectErpChanges.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/erp/erpChangeTypes.ts"), "utf8"),
    readFile(path.join(queueRoot, "worker/src/lib/acumaticaClient.ts"), "utf8"),
  ]);
  const directFullFetch = functionSegment(directClient, "fetchDeliverySalesOrderByOrderNumber");
  const queueFullFetch = functionSegment(queueClient, "fetchDeliverySalesOrderFull");

  assert(
    schema.includes("salespersonNumber       String?") &&
      schema.includes("model SalespersonContact"),
    "schema should define Order.salespersonNumber and SalespersonContact"
  );
  assert(
    migration.includes('ALTER TABLE "orders" ADD COLUMN     "salespersonNumber"') &&
      migration.includes('CREATE TABLE "salesperson_contacts"'),
    "migration should add order column and salesperson cache table"
  );
  assert(
    directClient.includes("Document.AttributeSALESNEW"),
    "direct delivery Acumatica full fetch should request AttributeSALESNEW"
  );
  assert(
    directFullFetch.includes("$expand: DEFAULT_SALES_ORDER_EXPAND") &&
      !directFullFetch.includes("$select"),
    "direct delivery Acumatica full fetch should preserve standard fields including SalespersonNumber"
  );
  assert(
    queueClient.includes(
      "Document.AttributeBUYERGROUP,Document.AttributeCONFIRMVIA,Document.AttributeCONFIRMWTH,Document.AttributeSALESNEW"
    ),
    "mld-queue full delivery SalesOrder fetch should request AttributeSALESNEW"
  );
  assert(
    queueFullFetch.includes("$expand: DEFAULT_DELIVERY_SALES_ORDER_EXPAND") &&
      !queueFullFetch.includes("$select"),
    "mld-queue full delivery SalesOrder fetch should preserve standard fields including SalespersonNumber"
  );
  assert(
    importer.includes("salespersonNumber: true") &&
      importer.includes("salespersonNumber: getSalespersonNumber(fullOrder)"),
    "importer should select and store salespersonNumber"
  );
  assert(
    detectChanges.includes("ERP_CHANGE_TYPES.SALESPERSON_CHANGED") &&
      changeTypes.includes('salesperson_changed: ["salespersonNumber"]'),
    "salespersonNumber should be tracked as a meaningful ERP change"
  );
  assert(
    !importer.includes("enqueueDeliveryConfirmationAttributeWriteback"),
    "salesperson import should not introduce Acumatica writeback"
  );

  console.log(
    JSON.stringify(
      {
        acumaticaPrecedence: [
          "SalespersonNumber",
          "Document.AttributeSALESNEW",
          "DefaultSalesperson",
          "SalespersonID",
        ],
        orderSalespersonNumberStored: true,
        missingSalespersonNumberAllowed: true,
        directSalespersonNumberParsed: true,
        directFetchIncludesAttributeSALESNEW: true,
        directFetchPreservesSalespersonNumber: true,
        queueFetchIncludesAttributeSALESNEW: true,
        queueFetchPreservesSalespersonNumber: true,
        salespersonChangeDetectionWired: true,
        noDirectAcumaticaWriteIntroduced: true,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
