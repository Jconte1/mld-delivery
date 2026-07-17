export type DemoSendResult = {
  provider: "twilio" | "ms_graph";
  recipientEnvVar: "NOTIFICATIONS_TEST_PHONE" | "NOTIFICATIONS_TEST_EMAIL";
  ok: boolean;
  id?: string | null;
};

type DemoSmsInput = {
  toOverride: string;
  body: string;
};

type DemoEmailInput = {
  toOverride: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
};

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function requireEnv(name: string) {
  const value = envValue(name);
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function requireDemoSendEnabled() {
  if (envValue("DEMO_NOTIFICATION_SEND_ENABLED").toLowerCase() !== "true") {
    throw new Error("Refusing demo send: DEMO_NOTIFICATION_SEND_ENABLED must be true");
  }
}

function assertDemoRecipient(name: "NOTIFICATIONS_TEST_PHONE" | "NOTIFICATIONS_TEST_EMAIL", value: string) {
  const expected = requireEnv(name);
  if (value.trim() !== expected) {
    throw new Error(`Refusing demo send: recipient must match ${name}`);
  }
  return expected;
}

function htmlFromText(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
    )
    .join("<br />");
}

export function requireDemoSmsEnv() {
  requireDemoSendEnabled();
  requireEnv("NOTIFICATIONS_TEST_PHONE");
  requireEnv("TWILIO_ACCOUNT_SID");
  requireEnv("TWILIO_AUTH_TOKEN");
  if (!envValue("TWILIO_MESSAGING_SERVICE_SID") && !envValue("TWILIO_FROM_NUMBER")) {
    throw new Error(
      "Missing Twilio sender env var: TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER"
    );
  }
}

export function requireDemoEmailEnv() {
  requireDemoSendEnabled();
  requireEnv("NOTIFICATIONS_TEST_EMAIL");
  requireEnv("MS_GRAPH_TENANT_ID");
  requireEnv("MS_GRAPH_CLIENT_ID");
  requireEnv("MS_GRAPH_CLIENT_SECRET");
  requireEnv("MS_GRAPH_FROM_EMAIL");
}

async function getGraphAccessToken() {
  const tenantId = requireEnv("MS_GRAPH_TENANT_ID");
  const clientId = requireEnv("MS_GRAPH_CLIENT_ID");
  const clientSecret = requireEnv("MS_GRAPH_CLIENT_SECRET");

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("scope", "https://graph.microsoft.com/.default");
  body.set("grant_type", "client_credentials");

  const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph token failed: ${resp.status} ${text}`);
  }

  const json = (await resp.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Graph token missing access_token");
  }
  return json.access_token;
}

export async function sendDemoSms(input: DemoSmsInput): Promise<DemoSendResult> {
  requireDemoSmsEnv();

  const to = assertDemoRecipient("NOTIFICATIONS_TEST_PHONE", input.toOverride);
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const messagingServiceSid = envValue("TWILIO_MESSAGING_SERVICE_SID");
  const from = envValue("TWILIO_FROM_NUMBER");
  const body = new URLSearchParams();
  body.set("To", to);
  body.set("Body", input.body);
  if (messagingServiceSid) {
    body.set("MessagingServiceSid", messagingServiceSid);
  } else {
    body.set("From", from);
  }

  const resp = await fetch(
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

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Twilio demo SMS failed: ${resp.status} ${text}`);
  }

  const json = JSON.parse(text) as { sid?: string };
  console.log("[demo-notifications][sms] sent", {
    recipientEnvVar: "NOTIFICATIONS_TEST_PHONE",
    messageIdPresent: Boolean(json.sid),
  });
  return {
    provider: "twilio",
    recipientEnvVar: "NOTIFICATIONS_TEST_PHONE",
    ok: true,
    id: json.sid ?? null,
  };
}

export async function sendDemoEmail(input: DemoEmailInput): Promise<DemoSendResult> {
  requireDemoEmailEnv();

  const to = assertDemoRecipient("NOTIFICATIONS_TEST_EMAIL", input.toOverride);
  const fromEmail = requireEnv("MS_GRAPH_FROM_EMAIL");
  const token = await getGraphAccessToken();
  const payload = {
    message: {
      subject: input.subject,
      body: {
        contentType: "HTML",
        content: input.htmlBody ?? htmlFromText(input.textBody),
      },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };

  const resp = await fetch(
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

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph demo email failed: ${resp.status} ${text}`);
  }

  console.log("[demo-notifications][email] sent", {
    recipientEnvVar: "NOTIFICATIONS_TEST_EMAIL",
  });
  return { provider: "ms_graph", recipientEnvVar: "NOTIFICATIONS_TEST_EMAIL", ok: true };
}
