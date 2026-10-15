import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { CLINE_MCP_SERVER_NAME, McpConfigWriter, resolveClineSettingsPath } from "../config/mcp-config-writer";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("McpConfigWriter", () => {
  it("resolves the Cline settings override and user-level fallback", () => {
    const originalPath = process.env.CLINE_MCP_SETTINGS_PATH;
    process.env.CLINE_MCP_SETTINGS_PATH = "C:/test/cline-settings.json";
    try {
      expect(resolveClineSettingsPath()).toBe("C:/test/cline-settings.json");
    } finally {
      if (originalPath === undefined) {
        delete process.env.CLINE_MCP_SETTINGS_PATH;
      } else {
        process.env.CLINE_MCP_SETTINGS_PATH = originalPath;
      }
    }
    expect(resolveClineSettingsPath(undefined, "C:/home")).toBe(join("C:/home", ".cline", "data", "settings", "cline_mcp_settings.json"));
  });

  it("writes only Cline's fixed global key with streamableHttp and preserves siblings", async () => {
    const { root, codexPath } = await workspace();
    const clinePath = join(root, "cline-settings.json");
    await writeFile(clinePath, JSON.stringify({ mcpServers: { other: { type: "stdio", command: "other" } } }, null, 2));
    const writer = new McpConfigWriter(root, codexPath, clinePath);
    const url = "http://127.0.0.1:51234/profile-id/mcp";
    await writer.install(["cline"], "ws-hash-cline-001", url);

    const config = JSON.parse(await readFile(clinePath, "utf8")) as { mcpServers: Record<string, { type: string; url?: string; command?: string }> };
    expect(config.mcpServers.other.command).toBe("other");
    expect(config.mcpServers[CLINE_MCP_SERVER_NAME]).toEqual({ type: "streamableHttp", url });
    await expect(readFile(join(root, ".vscode", "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(codexPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces Cline's full URL on generation and rejects non-owned collisions", async () => {
    const { root, codexPath } = await workspace();
    const clinePath = join(root, "cline-settings.json");
    const writer = new McpConfigWriter(root, codexPath, clinePath);
    await writer.install(["cline"], "ws-hash-cline-002", "http://127.0.0.1:51234/first-profile/mcp");
    await writer.install(["cline"], "ws-hash-cline-002", "http://127.0.0.1:54321/second-profile/mcp");
    const config = JSON.parse(await readFile(clinePath, "utf8")) as { mcpServers: Record<string, { url: string }> };
    expect(config.mcpServers[CLINE_MCP_SERVER_NAME].url).toBe("http://127.0.0.1:54321/second-profile/mcp");

    const collision = JSON.stringify({ mcpServers: { [CLINE_MCP_SERVER_NAME]: { command: "other-tool" } } });
    await writeFile(clinePath, collision);
    await expect(writer.install(["cline"], "ws-hash-cline-002", "http://127.0.0.1:51234/profile-id/mcp")).rejects.toThrow("其他工具使用");
    expect(await readFile(clinePath, "utf8")).toBe(collision);
  });

  it("refreshes only an existing Cline entry with the matching profile path", async () => {
    const { root, codexPath } = await workspace();
    const clinePath = join(root, "cline-settings.json");
    const writer = new McpConfigWriter(root, codexPath, clinePath);
    await writer.install(["cline"], "ws-hash-cline-003", "http://127.0.0.1:51234/profile-id/mcp");
    await writer.refreshExisting("ws-hash-cline-003", "http://127.0.0.1:54321/profile-id/mcp");
    const config = JSON.parse(await readFile(clinePath, "utf8")) as { mcpServers: Record<string, { url: string }> };
    expect(config.mcpServers[CLINE_MCP_SERVER_NAME].url).toBe("http://127.0.0.1:54321/profile-id/mcp");

    const beforeOtherProfile = await readFile(clinePath, "utf8");
    await writer.refreshExisting("ws-hash-cline-003", "http://127.0.0.1:55555/another-profile/mcp");
    expect(await readFile(clinePath, "utf8")).toBe(beforeOtherProfile);

    await rm(clinePath);
    await writer.refreshExisting("ws-hash-cline-003", "http://127.0.0.1:55555/profile-id/mcp");
    await expect(readFile(clinePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans only the owned exact Cline key and leaves it alone for other targets", async () => {
    const { root, codexPath } = await workspace();
    const clinePath = join(root, "cline-settings.json");
    await writeFile(clinePath, JSON.stringify({ mcpServers: {
      [CLINE_MCP_SERVER_NAME]: { type: "streamableHttp", url: "http://127.0.0.1:51234/profile-id/mcp" },
      "netsuite-mcp-other": { type: "http", url: "http://127.0.0.1:51234/other/mcp" },
      unrelated: { type: "stdio", command: "other" }
    } }, null, 2));
    const writer = new McpConfigWriter(root, codexPath, clinePath);
    await writer.removeAllManaged(["claude-code"]);
    const unchanged = await readFile(clinePath, "utf8");
    expect(JSON.parse(unchanged).mcpServers[CLINE_MCP_SERVER_NAME]).toBeDefined();

    await writer.removeAllManaged(["cline"]);
    const config = JSON.parse(await readFile(clinePath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers[CLINE_MCP_SERVER_NAME]).toBeUndefined();
    expect(config.mcpServers["netsuite-mcp-other"]).toBeDefined();
    expect(config.mcpServers.unrelated).toBeDefined();

    await writeFile(clinePath, JSON.stringify({ mcpServers: {
      [CLINE_MCP_SERVER_NAME]: { type: "http", url: "http://127.0.0.1:51234/profile-id/mcp" }
    } }));
    await writer.removeAllManaged(["cline"]);
    expect(JSON.parse(await readFile(clinePath, "utf8")).mcpServers[CLINE_MCP_SERVER_NAME]).toBeUndefined();

    await writeFile(clinePath, JSON.stringify({ mcpServers: {
      [CLINE_MCP_SERVER_NAME]: { type: "stdio", command: "other-tool" }
    } }));
    await writer.removeAllManaged(["cline"]);
    expect(JSON.parse(await readFile(clinePath, "utf8")).mcpServers[CLINE_MCP_SERVER_NAME].command).toBe("other-tool");
  });

  it("skips workspace Git checks for Cline settings outside the workspace", async () => {
    const { root, codexPath } = await workspace();
    const settingsRoot = await mkdtemp(join(tmpdir(), "netsuite-mcp-cline-"));
    roots.push(settingsRoot);
    const clinePath = join(settingsRoot, "cline-settings.json");
    await rm(root, { recursive: true, force: true });
    const writer = new McpConfigWriter(root, codexPath, clinePath);

    await writer.install(["cline"], "ws-hash-cline-004", "http://127.0.0.1:51234/profile-id/mcp");
    expect(JSON.parse(await readFile(clinePath, "utf8")).mcpServers[CLINE_MCP_SERVER_NAME].type).toBe("streamableHttp");
  });

  it("preserves unrelated servers while writing both client formats", async () => {
    const { root, codexPath } = await workspace();
    await writeFile(join(root, ".mcp.json"), "{\n  // existing local MCP\n  \"mcpServers\": {\n    \"other\": { \"type\": \"http\", \"url\": \"http://127.0.0.1:3000/mcp\" }\n  }\n}\n");
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-001";
    await writer.install(["vscode", "claude-code"], workspaceId, "http://127.0.0.1:51234/profile-id/mcp");

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, { url: string }> };
    expect(claude.mcpServers.other.url).toBe("http://127.0.0.1:3000/mcp");
    expect(claude.mcpServers[`netsuite-mcp-${workspaceId}`].url).toContain("51234");
    expect(vscodeConfig.servers[`netsuite-mcp-${workspaceId}`].url).toContain("profile-id");
  });

  it("writes only to selected agents", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-002";
    await writer.install(["claude-code"], workspaceId, "http://127.0.0.1:51234/profile-id/mcp");

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    expect(claude.mcpServers[`netsuite-mcp-${workspaceId}`].url).toContain("51234");
    await expect(readFile(join(root, ".vscode", "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refreshes both generated configs after repairing the local port", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-003";
    await writer.install(["vscode", "claude-code"], workspaceId, "http://127.0.0.1:51234/profile-id/mcp");
    await writer.refreshExisting(workspaceId, "http://127.0.0.1:54321/profile-id/mcp");

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, { url: string }> };
    expect(claude.mcpServers[`netsuite-mcp-${workspaceId}`].url).toContain("54321");
    expect(vscodeConfig.servers[`netsuite-mcp-${workspaceId}`].url).toContain("54321");
  });

  it("does not overwrite a non-owned server with the managed name", async () => {
    const { root, codexPath } = await workspace();
    const workspaceId = "ws-hash-004";
    await writeFile(join(root, ".mcp.json"), `{\n  "mcpServers": {\n    "netsuite-mcp-${workspaceId}": { "command": "other-tool" }\n  }\n}\n`);
    const writer = new McpConfigWriter(root, codexPath);
    await expect(writer.install(["claude-code"], workspaceId, "http://127.0.0.1:51234/profile-id/mcp")).rejects.toThrow("其他工具使用");
    await expect(readFile(join(root, ".vscode", "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes all managed servers while preserving unrelated entries", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-005";
    await writer.install(["vscode", "claude-code"], workspaceId, "http://127.0.0.1:51234/profile-id/mcp");

    const existing = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    existing.mcpServers["unrelated"] = { type: "http", url: "http://127.0.0.1:3000/mcp" };
    await writeFile(join(root, ".mcp.json"), `${JSON.stringify(existing, null, 2)}\n`);

    await writer.removeAllManaged(["vscode", "claude-code"]);

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, unknown> };
    expect(claude.mcpServers[`netsuite-mcp-${workspaceId}`]).toBeUndefined();
    expect(claude.mcpServers["unrelated"]).toBeDefined();
    expect(vscodeConfig.servers[`netsuite-mcp-${workspaceId}`]).toBeUndefined();
  });

  it("removes only selected agents when cleaning", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-006";
    await writer.install(["vscode", "claude-code"], workspaceId, "http://127.0.0.1:51234/profile-id/mcp");

    await writer.removeAllManaged(["claude-code"]);

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, unknown> };
    expect(claude.mcpServers[`netsuite-mcp-${workspaceId}`]).toBeUndefined();
    expect(vscodeConfig.servers[`netsuite-mcp-${workspaceId}`]).toBeDefined();
  });

  it("does not modify files when no managed servers exist", async () => {
    const { root, codexPath } = await workspace();
    const original = "{\n  \"mcpServers\": {\n    \"other\": { \"type\": \"http\", \"url\": \"http://127.0.0.1:3000/mcp\" }\n  }\n}\n";
    await writeFile(join(root, ".mcp.json"), original);
    const writer = new McpConfigWriter(root, codexPath);

    await writer.removeAllManaged(["vscode", "claude-code"]);

    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(original);
  });
});

describe("McpConfigWriter Codex TOML", () => {
  it("defaults to the workspace-scoped .codex/config.toml", async () => {
    const { root } = await workspace();
    const writer = new McpConfigWriter(root);
    const workspaceId = "ws-hash-codex-project";
    await writer.install(["codex"], workspaceId, "http://127.0.0.1:51234/profile-id/mcp");

    const toml = await readFile(join(root, ".codex", "config.toml"), "utf8");
    expect(toml).toContain(`[mcp_servers.netsuite-mcp-${workspaceId}]`);
  });

  it("writes a streamable HTTP server entry with workspaceId name", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-codex-001";
    await writer.installCodex(workspaceId, "http://127.0.0.1:51234/profile-id/mcp");

    const toml = await readFile(codexPath, "utf8");
    expect(toml).toContain(`[mcp_servers.netsuite-mcp-${workspaceId}]`);
    expect(toml).toContain('url = "http://127.0.0.1:51234/profile-id/mcp"');
  });

  it("preserves existing config.toml content when adding a managed server", async () => {
    const { root, codexPath } = await workspace();
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, 'model = "o3"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n');
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-codex-002";
    await writer.installCodex(workspaceId, "http://127.0.0.1:51234/profile-id/mcp");

    const toml = await readFile(codexPath, "utf8");
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain('url = "https://example.com/mcp"');
    expect(toml).toContain(`[mcp_servers.netsuite-mcp-${workspaceId}]`);
    expect(toml).toContain('url = "http://127.0.0.1:51234/profile-id/mcp"');
  });

  it("updates the url when the managed server already exists", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-codex-003";
    await writer.installCodex(workspaceId, "http://127.0.0.1:51234/profile-id/mcp");
    await writer.installCodex(workspaceId, "http://127.0.0.1:54321/profile-id/mcp");

    const toml = await readFile(codexPath, "utf8");
    expect(toml).toContain('url = "http://127.0.0.1:54321/profile-id/mcp"');
    expect(toml).not.toContain("51234");
  });

  it("refuses to overwrite a non-owned Codex server entry", async () => {
    const { root, codexPath } = await workspace();
    const workspaceId = "ws-hash-codex-004";
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, `[mcp_servers.netsuite-mcp-${workspaceId}]\nurl = "https://remote.example.com/mcp"\n`);
    const writer = new McpConfigWriter(root, codexPath);

    await expect(writer.installCodex(workspaceId, "http://127.0.0.1:51234/profile-id/mcp")).rejects.toThrow("其他工具使用");
  });

  it("removes a specific Codex entry by name", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    await writer.installCodex("ws-a", "http://127.0.0.1:51234/profile-a/mcp");
    await writer.installCodex("ws-b", "http://127.0.0.1:54321/profile-b/mcp");

    await writer.removeCodexServer("netsuite-mcp-ws-a");

    const toml = await readFile(codexPath, "utf8");
    expect(toml).not.toContain("netsuite-mcp-ws-a");
    expect(toml).toContain("netsuite-mcp-ws-b");
  });

  it("removes only managed entries from config.toml", async () => {
    const { root, codexPath } = await workspace();
    const workspaceId = "ws-hash-codex-005";
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, [
      'model = "o3"',
      "",
      `[mcp_servers.netsuite-mcp-${workspaceId}]`,
      'url = "http://127.0.0.1:51234/profile-id/mcp"',
      "",
      "[mcp_servers.other]",
      'url = "https://example.com/mcp"',
      ""
    ].join("\n"));
    const writer = new McpConfigWriter(root, codexPath);

    await writer.removeAllManaged(["codex"]);

    const toml = await readFile(codexPath, "utf8");
    expect(toml).not.toContain(`netsuite-mcp-${workspaceId}`);
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain('model = "o3"');
  });

  it("does not modify config.toml when no managed servers exist", async () => {
    const { root, codexPath } = await workspace();
    await mkdir(dirname(codexPath), { recursive: true });
    const original = 'model = "o3"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n';
    await writeFile(codexPath, original);
    const writer = new McpConfigWriter(root, codexPath);

    await writer.removeAllManaged(["codex"]);

    expect(await readFile(codexPath, "utf8")).toBe(original);
  });

  it("refreshes config.toml url when the port changes", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    const workspaceId = "ws-hash-codex-006";
    await writer.installCodex(workspaceId, "http://127.0.0.1:51234/profile-id/mcp");
    await writer.refreshExisting(workspaceId, "http://127.0.0.1:54321/profile-id/mcp");

    const toml = await readFile(codexPath, "utf8");
    expect(toml).toContain('url = "http://127.0.0.1:54321/profile-id/mcp"');
    expect(toml).not.toContain("51234");
  });
});

async function workspace(): Promise<{ root: string; codexPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-config-"));
  roots.push(root);
  const codexPath = join(root, ".codex", "config.toml");
  return { root, codexPath };
}
