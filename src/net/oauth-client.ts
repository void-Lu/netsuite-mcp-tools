import { createHash, randomBytes } from "node:crypto";
import { ConnectionProfile, NetSuiteEndpoints, NetSuiteMcpError, TokenValue } from "../domain/types";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 64;

export interface AccessTokenWithMetadata {
  accessToken: string;
  httpStatus: number;
}

export interface AuthorizationRequest {
  authorizationUrl: string;
  completion: Promise<AccessTokenWithMetadata>;
}

export interface AuthorizationCallbackResult {
  statusCode: number;
  message: string;
}

export type AuthorizationBrowserOpener = (authorizationUrl: string) => Promise<boolean>;

interface PendingAuthorization {
  state: string;
  profileId: string;
  clientId: string;
  tokenUrl: string;
  redirectUri: string;
  verifier: string;
  completion: Promise<TokenValue>;
  resolve: (token: TokenValue) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  handling: boolean;
}

/**
 * Public-client OAuth adapter. It deliberately owns all volatile credentials in
 * memory: PKCE verifier/state, access token and refresh token are never
 * returned to callers other than the local proxy and are never persisted.
 */
export class OAuthClient {
  private readonly cache = new Map<string, TokenValue>();
  private readonly inFlight = new Map<string, Promise<TokenValue>>();
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();

  public constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  public async getAccessToken(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<string> {
    return (await this.getAccessTokenValue(profile, endpoints)).accessToken;
  }

  /**
   * 健康检查需要 token 阶段的 HTTP 状态，但不得接触或记录 token 响应正文。
   */
  public async getAccessTokenWithMetadata(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<AccessTokenWithMetadata> {
    const token = await this.getAccessTokenValue(profile, endpoints);
    return { accessToken: token.accessToken, httpStatus: token.httpStatus };
  }

  public async authorize(
    profile: ConnectionProfile,
    endpoints: NetSuiteEndpoints,
    redirectUri: string,
    openBrowser: AuthorizationBrowserOpener
  ): Promise<AccessTokenWithMetadata> {
    const request = this.beginAuthorization(profile, endpoints, redirectUri);
    try {
      if (!await openBrowser(request.authorizationUrl)) {
        this.rejectAuthorization(request.authorizationUrl, new NetSuiteMcpError(
          "authorization-browser-not-opened",
          "无法打开本机浏览器以完成 NetSuite 授权。请检查默认浏览器后重试。"
        ));
      }
      return await request.completion;
    } catch (error) {
      this.rejectAuthorization(request.authorizationUrl, error instanceof Error ? error : new Error("OAuth 授权未完成。"));
      throw error;
    }
  }

  public beginAuthorization(profile: ConnectionProfile, endpoints: NetSuiteEndpoints, redirectUri: string): AuthorizationRequest {
    const clientId = requireClientId(profile);
    assertLoopbackRedirectUri(redirectUri);
    this.invalidate(profile.id);

    const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const authorizationUrl = new URL(endpoints.authorizationUrl);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "mcp",
      state,
      code_challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
      code_challenge_method: "S256"
    }).toString();

    let resolveCompletion!: (token: TokenValue) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<TokenValue>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const pending: PendingAuthorization = {
      state,
      profileId: profile.id,
      clientId,
      tokenUrl: endpoints.tokenUrl,
      redirectUri,
      verifier,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timeout: undefined as unknown as NodeJS.Timeout,
      handling: false
    };
    pending.timeout = setTimeout(() => {
      this.settleAuthorization(pending, new NetSuiteMcpError(
        "authorization-timed-out",
        "等待 NetSuite 浏览器授权超时。请重新开始测试连接。"
      ));
    }, AUTHORIZATION_TIMEOUT_MS);
    this.pendingAuthorizations.set(state, pending);

    return {
      authorizationUrl: authorizationUrl.toString(),
      completion: completion.then((token) => ({ accessToken: token.accessToken, httpStatus: token.httpStatus }))
    };
  }

  /**
   * 由仅监听 127.0.0.1 的本机 HTTP 服务器调用。state 是唯一的 callback
   * 关联键；任何未知、过期或重复 callback 都不会触发 token 请求。
   */
  public async completeAuthorizationCallback(callbackUrl: URL): Promise<AuthorizationCallbackResult> {
    const state = callbackUrl.searchParams.get("state");
    if (!state) {
      return { statusCode: 400, message: "缺少 OAuth state，无法完成授权。" };
    }
    const pending = this.pendingAuthorizations.get(state);
    if (!pending || pending.handling) {
      return { statusCode: 400, message: "OAuth 授权已过期、无效或已完成。请返回 VS Code 重新开始。" };
    }
    pending.handling = true;

    if (callbackUrl.searchParams.has("error")) {
      this.settleAuthorization(pending, new NetSuiteMcpError(
        "authorization-denied",
        "NetSuite 未授予授权。请检查 Integration、Role 和 AI Connector 权限后重试。"
      ));
      return { statusCode: 400, message: "NetSuite 未授予授权。可关闭此页面并返回 VS Code。" };
    }
    const code = callbackUrl.searchParams.get("code");
    if (!code) {
      this.settleAuthorization(pending, new NetSuiteMcpError("authorization-code-missing", "NetSuite 未返回授权码。请重新开始授权。"));
      return { statusCode: 400, message: "NetSuite 未返回授权码。可关闭此页面并返回 VS Code。" };
    }

    try {
      const token = await this.exchangeAuthorizationCode(pending, code);
      this.cache.set(pending.profileId, token);
      this.settleAuthorization(pending, token);
      return { statusCode: 200, message: "NetSuite 授权完成。请关闭此页面并返回 VS Code。" };
    } catch (error) {
      this.settleAuthorization(pending, error instanceof Error ? error : new Error("NetSuite token 请求失败。"));
      return { statusCode: 500, message: "NetSuite 授权未完成。请返回 VS Code 查看错误后重试。" };
    }
  }

