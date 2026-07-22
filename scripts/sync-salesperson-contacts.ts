import { fetchCatalogueSalespersonStaffUsers } from "../lib/salespersonContacts/catalogueStaffUsers";
import { syncSalespersonContactsFromStaffUsers } from "../lib/salespersonContacts/syncSalespersonContacts";

// TODO: schedule this sync to run once per month after production read-only catalogue-db credentials are confirmed.

async function main() {
  const staffUsers = await fetchCatalogueSalespersonStaffUsers();
  const counts = await syncSalespersonContactsFromStaffUsers({
    staffUsers,
    log: (summary) => {
      console.info("[salesperson-contact-sync] complete", summary);
    },
  });

  console.log(JSON.stringify(counts, null, 2));
}

main().catch((error) => {
  console.error("[salesperson-contact-sync] failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
