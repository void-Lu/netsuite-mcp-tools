import { describe, expect, it, vi } from "vitest";
import { ConnectionProfile, NetSuiteMcpError } from "../domain/types";
import { OAuthClient } from "../net/oauth-client";
import { HealthCheckLogger, HealthCheckService } from "../services/health-check";
import { redactIdentifier } from "../util/redaction";

const profile: ConnectionProfile = {
  id: "profile-123456789",
  status: "registered",
  clientId: "client-id-must-not-appear-in-logs",
  createdAt: "2026-07-28T00:00:00.000Z"
};

const endpoints = {
  accountId: "9832121-sb1",
  host: "9832121-sb1.suitetalk.api.netsuite.com",
  authorizationUrl: "https://9832121-sb1.app.netsuite.com/app/login/oauth2/authorize.nl",
  tokenUrl: "https://9832121-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
  mcpUrl: "https://9832121-sb1.suitetalk.api.netsuite.com/services/mcp"
};

interface LogRecord {
  level: "info" | "error";
  event: string;
  fields: Record<string, unknown>;
}

function createLogger(records: LogRecord[]): HealthCheckLogger {
  return {
    async info(event, fields = {}) {
      records.push({ level: "info", event, fields });
    },
    async error(event, fields = {}) {
      records.push({ level: "error", event, fields });
    }
  };
}

function createOAuthClient(): OAuthClient {
  return {
    getAccessTokenWithMetadata: vi.fn(async () => ({
      accessToken: "access-token-must-not-appear-in-logs",
      httpStatus: 200
    }))
  } as unknown as OAuthClient;
}

describe("HealthCheckService phase logging", () => {
  it("records safe start and success events for all four zero-data phases", async () => {
    const records: LogRecord[] = [];
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "mcp-session-id": "session-id-must-not-appear-in-logs" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { tools: [{ name: "one" }, { name: "two" }] } }), { status: 200 }));
    const service = new HealthCheckService(createOAuthClient(), fetchImplementation, createLogger(records));

    await expect(service.verify(profile, endpoints)).resolves.toMatchObject({ initialized: true, listedTools: true, toolCount: 2 });

    expect(JSON.parse(fetchImplementation.mock.calls[0][1]?.body as string)).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-06-18" }
    });

    expect(records.map(({ level, event, fields }) => [level, event, fields.phase, fields.mcpMethod, fields.httpStatus])).toEqual([
      ["info", "health_check_phase_started", "token", null, null],
      ["info", "health_check_phase_succeeded", "token", null, 200],
      ["info", "health_check_phase_started", "initialize", "initialize", null],
      ["info", "health_check_phase_succeeded", "initialize", "initialize", 200],
      ["info", "health_check_phase_started", "notifications/initialized", "notifications/initialized", null],
      ["info", "health_check_phase_succeeded", "notifications/initialized", "notifications/initialized", 202],
      ["info", "health_check_phase_started", "tools/list", "tools/list", null],
      ["info", "health_check_phase_succeeded", "tools/list", "tools/list", 200]
    ]);
    for (const record of records) {
      expect(record.fields.profileId).toBe(redactIdentifier(profile.id));
    }
    for (const record of records.filter(({ event }) => event === "health_check_phase_succeeded")) {
      expect(record.fields.durationMs).toEqual(expect.any(Number));
    }
    expect(JSON.stringify(records)).not.toContain("access-token-must-not-appear-in-logs");
    expect(JSON.stringify(records)).not.toContain("client-id-must-not-appear-in-logs");
    expect(JSON.stringify(records)).not.toContain("session-id-must-not-appear-in-logs");
  });

  it("logs an MCP rejection with its HTTP status but never its response body", async () => {
    const records: LogRecord[] = [];
    const rejectedBody = JSON.stringify({
      authorization: "Bearer should-not-be-logged",
      access_token: "access-token-must-not-appear-in-logs",
      client_id: "client-id-must-not-appear-in-logs",
      certificate_id: "certificate-id-must-not-appear-in-logs",
      private_key: "private-key-must-not-appear-in-logs"
    });
    const service = new HealthCheckService(
      createOAuthClient(),
      vi.fn<typeof fetch>(async () => new Response(rejectedBody, { status: 403 })),
      createLogger(records)
    );

    await expect(service.verify(profile, endpoints)).rejects.toThrow(
      "NetSuite MCP 健康检查失败（HTTP 403）。请检查 SuiteApp、Role 与 OAuth scope。"
    );

    expect(records).toHaveLength(4);
    expect(records.at(-1)).toMatchObject({
      level: "error",
      event: "health_check_phase_failed",
      fields: {
        profileId: redactIdentifier(profile.id),
        phase: "initialize",
        mcpMethod: "initialize",
        httpStatus: 403
      }
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(rejectedBody);
    expect(serialized).not.toContain("should-not-be-logged");
    expect(serialized).not.toContain("access-token-must-not-appear-in-logs");
    expect(serialized).not.toContain("private-key-must-not-appear-in-logs");
  });

  it("preserves token failure status in the token phase event", async () => {
    const records: LogRecord[] = [];
    const oauthClient = {
      getAccessTokenWithMetadata: vi.fn(async () => {
        throw new NetSuiteMcpError("token-request-rejected", "既有的 token 失败提示。", undefined, 401);
      })
    } as unknown as OAuthClient;
    const service = new HealthCheckService(oauthClient, vi.fn<typeof fetch>(), createLogger(records));

    await expect(service.verify(profile, endpoints)).rejects.toThrow("既有的 token 失败提示。");

    expect(records).toEqual([
      {
        level: "info",
        event: "health_check_phase_started",
        fields: { profileId: redactIdentifier(profile.id), phase: "token", mcpMethod: null, httpStatus: null }
      },
      {
        level: "error",
        event: "health_check_phase_failed",
        fields: {
          profileId: redactIdentifier(profile.id),
          phase: "token",
          mcpMethod: null,
          durationMs: expect.any(Number),
          httpStatus: 401
        }
      }
    ]);
  });
});
