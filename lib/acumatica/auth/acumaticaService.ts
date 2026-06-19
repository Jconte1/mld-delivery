const acumaticaBaseUrl = process.env.ACUMATICA_BASE_URL;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
};

type TokenGrantType = "password" | "refresh_token";

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function redactTokenResponseBody(value: string) {
  return value
    .replace(/"(access_token|refresh_token)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/(access_token|refresh_token)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, 500);
}

function parseTokenResponse(text: string): TokenResponse {
  if (!text) {
    return {
      access_token: "",
      expires_in: 0,
      error: "empty_response",
      error_description: "Token endpoint returned an empty response",
    };
  }

  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    return {
      access_token: "",
      expires_in: 0,
      error: "invalid_response",
      error_description: redactTokenResponseBody(text),
    };
  }
}

class AcumaticaService {
  public readonly baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private username: string;
  private password: string;

  private accessToken: string | null;
  private refreshToken: string | null;
  private tokenExpiry: number | null;

  constructor(
    baseUrl: string | undefined,
    clientId: string,
    clientSecret: string,
    username: string,
    password: string
  ) {
    const resolvedBaseUrl = baseUrl || acumaticaBaseUrl || "";
    this.baseUrl = resolvedBaseUrl ? normalizeBaseUrl(resolvedBaseUrl) : "";
    if (!this.baseUrl) {
      throw new Error("ACUMATICA_BASE_URL is not set");
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.username = username;
    this.password = password;
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
  }

  async getToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const cachedToken = this.accessToken;
    if (!options.forceRefresh && cachedToken && this.isAccessTokenValid()) {
      return cachedToken;
    }

    if (this.refreshToken) {
      try {
        return await this.requestToken("refresh_token");
      } catch {
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;
      }
    }

    return this.requestToken("password");
  }

  invalidateAccessToken() {
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
  }

  private isAccessTokenValid() {
    return Boolean(
      this.accessToken &&
        this.tokenExpiry &&
        this.tokenExpiry - TOKEN_EXPIRY_BUFFER_MS > Date.now()
    );
  }

  private async requestToken(grantType: TokenGrantType): Promise<string> {
    const url = `${this.baseUrl}/identity/connect/token`;
    const body = new URLSearchParams({
      grant_type: grantType,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    if (grantType === "refresh_token" && this.refreshToken) {
      body.append("refresh_token", this.refreshToken);
    } else {
      body.append("username", this.username);
      body.append("password", this.password);
      body.append("scope", "api offline_access");
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const text = await response.text();
    const data = parseTokenResponse(text);

    if (!response.ok) {
      const message = data.error_description || data.error || "unknown token error";
      throw new Error(`Acumatica token request failed (${response.status}): ${message}`);
    }

    if (!data.access_token || typeof data.expires_in !== "number") {
      throw new Error("Acumatica token response did not include an access token and expiry");
    }

    this.accessToken = data.access_token;
    this.refreshToken =
      data.refresh_token ?? (grantType === "refresh_token" ? this.refreshToken : null);
    this.tokenExpiry = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }
}

export default AcumaticaService;
