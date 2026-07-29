import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  ConnectionProfile,
  ENVIRONMENT_SCHEMA_VERSION,
  EnvironmentState,
  EnvironmentType,
  NetSuiteEnvironment,
  NetSuiteMcpError,
  WorkspacePaths
} from "../domain/types";
import { atomicWriteFile, ensureDirectory, readTextIfExists, stableHash } from "../util/files";

const LOCAL_GITIGNORE_RULES = ["/.netsuite-mcp/logs/", "/.vscode/mcp.json", "/.mcp.json"];
const LEGACY_GITIGNORE_RULES = ["/.netsuite-mcp/"];
const TEMPLATE_ACCOUNT_ID = "YOUR_NETSUITE_ACCOUNT_ID";
const TOP_LEVEL_FIELDS = ["schemaVersion", "workspaceId", "listener", "allocatedPorts", "environments"] as const;
const PRE_ALLOCATION_TOP_LEVEL_FIELDS = ["schemaVersion", "workspaceId", "listener", "environments"] as const;
const LISTENER_FIELDS = ["host", "port"] as const;
const ENVIRONMENT_FIELDS = ["accountId", "environmentType", "profiles"] as const;
const PROFILE_FIELDS = ["id", "status", "clientId", "createdAt", "verifiedAt"] as const;
const V2_PROFILE_FIELDS = ["id", "access", "status", "clientId", "createdAt", "verifiedAt"] as const;
const LEGACY_PROFILE_FIELDS = [
  "id", "access", "status", "clientId", "certificateId", "publicCertificatePath", "privateKeyPath", "expiresAt", "createdAt", "verifiedAt"
] as const;

export type ConfigurationTemplateResult = "initialized" | "completed" | "unchanged";

/**
 * 环境文件仅保存可审阅的 Public Client 元数据。本机 OAuth 的 state、PKCE
 * verifier、access/refresh token 均由 OAuthClient 持有，绝不写入此处。
 */
export class EnvironmentStore {
  public readonly paths: WorkspacePaths;
  private state: EnvironmentState | undefined;

  public constructor(workspaceRoot: string) {
    const resolvedRoot = resolve(workspaceRoot);
    const dataDirectory = join(resolvedRoot, ".netsuite-mcp");
    this.paths = {
      workspaceRoot: resolvedRoot,
      dataDirectory,
      logsDirectory: join(dataDirectory, "logs"),
      environmentFile: join(dataDirectory, "environment.json")
    };
  }

  public async load(): Promise<EnvironmentState> {
    if (this.state) {
      return this.state;
    }
    const content = await readTextIfExists(this.paths.environmentFile);
    this.state = content?.trim() ? parseEnvironmentState(content) : this.createEmptyState();
    return this.state;
  }

  public async reload(): Promise<EnvironmentState> {
    const content = await readTextIfExists(this.paths.environmentFile);
    this.state = content?.trim() ? parseEnvironmentState(content) : this.createEmptyState();
    return this.state;
  }

  public async save(): Promise<void> {
    const state = await this.load();
    await ensureDirectory(this.paths.dataDirectory);
    await ensureDirectory(this.paths.logsDirectory);
    await atomicWriteFile(this.paths.environmentFile, `${JSON.stringify(state, null, 2)}\n`);
    await this.ensureGitIgnore();
  }

  public async getState(): Promise<EnvironmentState> {
    return this.load();
  }

  public async ensureConfigurationTemplate(): Promise<ConfigurationTemplateResult> {
    const existing = await readTextIfExists(this.paths.environmentFile);
    if (existing === undefined || existing.trim().length === 0) {
      this.state = this.createTemplateState();
      await this.save();
      return "initialized";
    }
    const completed = this.completeEnvironmentState(existing);
    this.state = completed.state;
    if (completed.changed) {
      await this.save();
      return "completed";
    }
    return "unchanged";
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
    environmentType: EnvironmentType
  ): Promise<{ environment: NetSuiteEnvironment; profile: ConnectionProfile }> {
    const state = await this.load();
    const environment = state.environments[accountId] ?? { accountId, environmentType, profiles: [] };
    if (environment.environmentType !== environmentType) {
      throw new NetSuiteMcpError("environment-type-mismatch", "该 accountId 已使用不同的环境标签，请先确认现有配置。");
    }
    const profile = this.createDraftProfileRecord();
    environment.profiles.push(profile);
    state.environments[accountId] = environment;
    await this.save();
    return { environment, profile };
  }

