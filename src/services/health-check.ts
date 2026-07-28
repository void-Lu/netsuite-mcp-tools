import { ConnectionProfile, HealthCheckResult, NetSuiteEndpoints, NetSuiteMcpError } from "../domain/types";
import { OAuthClient } from "../net/oauth-client";

const PROTOCOL_VERSION = "2025-03-26";

export class HealthCheckService {
  public constructor(
    private readonly oauthClient: OAuthClient,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  public async verify(profile: ConnectionProfile, endpoints: NetSuiteEndpoints): Promise<HealthCheckResult> {
    const token = await this.oauthClient.getAccessToken(profile, endpoints);
    const initialization = await this.call(endpoints.mcpUrl, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "netsuite-mcp-tools", version: "0.1.0" }
      }
    });
    const sessionId = initialization.headers.get("mcp-session-id");
    await this.call(endpoints.mcpUrl, token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    }, sessionId);
    const tools = await this.call(endpoints.mcpUrl, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    }, sessionId);
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
      throw new NetSuiteMcpError("mcp-health-rejected", `NetSuite MCP 健康检查失败（HTTP ${response.status}）。请检查 SuiteApp、Role 与 OAuth scope。`);
    }
    return response;
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
