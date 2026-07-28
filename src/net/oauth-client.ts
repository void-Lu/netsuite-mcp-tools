import { constants, createPrivateKey, sign } from "node:crypto";
import { ConnectionProfile, NetSuiteEndpoints, NetSuiteMcpError, TokenValue } from "../domain/types";
import { CertificateService } from "../security/certificate-service";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const CLIENT_ASSERTION_LIFETIME_SECONDS = 120;

export class OAuthClient {
  private readonly cache = new Map<string, TokenValue>();
  private readonly inFlight = new Map<string, Promise<TokenValue>>();

  public constructor(
    private readonly certificateService: CertificateService,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  public async getAccessToken(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<string> {
    const cached = this.cache.get(profile.id);
    if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }
    const request = this.inFlight.get(profile.id) ?? this.fetchToken(profile, endpoints);
    this.inFlight.set(profile.id, request);
    try {
      return (await request).accessToken;
    } finally {
      this.inFlight.delete(profile.id);
    }
  }

  public invalidate(profileId: string): void {
    this.cache.delete(profileId);
  }

  public async createClientAssertion(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<string> {
    if (!profile.clientId || !profile.certificateId) {
      throw new NetSuiteMcpError("profile-not-registered", "连接档案尚未录入 NetSuite Client ID 和 Certificate ID。");
    }
    const privateKeyPem = await this.certificateService.readPrivateKey(profile);
    const now = Math.floor(Date.now() / 1000);
    const header = { typ: "JWT", alg: "PS256", kid: profile.certificateId };
    const payload = {
      iss: profile.clientId,
      scope: ["rest_webservices"],
      aud: endpoints.tokenUrl,
      iat: now,
      exp: now + CLIENT_ASSERTION_LIFETIME_SECONDS
    };
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
    const signature = sign("sha256", Buffer.from(signingInput, "utf8"), {
      key: createPrivateKey(privateKeyPem),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST
    });
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  private async fetchToken(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<TokenValue> {
    const assertion = await this.createClientAssertion(profile, endpoints);
    let response: Response;
    try {
      response = await this.fetchImplementation(endpoints.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json"
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion
        })
      });
    } catch (error) {
      throw new NetSuiteMcpError("token-network-error", "无法连接 NetSuite token 端点。请检查网络、accountId 与 DNS。", error);
    }
    if (!response.ok) {
      throw new NetSuiteMcpError("token-request-rejected", `NetSuite 拒绝 token 请求（HTTP ${response.status}）。请核对 Integration、M2M 映射、Client ID、Certificate ID 与 Role。`);
    }
    const payload = await response.json() as unknown;
    if (!isTokenResponse(payload)) {
      throw new NetSuiteMcpError("token-response-invalid", "NetSuite token 响应未包含有效 access_token。");
    }
    const token = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000
    };
    this.cache.set(profile.id, token);
    return token;
  }
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function isTokenResponse(value: unknown): value is { access_token: string; expires_in?: number } {
  return typeof value === "object" && value !== null &&
    "access_token" in value && typeof value.access_token === "string" &&
    (!("expires_in" in value) || typeof value.expires_in === "number");
}