  public async registerProfile(profileId: string, clientId: string): Promise<ConnectionProfile> {
    const normalizedClientId = clientId.trim();
    if (!normalizedClientId) {
      throw new NetSuiteMcpError("profile-not-registered", "NetSuite Public Client ID 不能为空。");
    }
    return this.updateProfile(profileId, (profile) => ({ ...profile, clientId: normalizedClientId, status: "registered" }));
  }

  public async markVerified(profileId: string): Promise<ConnectionProfile> {
    return this.updateProfile(profileId, (profile) => ({ ...profile, status: "verified", verifiedAt: new Date().toISOString() }));
  }

  public async markRegistered(profileId: string): Promise<ConnectionProfile> {
    return this.updateProfile(profileId, (profile) => {
      const rest = { ...profile };
      delete rest.verifiedAt;
      return { ...rest, status: "registered" };
    });
  }

  public async setListenerPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new NetSuiteMcpError("invalid-port", "本地端口必须位于 1024 到 65535 之间。");
    }
    const state = await this.load();
    state.listener.port = port;
    await this.save();
  }

  /**
   * 只记录已完成浏览器授权和零数据健康检查的端口。该列表用于通知其他
   * 工作区/用户避开已登记端口，并不改变当前 workspace 的 callback URI。
   */
  public async addAllocatedPort(port: number): Promise<void> {
    if (!isValidAllocatedPort(port)) {
      throw new NetSuiteMcpError("invalid-port", "已分配端口必须位于 1024 到 65535 之间。");
    }
    const state = await this.load();
    if (state.allocatedPorts.includes(port)) {
      return;
    }
    state.allocatedPorts.push(port);
    await this.save();
  }

  /** 将其他 Windows 用户已成功登记的端口并入可共享的环境排除清单。 */
  public async mergeAllocatedPorts(ports: readonly number[]): Promise<void> {
    if (!ports.every(isValidAllocatedPort)) {
      throw new NetSuiteMcpError("invalid-port", "已分配端口必须位于 1024 到 65535 之间。");
    }
    const state = await this.load();
    const merged = uniquePorts([...state.allocatedPorts, ...ports]);
    if (merged.length === state.allocatedPorts.length) {
      return;
    }
    state.allocatedPorts = merged;
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
      listener: { host: "127.0.0.1", port: 0 },
      allocatedPorts: [],
      environments: {}
    };
  }

  private createTemplateState(): EnvironmentState {
    const state = this.createEmptyState();
    state.environments[TEMPLATE_ACCOUNT_ID] = {
      accountId: TEMPLATE_ACCOUNT_ID,
      environmentType: "sandbox",
      profiles: [this.createTemplateProfile()]
    };
    return state;
  }

  private createTemplateProfile(): ConnectionProfile {
    return { ...this.createDraftProfileRecord(), clientId: "" };
  }

  private createDraftProfileRecord(): ConnectionProfile {
    return { id: randomUUID(), status: "draft", createdAt: new Date().toISOString() };
  }

  private completeEnvironmentState(content: string): { state: EnvironmentState; changed: boolean } {
    const raw = parseEnvironmentDocument(content);
    if (!isRecord(raw)) {
      throw invalidEnvironmentSchema();
    }
    if (raw.schemaVersion === 1) {
      return { state: migrateLegacyState(raw), changed: true };
    }
    if (raw.schemaVersion === 2) {
      return { state: migrateV2State(raw), changed: true };
    }
    assertOnlyKnownFields(raw, TOP_LEVEL_FIELDS);
    let changed = false;
    const state: EnvironmentState = {
      schemaVersion: readSchemaVersion(raw, () => { changed = true; }),
      workspaceId: readDerivedString(raw, "workspaceId", stableHash(this.paths.workspaceRoot), () => { changed = true; }),
      listener: this.completeListener(raw.listener, () => { changed = true; }),
      allocatedPorts: this.completeAllocatedPorts(raw.allocatedPorts, () => { changed = true; }),
      environments: this.completeEnvironments(raw.environments, () => { changed = true; })
    };
    return { state, changed };
  }

  private completeListener(value: unknown, markChanged: () => void): EnvironmentState["listener"] {
    if (value === undefined) {
      markChanged();
      return { host: "127.0.0.1", port: 0 };
    }
    if (!isRecord(value)) {
      throw invalidEnvironmentSchema();
    }
    assertOnlyKnownFields(value, LISTENER_FIELDS);
    if (value.host !== undefined && value.host !== "127.0.0.1") {
      throw invalidEnvironmentSchema();
    }
    if (value.host === undefined) {
      markChanged();
    }
    if (value.port !== undefined && !isValidListenerPort(value.port)) {
      throw invalidEnvironmentSchema();
    }
    if (value.port === undefined) {
      markChanged();
    }
    return { host: "127.0.0.1", port: (value.port as number | undefined) ?? 0 };
  }

  private completeAllocatedPorts(value: unknown, markChanged: () => void): number[] {
    if (value === undefined) {
      markChanged();
      return [];
    }
    if (!Array.isArray(value) || !value.every(isValidAllocatedPort)) {
      throw invalidEnvironmentSchema();
    }
    const ports = uniquePorts(value);
    if (ports.length !== value.length) {
      markChanged();
    }
    return ports;
  }

  private completeEnvironments(value: unknown, markChanged: () => void): Record<string, NetSuiteEnvironment> {
    if (value === undefined || (isRecord(value) && Object.keys(value).length === 0)) {
      markChanged();
      return this.createTemplateState().environments;
    }
    if (!isRecord(value)) {
      throw invalidEnvironmentSchema();
    }
    return Object.fromEntries(Object.entries(value).map(([accountId, environment]) => {
      if (isUnsafeObjectKey(accountId)) {
        throw invalidEnvironmentSchema();
      }
      return [accountId, this.completeEnvironment(accountId, environment, markChanged)];
    }));
  }

  private completeEnvironment(accountId: string, value: unknown, markChanged: () => void): NetSuiteEnvironment {
    if (!isRecord(value)) {
      throw invalidEnvironmentSchema();
    }
    assertOnlyKnownFields(value, ENVIRONMENT_FIELDS);
    if (value.accountId !== undefined && (typeof value.accountId !== "string" || value.accountId !== accountId)) {
      throw invalidEnvironmentSchema();
    }
    if (value.accountId === undefined) {
      markChanged();
    }
    if (value.environmentType !== undefined && !isEnvironmentType(value.environmentType)) {
      throw invalidEnvironmentSchema();
    }
    if (value.environmentType === undefined) {
      markChanged();
    }
    return {
      accountId,
      environmentType: (value.environmentType as EnvironmentType | undefined) ?? "sandbox",
      profiles: this.completeProfiles(value.profiles, markChanged)
    };
  }

  private completeProfiles(value: unknown, markChanged: () => void): ConnectionProfile[] {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      markChanged();
      return [this.createTemplateProfile()];
    }
    if (!Array.isArray(value)) {
      throw invalidEnvironmentSchema();
    }
    return value.map((profile) => this.completeProfile(profile, markChanged));
  }

  private completeProfile(value: unknown, markChanged: () => void): ConnectionProfile {
    if (!isRecord(value)) {
      throw invalidEnvironmentSchema();
    }
    if ("access" in value) {
      assertOnlyKnownFields(value, V2_PROFILE_FIELDS);
      markChanged();
      const id = readDerivedString(value, "id", randomUUID(), markChanged);
      const status = value.status === undefined || value.status === "" ? (markChanged(), "draft") : isProfileStatus(value.status) ? value.status : failSchema();
      const clientId = readOptionalString(value, "clientId", markChanged);
      const createdAt = readDerivedString(value, "createdAt", new Date().toISOString(), markChanged);
      const verifiedAt = readOptionalTimestamp(value, "verifiedAt");
      return { id, status, clientId, createdAt, ...(verifiedAt ? { verifiedAt } : {}) };
    }
    assertOnlyKnownFields(value, PROFILE_FIELDS);
    const id = readDerivedString(value, "id", randomUUID(), markChanged);
    const status = value.status === undefined || value.status === "" ? (markChanged(), "draft") : isProfileStatus(value.status) ? value.status : failSchema();
    const clientId = readOptionalString(value, "clientId", markChanged);
    const createdAt = readDerivedString(value, "createdAt", new Date().toISOString(), markChanged);
    const verifiedAt = readOptionalTimestamp(value, "verifiedAt");
    return { id, status, clientId, createdAt, ...(verifiedAt ? { verifiedAt } : {}) };
  }

  private async ensureGitIgnore(): Promise<void> {
    const gitIgnorePath = join(this.paths.workspaceRoot, ".gitignore");
    const existing = (await readTextIfExists(gitIgnorePath)) ?? "";
    const retainedLines = existing.split(/\r?\n/).filter((line) => !LEGACY_GITIGNORE_RULES.includes(line.trim()));
    const missing = LOCAL_GITIGNORE_RULES.filter((rule) => !retainedLines.includes(rule));
    if (missing.length > 0 || retainedLines.length !== existing.split(/\r?\n/).length) {
      const retained = retainedLines.join("\n").replace(/\s*$/, "");
      await atomicWriteFile(gitIgnorePath, `${retained}${retained ? "\n" : ""}${missing.join("\n")}\n`);
    }
  }
}

