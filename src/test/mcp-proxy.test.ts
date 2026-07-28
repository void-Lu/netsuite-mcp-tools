import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionProfile } from "../domain/types";
import { OAuthClient } from "../net/oauth-client";
import { RedactedLogger } from "../services/redacted-logger";
import { McpProxy } from "../transport/mcp-proxy";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("McpProxy local boundary", () => {
  it("refuses a disabled route without trying to contact NetSuite", async () => {
    const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-proxy-"));
    roots.push(root);
    const profile: ConnectionProfile = {
      id: "read-profile",
      access: "read",
      status: "verified",
      clientId: "client",
      certificateId: "certificate",
      publicCertificatePath: "certificate.pem",
      privateKeyPath: "private.dpapi",
      expiresAt: "2027-07-28T00:00:00.000Z",
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    const proxy = new McpProxy(
      {} as OAuthClient,
      async () => ({
        profile,
        endpoints: {
          accountId: "9832121-sb1",
          host: "9832121-sb1.suitetalk.api.netsuite.com",
          tokenUrl: "https://example.invalid/token",
          mcpUrl: "https://example.invalid/mcp"
        },
        enabled: false
      }),
      new RedactedLogger(join(root, "logs"))
    );
    const port = await proxy.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/read-profile/mcp`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("未启用") });
    await proxy.stop();
  });
});
