import { randomBytes } from "crypto";

const DELIVERY_APP_BASE_URL_ENV_VARS = [
  "DELIVERY_APP_BASE_URL",
  "APP_BASE_URL",
  "NEXT_PUBLIC_APP_BASE_URL",
] as const;

export function newDeliveryConfirmationLinkToken() {
  return `dc42_${randomBytes(24).toString("hex")}`;
}

export function normalizeDeliveryAppBaseUrl(value: string) {
  const normalized = value.trim().replace(/\/+$/, "");

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname) url.pathname = "/delivery";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
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
      const baseUrl = normalizeDeliveryAppBaseUrl(value);
      return {
        baseUrl,
        envVar,
        isDefault: false,
        isLocalhost: isLocalhostDeliveryAppBaseUrl(baseUrl),
      };
    }
  }

  const baseUrl = "http://localhost:3000/delivery";
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
  return `${getDeliveryAppBaseUrl()}/confirm/${encodeURIComponent(token)}`;
}

export function buildShortDeliveryConfirmationLink(token: string) {
  return `${getDeliveryAppBaseUrl()}/c/${encodeURIComponent(token)}`;
}

export function shortenDeliveryConfirmationLink(link: string) {
  const trimmed = link.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    const marker = "/confirm/";
    const markerIndex = url.pathname.lastIndexOf(marker);
    if (markerIndex < 0) return trimmed;

    const token = url.pathname.slice(markerIndex + marker.length);
    if (!token) return trimmed;

    url.pathname = `${url.pathname.slice(0, markerIndex)}/c/${token}`;
    return url.toString();
  } catch {
    return trimmed;
  }
}
