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

async function defaultSalespersonContactLookupClient() {
  const { prisma } = await import("@/lib/prisma");
  return prisma as unknown as SalespersonContactLookupClient;
}

export async function getActiveSalespersonContactMap(
  salespersonNumbers: Array<string | null | undefined>,
  client?: SalespersonContactLookupClient
) {
  const numbers = Array.from(
    new Set(
      salespersonNumbers
        .map(cleanSalespersonNumber)
        .filter((value): value is string => Boolean(value))
    )
  );

  const lookupClient = client ?? (await defaultSalespersonContactLookupClient());

  if (numbers.length === 0 || !lookupClient.salespersonContact) {
    return new Map<string, SalespersonContactInput>();
  }

  const contacts = await lookupClient.salespersonContact.findMany({
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
  client?: SalespersonContactLookupClient
) {
  const map = await getActiveSalespersonContactMap([salespersonNumber], client);
  const cleaned = cleanSalespersonNumber(salespersonNumber);
  return cleaned ? map.get(cleaned) ?? null : null;
}
