import { createHash, randomBytes } from "node:crypto";
import { ConnectionProfile, NetSuiteEndpoints, NetSuiteMcpError, TokenValue } from "../domain/types";
import { redactIdentifier } from "../util/redaction";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 64;

export interface AccessTokenWithMetadata {
  accessToken: string;
  /** Absent when the token was restored from secret storage. Never invent a status. */
  httpStatus: number | null;
}

/** Profile-scoped secret store. Callers assemble the storage key; this client never sees it. */
export interface TokenSecretStore {
  get(profileId: string): Promise<string | undefined>;
  set(profileId: string, value: string): Promise<void>;
  delete(profileId: string): Promise<void>;
}

export interface TokenSecretLogger {
  warn(event: string, fields?: Record<string, unknown>): void | Promise<void>;
}

export interface PersistedToken {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
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
  generation: number;
}

/**
 * Public-client OAuth adapter. PKCE verifier and state stay in memory. Access
 * and refresh tokens are returned only to the local proxy, and are never written
 * to files or logs. An injected secret store may persist the token triple.
 */
export class OAuthClient {
  private readonly cache = new Map<string, TokenValue>();
  private readonly inFlight = new Map<string, Promise<TokenValue>>();
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();
  private readonly generation = new Map<string, number>();
  private readonly secretTails = new Map<string, Promise<unknown>>();