function parseEnvironmentState(content: string): EnvironmentState {
  const raw = parseEnvironmentDocument(content);
  if (isRecord(raw) && raw.schemaVersion === 1) {
    return migrateLegacyState(raw);
  }
  if (isRecord(raw) && raw.schemaVersion === 2) {
    return migrateV2State(raw);
  }
  if (isEnvironmentState(raw)) {
    return raw;
  }
  if (isPreAllocationEnvironmentState(raw)) {
    return { ...raw, allocatedPorts: [] };
  }
  throw invalidEnvironmentSchema();
}

function parseEnvironmentDocument(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new NetSuiteMcpError("invalid-environment-json", "environment.json 不是有效 JSON，请修复或恢复备份。", error);
  }
}

/** 仅接受已知 v1 结构，再无损保留 clientId 并删除废弃的证书路径/标识。 */
function migrateLegacyState(raw: Record<string, unknown>): EnvironmentState {
  if (!isLegacyEnvironmentState(raw)) {
    throw invalidEnvironmentSchema();
  }
  return {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    workspaceId: raw.workspaceId as string,
    listener: raw.listener as EnvironmentState["listener"],
    allocatedPorts: [],
    environments: Object.fromEntries(Object.entries(raw.environments as Record<string, NetSuiteEnvironment>).map(([accountId, environment]) => [
      accountId,
      {
        accountId: environment.accountId,
        environmentType: environment.environmentType,
        profiles: selectSingleProfile(environment.profiles.map((profile) => ({
          id: profile.id,
          status: profile.status,
          ...(profile.clientId === undefined ? {} : { clientId: profile.clientId }),
          createdAt: profile.createdAt,
          ...(profile.verifiedAt === undefined ? {} : { verifiedAt: profile.verifiedAt })
        })))
      }
    ]))
  };
}

