import twilio from "twilio";

export type TwilioFormPayload = Record<string, string>;

const SIGNATURE_HEADER = "x-twilio-signature";
const VALIDATE_SIGNATURES_ENV = "TWILIO_WEBHOOK_VALIDATE_SIGNATURES";
const AUTH_TOKEN_ENV = "TWILIO_AUTH_TOKEN";
const DELIVERY_APP_BASE_URL_ENV = "DELIVERY_APP_BASE_URL";

export async function readTwilioFormPayload(request: Request): Promise<TwilioFormPayload> {
  const formData = await request.formData();
  const payload: TwilioFormPayload = {};

  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      payload[key] = value;
    }
  }

  return payload;
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function externalWebhookUrl(request: Request) {
  const configuredBaseUrl = process.env[DELIVERY_APP_BASE_URL_ENV]?.trim();
  const requestUrl = new URL(request.url);

  if (configuredBaseUrl) {
    return `${normalizeBaseUrl(configuredBaseUrl)}${requestUrl.pathname}`;
  }

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");

  if (host) {
    return `${forwardedProto || requestUrl.protocol.replace(":", "")}://${host}${requestUrl.pathname}`;
  }

  return requestUrl.toString();
}

export function shouldValidateTwilioWebhookSignatures() {
  const configured = process.env[VALIDATE_SIGNATURES_ENV]?.trim().toLowerCase();
  if (configured === "false") return false;
  if (configured === "0") return false;
  if (configured === "no") return false;
  return true;
}

export function validateTwilioWebhookSignature(params: {
  request: Request;
  payload: TwilioFormPayload;
}) {
  if (!shouldValidateTwilioWebhookSignatures()) {
    return { valid: true, skipped: true };
  }

  const authToken = process.env[AUTH_TOKEN_ENV]?.trim();
  if (!authToken) {
    return { valid: false, skipped: false, reason: `Missing env var: ${AUTH_TOKEN_ENV}` };
  }

  const signature = params.request.headers.get(SIGNATURE_HEADER);
  if (!signature) {
    return { valid: false, skipped: false, reason: "Missing Twilio signature header" };
  }

  const webhookUrl = externalWebhookUrl(params.request);
  const valid = twilio.validateRequest(authToken, signature, webhookUrl, params.payload);
  return { valid, skipped: false, reason: valid ? null : "Invalid Twilio signature" };
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function twimlResponse(message: string | null | undefined, status = 200) {
  const body = message
    ? `<Response><Message>${escapeXml(message)}</Message></Response>`
    : "<Response></Response>";

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
}
