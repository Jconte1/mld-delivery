export const SALESPERSON_ROLE = "SALESPERSON";

export type CatalogueStaffUserRow = {
  id?: string | null;
  salespersonNumber?: string | null;
  salespersonName?: string | null;
  salespersonEmail?: string | null;
  salespersonPhone?: string | null;
  role?: string | null;
  isActive?: boolean | null;
  updatedAt?: Date | string | null;
};

export type SalespersonContactSyncCounts = {
  fetched: number;
  upserted: number;
  updated: number;
  skippedMissingSalespersonNumber: number;
  skippedNonSalesperson: number;
  inactive: number;
};

type SalespersonContactSyncClient = {
  salespersonContact: {
    findMany(args: {
      where: { salespersonNumber: { in: string[] } };
      select: { salespersonNumber: true };
    }): Promise<Array<{ salespersonNumber: string }>>;
    upsert(args: {
      where: { salespersonNumber: string };
      create: {
        salespersonNumber: string;
        salespersonName: string | null;
        salespersonEmail: string | null;
        salespersonPhone: string | null;
        sourceStaffUserId: string | null;
        sourceRole: string | null;
        isActive: boolean;
        sourceUpdatedAt: Date | null;
        lastSyncedAt: Date;
      };
      update: {
        salespersonName: string | null;
        salespersonEmail: string | null;
        salespersonPhone: string | null;
        sourceStaffUserId: string | null;
        sourceRole: string | null;
        isActive: boolean;
        sourceUpdatedAt: Date | null;
        lastSyncedAt: Date;
      };
    }): Promise<unknown>;
  };
};

function nullableTrimmedString(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeSalespersonNumber(value: string | null | undefined) {
  return nullableTrimmedString(value);
}

function normalizeRole(value: string | null | undefined) {
  return nullableTrimmedString(value)?.toUpperCase() ?? null;
}

function dateOrNull(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function emptyCounts(fetched: number): SalespersonContactSyncCounts {
  return {
    fetched,
    upserted: 0,
    updated: 0,
    skippedMissingSalespersonNumber: 0,
    skippedNonSalesperson: 0,
    inactive: 0,
  };
}

export async function syncSalespersonContactsFromStaffUsers(params: {
  staffUsers: CatalogueStaffUserRow[];
  client?: SalespersonContactSyncClient;
  now?: Date;
  log?: (counts: SalespersonContactSyncCounts) => void;
}) {
  const client =
    params.client ?? (await import("@/lib/prisma")).prisma;
  const now = params.now ?? new Date();
  const counts = emptyCounts(params.staffUsers.length);
  const eligibleRows: Array<
    CatalogueStaffUserRow & { salespersonNumber: string; normalizedRole: string }
  > = [];

  for (const row of params.staffUsers) {
    const normalizedRole = normalizeRole(row.role);
    if (normalizedRole !== SALESPERSON_ROLE) {
      counts.skippedNonSalesperson += 1;
      continue;
    }

    const salespersonNumber = normalizeSalespersonNumber(row.salespersonNumber);
    if (!salespersonNumber) {
      counts.skippedMissingSalespersonNumber += 1;
      continue;
    }

    eligibleRows.push({ ...row, salespersonNumber, normalizedRole });
    if (row.isActive === false) {
      counts.inactive += 1;
    }
  }

  const salespersonNumbers = Array.from(
    new Set(eligibleRows.map((row) => row.salespersonNumber))
  );
  const existingRows =
    salespersonNumbers.length > 0
      ? await client.salespersonContact.findMany({
          where: { salespersonNumber: { in: salespersonNumbers } },
          select: { salespersonNumber: true },
        })
      : [];
  const existingNumbers = new Set(existingRows.map((row) => row.salespersonNumber));

  for (const row of eligibleRows) {
    const create = {
      salespersonNumber: row.salespersonNumber,
      salespersonName: nullableTrimmedString(row.salespersonName),
      salespersonEmail: nullableTrimmedString(row.salespersonEmail)?.toLowerCase() ?? null,
      salespersonPhone: nullableTrimmedString(row.salespersonPhone),
      sourceStaffUserId: nullableTrimmedString(row.id),
      sourceRole: row.normalizedRole,
      isActive: row.isActive !== false,
      sourceUpdatedAt: dateOrNull(row.updatedAt),
      lastSyncedAt: now,
    };

    await client.salespersonContact.upsert({
      where: { salespersonNumber: row.salespersonNumber },
      create,
      update: {
        salespersonName: create.salespersonName,
        salespersonEmail: create.salespersonEmail,
        salespersonPhone: create.salespersonPhone,
        sourceStaffUserId: create.sourceStaffUserId,
        sourceRole: create.sourceRole,
        isActive: create.isActive,
        sourceUpdatedAt: create.sourceUpdatedAt,
        lastSyncedAt: create.lastSyncedAt,
      },
    });

    counts.upserted += 1;
    if (existingNumbers.has(row.salespersonNumber)) {
      counts.updated += 1;
    }
  }

  params.log?.(counts);
  return counts;
}
