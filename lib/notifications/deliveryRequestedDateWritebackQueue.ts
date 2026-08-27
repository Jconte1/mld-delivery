import { dateKey } from "@/lib/notifications/helpers";

export const DELIVERY_REQUESTED_DATE_WRITEBACK_ROUTE =
  "/api/erp/jobs/delivery/requested-date";
export const DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN_ENV =
  "DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN";
const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;

type QueueFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type DeliveryRequestedDateWritebackSource = "WEBPAGE" | "SMS";

export type RequestedDateWritebackContactInput = {
  displayName?: string | null;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type DeliveryRequestedDateWritebackPayload = {
  orderType: string;
  orderNumber: string;
  deliveryConfirmationId: string;
  deliveryGroupId: string;
  originalDeliveryDate: string;
  requestedDeliveryDate: string;
  lineNumbers: number[];
  source: DeliveryRequestedDateWritebackSource;
  dryRun: boolean;
  requestedAt: string;
  requestedBy?: RequestedDateWritebackContactInput;
};

export type EnqueueDeliveryRequestedDateWritebackParams = {
  orderType: string;
  orderNumber: string;
  deliveryConfirmationId: string;
  deliveryGroupId: string;
  originalDeliveryDate: Date | string;
  requestedDeliveryDate: Date | string;
  lineNumbers: number[];
  source: DeliveryRequestedDateWritebackSource;
  requestedAt?: Date | string;
  contact?: RequestedDateWritebackContactInput | null;
};

export type EnqueueDeliveryRequestedDateWritebackOptions = {
  baseUrl?: string;
  token?: string;
  fetchImpl?: QueueFetch;
};

export type DeliveryRequestedDateLineClient = {
  orderDeliveryGroupLine: {
    findMany(args: {
      where: { orderDeliveryGroupId: string; isActive: boolean };
      orderBy: { lineNbr: "asc" };
      select: { lineNbr: true };
    }): Promise<Array<{ lineNbr: number | null }>>;
  };
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
  const raw = process.env.MLD_QUEUE_REQUESTED_DATE_WRITEBACK_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ENQUEUE_TIMEOUT_MS;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ENQUEUE_TIMEOUT_MS;
}

function normalizeDate(value: Date | string) {
  return dateKey(value);
}

function normalizeRequestedAt(value: Date | string | undefined) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("requestedAt must be a valid date");
  }
  return date.toISOString();
}

function normalizeLineNumbers(lineNumbers: number[]) {
  const normalized = Array.from(
    new Set(
      lineNumbers
        .map((lineNumber) => Number(lineNumber))
        .filter((lineNumber) => Number.isInteger(lineNumber) && lineNumber > 0)
    )
  ).sort((left, right) => left - right);

  if (normalized.length === 0) {
    throw new Error("At least one delivery group line number is required");
  }

  return normalized;
}

function contactPayload(contact: RequestedDateWritebackContactInput | null | undefined) {
  if (!contact) return undefined;

  const payload: RequestedDateWritebackContactInput = {};
  const displayName = clean(contact.displayName);
  const companyName = clean(contact.companyName);
  const firstName = clean(contact.firstName);
  const lastName = clean(contact.lastName);
  const email = clean(contact.email);
  const phone = clean(contact.phone);

  if (displayName) payload.displayName = displayName;
  if (companyName) payload.companyName = companyName;
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  if (email) payload.email = email;
  if (phone) payload.phone = phone;

  return Object.keys(payload).length ? payload : undefined;
}

export function shouldDryRunDeliveryRequestedDateWriteback() {
  const dryRunOverride = process.env[DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN_ENV]
    ?.trim()
    .toLowerCase();

  return dryRunOverride !== "false";
}

export async function loadDeliveryRequestedDateWritebackLineNumbers(params: {
  deliveryGroupId: string;
  client: DeliveryRequestedDateLineClient;
}) {
  const deliveryGroupId = params.deliveryGroupId.trim();
  if (!deliveryGroupId) throw new Error("deliveryGroupId is required");

  const rows = await params.client.orderDeliveryGroupLine.findMany({
    where: { orderDeliveryGroupId: deliveryGroupId, isActive: true },
    orderBy: { lineNbr: "asc" },
    select: { lineNbr: true },
  });
  if (rows.length === 0) {
    throw new Error("Delivery group has no active line memberships");
  }

  const lineNumbers = normalizeLineNumbers(rows.map((row) => row.lineNbr ?? NaN));
  if (lineNumbers.length !== rows.length) {
    throw new Error("Delivery group line membership is missing a valid lineNbr");
  }

  return lineNumbers;
}

export function buildDeliveryRequestedDateWritebackPayload(
  params: EnqueueDeliveryRequestedDateWritebackParams
): DeliveryRequestedDateWritebackPayload {
  const requestedBy = contactPayload(params.contact);
  const payload: DeliveryRequestedDateWritebackPayload = {
    orderType: params.orderType.trim().toUpperCase(),
    orderNumber: params.orderNumber.trim().toUpperCase(),
    deliveryConfirmationId: params.deliveryConfirmationId.trim(),
    deliveryGroupId: params.deliveryGroupId.trim(),
    originalDeliveryDate: normalizeDate(params.originalDeliveryDate),
    requestedDeliveryDate: normalizeDate(params.requestedDeliveryDate),
    lineNumbers: normalizeLineNumbers(params.lineNumbers),
    source: params.source,
    dryRun: shouldDryRunDeliveryRequestedDateWriteback(),
    requestedAt: normalizeRequestedAt(params.requestedAt),
  };

  if (!payload.orderType) throw new Error("orderType is required");
  if (!payload.orderNumber) throw new Error("orderNumber is required");
  if (!payload.deliveryConfirmationId) throw new Error("deliveryConfirmationId is required");
  if (!payload.deliveryGroupId) throw new Error("deliveryGroupId is required");
  if (requestedBy) payload.requestedBy = requestedBy;

  return payload;
}

export async function enqueueDeliveryRequestedDateWriteback(
  params: EnqueueDeliveryRequestedDateWritebackParams,
  options: EnqueueDeliveryRequestedDateWritebackOptions = {}
) {
  const baseUrl = normalizeBaseUrl(requiredConfig("MLD_QUEUE_BASE_URL", options.baseUrl));
  const token = requiredConfig("MLD_QUEUE_TOKEN", options.token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = buildDeliveryRequestedDateWritebackPayload(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), enqueueTimeoutMs());

  const response = await fetchImpl(`${baseUrl}${DELIVERY_REQUESTED_DATE_WRITEBACK_ROUTE}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Delivery requested-date writeback enqueue failed status=${response.status} body=${text.slice(0, 500)}`
    );
  }

  const result = (text ? JSON.parse(text) : {}) as { jobId?: string };
  if (!result.jobId) {
    throw new Error("Delivery requested-date writeback enqueue response missing jobId");
  }

  return {
    jobId: result.jobId,
    payload,
  };
}
