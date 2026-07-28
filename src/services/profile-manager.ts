import { ConnectionProfile, EnvironmentType, NetSuiteEnvironment, NetSuiteMcpError } from "../domain/types";
import { EnvironmentStore } from "../config/environment-store";
import { buildNetSuiteEndpoints, normalizeAccountId } from "../net/endpoints";
import { AuthorizationBrowserOpener, OAuthClient } from "../net/oauth-client";
import { HealthCheckService } from "./health-check";
import { listenerPortOccupied, PortManager } from "./port-manager";
import { McpProxy, ProxyRoute } from "../transport/mcp-proxy";

export interface ProfileSummary {
  environment: NetSuiteEnvironment;
  profile: ConnectionProfile;
}

/** Coordinates persisted non-secret profile metadata with the in-memory OAuth session. */
export class ProfileManager {
  private readonly enabledWriteProfiles = new Set<string>();

  public constructor(
    private readonly store: EnvironmentStore,
    private readonly oauthClient: OAuthClient,
    private readonly healthCheck: HealthCheckService,
    private readonly portManager: PortManager,
    private readonly proxy: McpProxy
  ) {}

  public async initialize(): Promise<void> {
    await this.portManager.synchronizeAllocatedPorts();
    const profiles = await this.listProfiles();
    if (profiles.some(({ profile }) => profile.access === "read" && profile.status === "verified")) {
      await this.ensureProxyStarted();
    }
  }

  public async listProfiles(): Promise<ProfileSummary[]> {
    const state = await this.store.reload();
    return Object.values(state.environments).flatMap((environment) => environment.profiles.map((profile) => ({ environment, profile })));
  }

  public async createDraftProfile(accountIdInput: string, environmentType: EnvironmentType, access: "read" | "write"): Promise<ProfileSummary> {
    const accountId = normalizeAccountId(accountIdInput);
    return this.store.createDraftProfile(accountId, environmentType, access);
  }

  /**
   * Starts a Public Client Authorization Code + PKCE exchange and only marks a
   * profile verified after the zero-data MCP health check succeeds.
   */
  public async authorizeAndVerify(profileId: string, openBrowser: AuthorizationBrowserOpener): Promise<ProfileSummary> {
    const found = await this.requireProfile(profileId);
    if (!found.profile.clientId?.trim()) {
      throw new NetSuiteMcpError("profile-not-registered", "请先在 environment.json 填写 NetSuite Public Client ID。");
    }
    await this.ensureProxyStarted();
    const redirectUri = this.proxy.getAuthorizationCallbackUrl();
    if (!redirectUri) {
      throw new NetSuiteMcpError("oauth-callback-unavailable", "本机 OAuth 回调端口未启动。请释放 environment.json 中登记的端口后重试。");
    }
    const endpoints = buildNetSuiteEndpoints(found.environment.accountId);
    await this.oauthClient.authorize(found.profile, endpoints, redirectUri, openBrowser);
    await this.healthCheck.verify(found.profile, endpoints);
    const verified = await this.store.markVerified(profileId);
    await this.portManager.recordSuccessfulConnection();
    if (verified.access === "read") {
      await this.ensureProxyStarted();
    }
    return { environment: found.environment, profile: verified };
  }

  /**
   * Performs a health check with an already-authorized in-memory session. This
   * intentionally never opens a browser, so callers can distinguish missing
   * authorization from MCP/permission failures.
   */
  public async verify(profileId: string): Promise<ProfileSummary> {
    const found = await this.requireProfile(profileId);
    await this.healthCheck.verify(found.profile, buildNetSuiteEndpoints(found.environment.accountId));
    const verified = await this.store.markVerified(profileId);
    await this.portManager.recordSuccessfulConnection();
    if (verified.access === "read") {
      await this.ensureProxyStarted();
    }
    return { environment: found.environment, profile: verified };
  }

  public async enableWrite(profileId: string): Promise<void> {
    const found = await this.requireProfile(profileId);
    if (found.profile.access !== "write") {
      throw new NetSuiteMcpError("not-write-profile", "所选档案不是写入连接。请先配置独立的 write profile。");
    }
    if (found.profile.status !== "verified") {
      throw new NetSuiteMcpError("authorization-required", "请先运行“NetSuite MCP：测试连接”并在浏览器中完成此写入档案的授权。");
    }
    this.enabledWriteProfiles.add(profileId);
    await this.ensureProxyStarted();
  }

  public disableWrite(profileId: string): void {
    this.enabledWriteProfiles.delete(profileId);
  }

  public isWriteEnabled(profileId: string): boolean {
    return this.enabledWriteProfiles.has(profileId);
  }

  public async remove(profileId: string): Promise<ProfileSummary> {
    this.enabledWriteProfiles.delete(profileId);
    this.oauthClient.invalidate(profileId);
    return this.store.removeProfile(profileId);
  }

  public async resolveProxyRoute(profileId: string): Promise<ProxyRoute | undefined> {
    const found = await this.store.findProfile(profileId);
    if (!found || found.profile.status !== "verified") {
      return undefined;
    }
    return {
      profile: found.profile,
      endpoints: buildNetSuiteEndpoints(found.environment.accountId),
      enabled: found.profile.access === "read" || this.enabledWriteProfiles.has(profileId)
    };
  }

  public async getMcpUrl(profileId: string): Promise<string> {
    const activeUrl = this.proxy.getUrl(profileId);
    if (activeUrl) {
      return activeUrl;
    }
    const port = await this.portManager.getOrAllocate();
    return `http://127.0.0.1:${port}/${profileId}/mcp`;
  }

  /** 为 NetSuite Integration 提供一个持久化的精确 loopback Redirect URI。 */
  public async prepareAuthorizationCallback(): Promise<string> {
    await this.ensureProxyStarted();
    const redirectUri = this.proxy.getAuthorizationCallbackUrl();
    if (!redirectUri) {
      throw new NetSuiteMcpError("oauth-callback-unavailable", "无法启动本机 OAuth 回调端口。");
    }
    return redirectUri;
  }

  public async stop(): Promise<void> {
    this.enabledWriteProfiles.clear();
    this.oauthClient.clear();
    await this.proxy.stop();
  }

  private async ensureProxyStarted(): Promise<void> {
    if (!this.proxy.isListening()) {
      const port = await this.portManager.getOrAllocate();
      try {
        await this.proxy.start(port);
      } catch (error) {
        if (isAddressInUse(error)) {
          throw listenerPortOccupied(port);
        }
        throw error;
      }
    }
  }

  private async requireProfile(profileId: string): Promise<ProfileSummary> {
    const found = await this.store.findProfile(profileId);
    if (!found) {
      throw new NetSuiteMcpError("profile-not-found", "找不到连接档案。");
    }
    return found;
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "EADDRINUSE";
}