/** 将 v2（含 read/write access 区分）迁移到 v3：每个 environment 只保留一个 profile，移除 access 字段。 */
function migrateV2State(raw: Record<string, unknown>): EnvironmentState {
  if (!isV2EnvironmentState(raw)) {
    throw invalidEnvironmentSchema();
  }
  const v2State = raw as unknown as {
    schemaVersion: 2;
    workspaceId: string;
    listener: EnvironmentState["listener"];
    allocatedPorts: number[];
    environments: Record<string, NetSuiteEnvironment & { profiles: Array<ConnectionProfile & { access: string }> }>;
  };
  return {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    workspaceId: v2State.workspaceId,
    listener: v2State.listener,
    allocatedPorts: v2State.allocatedPorts,
    environments: Object.fromEntries(Object.entries(v2State.environments).map(([accountId, environment]) => [
      accountId,
      {
        accountId: environment.accountId,
        environmentType: environment.environmentType,
        profiles: selectSingleProfile(environment.profiles.map((profile) => ({
          id: profile.id,
          status: profile.status,
          ...(profile.clientId === undefined ? {} : { clientId: profile.clientId }),
          createdAt: profile.createdAt,
          ...(profile.verifiedAt === undefined ? {} : { verifiedAt: profile.verifiedAt })
        })))
      }
    ]))
  };
}

