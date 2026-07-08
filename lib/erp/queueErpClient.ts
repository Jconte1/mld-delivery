import {
  DEFAULT_ALLOWED_SHIP_VIA,
  DEFAULT_ALLOWED_STATUSES,
  DEFAULT_EXCLUDED_ORDER_TYPES,
} from "@/lib/acumatica/client/acumaticaClient";

import type { DeliveryErpClient } from "@/lib/erp/erpClient";

const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 1_000;

type QueueErpJobSubmitResponse = {
  jobId?: string;
};

type QueueErpJobStatusResponse = {
  jobId?: string;
  type?: string;
  status?: "queued" | "processing" | "succeeded" | "failed";
  result?: unknown;
  error?: string | null;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requestedOnPayloadValue(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowsFromResult(result: unknown, jobType: string, jobId: string): unknown[] {
  if (!result || typeof result !== "object" || !("rows" in result)) {
    throw new Error(`Queue ERP job returned invalid result shape jobType=${jobType} jobId=${jobId}`);
  }

  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new Error(`Queue ERP job result.rows is not an array jobType=${jobType} jobId=${jobId}`);
  }

  return rows;
}

export class QueueErpClient implements DeliveryErpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly pollIntervalMs: number;

  constructor() {
    this.baseUrl = normalizeBaseUrl(requireEnv("MLD_QUEUE_BASE_URL"));
    this.token = requireEnv("MLD_QUEUE_TOKEN");
    this.pollIntervalMs = numberFromEnv(
      "MLD_QUEUE_JOB_POLL_INTERVAL_MS",
      DEFAULT_QUEUE_POLL_INTERVAL_MS
    );
  }

  async fetchQualifyingSalesOrdersByLineRequestedOn(
    requestedOn: Date | string
  ): Promise<unknown[]> {
    return this.submitAndPollRows(
      "ERP_FIND_DELIVERY_SALES_ORDERS_BY_LINE_REQUESTED_ON",
      "/api/erp/jobs/delivery/sales-orders/by-line-requested-on",
      {
        requestedOn: requestedOnPayloadValue(requestedOn),
        excludedOrderTypes: DEFAULT_EXCLUDED_ORDER_TYPES,
        allowedShipVia: DEFAULT_ALLOWED_SHIP_VIA,
        allowedStatuses: DEFAULT_ALLOWED_STATUSES,
      },
      numberFromEnv(
        "MLD_QUEUE_STEP1_TIMEOUT_MS",
        numberFromEnv("MLD_QUEUE_JOB_POLL_TIMEOUT_MS", DEFAULT_QUEUE_TIMEOUT_MS)
      )
    );
  }

  async fetchDeliverySalesOrderByOrderNumber(
    orderNumber: string,
    orderType?: string | null
  ): Promise<unknown[]> {
    const payload: Record<string, unknown> = {
      orderNbr: orderNumber,
    };
    if (orderType) {
      payload.orderType = orderType;
    }

    return this.submitAndPollRows(
      "ERP_GET_DELIVERY_SALES_ORDER_FULL",
      "/api/erp/jobs/delivery/sales-orders/full",
      payload,
      numberFromEnv(
        "MLD_QUEUE_STEP2_TIMEOUT_MS",
        numberFromEnv("MLD_QUEUE_JOB_POLL_TIMEOUT_MS", DEFAULT_QUEUE_TIMEOUT_MS)
      )
    );
  }

  async fetchDeliveryContactByContactId(contactId: string): Promise<unknown[]> {
    return this.submitAndPollRows(
      "ERP_GET_DELIVERY_CONTACT",
      "/api/erp/jobs/delivery/contacts",
      { contactId },
      numberFromEnv(
        "MLD_QUEUE_CONTACT_TIMEOUT_MS",
        numberFromEnv("MLD_QUEUE_JOB_POLL_TIMEOUT_MS", DEFAULT_QUEUE_TIMEOUT_MS)
      )
    );
  }

  private async submitAndPollRows(
    jobType: string,
    submitPath: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ) {
    const submit = await this.queueRequest<QueueErpJobSubmitResponse>(submitPath, {
      method: "POST",
      body: payload,
    });

    if (!submit.jobId) {
      throw new Error(`Queue ERP job submit missing jobId jobType=${jobType} path=${submitPath}`);
    }

    const status = await this.pollJob(jobType, submit.jobId, timeoutMs);
    return rowsFromResult(status.result, jobType, submit.jobId);
  }

  private async pollJob(jobType: string, jobId: string, timeoutMs: number) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.queueRequest<QueueErpJobStatusResponse>(
        `/api/erp/jobs/${encodeURIComponent(jobId)}`,
        { method: "GET" }
      );

      if (status.status === "succeeded") {
        return status;
      }

      if (status.status === "failed") {
        throw new Error(
          `Queue ERP job failed jobType=${jobType} jobId=${jobId} error=${status.error || "unknown"}`
        );
      }

      if (status.status !== "queued" && status.status !== "processing") {
        throw new Error(
          `Queue ERP job returned unexpected status jobType=${jobType} jobId=${jobId} status=${String(status.status)}`
        );
      }

      await sleep(this.pollIntervalMs);
    }

    throw new Error(`Queue ERP job timeout jobType=${jobType} jobId=${jobId} timeoutMs=${timeoutMs}`);
  }

  private async queueRequest<T>(
    path: string,
    opts: { method: "GET" | "POST"; body?: unknown }
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: opts.method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
      cache: "no-store",
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Queue ERP request failed status=${response.status} path=${path} body=${text.slice(0, 500)}`
      );
    }

    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Queue ERP request returned non-JSON response path=${path}`);
    }
  }
}

export function createQueueErpClientFromEnv(): DeliveryErpClient {
  return new QueueErpClient();
}
