import { prisma } from "@/lib/prisma";

export type ActiveNotificationOptOutAddresses = {
  activeSmsOptOutPhones: string[];
  activeEmailOptOutEmails: string[];
};

type NotificationOptOutLookupClient = {
  smsOptOut: {
    findMany(args: {
      where: { isActive: true };
      select: { phone: true };
    }): Promise<Array<{ phone: string }>>;
  };
  emailOptOut: {
    findMany(args: {
      where: { isActive: true };
      select: { email: true };
    }): Promise<Array<{ email: string }>>;
  };
};

export const EMPTY_ACTIVE_NOTIFICATION_OPT_OUT_ADDRESSES: ActiveNotificationOptOutAddresses = {
  activeSmsOptOutPhones: [],
  activeEmailOptOutEmails: [],
};

function hasOptOutLookupClient(value: unknown): value is NotificationOptOutLookupClient {
  if (!value || typeof value !== "object") return false;

  const candidate = value as {
    smsOptOut?: { findMany?: unknown };
    emailOptOut?: { findMany?: unknown };
  };

  return (
    typeof candidate.smsOptOut?.findMany === "function" &&
    typeof candidate.emailOptOut?.findMany === "function"
  );
}

export async function loadActiveNotificationOptOutAddresses(
  client: unknown = prisma
): Promise<ActiveNotificationOptOutAddresses> {
  if (!hasOptOutLookupClient(client)) {
    return EMPTY_ACTIVE_NOTIFICATION_OPT_OUT_ADDRESSES;
  }

  const [smsOptOuts, emailOptOuts] = await Promise.all([
    client.smsOptOut.findMany({
      where: { isActive: true },
      select: { phone: true },
    }),
    client.emailOptOut.findMany({
      where: { isActive: true },
      select: { email: true },
    }),
  ]);

  return {
    activeSmsOptOutPhones: smsOptOuts.map((optOut) => optOut.phone),
    activeEmailOptOutEmails: emailOptOuts.map((optOut) => optOut.email),
  };
}

export function mergeNotificationOptOutAddresses(
  globalOptOuts: ActiveNotificationOptOutAddresses,
  localOptOuts: Partial<ActiveNotificationOptOutAddresses>
): ActiveNotificationOptOutAddresses {
  return {
    activeSmsOptOutPhones: [
      ...globalOptOuts.activeSmsOptOutPhones,
      ...(localOptOuts.activeSmsOptOutPhones ?? []),
    ],
    activeEmailOptOutEmails: [
      ...globalOptOuts.activeEmailOptOutEmails,
      ...(localOptOuts.activeEmailOptOutEmails ?? []),
    ],
  };
}