/**
 * 从 v1/v2 的多个 profile（可能含 read + write）中选择保留一个：
 * 1. 优先 verified 的
 * 2. 若都 verified 或都未 verified，优先有 clientId 的
 * 3. 若都无 clientId，取第一个
 */
function selectSingleProfile(profiles: ConnectionProfile[]): ConnectionProfile[] {
  if (profiles.length <= 1) {
    return profiles;
  }
  const verified = profiles.find((p) => p.status === "verified");
  if (verified) {
    return [verified];
  }
  const withClientId = profiles.find((p) => p.clientId?.trim());
  return [withClientId ?? profiles[0]];
}

function invalidEnvironmentSchema(): NetSuiteMcpError {
  return new NetSuiteMcpError("invalid-environment-schema", "environment.json 的结构不受当前扩展支持。请恢复备份或重新配置。");
}

function failSchema(): never {
  throw invalidEnvironmentSchema();
}

function assertOnlyKnownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (!hasOnlyKeys(value, allowed)) {
    throw invalidEnvironmentSchema();
  }
}

function readSchemaVersion(value: Record<string, unknown>, markChanged: () => void): typeof ENVIRONMENT_SCHEMA_VERSION {
  if (value.schemaVersion === undefined) {
    markChanged();
    return ENVIRONMENT_SCHEMA_VERSION;
  }
  if (value.schemaVersion !== ENVIRONMENT_SCHEMA_VERSION) {
    throw invalidEnvironmentSchema();
  }
  return ENVIRONMENT_SCHEMA_VERSION;
}

function readDerivedString(value: Record<string, unknown>, field: string, fallback: string, markChanged: () => void): string {
  const existing = value[field];
  if (existing === undefined || existing === "") {
    markChanged();
    return fallback;
  }
  if (typeof existing !== "string") {
    throw invalidEnvironmentSchema();
  }
  return existing;
}

function readOptionalString(value: Record<string, unknown>, field: string, markChanged: () => void): string {
  const existing = value[field];
  if (existing === undefined) {
    markChanged();
    return "";
  }
  if (typeof existing !== "string") {
    throw invalidEnvironmentSchema();
  }
  return existing;
}

function readOptionalTimestamp(value: Record<string, unknown>, field: string): string | undefined {
  const existing = value[field];
  if (existing === undefined) {
    return undefined;
  }
  if (typeof existing !== "string") {
    throw invalidEnvironmentSchema();
  }
  return existing;
}

function isEnvironmentState(value: unknown): value is EnvironmentState {
  return isRecord(value) && hasOnlyKeys(value, TOP_LEVEL_FIELDS) &&
    value.schemaVersion === ENVIRONMENT_SCHEMA_VERSION && typeof value.workspaceId === "string" &&
    isListener(value.listener) && isAllocatedPorts(value.allocatedPorts) && isRecord(value.environments) &&
    Object.entries(value.environments).every(([accountId, environment]) => isEnvironment(accountId, environment));
}

type PreAllocationEnvironmentState = Omit<EnvironmentState, "allocatedPorts">;

function isPreAllocationEnvironmentState(value: unknown): value is PreAllocationEnvironmentState {
  return isRecord(value) && hasOnlyKeys(value, PRE_ALLOCATION_TOP_LEVEL_FIELDS) &&
    value.schemaVersion === ENVIRONMENT_SCHEMA_VERSION && typeof value.workspaceId === "string" &&
    isListener(value.listener) && isRecord(value.environments) &&
    Object.entries(value.environments).every(([accountId, environment]) => isEnvironment(accountId, environment));
}

