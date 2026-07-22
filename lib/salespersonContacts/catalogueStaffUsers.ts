import { Pool } from "pg";

import type { CatalogueStaffUserRow } from "@/lib/salespersonContacts/syncSalespersonContacts";

export function requireCatalogueDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const value = env.CATALOGUE_DATABASE_URL?.trim();
  if (!value) {
    throw new Error("Missing env var: CATALOGUE_DATABASE_URL");
  }
  return value;
}

export async function fetchCatalogueSalespersonStaffUsers(
  connectionString = requireCatalogueDatabaseUrl()
): Promise<CatalogueStaffUserRow[]> {
  const pool = new Pool({ connectionString, max: 1 });

  try {
    const result = await pool.query<CatalogueStaffUserRow>(`
      SELECT
        "id",
        "salespersonNumber",
        "salespersonName",
        "salespersonEmail",
        "salespersonPhone",
        "role"::text AS "role",
        "isActive",
        "updatedAt"
      FROM "StaffUser"
      WHERE "role" = 'SALESPERSON'
    `);

    return result.rows;
  } finally {
    await pool.end();
  }
}
