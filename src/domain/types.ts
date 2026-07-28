export const ENVIRONMENT_SCHEMA_VERSION = 1 as const;

export type AccessMode = "read" | "write";
export type EnvironmentType = "sandbox" | "production";
export type ProfileStatus = "draft" | "registered" | "verified" | "active";

export interface ConnectionProfile {
  id: string;
  access: AccessMode;
  status: ProfileStatus;
  clientId?: string;
  certificateId?: string;
  publicCertificatePath: string;
  privateKeyPath: string;
  expiresAt: string;
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
  environments: Record<string, NetSuiteEnvironment>;
}

export interface WorkspacePaths {
  workspaceRoot: string;
  dataDirectory: string;
  certificatesDirectory: string;
  logsDirectory: string;
  environmentFile: string;
}

export interface NetSuiteEndpoints {
  accountId: string;
  host: string;
  tokenUrl: string;
  mcpUrl: string;
}

export interface TokenValue {
  accessToken: string;
  expiresAt: number;
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
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "NetSuiteMcpError";
  }
}
