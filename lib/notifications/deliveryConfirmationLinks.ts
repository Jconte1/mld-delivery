import { randomBytes } from "crypto";

const DELIVERY_APP_BASE_URL_ENV_VARS = [
  "DELIVERY_APP_BASE_URL",
  "APP_BASE_URL",
  "NEXT_PUBLIC_APP_BASE_URL",
] as const;

export function newDeliveryConfirmationLinkToken() {
  return `dc42_${randomBytes(24).toString("hex")}`;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function isLocalhostDeliveryAppBaseUrl(value: string) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function getDeliveryAppBaseUrlConfig() {
  for (const envVar of DELIVERY_APP_BASE_URL_ENV_VARS) {
    const value = process.env[envVar]?.trim();
    if (value) {
      const baseUrl = normalizeBaseUrl(value);
      return {
        baseUrl,
        envVar,
        isDefault: false,
        isLocalhost: isLocalhostDeliveryAppBaseUrl(baseUrl),
      };
    }
  }

  const baseUrl = "http://localhost:3000";
  return {
    baseUrl,
    envVar: null,
    isDefault: true,
    isLocalhost: true,
  };
}

export function getDeliveryAppBaseUrl() {
  return getDeliveryAppBaseUrlConfig().baseUrl;
}

export function buildDeliveryConfirmationLink(token: string) {
  return `${getDeliveryAppBaseUrl()}/delivery/confirm/${encodeURIComponent(token)}`;
}
