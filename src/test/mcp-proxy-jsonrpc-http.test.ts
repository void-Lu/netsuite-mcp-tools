import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionProfile } from "../domain/types";
import { OAuthClient } from "../net/oauth-client";
import { RedactedLogger } from "../services/redacted-logger";
import { McpProxy } from "../transport/mcp-proxy";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function endpoints(mcpUrl: string) {
  return {
    accountId: "9832121-sb1",
    host: "127.0.0.1",
    authorizationUrl: "https://example.invalid/authorize",
    tokenUrl: "https://example.invalid/token",
    mcpUrl
  };
}

describe("McpProxy JSON-RPC HTTP status for Cline", () => {
  it("answers resources/templates/list locally with empty list and never hits upstream", async () => {
    let upstreamHits = 0;
    const upstream = createServer((_req, res) => {
      upstreamHits += 1;
      res.writeHead(500);
      res.end("should not be called");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no upstream port");
    }

    const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-proxy-templates-"));
    roots.push(root);
    const profile: ConnectionProfile = {
      id: "templates-profile",
      status: "verified",
      clientId: "client",
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    const oauth = {
      getAccessToken: vi.fn(async () => {
        throw new Error("OAuth must not run for local templates stub");
      })
    } as unknown as OAuthClient;
    const proxy = new McpProxy(
      oauth,
      async () => ({ profile, endpoints: endpoints(`http://127.0.0.1:${addr.port}/mcp`) }),
      new RedactedLogger(join(root, "logs"))
    );
    const port = await proxy.start(0);

    const response = await fetch(`http://127.0.0.1:${port}/templates-profile/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/templates/list", params: {} })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { resourceTemplates: [] }
    });
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
    expect(upstreamHits).toBe(0);

    await proxy.stop();
    await new Promise<void>((resolve, reject) => upstream.close((err) => (err ? reject(err) : resolve())));
  });

  it("rewrites upstream HTTP 400 JSON-RPC Capability not supported to HTTP 200", async () => {
    const errorBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32601, message: "Capability not supported" }
    });
    const upstream = createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(errorBody)) });
      res.end(errorBody);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no upstream port");
    }

    const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-proxy-400-"));
    roots.push(root);
    const profile: ConnectionProfile = {
      id: "rpc400-profile",
      status: "verified",
      clientId: "client",
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    const oauth = { getAccessToken: vi.fn(async () => "tok") } as unknown as OAuthClient;
    const proxy = new McpProxy(
      oauth,
      async () => ({ profile, endpoints: endpoints(`http://127.0.0.1:${addr.port}/mcp`) }),
      new RedactedLogger(join(root, "logs"))
    );
    const port = await proxy.start(0);

    const response = await fetch(`http://127.0.0.1:${port}/rpc400-profile/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "logging/setLevel", params: { level: "info" } })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(JSON.parse(errorBody));

    await proxy.stop();
    await new Promise<void>((resolve, reject) => upstream.close((err) => (err ? reject(err) : resolve())));
  });
});
