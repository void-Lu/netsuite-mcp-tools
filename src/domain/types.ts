export const ENVIRONMENT_SCHEMA_VERSION = 2 as const;

export type AccessMode = "read" | "write";
export type EnvironmentType = "sandbox" | "production";
export type ProfileStatus = "draft" | "registered" | "verified" | "active";

export interface ConnectionProfile {
  id: string;
  access: AccessMode;
  status: ProfileStatus;
  clientId?: string;
  createdAt: string;
  verifiedAt?: string;
}

export interface NetSuiteEnvironment {
  accountId: string;
  environmentType: EnvironmentType;
  profiles: ConnectionProfile[];
}

export interface EnvironmentState {
  schemaVersion: typeof ENVIRONMENT_SCHEMA_VERSION;
  workspaceId: string;
  listener: {
    host: "127.0.0.1";
    port: number;
  };
  /**
   * 已在其他工作区完成连接测试的端口清单。它只用于避免本机端口分配冲突；
   * 当前工作区的 OAuth 回调地址仍唯一由 listener.port 派生。
   */
  allocatedPorts: number[];
  environments: Record<string, NetSuiteEnvironment>;
}

export interface WorkspacePaths {
  workspaceRoot: string;
  dataDirectory: string;
  logsDirectory: string;
  environmentFile: string;
}

export interface NetSuiteEndpoints {
  accountId: string;
  host: string;
  authorizationUrl: string;
  tokenUrl: string;
  mcpUrl: string;
}

export interface TokenValue {
  accessToken: string;
  expiresAt: number;
  /**
   * refresh token 仅保存在 OAuthClient 的内存缓存中；绝不写入日志或配置文件。
   */
  refreshToken?: string;
  /**
   * 创建此内存 token 时 token 端点返回的 HTTP 状态。它不包含任何响应内容，
   * 仅供零数据健康检查记录脱敏诊断。
   */
  httpStatus: number;
}

export interface HealthCheckResult {
  accountId: string;
  profileId: string;
  initialized: boolean;
  listedTools: boolean;
  toolCount?: number;
}

export interface ManagedMcpServer {
  name: string;
  url: string;
  access: AccessMode;
}

export class NetSuiteMcpError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = "NetSuiteMcpError";
  }
}
