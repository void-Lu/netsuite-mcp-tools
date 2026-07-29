import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionProfile, NetSuiteMcpError } from "../domain/types";
import { OAuthClient } from "../net/oauth-client";
import { RedactedLogger } from "../services/redacted-logger";
import { McpProxy } from "../transport/mcp-proxy";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("McpProxy local boundary", () => {
  it("refuses an unavailable route without trying to contact NetSuite", async () => {
    const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-proxy-"));
    roots.push(root);
    const proxy = new McpProxy(
      {} as OAuthClient,
      async () => undefined,
      new RedactedLogger(join(root, "logs"))
    );
    const port = await proxy.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/read-profile/mcp`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("未启用") });
    await proxy.stop();
  });

  it("handles OAuth callbacks only on the exact loopback callback route", async () => {
    const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-proxy-"));
    roots.push(root);
    const oauth = {
      completeAuthorizationCallback: vi.fn(async () => ({ statusCode: 200, message: "完成" }))
    } as unknown as OAuthClient;
    const proxy = new McpProxy(oauth, async () => undefined, new RedactedLogger(join(root, "logs")));
    const port = await proxy.start(0);

    const success = await fetch(`http://127.0.0.1:${port}/oauth/callback?state=never-log-this`);
    expect(success.status).toBe(200);
    expect(await success.text()).toContain("完成");
    expect(oauth.completeAuthorizationCallback).toHaveBeenCalledTimes(1);

    const rejectedMethod = await fetch(`http://127.0.0.1:${port}/oauth/callback`, { method: "POST" });
    expect(rejectedMethod.status).toBe(405);
    expect(oauth.completeAuthorizationCallback).toHaveBeenCalledTimes(1);
    await proxy.stop();
  });

  it("returns a safe browser-authorization instruction when a proxy route has no in-memory token", async () => {
    const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-proxy-"));
    roots.push(root);
    const profile: ConnectionProfile = { id: "needs-auth", status: "verified", clientId: "client", createdAt: "2026-07-28T00:00:00.000Z" };
    const oauth = {
      getAccessToken: vi.fn(async () => {
        throw new NetSuiteMcpError("authorization-required", "尚未在本次 VS Code 会话中授权 NetSuite。请运行“NetSuite MCP：启动连接”并在浏览器中完成登录。");
      })
    } as unknown as OAuthClient;
    const proxy = new McpProxy(oauth, async () => ({
      profile,
      endpoints: {
        accountId: "9832121-sb1",
        host: "9832121-sb1.suitetalk.api.netsuite.com",
        authorizationUrl: "https://9832121-sb1.app.netsuite.com/app/login/oauth2/authorize.nl",
        tokenUrl: "https://example.invalid/token",
        mcpUrl: "https://example.invalid/mcp"
      }
    }), new RedactedLogger(join(root, "logs")));
    const port = await proxy.start(0);

    const response = await fetch(`http://127.0.0.1:${port}/needs-auth/mcp`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("启动连接") });
    await proxy.stop();
  });
});
