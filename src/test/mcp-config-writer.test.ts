import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { McpConfigWriter } from "../config/mcp-config-writer";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("McpConfigWriter", () => {
  it("preserves unrelated servers while writing both client formats", async () => {
    const { root, codexPath } = await workspace();
    await writeFile(join(root, ".mcp.json"), "{\n  // existing local MCP\n  \"mcpServers\": {\n    \"other\": { \"type\": \"http\", \"url\": \"http://127.0.0.1:3000/mcp\" }\n  }\n}\n");
    const writer = new McpConfigWriter(root, codexPath);
    await writer.install("profile-id", "9832121-sb1", "read", "http://127.0.0.1:51234/profile-id/mcp");

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, { url: string }> };
    expect(claude.mcpServers.other.url).toBe("http://127.0.0.1:3000/mcp");
    expect(claude.mcpServers["netsuite-mcp-9832121-sb1-read"].url).toContain("51234");
    expect(vscodeConfig.servers["netsuite-mcp-9832121-sb1-read"].url).toContain("profile-id");
  });

  it("refreshes both generated configs after repairing the local port", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    await writer.install("profile-id", "9832121-sb1", "read", "http://127.0.0.1:51234/profile-id/mcp");
    await writer.refreshExisting("9832121-sb1", "read", "http://127.0.0.1:54321/profile-id/mcp");

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, { url: string }> };
    expect(claude.mcpServers["netsuite-mcp-9832121-sb1-read"].url).toContain("54321");
    expect(vscodeConfig.servers["netsuite-mcp-9832121-sb1-read"].url).toContain("54321");
  });

  it("does not overwrite a non-owned server with the managed name", async () => {
    const { root, codexPath } = await workspace();
    await writeFile(join(root, ".mcp.json"), "{\n  \"mcpServers\": {\n    \"netsuite-mcp-9832121-read\": { \"command\": \"other-tool\" }\n  }\n}\n");
    const writer = new McpConfigWriter(root, codexPath);
    await expect(writer.install("profile-id", "9832121", "read", "http://127.0.0.1:51234/profile-id/mcp")).rejects.toThrow("其他工具使用");
    await expect(readFile(join(root, ".vscode", "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes all managed servers while preserving unrelated entries", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    await writer.install("read-profile", "9832121-sb1", "read", "http://127.0.0.1:51234/read-profile/mcp");
    await writer.install("write-profile", "9832121", "write", "http://127.0.0.1:51234/write-profile/mcp");

    const existing = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    existing.mcpServers["unrelated"] = { type: "http", url: "http://127.0.0.1:3000/mcp" };
    await writeFile(join(root, ".mcp.json"), `${JSON.stringify(existing, null, 2)}\n`);

    await writer.removeAllManaged();

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, unknown> };
    expect(claude.mcpServers["netsuite-mcp-9832121-sb1-read"]).toBeUndefined();
    expect(claude.mcpServers["netsuite-mcp-9832121-write"]).toBeUndefined();
    expect(claude.mcpServers["unrelated"]).toBeDefined();
    expect(vscodeConfig.servers["netsuite-mcp-9832121-sb1-read"]).toBeUndefined();
    expect(vscodeConfig.servers["netsuite-mcp-9832121-write"]).toBeUndefined();
  });

  it("does not modify files when no managed servers exist", async () => {
    const { root, codexPath } = await workspace();
    const original = "{\n  \"mcpServers\": {\n    \"other\": { \"type\": \"http\", \"url\": \"http://127.0.0.1:3000/mcp\" }\n  }\n}\n";
    await writeFile(join(root, ".mcp.json"), original);
    const writer = new McpConfigWriter(root, codexPath);

    await writer.removeAllManaged();

    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(original);
  });
});

