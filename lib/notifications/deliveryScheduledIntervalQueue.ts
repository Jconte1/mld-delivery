import type {
  DeliveryScheduledIntervalQueuePayload,
  DeliveryScheduledIntervalQueueResult,
} from "@/scripts/run-scheduled-delivery-interval";

export const DELIVERY_SCHEDULED_INTERVAL_QUEUE_ROUTE =
  "/api/erp/jobs/delivery/scheduled-interval";

type QueueFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type QueueJobSubmitResponse = {
  jobId?: string;
};

export type EnqueueDeliveryScheduledIntervalOptions = {
  baseUrl?: string;
  token?: string;
  fetchImpl?: QueueFetch;
  timeoutMs?: number;
};

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function requiredConfig(name: "MLD_QUEUE_BASE_URL" | "MLD_QUEUE_TOKEN", override?: string) {
  const value = override?.trim() || process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function enqueueTimeoutMs(override?: number) {
  if (override && Number.isFinite(override) && override > 0) return override;
  const raw = process.env.MLD_QUEUE_SCHEDULED_INTERVAL_ENQUEUE_TIMEOUT_MS?.trim();
  const value = raw ? Number(raw) : 30_000;
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

export async function enqueueDeliveryScheduledInterval(
  payload: DeliveryScheduledIntervalQueuePayload,
  options: EnqueueDeliveryScheduledIntervalOptions = {}
): Promise<DeliveryScheduledIntervalQueueResult> {
  const baseUrl = normalizeBaseUrl(requiredConfig("MLD_QUEUE_BASE_URL", options.baseUrl));
  const token = requiredConfig("MLD_QUEUE_TOKEN", options.token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), enqueueTimeoutMs(options.timeoutMs));

  try {
    const response = await fetchImpl(`${baseUrl}${DELIVERY_SCHEDULED_INTERVAL_QUEUE_ROUTE}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Delivery scheduled interval enqueue failed status=${response.status} body=${text.slice(0, 500)}`
      );
    }

    const body = text ? (JSON.parse(text) as QueueJobSubmitResponse) : {};
    if (!body.jobId?.trim()) {
      throw new Error("Delivery scheduled interval enqueue response missing jobId");
    }

    return {
      jobId: body.jobId,
      payload,
    };
  } finally {
    clearTimeout(timeout);
  }
}