  /** 使 access token 立即过期，但保留仅内存 refresh token 以完成一次安全刷新。 */
  public invalidateAccessToken(profileId: string): void {
    const cached = this.cache.get(profileId);
    if (cached) {
      this.cache.set(profileId, { ...cached, expiresAt: 0 });
    }
  }

  public invalidate(profileId: string): void {
    this.cache.delete(profileId);
  }

  public clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    for (const pending of this.pendingAuthorizations.values()) {
      this.settleAuthorization(pending, new NetSuiteMcpError("authorization-cancelled", "VS Code 已关闭，NetSuite 授权已取消。"));
    }
  }

  /** 仅用于状态栏判定：profile 是否在当前会话中持有内存 token（不含 refresh 刷新能力判断）。 */
  public hasActiveSession(profileId: string): boolean {
    return this.cache.has(profileId);
  }

  private async getAccessTokenValue(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<TokenValue> {
    const cached = this.cache.get(profile.id);
    if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return cached;
    }
    const request = this.inFlight.get(profile.id) ?? this.refreshOrRequireAuthorization(profile, endpoints, cached);
    this.inFlight.set(profile.id, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(profile.id);
    }
  }

  private async refreshOrRequireAuthorization(
    profile: ConnectionProfile,
    endpoints: NetSuiteEndpoints,
    cached: TokenValue | undefined
  ): Promise<TokenValue> {
    if (!cached?.refreshToken) {
      throw new NetSuiteMcpError(
        "authorization-required",
        "尚未在本次 VS Code 会话中授权 NetSuite。请运行“NetSuite MCP：测试连接”并在浏览器中完成登录。"
      );
    }
    const clientId = requireClientId(profile);
    const token = await this.requestToken(endpoints.tokenUrl, new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cached.refreshToken,
      client_id: clientId
    }), true);
    // NetSuite refresh token 为一次性使用：只在完整、有效的响应解析后替换整个内存条目。
    this.cache.set(profile.id, token);
    return token;
  }

  private async exchangeAuthorizationCode(pending: PendingAuthorization, code: string): Promise<TokenValue> {
    return this.requestToken(pending.tokenUrl, new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier
    }), true);
  }

  private async requestToken(tokenUrl: string, body: URLSearchParams, requireRefreshToken: boolean): Promise<TokenValue> {
    let response: Response;
    try {
      response = await this.fetchImplementation(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json"
        },
        body
      });
    } catch (error) {
      throw new NetSuiteMcpError("token-network-error", "无法连接 NetSuite token 端点。请检查网络、accountId 与 DNS。", error);
    }
    if (!response.ok) {
      throw new NetSuiteMcpError(
        "token-request-rejected",
        `NetSuite 拒绝 token 请求（HTTP ${response.status}）。请核对 Public Client Integration、Redirect URI、AI Connector Service scope 与 Role。`,
        undefined,
        response.status
      );
    }
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch (error) {
      throw new NetSuiteMcpError("token-response-invalid", "NetSuite token 响应未包含有效 access_token。", error, response.status);
    }
    if (!isTokenResponse(payload, requireRefreshToken)) {
      throw new NetSuiteMcpError("token-response-invalid", "NetSuite token 响应未包含有效 access_token。", undefined, response.status);
    }
    return {
      accessToken: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
      refreshToken: payload.refresh_token,
      httpStatus: response.status
    };
  }

  private settleAuthorization(pending: PendingAuthorization, result: TokenValue | Error): void {
    if (!this.pendingAuthorizations.delete(pending.state)) {
      return;
    }
    clearTimeout(pending.timeout);
    if (result instanceof Error) {
      pending.reject(result);
    } else {
      pending.resolve(result);
    }
  }

  private rejectAuthorization(authorizationUrl: string, error: Error): void {
    const state = new URL(authorizationUrl).searchParams.get("state");
    if (!state) {
      return;
    }
    const pending = this.pendingAuthorizations.get(state);
    if (pending) {
      this.settleAuthorization(pending, error);
    }
  }
}

function requireClientId(profile: ConnectionProfile): string {
  const clientId = profile.clientId?.trim();
  if (!clientId) {
    throw new NetSuiteMcpError("profile-not-registered", "连接档案尚未录入 NetSuite Public Client ID。");
  }
  return clientId;
}

function assertLoopbackRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new NetSuiteMcpError("invalid-redirect-uri", "本机 OAuth Redirect URI 无效。", error);
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/oauth/callback" || !url.port || url.username || url.password || url.search || url.hash) {
    throw new NetSuiteMcpError("invalid-redirect-uri", "OAuth Redirect URI 必须是 http://127.0.0.1:<port>/oauth/callback。");
  }
}

function isTokenResponse(value: unknown, requireRefreshToken: boolean): value is { access_token: string; expires_in?: number; refresh_token?: string } {
  return typeof value === "object" && value !== null &&
    "access_token" in value && typeof value.access_token === "string" &&
    (!("expires_in" in value) || typeof value.expires_in === "number") &&
    (!("refresh_token" in value) || typeof value.refresh_token === "string") &&
    (!requireRefreshToken || ("refresh_token" in value && typeof value.refresh_token === "string"));
}
