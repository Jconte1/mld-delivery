import { randomBytes } from "crypto";

export function newDeliveryConfirmationLinkToken() {
  return `dc42_${randomBytes(24).toString("hex")}`;
}

export function getDeliveryAppBaseUrl() {
  return (
    process.env.DELIVERY_APP_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.DELIVERY_CONFIRMATION_BASE_URL ||
    process.env.NEXT_PUBLIC_DELIVERY_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
}

export function buildDeliveryConfirmationLink(token: string) {
  return `${getDeliveryAppBaseUrl()}/delivery/confirm/${encodeURIComponent(token)}`;
}
