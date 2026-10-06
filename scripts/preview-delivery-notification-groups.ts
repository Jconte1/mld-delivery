import { prisma } from "../lib/prisma";
import { deliveryAddressGroupingKey, deliveryNotificationCompatibilityKey } from "../lib/notifications/deliveryNotificationGrouping";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--delivery-date" || !/^\d{4}-\d{2}-\d{2}$/.test(args[1])) {
    throw new Error("Usage: preview:delivery-notification-groups -- --delivery-date YYYY-MM-DD (read-only stored-data compatibility, not send eligibility)");
  }
  const date = new Date(`${args[1]}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== args[1]) throw new Error("Invalid delivery date");
  const rows = await prisma.orderDeliveryGroup.findMany({
    where: { isActive: true, deliveryDate: date },
    select: { id: true, orderType: true, orderNumber: true,
      order: { select: { contactId: true, address: true, contact: { select: { email: true, phone1: true, emailOptIn: true, smsOptIn: true } } } } },
  });
  const channels = ["EMAIL", "SMS"] as const;
  const output = channels.map(channel => {
    const groups = new Map<string, { orders: string[]; separateReason: string | null }>();
    let missingRecipientOrOptIn = 0;
    for (const row of rows) {
      const contact = row.order.contact;
      const recipient = channel === "EMAIL" ? contact?.email : contact?.phone1;
      const optIn = channel === "EMAIL" ? contact?.emailOptIn : contact?.smsOptIn;
      if (!recipient?.trim() || !row.order.contactId || !optIn) { missingRecipientOrOptIn++; continue; }
      const key = deliveryNotificationCompatibilityKey({ eventId: row.id, contactId: row.order.contactId,
        recipient, channel, deliveryDate: args[1], interval: "STRUCTURAL_PREVIEW", action: "STRUCTURAL_PREVIEW",
        stage: "STRUCTURAL_PREVIEW", address: row.order.address });
      const group = groups.get(key) ?? { orders: [], separateReason: deliveryAddressGroupingKey(row.order.address) ? null : "incomplete_delivery_address" };
      group.orders.push(`${row.orderType}/${row.orderNumber}`);
      groups.set(key, group);
    }
    return { channel, missingRecipientOrOptIn, groups: [...groups.values()] };
  });
  console.log(JSON.stringify({ readOnly: true, productionEligibilityVerified: false,
    note: "Stored-data compatibility only. Channels are assessed separately, not selected. No fresh import, global opt-out, payment, stage or production qualification is performed. These are not approved sends.",
    deliveryDate: args[1], activeGroups: rows.length, channels: output }, null, 2));
}
main().catch(() => { console.error("Grouping preview failed; check date arguments and database connectivity."); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
