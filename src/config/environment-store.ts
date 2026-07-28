import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import {
  AccessMode,
  ConnectionProfile,
  ENVIRONMENT_SCHEMA_VERSION,
  EnvironmentState,
  EnvironmentType,
  NetSuiteEnvironment,
  NetSuiteMcpError,
  WorkspacePaths
} from "../domain/types";
import { atomicWriteFile, ensureDirectory, readTextIfExists, stableHash } from "../util/files";

const LOCAL_GITIGNORE_RULES = ["/.netsuite-mcp/", "/.vscode/mcp.json", "/.mcp.json"];

export class EnvironmentStore {
  public readonly paths: WorkspacePaths;
  private state: EnvironmentState | undefined;

  public constructor(workspaceRoot: string) {
    const resolvedRoot = resolve(workspaceRoot);
    const dataDirectory = join(resolvedRoot, ".netsuite-mcp");
    this.paths = {
      workspaceRoot: resolvedRoot,
      dataDirectory,
      certificatesDirectory: join(dataDirectory, "certificates"),
      logsDirectory: join(dataDirectory, "logs"),
      environmentFile: join(dataDirectory, "environment.json")
    };
  }

  public async load(): Promise<EnvironmentState> {
    if (this.state) {
      return this.state;
    }
    const content = await readTextIfExists(this.paths.environmentFile);
    this.state = content ? parseEnvironmentState(content) : this.createEmptyState();
    return this.state;
  }

  public async save(): Promise<void> {
    const state = await this.load();
    await ensureDirectory(this.paths.certificatesDirectory);
    await ensureDirectory(this.paths.logsDirectory);
    await atomicWriteFile(this.paths.environmentFile, `${JSON.stringify(state, null, 2)}\n`);
    await this.ensureGitIgnore();
  }

  public async getState(): Promise<EnvironmentState> {
    return this.load();
  }

  public async getEnvironment(accountId: string): Promise<NetSuiteEnvironment | undefined> {
    return (await this.load()).environments[accountId];
  }

  public async findProfile(profileId: string): Promise<{ environment: NetSuiteEnvironment; profile: ConnectionProfile } | undefined> {
    const state = await this.load();
    for (const environment of Object.values(state.environments)) {
      const profile = environment.profiles.find((candidate) => candidate.id === profileId);
      if (profile) {
        return { environment, profile };
      }
    }
    return undefined;
  }

  public async createDraftProfile(
    accountId: string,
    environmentType: EnvironmentType,
    access: AccessMode,
    expiresAt: Date
  ): Promise<{ environment: NetSuiteEnvironment; profile: ConnectionProfile }> {
    const state = await this.load();
    const environment = state.environments[accountId] ?? {
      accountId,
      environmentType,
      profiles: []
    };
    if (environment.environmentType !== environmentType) {
      throw new NetSuiteMcpError("environment-type-mismatch", "该 accountId 已使用不同的环境标签，请先确认现有配置。");
    }
    const profileId = randomUUID();
    const profile: ConnectionProfile = {
      id: profileId,
      access,
      status: "draft",
      publicCertificatePath: relative(this.paths.dataDirectory, join(this.paths.certificatesDirectory, `${profileId}.public.pem`)),
      privateKeyPath: relative(this.paths.dataDirectory, join(this.paths.certificatesDirectory, `${profileId}.private.dpapi`)),
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString()
    };
    environment.profiles.push(profile);
    state.environments[accountId] = environment;
    await this.save();
    return { environment, profile };
  }

  public async registerProfile(profileId: string, clientId: string, certificateId: string): Promise<ConnectionProfile> {
    return this.updateProfile(profileId, (profile) => ({
      ...profile,
      clientId,
      certificateId,
      status: "registered"
    }));
  }

  public async markVerified(profileId: string): Promise<ConnectionProfile> {
    return this.updateProfile(profileId, (profile) => ({
      ...profile,
      status: "verified",
      verifiedAt: new Date().toISOString()
    }));
  }

