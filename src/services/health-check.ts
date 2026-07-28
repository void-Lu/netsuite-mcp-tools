import { ConnectionProfile, HealthCheckResult, NetSuiteEndpoints, NetSuiteMcpError } from "../domain/types";
import { OAuthClient } from "../net/oauth-client";
import { redactIdentifier } from "../util/redaction";

const PROTOCOL_VERSION = "2025-06-18";

type HealthCheckPhase = "token" | "initialize" | "notifications/initialized" | "tools/list";

interface HealthCheckPhaseDefinition {
  phase: HealthCheckPhase;
  mcpMethod: string | null;
}

interface HealthCheckPhaseResult<T> {
  value: T;
  httpStatus: number;
}

export interface HealthCheckLogger {
  info(event: string, fields?: Record<string, unknown>): Promise<void>;
  error(event: string, fields?: Record<string, unknown>): Promise<void>;
}

const HEALTH_CHECK_PHASES = {
  token: { phase: "token", mcpMethod: null },
  initialize: { phase: "initialize", mcpMethod: "initialize" },
  initialized: { phase: "notifications/initialized", mcpMethod: "notifications/initialized" },
  toolsList: { phase: "tools/list", mcpMethod: "tools/list" }
} as const satisfies Record<string, HealthCheckPhaseDefinition>;

export class HealthCheckService {
  public constructor(
    private readonly oauthClient: OAuthClient,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly logger?: HealthCheckLogger
  ) {}

  public async verify(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<HealthCheckResult> {
    const token = await this.runPhase(profile, HEALTH_CHECK_PHASES.token, async () => {
      const result = await this.oauthClient.getAccessTokenWithMetadata(profile, endpoints);
      return { value: result.accessToken, httpStatus: result.httpStatus };
    });
    const initialization = await this.runPhase(profile, HEALTH_CHECK_PHASES.initialize, async () => {
      const response = await this.call(endpoints.mcpUrl, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "netsuite-mcp-tools", version: "0.2.0" }
        }
      });
      return { value: response, httpStatus: response.status };
    });
    const sessionId = initialization.headers.get("mcp-session-id");
    await this.runPhase(profile, HEALTH_CHECK_PHASES.initialized, async () => {
      const response = await this.call(endpoints.mcpUrl, token, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {}
      }, sessionId);
      return { value: undefined, httpStatus: response.status };
    });
    const tools = await this.runPhase(profile, HEALTH_CHECK_PHASES.toolsList, async () => {
      const response = await this.call(endpoints.mcpUrl, token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      }, sessionId);
      return { value: response, httpStatus: response.status };
    });
    const toolCount = readToolCount(await tools.text());
    return {
      accountId: endpoints.accountId,
      profileId: profile.id,
      initialized: true,
      listedTools: true,
      toolCount
    };
  }

  private async call(url: string, token: string, body: Record<string, unknown>, sessionId?: string | null): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {})
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new NetSuiteMcpError("mcp-health-network-error", "无法连接 NetSuite MCP 端点。", error);
    }
    if (!response.ok) {
      throw new NetSuiteMcpError(
        "mcp-health-rejected",
        `NetSuite MCP 健康检查失败（HTTP ${response.status}）。请检查 SuiteApp、Role 与 OAuth scope。`,
        undefined,
        response.status
      );
    }
    return response;
  }

  private async runPhase<T>(
    profile: ConnectionProfile,
    definition: HealthCheckPhaseDefinition,
    action: () => Promise<HealthCheckPhaseResult<T>>
  ): Promise<T> {
    const fields = {
      profileId: redactIdentifier(profile.id),
      phase: definition.phase,
      mcpMethod: definition.mcpMethod
    };
    await this.log("info", "health_check_phase_started", { ...fields, httpStatus: null });
    const startedAt = Date.now();
    try {
      const result = await action();
      await this.log("info", "health_check_phase_succeeded", {
        ...fields,
        durationMs: Date.now() - startedAt,
        httpStatus: result.httpStatus
      });
      return result.value;
    } catch (error) {
      await this.log("error", "health_check_phase_failed", {
        ...fields,
        durationMs: Date.now() - startedAt,
        httpStatus: error instanceof NetSuiteMcpError ? error.httpStatus ?? null : null
      });
      throw error;
    }
  }

  private async log(level: "info" | "error", event: string, fields: Record<string, unknown>): Promise<void> {
    try {
      await this.logger?.[level](event, fields);
    } catch {
      // 日志不可用不能改变健康检查的结果或面向用户的错误提示。
    }
  }
}

function readToolCount(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { result?: { tools?: unknown[] } };
    return Array.isArray(parsed.result?.tools) ? parsed.result.tools.length : undefined;
  } catch {
    return undefined;
  }
}