/** v2 结构验证：schemaVersion === 2，profile 含 access 字段。 */
function isV2EnvironmentState(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, TOP_LEVEL_FIELDS) && value.schemaVersion === 2 && typeof value.workspaceId === "string" &&
    isListener(value.listener) && isAllocatedPorts(value.allocatedPorts) && isRecord(value.environments) &&
    Object.entries(value.environments).every(([accountId, environment]) => isV2Environment(accountId, environment));
}

function isLegacyEnvironmentState(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, TOP_LEVEL_FIELDS) && value.schemaVersion === 1 && typeof value.workspaceId === "string" &&
    isListener(value.listener) && isRecord(value.environments) &&
    Object.entries(value.environments).every(([accountId, environment]) => isLegacyEnvironment(accountId, environment));
}

function isListener(value: unknown): value is EnvironmentState["listener"] {
  return isRecord(value) && hasOnlyKeys(value, LISTENER_FIELDS) && value.host === "127.0.0.1" && isValidListenerPort(value.port);
}

function isEnvironment(accountId: string, value: unknown): value is NetSuiteEnvironment {
  return isRecord(value) && hasOnlyKeys(value, ENVIRONMENT_FIELDS) && value.accountId === accountId &&
    isEnvironmentType(value.environmentType) && Array.isArray(value.profiles) && value.profiles.every(isProfile);
}

function isV2Environment(accountId: string, value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ENVIRONMENT_FIELDS) && value.accountId === accountId &&
    isEnvironmentType(value.environmentType) && Array.isArray(value.profiles) && value.profiles.every(isV2Profile);
}

function isLegacyEnvironment(accountId: string, value: unknown): value is NetSuiteEnvironment {
  return isRecord(value) && hasOnlyKeys(value, ENVIRONMENT_FIELDS) && value.accountId === accountId &&
    isEnvironmentType(value.environmentType) && Array.isArray(value.profiles) && value.profiles.every(isLegacyProfile);
}

function isProfile(value: unknown): value is ConnectionProfile {
  return isRecord(value) && hasOnlyKeys(value, PROFILE_FIELDS) && typeof value.id === "string" &&
    isProfileStatus(value.status) &&
    (value.clientId === undefined || typeof value.clientId === "string") && typeof value.createdAt === "string" &&
    (value.verifiedAt === undefined || typeof value.verifiedAt === "string");
}

function isV2Profile(value: unknown): value is ConnectionProfile & { access: string } {
  return isRecord(value) && hasOnlyKeys(value, V2_PROFILE_FIELDS) && typeof value.id === "string" &&
    typeof value.access === "string" && isProfileStatus(value.status) &&
    (value.clientId === undefined || typeof value.clientId === "string") && typeof value.createdAt === "string" &&
    (value.verifiedAt === undefined || typeof value.verifiedAt === "string");
}

function isLegacyProfile(value: unknown): value is ConnectionProfile {
  return isRecord(value) && hasOnlyKeys(value, LEGACY_PROFILE_FIELDS) && typeof value.id === "string" &&
    typeof value.access === "string" && isProfileStatus(value.status) &&
    (value.clientId === undefined || typeof value.clientId === "string") &&
    (value.certificateId === undefined || typeof value.certificateId === "string") &&
    typeof value.publicCertificatePath === "string" && typeof value.privateKeyPath === "string" &&
    typeof value.expiresAt === "string" && typeof value.createdAt === "string" &&
    (value.verifiedAt === undefined || typeof value.verifiedAt === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isValidListenerPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535;
}

function isValidAllocatedPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function isAllocatedPorts(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isValidAllocatedPort) && uniquePorts(value).length === value.length;
}

function uniquePorts(ports: readonly number[]): number[] {
  return [...new Set(ports)];
}

function isUnsafeObjectKey(value: string): boolean {
  return value === "__proto__" || value === "constructor" || value === "prototype";
}

function isEnvironmentType(value: unknown): value is EnvironmentType {
  return value === "sandbox" || value === "production";
}

function isProfileStatus(value: unknown): value is ConnectionProfile["status"] {
  return value === "draft" || value === "registered" || value === "verified";
}