  public async setListenerPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new NetSuiteMcpError("invalid-port", "本地端口必须位于 1024 到 65535 之间。");
    }
    const state = await this.load();
    state.listener.port = port;
    await this.save();
  }

  public async removeProfile(profileId: string): Promise<{ environment: NetSuiteEnvironment; profile: ConnectionProfile }> {
    const state = await this.load();
    for (const [accountId, environment] of Object.entries(state.environments)) {
      const index = environment.profiles.findIndex((candidate) => candidate.id === profileId);
      if (index < 0) {
        continue;
      }
      const [profile] = environment.profiles.splice(index, 1);
      if (environment.profiles.length === 0) {
        delete state.environments[accountId];
      }
      await this.save();
      return { environment, profile };
    }
    throw new NetSuiteMcpError("profile-not-found", "找不到要移除的连接档案。");
  }

  private async updateProfile(profileId: string, updater: (profile: ConnectionProfile) => ConnectionProfile): Promise<ConnectionProfile> {
    const found = await this.findProfile(profileId);
    if (!found) {
      throw new NetSuiteMcpError("profile-not-found", "找不到连接档案。");
    }
    const index = found.environment.profiles.findIndex((profile) => profile.id === profileId);
    const next = updater(found.profile);
    found.environment.profiles[index] = next;
    await this.save();
    return next;
  }

  private createEmptyState(): EnvironmentState {
    return {
      schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
      workspaceId: stableHash(this.paths.workspaceRoot),
      listener: {
        host: "127.0.0.1",
        port: 0
      },
      environments: {}
    };
  }

  private async ensureGitIgnore(): Promise<void> {
    const gitIgnorePath = join(this.paths.workspaceRoot, ".gitignore");
    const existing = (await readTextIfExists(gitIgnorePath)) ?? "";
    const missing = LOCAL_GITIGNORE_RULES.filter((rule) => !existing.split(/\r?\n/).includes(rule));
    if (missing.length > 0) {
      const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
      await atomicWriteFile(gitIgnorePath, `${prefix}${missing.join("\n")}\n`);
    }
  }
}

function parseEnvironmentState(content: string): EnvironmentState {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new NetSuiteMcpError("invalid-environment-json", "environment.json 不是有效 JSON，请修复或恢复备份。", error);
  }
  if (!isEnvironmentState(raw)) {
    throw new NetSuiteMcpError("invalid-environment-schema", "environment.json 的结构不受当前扩展支持。请恢复备份或重新配置。");
  }
  return raw;
}

function isEnvironmentState(value: unknown): value is EnvironmentState {
  if (!isRecord(value) || value.schemaVersion !== ENVIRONMENT_SCHEMA_VERSION || typeof value.workspaceId !== "string") {
    return false;
  }
  if (!isRecord(value.listener) || value.listener.host !== "127.0.0.1" || typeof value.listener.port !== "number") {
    return false;
  }
  if (!isRecord(value.environments)) {
    return false;
  }
  return Object.entries(value.environments).every(([accountId, environment]) => isEnvironment(accountId, environment));
}

function isEnvironment(accountId: string, value: unknown): value is NetSuiteEnvironment {
  return isRecord(value) && value.accountId === accountId && isEnvironmentType(value.environmentType) && Array.isArray(value.profiles) && value.profiles.every(isProfile);
}

function isProfile(value: unknown): value is ConnectionProfile {
  return isRecord(value) && typeof value.id === "string" && isAccessMode(value.access) && isProfileStatus(value.status) &&
    (value.clientId === undefined || typeof value.clientId === "string") &&
    (value.certificateId === undefined || typeof value.certificateId === "string") &&
    typeof value.publicCertificatePath === "string" && typeof value.privateKeyPath === "string" &&
    typeof value.expiresAt === "string" && typeof value.createdAt === "string" &&
    (value.verifiedAt === undefined || typeof value.verifiedAt === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAccessMode(value: unknown): value is AccessMode {
  return value === "read" || value === "write";
}

function isEnvironmentType(value: unknown): value is EnvironmentType {
  return value === "sandbox" || value === "production";
}

function isProfileStatus(value: unknown): boolean {
  return value === "draft" || value === "registered" || value === "verified" || value === "active";
}
