export type DeliveryNotificationProviderName = "twilio" | "ms_graph";

export type DeliveryNotificationProviderResult = {
  provider: DeliveryNotificationProviderName;
  externalMessageId: string | null;
  providerCode: string | null;
  httpStatus: number | null;
  raw?: Record<string, unknown> | null;
};

export type DeliveryNotificationProvider = {
  sendSms(input: {
    to: string;
    body: string;
    statusCallbackUrl: string;
  }): Promise<DeliveryNotificationProviderResult>;
  sendEmail(input: {
    to: string;
    subject: string;
    textBody: string;
    htmlBody?: string | null;
  }): Promise<DeliveryNotificationProviderResult>;
};

export class DeliveryNotificationProviderError extends Error {
  readonly provider: DeliveryNotificationProviderName;
  readonly providerCode: string | null;
  readonly httpStatus: number | null;
  readonly externalMessageId: string | null;

  constructor(params: {
    provider: DeliveryNotificationProviderName;
    message: string;
    providerCode?: string | null;
    httpStatus?: number | null;
    externalMessageId?: string | null;
  }) {
    super(params.message);
    this.name = "DeliveryNotificationProviderError";
    this.provider = params.provider;
    this.providerCode = params.providerCode ?? null;
    this.httpStatus = params.httpStatus ?? null;
    this.externalMessageId = params.externalMessageId ?? null;
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string) {
  return env[name]?.trim() ?? "";
}

function requireEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = envValue(env, name);
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function safeErrorText(value: string) {
  return value.replace(/\s+/g, " ").slice(0, 1000);
}

async function graphAccessToken(env: NodeJS.ProcessEnv) {
  const tenantId = requireEnv(env, "MS_GRAPH_TENANT_ID");
  const clientId = requireEnv(env, "MS_GRAPH_CLIENT_ID");
  const clientSecret = requireEnv(env, "MS_GRAPH_CLIENT_SECRET");
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("scope", "https://graph.microsoft.com/.default");
  body.set("grant_type", "client_credentials");

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new DeliveryNotificationProviderError({
      provider: "ms_graph",
      httpStatus: response.status,
      providerCode: "TOKEN_REQUEST_FAILED",
      message: `Graph token request failed: ${response.status} ${safeErrorText(text)}`,
    });
  }

  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) {
    throw new DeliveryNotificationProviderError({
      provider: "ms_graph",
      httpStatus: response.status,
      providerCode: "TOKEN_MISSING",
      message: "Graph token response did not include access_token",
    });
  }
  return json.access_token;
}

export function buildTwilioStatusCallbackUrl(env: NodeJS.ProcessEnv = process.env) {
  const baseUrl = requireEnv(env, "DELIVERY_APP_BASE_URL").replace(/\/+$/, "");
  return `${baseUrl}/api/webhooks/twilio/message-status`;
}

export function createDeliveryNotificationProvider(
  env: NodeJS.ProcessEnv = process.env
): DeliveryNotificationProvider {
  return {
    async sendSms(input) {
      const accountSid = requireEnv(env, "TWILIO_ACCOUNT_SID");
      const authToken = requireEnv(env, "TWILIO_AUTH_TOKEN");
      const messagingServiceSid = envValue(env, "TWILIO_MESSAGING_SERVICE_SID");
      const from = envValue(env, "TWILIO_FROM_NUMBER");
      if (!messagingServiceSid && !from) {
        throw new Error("Missing Twilio sender env var: TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER");
      }

      const body = new URLSearchParams();
      body.set("To", input.to);
      body.set("Body", input.body);
      body.set("StatusCallback", input.statusCallbackUrl);
      if (messagingServiceSid) {
        body.set("MessagingServiceSid", messagingServiceSid);
      } else {
        body.set("From", from);
      }

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        }
      );
      const text = await response.text();
      if (!response.ok) {
        throw new DeliveryNotificationProviderError({
          provider: "twilio",
          httpStatus: response.status,
          providerCode: "SEND_FAILED",
          message: `Twilio SMS send failed: ${response.status} ${safeErrorText(text)}`,
        });
      }

      const json = JSON.parse(text) as {
        sid?: string;
        status?: string;
        error_code?: string | null;
      };
      return {
        provider: "twilio",
        externalMessageId: json.sid ?? null,
        providerCode: json.error_code ? String(json.error_code) : json.status ?? "accepted",
        httpStatus: response.status,
        raw: {
          sidPresent: Boolean(json.sid),
          status: json.status ?? null,
          errorCode: json.error_code ?? null,
        },
      };
    },

    async sendEmail(input) {
      const fromEmail = requireEnv(env, "MS_GRAPH_FROM_EMAIL");
      const token = await graphAccessToken(env);
      const payload = {
        message: {
          subject: input.subject,
          body: {
            contentType: input.htmlBody ? "HTML" : "Text",
            content: input.htmlBody ?? input.textBody,
          },
          toRecipients: [{ emailAddress: { address: input.to } }],
        },
        saveToSentItems: true,
      };

      const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );
      const text = await response.text();
      if (!response.ok) {
        throw new DeliveryNotificationProviderError({
          provider: "ms_graph",
          httpStatus: response.status,
          providerCode: "SEND_FAILED",
          message: `Graph email send failed: ${response.status} ${safeErrorText(text)}`,
        });
      }

      return {
        provider: "ms_graph",
        externalMessageId: response.headers.get("request-id"),
        providerCode: "accepted",
        httpStatus: response.status,
        raw: {
          requestIdPresent: Boolean(response.headers.get("request-id")),
        },
      };
    },
  };
}
