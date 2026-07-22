import { prisma } from "@/lib/prisma";
import type { SalespersonContactInput } from "@/lib/notifications/salespersonContactDisplay";

type SalespersonContactLookupClient = {
  salespersonContact?: {
    findMany(args: {
      where: { salespersonNumber: { in: string[] }; isActive: true };
      select: {
        salespersonNumber: true;
        salespersonName: true;
        salespersonEmail: true;
        salespersonPhone: true;
        isActive: true;
      };
    }): Promise<Array<SalespersonContactInput & { salespersonNumber: string }>>;
  };
};

function cleanSalespersonNumber(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export async function getActiveSalespersonContactMap(
  salespersonNumbers: Array<string | null | undefined>,
  client: SalespersonContactLookupClient = prisma
) {
  const numbers = Array.from(
    new Set(
      salespersonNumbers
        .map(cleanSalespersonNumber)
        .filter((value): value is string => Boolean(value))
    )
  );

  if (numbers.length === 0 || !client.salespersonContact) {
    return new Map<string, SalespersonContactInput>();
  }

  const contacts = await client.salespersonContact.findMany({
    where: {
      salespersonNumber: { in: numbers },
      isActive: true,
    },
    select: {
      salespersonNumber: true,
      salespersonName: true,
      salespersonEmail: true,
      salespersonPhone: true,
      isActive: true,
    },
  });

  return new Map(contacts.map((contact) => [contact.salespersonNumber, contact]));
}

export async function getActiveSalespersonContact(
  salespersonNumber: string | null | undefined,
  client: SalespersonContactLookupClient = prisma
) {
  const map = await getActiveSalespersonContactMap([salespersonNumber], client);
  const cleaned = cleanSalespersonNumber(salespersonNumber);
  return cleaned ? map.get(cleaned) ?? null : null;
}
