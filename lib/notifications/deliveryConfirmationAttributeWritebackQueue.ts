import { dateKey } from "@/lib/notifications/helpers";

export const DELIVERY_CONFIRMATION_ATTRIBUTE_WRITEBACK_ROUTE =
  "/api/erp/jobs/delivery/confirmation-attributes";
export const WEBPAGE_CONFIRMED_VIA_VALUE = "WEBPAGE";
export const SMS_CONFIRMED_VIA_VALUE = "AUTOTXT";
export const DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV =
  "DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN";
const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;

type QueueFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ConfirmationWritebackContactInput = {
  displayName?: string | null;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type DeliveryConfirmationAttributeWritebackPayload = {
  orderType: string;
  orderNumber: string;
  confirmedVia: string;
  confirmedWith: string;
  deliveryConfirmationId: string;
  deliveryGroupId: string;
  deliveryDate: string;
  source: string;
  dryRun: boolean;
};

export type EnqueueDeliveryConfirmationAttributeWritebackParams = {
  orderType: string;
  orderNumber: string;
  deliveryConfirmationId: string;
  deliveryGroupId: string;
  deliveryDate: Date | string;
  contact: ConfirmationWritebackContactInput;
  confirmedVia?: string;
  source?: string;
};

export type EnqueueDeliveryConfirmationAttributeWritebackOptions = {
  baseUrl?: string;
  token?: string;
  fetchImpl?: QueueFetch;
};

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function requiredConfig(name: "MLD_QUEUE_BASE_URL" | "MLD_QUEUE_TOKEN", override?: string) {
  const value = override?.trim() || process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function enqueueTimeoutMs() {
  const raw = process.env.MLD_QUEUE_CONFIRMATION_WRITEBACK_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ENQUEUE_TIMEOUT_MS;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ENQUEUE_TIMEOUT_MS;
}

export function resolveConfirmedWith(contact: ConfirmationWritebackContactInput) {
  const fullName = [contact.firstName, contact.lastName].map(clean).filter(Boolean).join(" ");

  return (
    clean(contact.displayName) ??
    clean(contact.companyName) ??
    clean(fullName) ??
    clean(contact.email) ??
    clean(contact.phone) ??
    "Customer"
  );
}

export function shouldDryRunDeliveryConfirmationAttributeWriteback() {
  const dryRunOverride = process.env[DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN_ENV]
    ?.trim()
    .toLowerCase();

  return dryRunOverride !== "false";
}

export function buildDeliveryConfirmationAttributeWritebackPayload(
  params: EnqueueDeliveryConfirmationAttributeWritebackParams
): DeliveryConfirmationAttributeWritebackPayload {
  const orderNumber = params.orderNumber.trim().toUpperCase();

  return {
    orderType: params.orderType.trim().toUpperCase(),
    orderNumber,
    confirmedVia: clean(params.confirmedVia) ?? WEBPAGE_CONFIRMED_VIA_VALUE,
    confirmedWith: resolveConfirmedWith(params.contact),
    deliveryConfirmationId: params.deliveryConfirmationId,
    deliveryGroupId: params.deliveryGroupId,
    deliveryDate: dateKey(params.deliveryDate),
    source: clean(params.source) ?? "WEBPAGE",
    dryRun: shouldDryRunDeliveryConfirmationAttributeWriteback(),
  };
}

export async function enqueueDeliveryConfirmationAttributeWriteback(
  params: EnqueueDeliveryConfirmationAttributeWritebackParams,
  options: EnqueueDeliveryConfirmationAttributeWritebackOptions = {}
) {
  const baseUrl = normalizeBaseUrl(requiredConfig("MLD_QUEUE_BASE_URL", options.baseUrl));
  const token = requiredConfig("MLD_QUEUE_TOKEN", options.token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = buildDeliveryConfirmationAttributeWritebackPayload(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), enqueueTimeoutMs());

  const response = await fetchImpl(
    `${baseUrl}${DELIVERY_CONFIRMATION_ATTRIBUTE_WRITEBACK_ROUTE}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    }
  ).finally(() => clearTimeout(timeout));

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Delivery confirmation attribute writeback enqueue failed status=${response.status} body=${text.slice(0, 500)}`
    );
  }

  const result = (text ? JSON.parse(text) : {}) as { jobId?: string };
  if (!result.jobId) {
    throw new Error("Delivery confirmation attribute writeback enqueue response missing jobId");
  }

  return {
    jobId: result.jobId,
    payload,
  };
}
