import { prisma } from "../lib/prisma";

type CountRow = {
  total: number;
  active: number;
  inactive: number;
  missingEmail: number;
  missingPhone: number;
  missingBoth: number;
};

async function main() {
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE "isActive")::int AS "active",
      COUNT(*) FILTER (WHERE NOT "isActive")::int AS "inactive",
      COUNT(*) FILTER (
        WHERE NULLIF(BTRIM(COALESCE("salespersonEmail", '')), '') IS NULL
      )::int AS "missingEmail",
      COUNT(*) FILTER (
        WHERE NULLIF(BTRIM(COALESCE("salespersonPhone", '')), '') IS NULL
      )::int AS "missingPhone",
      COUNT(*) FILTER (
        WHERE NULLIF(BTRIM(COALESCE("salespersonEmail", '')), '') IS NULL
          AND NULLIF(BTRIM(COALESCE("salespersonPhone", '')), '') IS NULL
      )::int AS "missingBoth"
    FROM "salesperson_contacts"
  `;

  console.log(JSON.stringify(rows[0], null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
