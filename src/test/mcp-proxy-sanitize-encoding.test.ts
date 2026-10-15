import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionProfile } from "../domain/types";
import { OAuthClient } from "../net/oauth-client";
import { RedactedLogger } from "../services/redacted-logger";
import { McpProxy } from "../transport/mcp-proxy";
import { SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX } from "../util/sanitize-mcp-tools";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("McpProxy tools/list sanitize encoding", () => {
  it("returns uncompressed JSON without content-encoding when upstream gzipped tools/list", async () => {
    const longDesc = "D".repeat(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX + 500);
    const upstreamBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [{ name: "ns_runCustomSuiteQL", description: longDesc, inputSchema: { type: "object", title: "bad" } }]
      }
    });
    const gzipped = gzipSync(Buffer.from(upstreamBody, "utf8"));

    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        expect(Buffer.concat(chunks).toString("utf8")).toContain("tools/list");
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(gzipped.byteLength)
        });
        res.end(gzipped);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no upstream port");
    }
    const upstreamPort = addr.port;

    const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-proxy-gzip-"));
    roots.push(root);
    const profile: ConnectionProfile = {
      id: "gzip-profile",
      status: "verified",
      clientId: "client",
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    const oauth = {
      getAccessToken: vi.fn(async () => "tok")
    } as unknown as OAuthClient;
    const proxy = new McpProxy(
      oauth,
      async () => ({
        profile,
        endpoints: {
          accountId: "9832121-sb1",
          host: "127.0.0.1",
          authorizationUrl: "https://example.invalid/authorize",
          tokenUrl: "https://example.invalid/token",
          mcpUrl: `http://127.0.0.1:${upstreamPort}/mcp`
        }
      }),
      new RedactedLogger(join(root, "logs"))
    );
    const port = await proxy.start(0);

    const response = await fetch(`http://127.0.0.1:${port}/gzip-profile/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "accept-encoding": "gzip, deflate, br"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    const json = (await response.json()) as {
      result: { tools: Array<{ description: string; inputSchema?: { title?: string } }> };
    };
    expect(json.result.tools[0].description.length).toBe(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX);
    expect(json.result.tools[0].inputSchema?.title).toBeUndefined();

    await proxy.stop();
    await new Promise<void>((resolve, reject) => upstream.close((err) => (err ? reject(err) : resolve())));
  });
});
