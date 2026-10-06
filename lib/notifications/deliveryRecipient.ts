import { selectNotificationChannel, type NotificationContactInput } from "./helpers";
import { mergeNotificationOptOutAddresses, EMPTY_ACTIVE_NOTIFICATION_OPT_OUT_ADDRESSES,
  type ActiveNotificationOptOutAddresses } from "./notificationOptOutLookup";

export const recipientContactSelect = {
  contactId: true, companyName: true, displayName: true, firstName: true, lastName: true,
  email: true, phone1: true, phone2: true, smsOptIn: true, emailOptIn: true, phoneCallOptIn: true,
  smsOptOuts: { where: { isActive: true }, select: { phone: true } },
  emailOptOuts: { where: { isActive: true }, select: { email: true } },
} as const;

type RecipientContact = NotificationContactInput & {
  contactId: string; smsOptOuts?: { phone: string }[]; emailOptOuts?: { email: string }[];
};

export function selectDeliveryRecipient<T extends RecipientContact>(interval: string, order: {
  contact: T; deliveryContact?: T | null; deliveryContactId?: string | null;
  deliveryContactSyncStatus?: string; primaryContactFetchSucceeded?: boolean;
}, globalOptOuts: ActiveNotificationOptOutAddresses = EMPTY_ACTIVE_NOTIFICATION_OPT_OUT_ADDRESSES) {
  const channelFor = (contact: T) => selectNotificationChannel(contact, mergeNotificationOptOutAddresses(globalOptOuts, {
    activeSmsOptOutPhones: contact.smsOptOuts?.map(o => o.phone) ?? [],
    activeEmailOptOutEmails: contact.emailOptOuts?.map(o => o.email) ?? [],
  }));
  let fallbackReason: string | null = null;
  if (interval === "DAY_2") {
    if (!order.deliveryContactId) fallbackReason = "delivery_contact_missing";
    else if (order.deliveryContactSyncStatus !== "fetched" || !order.deliveryContact ||
      order.deliveryContact.contactId !== order.deliveryContactId) fallbackReason = "delivery_contact_unavailable";
    else {
      const channel = channelFor(order.deliveryContact);
      if (channel.selectedChannel) return { contact: order.deliveryContact, role: "DELIVERY" as const, fallbackReason, channel };
      fallbackReason = "delivery_contact_no_eligible_channel";
    }
    if (order.primaryContactFetchSucceeded !== true) return { contact: order.contact, role: "PRIMARY" as const,
      fallbackReason, channel: { selectedChannel: null, channelReason: "primary_contact_unavailable" } as ReturnType<typeof selectNotificationChannel> };
  }
  return { contact: order.contact, role: "PRIMARY" as const, fallbackReason, channel: channelFor(order.contact) };
}
