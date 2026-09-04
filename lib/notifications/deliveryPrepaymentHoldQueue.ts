import { dateKey } from "@/lib/notifications/helpers";

export const DELIVERY_PREPAYMENT_HOLD_ROUTE = "/api/erp/jobs/delivery/prepayment-hold";
export const DELIVERY_PREPAYMENT_HOLD_REASON = "payment_not_received_by_deadline" as const;
export const DELIVERY_PREPAYMENT_HOLD_DRY_RUN_ENV = "DELIVERY_PREPAYMENT_HOLD_DRY_RUN";

const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 1_000;

type QueueFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type QueueJobSubmitResponse = {
  jobId?: string;
};

type QueueJobStatusResponse = {
  jobId?: string;
  type?: string;
  status?: "queued" | "processing" | "succeeded" | "failed";
  result?: unknown;
  error?: string | null;
};

export type DeliveryPrepaymentHoldQueueResult = {
  status?: string;
  reason?: string;
  dryRun?: boolean;
  liveWriteEnabled?: boolean;
  allowedByOrderAllowlist?: boolean;
  orderType?: string;
  orderNumber?: string;
  paymentEnforcementReason?: string;
  currentHoldValue?: boolean | null;
  currentStatus?: string | null;
  intendedHoldValue?: boolean;
  wouldWrite?: boolean;
  acumaticaPayload?: unknown;
  acumaticaResponseSummary?: unknown;
  verification?: unknown;
  errorMessage?: string;
};

export type DeliveryPrepaymentHoldPayload = {
  orderType: string;
  orderNumber: string;
  reason: typeof DELIVERY_PREPAYMENT_HOLD_REASON;
  dryRun: boolean;
  deliveryDate?: string;
  amountDueAtTrigger?: string | number;
  paymentDeadline?: string;
};

export type EnqueueDeliveryPrepaymentHoldParams = {
  orderType: string;
  orderNumber: string;
  dryRun?: boolean;
  deliveryDate?: Date | string | null;
  amountDueAtTrigger?: string | number | null;
  paymentDeadline?: Date | string | null;
};

export type EnqueueDeliveryPrepaymentHoldOptions = {
  baseUrl?: string;
  token?: string;
  fetchImpl?: QueueFetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onJobAccepted?: (jobId: string) => void | Promise<void>;
};

