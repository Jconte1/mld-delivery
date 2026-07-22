import { requireCatalogueDatabaseUrl } from "../lib/salespersonContacts/catalogueStaffUsers";
import {
  SALESPERSON_ROLE,
  syncSalespersonContactsFromStaffUsers,
  type CatalogueStaffUserRow,
} from "../lib/salespersonContacts/syncSalespersonContacts";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

type ContactRow = {
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

class MockDeliveryStore {
  rows = new Map<string, ContactRow>();

  readonly client = {
    salespersonContact: {
      findMany: async (args: { where: { salespersonNumber: { in: string[] } } }) =>
        args.where.salespersonNumber.in
          .filter((salespersonNumber) => this.rows.has(salespersonNumber))
          .map((salespersonNumber) => ({ salespersonNumber })),
      upsert: async (args: {
        where: { salespersonNumber: string };
        create: ContactRow;
        update: Omit<ContactRow, "salespersonNumber">;
      }) => {
        const existing = this.rows.get(args.where.salespersonNumber);
        this.rows.set(
          args.where.salespersonNumber,
          existing
            ? { ...existing, ...args.update }
            : { ...args.create, salespersonNumber: args.where.salespersonNumber }
        );
      },
    },
  };
}

async function main() {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const store = new MockDeliveryStore();
  store.rows.set("100", {
    salespersonNumber: "100",
    salespersonName: "Old Name",
    salespersonEmail: "old@mld.com",
    salespersonPhone: "8010000000",
    sourceStaffUserId: "old",
    sourceRole: SALESPERSON_ROLE,
    isActive: true,
    sourceUpdatedAt: null,
    lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  const staffUsers: CatalogueStaffUserRow[] = [
    {
      id: "staff-100",
      role: SALESPERSON_ROLE,
      salespersonNumber: "100",
      salespersonName: "Updated Name",
      salespersonEmail: "UPDATED@MLD.COM",
      salespersonPhone: "8011112222",
      isActive: true,
      updatedAt: "2026-07-20T10:00:00.000Z",
    },
    {
      id: "staff-101",
      role: SALESPERSON_ROLE,
      salespersonNumber: "101",
      salespersonName: "John Smith",
      salespersonEmail: "john.smith@mld.com",
      salespersonPhone: "8015551234",
      isActive: true,
    },
    {
      id: "staff-102",
      role: SALESPERSON_ROLE,
      salespersonNumber: "102",
      salespersonName: "Inactive Sales",
      salespersonEmail: "inactive@mld.com",
      salespersonPhone: "8015559999",
      isActive: false,
    },
    {
      id: "staff-missing",
      role: SALESPERSON_ROLE,
      salespersonName: "Missing Number",
      salespersonEmail: "missing@mld.com",
      salespersonPhone: "8015550000",
      isActive: true,
    },
    {
      id: "staff-non-sales",
      role: "STAFF",
      salespersonNumber: "999",
      salespersonName: "Non Sales",
      salespersonEmail: "staff@mld.com",
      salespersonPhone: "8015557777",
      isActive: true,
    },
  ];

  const logged: unknown[] = [];
  const counts = await syncSalespersonContactsFromStaffUsers({
    staffUsers,
    client: store.client,
    now,
    log: (summary) => logged.push(summary),
  });

  assert(counts.fetched === 5, "sync should count fetched StaffUser rows");
  assert(counts.upserted === 3, "sync should upsert active and inactive salespeople with numbers");
  assert(counts.updated === 1, "sync should count existing rows as updated");
  assert(counts.skippedMissingSalespersonNumber === 1, "sync should skip missing salespersonNumber");
  assert(counts.skippedNonSalesperson === 1, "sync should ignore non-salesperson rows");
  assert(counts.inactive === 1, "sync should count inactive salespeople");
  assert(store.rows.has("999") === false, "non-salesperson row should not sync");
  assert(store.rows.get("102")?.isActive === false, "inactive salesperson should mark cache inactive");
  assert(store.rows.get("100")?.salespersonName === "Updated Name", "existing row should update");
  assert(store.rows.get("100")?.salespersonEmail === "updated@mld.com", "email should normalize lowercase");

  const secondCounts = await syncSalespersonContactsFromStaffUsers({
    staffUsers,
    client: store.client,
    now,
  });
  assert(secondCounts.upserted === 3, "second sync should upsert same eligible rows");
  assert(secondCounts.updated === 3, "second sync should be idempotent and update existing rows");
  assert(store.rows.size === 3, "idempotent sync should not duplicate rows");

  const loggedText = JSON.stringify(logged);
  assert(!loggedText.includes("john.smith@mld.com"), "sync log must not contain salesperson email");
  assert(!loggedText.includes("8015551234"), "sync log must not contain salesperson phone");

  let missingEnvFailed = false;
  try {
    requireCatalogueDatabaseUrl({} as NodeJS.ProcessEnv);
  } catch (error) {
    missingEnvFailed =
      error instanceof Error && error.message.includes("CATALOGUE_DATABASE_URL");
  }
  assert(missingEnvFailed, "missing CATALOGUE_DATABASE_URL should fail clearly");

  console.log(
    JSON.stringify(
      {
        roleFilter: SALESPERSON_ROLE,
        activeAndInactiveSynced: true,
        inactiveMarkedInactive: true,
        missingSalespersonNumberSkipped: true,
        nonSalespersonIgnored: true,
        idempotent: true,
        logsCountsOnly: true,
        missingCatalogueDatabaseUrlFailsClearly: true,
        counts,
        secondCounts,
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