  public constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly tokenStore?: TokenSecretStore,
    private readonly tokenLogger?: TokenSecretLogger
  ) {}

  public async getAccessToken(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<string> {
    return (await this.getAccessTokenValue(profile, endpoints)).accessToken;
  }

  /**
   * 健康检查需要 token 阶段的 HTTP 状态，但不得接触或记录 token 响应正文。
   */
  public async getAccessTokenWithMetadata(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<AccessTokenWithMetadata> {
    const token = await this.getAccessTokenValue(profile, endpoints);
    return { accessToken: token.accessToken, httpStatus: token.httpStatus ?? null };
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

    // 清理同 profileId 的旧 pending authorization，避免连续点击"重新授权"产生竞态
    for (const [, pending] of this.pendingAuthorizations) {
      if (pending.profileId === profile.id) {
        this.settleAuthorization(pending, new NetSuiteMcpError(
          "authorization-superseded",
          "已开始新的授权流程，之前的授权已被取代。"
        ));
      }
    }

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
      handling: false,
      generation: this.currentGeneration(profile.id)
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
      completion: completion.then((token) => ({ accessToken: token.accessToken, httpStatus: token.httpStatus ?? null }))
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
      if (!await this.rememberIfAuthorized(pending, token)) {
        return { statusCode: 400, message: "OAuth 授权已取消。请返回 VS Code 重新开始。" };
      }
      this.settleAuthorization(pending, token);
      return { statusCode: 200, message: "NetSuite 授权完成。请关闭此页面并返回 VS Code。" };
    } catch (error) {
      this.settleAuthorization(pending, error instanceof Error ? error : new Error("NetSuite token 请求失败。"));
      return { statusCode: 500, message: "NetSuite 授权未完成。请返回 VS Code 查看错误后重试。" };
    }
  }

  /**
   * 只使本次请求使用的 access token 过期。已轮换的新凭据保持不变。
   * refresh token 保留，供下一次独立请求刷新。不删除凭据。
   */
  public async invalidateAccessToken(profileId: string, accessToken: string): Promise<void> {
    await this.exclusive(profileId, async () => {
      const cached = this.cache.get(profileId);
      if (cached?.accessToken === accessToken) {
        this.cache.set(profileId, { ...cached, expiresAt: 0 });
      }
      if (!this.tokenStore) {
        return;
      }
      let raw: string | undefined;
      try {
        raw = await this.tokenStore.get(profileId);
      } catch {
        await this.note("token_secret_read_failed", profileId);
        return;
      }
      const parsed = raw === undefined ? undefined : parsePersistedToken(raw);
      if (!parsed || parsed.accessToken !== accessToken) {
        return;
      }
      try {
        await this.tokenStore.set(profileId, serializePersistedToken({ ...parsed, expiresAt: 0 }));
      } catch {
        await this.note("token_persist_failed", profileId);
      }
    });
  }

  /** 只清内存。断开和删除档案要先成功调用 deleteStoredToken。 */
  public invalidate(profileId: string): void {
    this.cache.delete(profileId);
  }

  /** 删除已保存凭据，并作废此前开始的写入。本来就没有视为成功。读取或删除失败则抛出，且不清除仍可用的内存会话。 */
  public async deleteStoredToken(profileId: string): Promise<void> {
    await this.exclusive(profileId, async () => {
      if (this.tokenStore) {
        const existing = await this.tokenStore.get(profileId);
        if (existing !== undefined) {
          await this.tokenStore.delete(profileId);
        }
      }
      this.bumpGeneration(profileId);
      this.cache.delete(profileId);
      this.cancelPending(profileId, new NetSuiteMcpError("authorization-cancelled", "连接已断开，未完成的授权已取消。"));
    });
  }

  /**
   * 关闭时只清内存缓存和未完成的 PKCE。不删除凭据，不降级档案。
   * 已进入换票的授权在保存前会发现 pending 已取消，因此不会写回。
   */
  public async clear(): Promise<void> {
    this.cache.clear();
    this.inFlight.clear();
    const pending = [...this.pendingAuthorizations.values()];
    await Promise.all(pending.map((item) => this.exclusive(item.profileId, async () => {
      this.settleAuthorization(item, new NetSuiteMcpError("authorization-cancelled", "VS Code 已关闭，NetSuite 授权已取消。"));
    })));
  }

  /**
   * 只在 initialize 调用一次。不读凭据库的路径仍是内存缓存。
   * 读取失败保留凭据并跳过；损坏、无 refresh 或刷新失败则删除凭据。不打开浏览器。
   */
  public async restorePersistedSession(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<boolean> {
    if (!this.tokenStore) {
      return false;
    }
    const generation = this.currentGeneration(profile.id);
    let raw: string | undefined;
    try {
      raw = await this.tokenStore.get(profile.id);
    } catch {
      await this.note("token_secret_read_failed", profile.id);
      return false;
    }
    if (raw === undefined) {
      return false;
    }
    const parsed = parsePersistedToken(raw);
    if (!parsed) {
      if (generation === this.currentGeneration(profile.id)) {
        await this.deleteStoredBestEffort(profile.id);
      }
      return false;
    }
    if (tokenReusable(parsed.expiresAt)) {
      await this.exclusive(profile.id, async () => {
        if (generation !== this.currentGeneration(profile.id)) {
          return;
        }
        this.cache.set(profile.id, {
          accessToken: parsed.accessToken,
          expiresAt: parsed.expiresAt,
          refreshToken: parsed.refreshToken
        });
      });
      return this.hasActiveSession(profile.id);
    }
    if (!parsed.refreshToken) {
      if (generation === this.currentGeneration(profile.id)) {
        await this.deleteStoredBestEffort(profile.id);
      }
      return false;
    }
    try {
      await this.refreshStored(profile, endpoints, parsed.refreshToken, generation);
      return generation === this.currentGeneration(profile.id) && this.hasActiveSession(profile.id);
    } catch {
      if (generation === this.currentGeneration(profile.id)) {
        await this.deleteStoredBestEffort(profile.id);
      }
      return false;
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
    return this.refreshStored(profile, endpoints, cached.refreshToken);
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

  /** NetSuite refresh token 一次性使用：只在完整响应解析后整包替换并写入凭据。 */
  private async refreshStored(
    profile: ConnectionProfile,
    endpoints: NetSuiteEndpoints,
    refreshToken: string,
    generation = this.currentGeneration(profile.id)
  ): Promise<TokenValue> {
    const token = await this.requestToken(endpoints.tokenUrl, new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: requireClientId(profile)
    }), true);
    await this.remember(profile.id, token, generation);
    return token;
  }

  private async remember(profileId: string, token: TokenValue, generation: number): Promise<void> {
    await this.exclusive(profileId, async () => {
      if (generation !== this.currentGeneration(profileId)) {
        return;
      }
      await this.writeToken(profileId, token);
    });
  }

  /** Saves only while this browser authorization is still the active pending exchange. */
  private async rememberIfAuthorized(pending: PendingAuthorization, token: TokenValue): Promise<boolean> {
    return this.exclusive(pending.profileId, async () => {
      if (!this.pendingAuthorizations.has(pending.state) || pending.generation !== this.currentGeneration(pending.profileId)) {
        return false;
      }
      await this.writeToken(pending.profileId, token);
      return true;
    });
  }

  private async writeToken(profileId: string, token: TokenValue): Promise<void> {
    this.cache.set(profileId, token);
    if (!this.tokenStore) {
      return;
    }
    try {
      await this.tokenStore.set(profileId, serializePersistedToken(token));
    } catch {
      await this.note("token_persist_failed", profileId);
    }
  }

  private cancelPending(profileId: string, error: Error): void {
    for (const pending of [...this.pendingAuthorizations.values()]) {
      if (pending.profileId === profileId) {
        this.settleAuthorization(pending, error);
      }
    }
  }

  private async deleteStoredBestEffort(profileId: string): Promise<void> {
    try {
      await this.tokenStore?.delete(profileId);
    } catch {
      await this.note("token_secret_delete_failed", profileId);
    }
  }

  private async note(event: string, profileId: string): Promise<void> {
    try {
      await this.tokenLogger?.warn(event, { profileId: redactIdentifier(profileId) });
    } catch {
      // 诊断失败不能改变会话或授权结果。
    }
  }

  private currentGeneration(profileId: string): number {
    return this.generation.get(profileId) ?? 0;
  }

  private bumpGeneration(profileId: string): void {
    this.generation.set(profileId, this.currentGeneration(profileId) + 1);
  }

  /** Serializes secret read-modify-write so a stale 401 cannot overwrite a newer refresh. */
  private async exclusive<T>(profileId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.secretTails.get(profileId) ?? Promise.resolve();
    const run = previous.then(action, action);
    this.secretTails.set(profileId, run.then(() => undefined, () => undefined));
    return run;
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

const TOKEN_SECRET_FIELDS = new Set(["accessToken", "expiresAt", "refreshToken"]);

export function tokenSecretKey(workspaceId: string, profileId: string): string {
  return `netsuite-mcp.token.v1.${workspaceId}.${profileId}`;
}

export function serializePersistedToken(token: PersistedToken): string {
  const value: PersistedToken = { accessToken: token.accessToken, expiresAt: token.expiresAt };
  if (token.refreshToken) {
    value.refreshToken = token.refreshToken;
  }
  return JSON.stringify(value);
}

/** Unknown fields, wrong types, or an empty access token are corrupt. Does not invent httpStatus. */
export function parsePersistedToken(raw: string): PersistedToken | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !TOKEN_SECRET_FIELDS.has(key))) {
    return undefined;
  }
  if (typeof record.accessToken !== "string" || record.accessToken.length === 0) {
    return undefined;
  }
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) {
    return undefined;
  }
  if ("refreshToken" in record && (typeof record.refreshToken !== "string" || record.refreshToken.length === 0)) {
    return undefined;
  }
  return {
    accessToken: record.accessToken,
    expiresAt: record.expiresAt,
    ...(typeof record.refreshToken === "string" ? { refreshToken: record.refreshToken } : {})
  };
}

function tokenReusable(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - TOKEN_REFRESH_SKEW_MS > now;
}
