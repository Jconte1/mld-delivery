export const CONTACT_OPT_IN_WRITEBACK_ROUTE =
  "/api/erp/jobs/delivery/contact-opt-in-attributes";
export const DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN_ENV =
  "DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN";
const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;

type QueueFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ContactOptInWritebackPayload = {
  contactId: string;
  smsOptIn?: false;
  emailOptIn?: false;
  phoneCallOptIn?: false;
  source: string;
  reason: string;
  dryRun: boolean;
};

export type EnqueueContactOptInWritebackParams = {
  contactId: string;
  smsOptIn?: false;
  emailOptIn?: false;
  phoneCallOptIn?: false;
  source: string;
  reason: string;
  dryRun?: boolean;
};

export type EnqueueContactOptInWritebackOptions = {
  baseUrl?: string;
  token?: string;
  fetchImpl?: QueueFetch;
  timeoutMs?: number;
};

export type EnqueueContactOptInWritebackResult = {
  jobId: string;
  payload: ContactOptInWritebackPayload;
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

function enqueueTimeoutMs(override?: number) {
  if (override && Number.isFinite(override) && override > 0) return override;

  const raw = process.env.MLD_QUEUE_CONTACT_OPT_IN_WRITEBACK_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ENQUEUE_TIMEOUT_MS;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ENQUEUE_TIMEOUT_MS;
}

function falseOnly(value: false | undefined, key: string) {
  if (value === undefined) return undefined;
  if (value !== false) {
    throw new Error(`${key} must be exactly false`);
  }
  return false as const;
}

function shouldDryRunContactOptInWriteback() {
  const dryRunOverride = process.env[DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN_ENV]
    ?.trim()
    .toLowerCase();

  return dryRunOverride === "true";
}

export function buildContactOptInWritebackPayload(
  params: EnqueueContactOptInWritebackParams
): ContactOptInWritebackPayload {
  const contactId = clean(params.contactId);
  const source = clean(params.source);
  const reason = clean(params.reason);
  if (!contactId) throw new Error("contactId is required");
  if (!source) throw new Error("source is required");
  if (!reason) throw new Error("reason is required");

  const payload: ContactOptInWritebackPayload = {
    contactId,
    source,
    reason,
    dryRun: params.dryRun ?? shouldDryRunContactOptInWriteback(),
  };

  const smsOptIn = falseOnly(params.smsOptIn, "smsOptIn");
  if (smsOptIn === false) payload.smsOptIn = false;
  const emailOptIn = falseOnly(params.emailOptIn, "emailOptIn");
  if (emailOptIn === false) payload.emailOptIn = false;
  const phoneCallOptIn = falseOnly(params.phoneCallOptIn, "phoneCallOptIn");
  if (phoneCallOptIn === false) payload.phoneCallOptIn = false;

  if (
    payload.smsOptIn !== false &&
    payload.emailOptIn !== false &&
    payload.phoneCallOptIn !== false
  ) {
    throw new Error("At least one opt-in field must be supplied and must be exactly false");
  }

  return payload;
}

export async function enqueueContactOptInWriteback(
  params: EnqueueContactOptInWritebackParams,
  options: EnqueueContactOptInWritebackOptions = {}
): Promise<EnqueueContactOptInWritebackResult> {
  const baseUrl = normalizeBaseUrl(requiredConfig("MLD_QUEUE_BASE_URL", options.baseUrl));
  const token = requiredConfig("MLD_QUEUE_TOKEN", options.token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = buildContactOptInWritebackPayload(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), enqueueTimeoutMs(options.timeoutMs));

  const response = await fetchImpl(`${baseUrl}${CONTACT_OPT_IN_WRITEBACK_ROUTE}`, {
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
      `Contact opt-in writeback enqueue failed status=${response.status} body=${text.slice(0, 500)}`
    );
  }

  const result = (text ? JSON.parse(text) : {}) as { jobId?: string };
  if (!result.jobId) {
    throw new Error("Contact opt-in writeback enqueue response missing jobId");
  }

  return {
    jobId: result.jobId,
    payload,
  };
}
