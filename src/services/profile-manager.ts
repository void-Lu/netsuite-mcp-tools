import { ConnectionProfile, EnvironmentType, NetSuiteEnvironment, NetSuiteMcpError } from "../domain/types";
import { EnvironmentStore } from "../config/environment-store";
import { buildNetSuiteEndpoints, normalizeAccountId } from "../net/endpoints";
import { HealthCheckService } from "./health-check";
import { PortManager } from "./port-manager";
import { CertificateService } from "../security/certificate-service";
import { McpProxy, ProxyRoute } from "../transport/mcp-proxy";

export interface ProfileSummary {
  environment: NetSuiteEnvironment;
  profile: ConnectionProfile;
}

export class ProfileManager {
  private readonly enabledWriteProfiles = new Set<string>();

  public constructor(
    private readonly store: EnvironmentStore,
    private readonly certificateService: CertificateService,
    private readonly healthCheck: HealthCheckService,
    private readonly portManager: PortManager,
    private readonly proxy: McpProxy
  ) {}

  public async initialize(): Promise<void> {
    const profiles = await this.listProfiles();
    if (profiles.some(({ profile }) => profile.access === "read" && profile.status === "verified")) {
      await this.ensureProxyStarted();
    }
  }

  public async listProfiles(): Promise<ProfileSummary[]> {
    const state = await this.store.getState();
    return Object.values(state.environments).flatMap((environment) => environment.profiles.map((profile) => ({ environment, profile })));
  }

  /**
   * 只返回尚未过期、且会在指定天数内到期的已登记证书。
   * 草稿尚未在 NetSuite 生效，不应造成误报；已过期证书则由用户在本地手动清理。
   */
  public async getProfilesExpiringWithin(days: number, now = Date.now()): Promise<ProfileSummary[]> {
    const deadline = now + days * 24 * 60 * 60 * 1000;
    return (await this.listProfiles()).filter(({ profile }) => {
      const expiresAt = Date.parse(profile.expiresAt);
      return profile.status !== "draft" && Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= deadline;
    });
  }

  public async createDraftProfile(accountIdInput: string, environmentType: EnvironmentType, access: "read" | "write"): Promise<ProfileSummary> {
    const accountId = normalizeAccountId(accountIdInput);
    const expiresAt = new Date(Date.now() + this.certificateService.getCertificateValidityDays() * 24 * 60 * 60 * 1000);
    const created = await this.store.createDraftProfile(accountId, environmentType, access, expiresAt);
    try {
      await this.certificateService.createProfileCertificate(created.profile);
    } catch (error) {
      await this.store.removeProfile(created.profile.id);
      throw error;
    }
    return created;
  }

  public async registerAndVerify(profileId: string, clientId: string, certificateId: string): Promise<ProfileSummary> {
    const registered = await this.store.registerProfile(profileId, clientId.trim(), certificateId.trim());
    const found = await this.store.findProfile(profileId);
    if (!found) {
      throw new NetSuiteMcpError("profile-not-found", "找不到新注册的连接档案。");
    }
    await this.healthCheck.verify(registered, buildNetSuiteEndpoints(found.environment.accountId));
    const verified = await this.store.markVerified(profileId);
    if (verified.access === "read") {
      await this.ensureProxyStarted();
    }
    return { environment: found.environment, profile: verified };
  }

  public async verify(profileId: string): Promise<ProfileSummary> {
    const found = await this.requireProfile(profileId);
    await this.healthCheck.verify(found.profile, buildNetSuiteEndpoints(found.environment.accountId));
    const verified = await this.store.markVerified(profileId);
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
      await this.verify(profileId);
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

  public async createRotationDraft(profileId: string): Promise<ProfileSummary> {
    const found = await this.requireProfile(profileId);
    return this.createDraftProfile(found.environment.accountId, found.environment.environmentType, found.profile.access);
  }

  public async remove(profileId: string): Promise<ProfileSummary> {
    this.enabledWriteProfiles.delete(profileId);
    const removed = await this.store.removeProfile(profileId);
    await this.certificateService.removeProfileCertificate(removed.profile);
    return removed;
  }

  public async resolveProxyRoute(profileId: string): Promise<ProxyRoute | undefined> {
    const found = await this.store.findProfile(profileId);
    if (!found || found.profile.status !== "verified") {
      return undefined;
    }
    const enabled = found.profile.access === "read" || this.enabledWriteProfiles.has(profileId);
    return {
      profile: found.profile,
      endpoints: buildNetSuiteEndpoints(found.environment.accountId),
      enabled
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

  public async repairPort(): Promise<number> {
    const port = await this.portManager.allocateReplacement();
    if (this.proxy.isListening()) {
      await this.proxy.stop();
    }
    await this.proxy.start(port);
    return port;
  }

  public async stop(): Promise<void> {
    this.enabledWriteProfiles.clear();
    await this.proxy.stop();
  }

  private async ensureProxyStarted(): Promise<void> {
    if (!this.proxy.isListening()) {
      await this.proxy.start(await this.portManager.getOrAllocate());
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