export type EnqueueDeliveryPrepaymentHoldResult = {
  jobId: string;
  payload: DeliveryPrepaymentHoldPayload;
  result: DeliveryPrepaymentHoldQueueResult;
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

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueRequest<T>(params: {
  baseUrl: string;
  token: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  fetchImpl: QueueFetch;
  signal?: AbortSignal;
}) {
  const response = await params.fetchImpl(`${params.baseUrl}${params.path}`, {
    method: params.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: params.method === "POST" ? JSON.stringify(params.body ?? {}) : undefined,
    cache: "no-store",
    signal: params.signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Delivery prepayment hold queue request failed status=${response.status} path=${params.path} body=${text.slice(0, 500)}`
    );
  }

  if (!text) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Delivery prepayment hold queue request returned non-JSON path=${params.path}`);
  }
}

function queueTimeoutMs(override?: number) {
  if (override && Number.isFinite(override) && override > 0) return override;
  return numberFromEnv("MLD_QUEUE_PREPAYMENT_HOLD_TIMEOUT_MS", DEFAULT_QUEUE_TIMEOUT_MS);
}

function queuePollIntervalMs(override?: number) {
  if (override && Number.isFinite(override) && override > 0) return override;
  return numberFromEnv("MLD_QUEUE_PREPAYMENT_HOLD_POLL_INTERVAL_MS", DEFAULT_QUEUE_POLL_INTERVAL_MS);
}

function normalizeDate(value: Date | string | null | undefined) {
  if (!value) return undefined;
  return dateKey(value);
}

export function shouldDryRunDeliveryPrepaymentHold() {
  const value = process.env[DELIVERY_PREPAYMENT_HOLD_DRY_RUN_ENV]?.trim().toLowerCase();
  return value === "true";
}

export function buildDeliveryPrepaymentHoldPayload(
  params: EnqueueDeliveryPrepaymentHoldParams
): DeliveryPrepaymentHoldPayload {
  const payload: DeliveryPrepaymentHoldPayload = {
    orderType: params.orderType.trim().toUpperCase(),
    orderNumber: params.orderNumber.trim().toUpperCase(),
    reason: DELIVERY_PREPAYMENT_HOLD_REASON,
    dryRun: params.dryRun ?? shouldDryRunDeliveryPrepaymentHold(),
  };

  const deliveryDate = normalizeDate(params.deliveryDate);
  if (deliveryDate) payload.deliveryDate = deliveryDate;

  if (params.amountDueAtTrigger !== null && params.amountDueAtTrigger !== undefined) {
    payload.amountDueAtTrigger = params.amountDueAtTrigger;
  }

  const paymentDeadline = normalizeDate(params.paymentDeadline);
  if (paymentDeadline) payload.paymentDeadline = paymentDeadline;

  return payload;
}

async function pollDeliveryPrepaymentHoldJob(params: {
  baseUrl: string;
  token: string;
  jobId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  fetchImpl: QueueFetch;
}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < params.timeoutMs) {
    const status = await queueRequest<QueueJobStatusResponse>({
      baseUrl: params.baseUrl,
      token: params.token,
      path: `/api/erp/jobs/${encodeURIComponent(params.jobId)}`,
      method: "GET",
      fetchImpl: params.fetchImpl,
    });

    if (status.status === "succeeded") {
      return (status.result ?? {}) as DeliveryPrepaymentHoldQueueResult;
    }

    if (status.status === "failed") {
      throw new Error(
        `Delivery prepayment hold queue job failed jobId=${params.jobId} error=${status.error || "unknown"}`
      );
    }

    if (status.status !== "queued" && status.status !== "processing") {
      throw new Error(
        `Delivery prepayment hold queue job returned unexpected status jobId=${params.jobId} status=${String(status.status)}`
      );
    }

    await sleep(params.pollIntervalMs);
  }

  throw new Error(
    `Delivery prepayment hold queue job timeout jobId=${params.jobId} timeoutMs=${params.timeoutMs}`
  );
}

export async function enqueueDeliveryPrepaymentHold(
  params: EnqueueDeliveryPrepaymentHoldParams,
  options: EnqueueDeliveryPrepaymentHoldOptions = {}
): Promise<EnqueueDeliveryPrepaymentHoldResult> {
  const baseUrl = normalizeBaseUrl(requiredConfig("MLD_QUEUE_BASE_URL", options.baseUrl));
  const token = requiredConfig("MLD_QUEUE_TOKEN", options.token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = buildDeliveryPrepaymentHoldPayload(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), queueTimeoutMs(options.timeoutMs));

  try {
    const submit = await queueRequest<QueueJobSubmitResponse>({
      baseUrl,
      token,
      path: DELIVERY_PREPAYMENT_HOLD_ROUTE,
      method: "POST",
      body: payload,
      fetchImpl,
      signal: controller.signal,
    });

    if (!clean(submit.jobId)) {
      throw new Error("Delivery prepayment hold enqueue response missing jobId");
    }

    const jobId = submit.jobId as string;
    await options.onJobAccepted?.(jobId);
    const result = await pollDeliveryPrepaymentHoldJob({
      baseUrl,
      token,
      jobId,
      timeoutMs: queueTimeoutMs(options.timeoutMs),
      pollIntervalMs: queuePollIntervalMs(options.pollIntervalMs),
      fetchImpl,
    });

    return { jobId, payload, result };
  } finally {
    clearTimeout(timeout);
  }
}
