const DEFAULT_TIMEOUT_MS = 285_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export type ThankYouQueueJobStatus = {
  jobId?: string;
  status?: "queued" | "processing" | "succeeded" | "failed";
  result?: unknown;
  error?: string | null;
};

function required(name: "MLD_QUEUE_BASE_URL" | "MLD_QUEUE_TOKEN") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function config() {
  const rawBaseUrl = required("MLD_QUEUE_BASE_URL").replace(/\/+$/, "");
  return {
    baseUrl: /^https?:\/\//i.test(rawBaseUrl) ? rawBaseUrl : `https://${rawBaseUrl}`,
    token: required("MLD_QUEUE_TOKEN"),
  };
}

async function request<T>(path: string, options: { method: "GET" | "POST"; body?: unknown }) {
  const { baseUrl, token } = config();
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Queue request failed status=${response.status} path=${path} body=${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function getThankYouQueueJob(jobId: string) {
  return request<ThankYouQueueJobStatus>(`/api/erp/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
  });
}

async function waitForJob(jobId: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const pollIntervalMs = Math.max(
    100,
    Number(process.env.MLD_QUEUE_JOB_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS)
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getThankYouQueueJob(jobId);
    if (job.status === "succeeded") return job;
    if (job.status === "failed") {
      throw new Error(`Queue job failed jobId=${jobId} error=${job.error || "unknown"}`);
    }
    if (job.status !== "queued" && job.status !== "processing") {
      throw new Error(`Queue job returned unexpected status jobId=${jobId} status=${String(job.status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Queue job timeout jobId=${jobId} timeoutMs=${timeoutMs}`);
}

export async function fetchThankYouReportRows() {
  const submitted = await request<{ jobId?: string }>("/api/erp/jobs/reports/thank-you", {
    method: "POST",
    body: {},
  });
  if (!submitted.jobId) throw new Error("Thank-you report queue submit did not return jobId");
  const completed = await waitForJob(submitted.jobId);
  const result = completed.result as { rows?: unknown[] } | null | undefined;
  if (!Array.isArray(result?.rows)) {
    throw new Error(`Thank-you report queue result is missing rows jobId=${submitted.jobId}`);
  }
  return { jobId: submitted.jobId, rows: result.rows };
}

export async function enqueueThankYouWriteback(orderType: string, orderNumber: string) {
  const submitted = await request<{ jobId?: string }>("/api/erp/jobs/thank-you/mark-sent", {
    method: "POST",
    body: { orderType, orderNbr: orderNumber },
  });
  if (!submitted.jobId) throw new Error("Thank-you writeback queue submit did not return jobId");
  return { jobId: submitted.jobId };
}