describe("McpConfigWriter Codex TOML", () => {
  it("writes a streamable HTTP server entry with simplified name", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    await writer.installCodex("read", "http://127.0.0.1:51234/profile-id/mcp");

    const toml = await readFile(codexPath, "utf8");
    expect(toml).toContain("[mcp_servers.netsuite-mcp-read]");
    expect(toml).toContain('url = "http://127.0.0.1:51234/profile-id/mcp"');
    expect(toml).not.toContain("9832121");
  });

  it("preserves existing config.toml content when adding a managed server", async () => {
    const { root, codexPath } = await workspace();
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, 'model = "o3"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n');
    const writer = new McpConfigWriter(root, codexPath);
    await writer.installCodex("read", "http://127.0.0.1:51234/profile-id/mcp");

    const toml = await readFile(codexPath, "utf8");
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain('url = "https://example.com/mcp"');
    expect(toml).toContain("[mcp_servers.netsuite-mcp-read]");
    expect(toml).toContain('url = "http://127.0.0.1:51234/profile-id/mcp"');
  });

  it("updates the url when the managed server already exists", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    await writer.installCodex("read", "http://127.0.0.1:51234/profile-id/mcp");
    await writer.installCodex("read", "http://127.0.0.1:54321/profile-id/mcp");

    const toml = await readFile(codexPath, "utf8");
    expect(toml).toContain('url = "http://127.0.0.1:54321/profile-id/mcp"');
    expect(toml).not.toContain("51234");
  });

  it("refuses to overwrite a non-owned Codex server entry", async () => {
    const { root, codexPath } = await workspace();
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, '[mcp_servers.netsuite-mcp-read]\nurl = "https://remote.example.com/mcp"\n');
    const writer = new McpConfigWriter(root, codexPath);

    await expect(writer.installCodex("read", "http://127.0.0.1:51234/profile-id/mcp")).rejects.toThrow("其他工具使用");
  });

  it("detects conflict when existing Codex entry points to a different URL", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    await writer.installCodex("read", "http://127.0.0.1:51234/profile-a/mcp");

    const conflict = await writer.getCodexConflictUrl("read", "http://127.0.0.1:54321/profile-b/mcp");
    expect(conflict).toBe("http://127.0.0.1:51234/profile-a/mcp");
  });

  it("returns no conflict when Codex entry URL matches", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    await writer.installCodex("read", "http://127.0.0.1:51234/profile-a/mcp");

    const conflict = await writer.getCodexConflictUrl("read", "http://127.0.0.1:51234/profile-a/mcp");
    expect(conflict).toBeUndefined();
  });

  it("returns no conflict when Codex config does not exist", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);

    const conflict = await writer.getCodexConflictUrl("read", "http://127.0.0.1:51234/profile-a/mcp");
    expect(conflict).toBeUndefined();
  });

  it("removes only managed entries from config.toml", async () => {
    const { root, codexPath } = await workspace();
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, [
      'model = "o3"',
      "",
      "[mcp_servers.netsuite-mcp-read]",
      'url = "http://127.0.0.1:51234/profile-id/mcp"',
      "",
      "[mcp_servers.other]",
      'url = "https://example.com/mcp"',
      ""
    ].join("\n"));
    const writer = new McpConfigWriter(root, codexPath);

    await writer.removeAllManaged();

    const toml = await readFile(codexPath, "utf8");
    expect(toml).not.toContain("netsuite-mcp-read");
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain('model = "o3"');
  });

  it("does not modify config.toml when no managed servers exist", async () => {
    const { root, codexPath } = await workspace();
    await mkdir(dirname(codexPath), { recursive: true });
    const original = 'model = "o3"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n';
    await writeFile(codexPath, original);
    const writer = new McpConfigWriter(root, codexPath);

    await writer.removeAllManaged();

    expect(await readFile(codexPath, "utf8")).toBe(original);
  });

  it("refreshes config.toml url when the port changes", async () => {
    const { root, codexPath } = await workspace();
    const writer = new McpConfigWriter(root, codexPath);
    await writer.installCodex("read", "http://127.0.0.1:51234/profile-id/mcp");
    await writer.refreshExisting("9832121-sb1", "read", "http://127.0.0.1:54321/profile-id/mcp");

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
