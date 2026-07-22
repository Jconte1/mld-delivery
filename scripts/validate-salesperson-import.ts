import { readFile } from "node:fs/promises";
import path from "node:path";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function field(value: unknown) {
  return { value };
}

async function main() {
  process.env.DATABASE_URL ||= "postgresql://localhost:5432/mock";
  const { getSalespersonNumber } = await import("../lib/erp/importSalesOrders");

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
    queueClient.includes(
      "Document.AttributeBUYERGROUP,Document.AttributeCONFIRMVIA,Document.AttributeCONFIRMWTH,Document.AttributeSALESNEW"
    ),
    "mld-queue full delivery SalesOrder fetch should request AttributeSALESNEW"
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
        acumaticaPrecedence: ["Document.AttributeSALESNEW", "DefaultSalesperson", "SalespersonID"],
        orderSalespersonNumberStored: true,
        missingSalespersonNumberAllowed: true,
        directFetchIncludesAttributeSALESNEW: true,
        queueFetchIncludesAttributeSALESNEW: true,
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
