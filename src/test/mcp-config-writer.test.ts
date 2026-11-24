import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { ANTIGRAVITY_MCP_SERVER_NAME, CLINE_MCP_SERVER_NAME, McpConfigWriter, resolveClineSettingsPath } from "../config/mcp-config-writer";

const roots: string[] = [];
const git = promisify(execFile);

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

describe("McpConfigWriter Antigravity", () => {
  const workspaceId = "ws-antigravity";
  const name = ANTIGRAVITY_MCP_SERVER_NAME;
  const legacyName = `netsuite-mcp-${workspaceId}`;
  const url = "http://127.0.0.1:51234/selected-profile/mcp";

  async function antigravityWorkspace() {
    const { root, codexPath } = await workspace();
    const path = join(root, ".agents", "mcp_config.json");
    const clinePath = join(root, "cline-settings.json");
    const writer = new McpConfigWriter(root, codexPath, clinePath);
    return { root, path, writer };
  }

  it("creates only the selected workspace config and adds a Git ignore rule to an existing workspace", async () => {
    const { root, path, writer } = await antigravityWorkspace();
    const ignorePath = join(root, ".gitignore");
    const originalIgnore = "# Keep these rules\r\n/.mcp.json";
    await git("git", ["init", "-q"], { cwd: root });
    await writeFile(ignorePath, originalIgnore);

    await writer.install(["claude-code"], workspaceId, url);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(ignorePath, "utf8")).toBe(originalIgnore);
    const claudePath = join(root, ".mcp.json");
    const claudeConfig = await readFile(claudePath, "utf8");

    await mkdir(dirname(path));
    const sibling = join(dirname(path), "workflow.md");
    await writeFile(sibling, "Existing workflow");
    await writer.install(["antigravity"], workspaceId, url);
    await writer.install(["antigravity"], workspaceId, url);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { [name]: { serverUrl: url } } });
    expect(await readFile(ignorePath, "utf8")).toBe(`${originalIgnore}\r\n/.agents/mcp_config.json\r\n`);
    await expect(git("git", ["check-ignore", "-q", "--", ".agents/mcp_config.json"], { cwd: root })).resolves.toBeDefined();
    await expect(git("git", ["check-ignore", "-q", "--", ".agents/workflow.md"], { cwd: root })).rejects.toMatchObject({ code: 1 });
    expect(await readFile(sibling, "utf8")).toBe("Existing workflow");
    expect(await readFile(claudePath, "utf8")).toBe(claudeConfig);
  });

  it("changes the selected connection on generation while keeping sibling servers and settings", async () => {
    const { path, writer } = await antigravityWorkspace();
    await mkdir(dirname(path));
    const original = {
      settings: { keep: true },
      mcpServers: {
        [name]: { serverUrl: url, disabled: true },
        other: { command: "other-tool" }
      }
    };
    await writeFile(path, JSON.stringify(original, null, 2));

    const newUrl = "http://127.0.0.1:54321/another-profile/mcp";
    await writer.install(["antigravity"], workspaceId, newUrl);

    original.mcpServers[name].serverUrl = newUrl;
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
  });

  it("refreshes only an existing Antigravity URL for the matching profile", async () => {
    const { path, writer } = await antigravityWorkspace();
    const newUrl = "http://127.0.0.1:54321/selected-profile/mcp";
    await writer.refreshExisting(workspaceId, newUrl);
    await writer.removeAllManaged(["antigravity"]);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writer.install(["antigravity"], workspaceId, url);
    const original = await readFile(path, "utf8");
    await writer.refreshExisting(workspaceId, "http://127.0.0.1:54321/another-profile/mcp");
    expect(await readFile(path, "utf8")).toBe(original);

    await writer.refreshExisting("different-workspace", newUrl);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { [name]: { serverUrl: newUrl } } });
  });

  it("cleans only managed loopback MCP routes from the selected Agent", async () => {
    const { path, writer } = await antigravityWorkspace();
    await mkdir(dirname(path));
    const otherServers = {
      "netsuite-mcp-remote": { serverUrl: "https://example.com/selected-profile/mcp" },
      "netsuite-mcp-stdio": { command: "other-tool" },
      "netsuite-mcp-loopback": { serverUrl: "http://127.0.0.1:51234/another-service" },
      unrelated: { serverUrl: url }
    };
    const original = JSON.stringify({ settings: true, mcpServers: { [name]: { serverUrl: url }, ...otherServers } }, null, 2);
    await writeFile(path, original);

    await writer.removeAllManaged(["claude-code"]);
    expect(await readFile(path, "utf8")).toBe(original);
    await writer.removeAllManaged(["antigravity"]);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ settings: true, mcpServers: otherServers });
  });

  it.each([
    { serverUrl: "https://example.com/selected-profile/mcp" },
    { command: "other-tool" },
    { command: "other-tool", serverUrl: url },
    { serverUrl: "http://127.0.0.1:51234/another-service" }
  ])("preserves a conflicting Antigravity entry %j", async (foreign) => {
    const { root, path, writer } = await antigravityWorkspace();
    await mkdir(dirname(path));
    const original = JSON.stringify({ mcpServers: { [name]: foreign } });
    await writeFile(path, original);

    await expect(writer.install(["antigravity"], workspaceId, url)).rejects.toMatchObject({ code: "mcp-name-conflict" });
    await writer.refreshExisting(workspaceId, "http://127.0.0.1:54321/selected-profile/mcp");
    await writer.removeAllManaged(["antigravity"]);
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(readFile(join(root, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["", "{ broken", "[]", '{"mcpServers": []}', '{"mcpServers": null}'])(
    "reports an invalid Antigravity config %j and preserves its contents", async (original) => {
      const { path, writer } = await antigravityWorkspace();
      await mkdir(dirname(path));
      await writeFile(path, original);

      await expect(writer.install(["antigravity"], workspaceId, url)).rejects.toMatchObject({ code: "invalid-mcp-config" });
      await expect(writer.removeAllManaged(["antigravity"])).rejects.toMatchObject({ code: "invalid-mcp-config" });
      expect(await readFile(path, "utf8")).toBe(original);
    }
  );

  it("protects tracked Antigravity config while other Agents can still refresh", async () => {
    const { root, path, writer } = await antigravityWorkspace();
    await git("git", ["init", "-q"], { cwd: root });
    await mkdir(dirname(path));
    const original = JSON.stringify({ mcpServers: { [name]: { serverUrl: url } } });
    await writeFile(path, original);
    await git("git", ["add", "-f", "--", ".agents/mcp_config.json"], { cwd: root });

    const newUrl = "http://127.0.0.1:54321/selected-profile/mcp";
    await expect(writer.install(["claude-code", "antigravity"], workspaceId, newUrl)).rejects.toMatchObject({ code: "mcp-config-tracked" });
    await expect(writer.removeAllManaged(["antigravity"])).rejects.toMatchObject({ code: "mcp-config-tracked" });
    await expect(readFile(join(root, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const claudePath = join(root, ".mcp.json");
    await expect(readFile(claudePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writer.install(["claude-code"], workspaceId, url);
    await writer.refreshExisting(workspaceId, newUrl);
    expect(await readFile(claudePath, "utf8")).toContain(newUrl);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("protects an Antigravity config tracked under a differently cased directory", async () => {
    const { root, path, writer } = await antigravityWorkspace();
    await git("git", ["init", "-q"], { cwd: root });
    await git("git", ["config", "core.ignorecase", "true"], { cwd: root });
    const trackedPath = join(root, ".Agents", "mcp_config.json");
    await mkdir(dirname(trackedPath));
    const original = JSON.stringify({ mcpServers: { [name]: { serverUrl: url } } });
    await writeFile(trackedPath, original);
    await git("git", ["add", "-f", "--", ".Agents/mcp_config.json"], { cwd: root });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, original);

    const newUrl = "http://127.0.0.1:54321/selected-profile/mcp";
    await expect(writer.install(["antigravity"], workspaceId, newUrl)).rejects.toMatchObject({ code: "mcp-config-tracked" });
    await expect(writer.removeAllManaged(["antigravity"])).rejects.toMatchObject({ code: "mcp-config-tracked" });
    await writer.refreshExisting(workspaceId, newUrl);

    expect(await readFile(path, "utf8")).toBe(original);
    await expect(readFile(join(root, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the generated config ignored when a workspace rule previously re-included it", async () => {
    const { root, writer } = await antigravityWorkspace();
    const ignorePath = join(root, ".gitignore");
    const rule = "/.agents/mcp_config.json\n";
    const original = `${rule}!${rule}`;
    await git("git", ["init", "-q"], { cwd: root });
    await writeFile(ignorePath, original);

    await writer.install(["antigravity"], workspaceId, url);
    await writer.install(["antigravity"], workspaceId, url);

    expect(await readFile(ignorePath, "utf8")).toBe(`${original}${rule}`);
    await expect(git("git", ["check-ignore", "-q", "--", ".agents/mcp_config.json"], { cwd: root })).resolves.toBeDefined();
  });

  it("keeps the config unwritten when a nested rule re-includes it", async () => {
    const { root, path, writer } = await antigravityWorkspace();
    await git("git", ["init", "-q"], { cwd: root });
    await mkdir(dirname(path));
    const nestedIgnore = join(dirname(path), ".gitignore");
    await writeFile(nestedIgnore, "!/mcp_config.json\n");

    await expect(writer.install(["antigravity"], workspaceId, url)).rejects.toMatchObject({ code: "mcp-config-not-ignored" });

    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(nestedIgnore, "utf8")).toBe("!/mcp_config.json\n");
  });

  it("migrates owned long-hash Antigravity entries to the short key and leaves others alone", async () => {
    const { path, writer } = await antigravityWorkspace();
    await mkdir(dirname(path));
    const otherWorkspace = "netsuite-mcp-" + "ab".repeat(32);
    const staleUrl = "http://127.0.0.1:51234/selected-profile/mcp";
    const original = {
      settings: { keep: true },
      mcpServers: {
        [legacyName]: { serverUrl: staleUrl, disabled: true },
        [otherWorkspace]: { serverUrl: "http://127.0.0.1:52000/selected-profile/mcp" },
        "netsuite-mcp-remote": { serverUrl: "https://example.com/selected-profile/mcp" },
        other: { command: "other-tool" }
      }
    };
    await writeFile(path, JSON.stringify(original, null, 2));

    const newUrl = "http://127.0.0.1:54321/selected-profile/mcp";
    await writer.install(["antigravity"], workspaceId, newUrl);

    const config = JSON.parse(await readFile(path, "utf8")) as {
      settings: { keep: boolean };
      mcpServers: Record<string, { serverUrl?: string; command?: string; disabled?: boolean }>;
    };
    expect(config.settings).toEqual({ keep: true });
    expect(config.mcpServers[name]).toEqual({ serverUrl: newUrl });
    expect(config.mcpServers[legacyName]).toBeUndefined();
    expect(config.mcpServers[otherWorkspace]).toBeUndefined();
    expect(config.mcpServers["netsuite-mcp-remote"]).toEqual({ serverUrl: "https://example.com/selected-profile/mcp" });
    expect(config.mcpServers.other).toEqual({ command: "other-tool" });
  });

  it("refreshes a short Antigravity URL and migrates a leftover long-hash entry on port change", async () => {
    const { path, writer } = await antigravityWorkspace();
    await mkdir(dirname(path));
    await writeFile(path, JSON.stringify({
      mcpServers: {
        [legacyName]: { serverUrl: url },
        other: { command: "other-tool" }
      }
    }, null, 2));

    const newUrl = "http://127.0.0.1:54321/selected-profile/mcp";
    await writer.refreshExisting(workspaceId, "http://127.0.0.1:54321/another-profile/mcp");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: {
        [legacyName]: { serverUrl: url },
        other: { command: "other-tool" }
      }
    });

    await writer.refreshExisting(workspaceId, newUrl);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: {
        [name]: { serverUrl: newUrl },
        other: { command: "other-tool" }
      }
    });
  });

  it("updates a stale short Antigravity URL and removes a duplicate long-hash entry during refresh", async () => {
    const { path, writer } = await antigravityWorkspace();
    await mkdir(dirname(path));
    await writeFile(path, JSON.stringify({
      mcpServers: {
        [name]: { serverUrl: url },
        [legacyName]: { serverUrl: url }
      }
    }, null, 2));

    const newUrl = "http://127.0.0.1:54321/selected-profile/mcp";
    await writer.refreshExisting(workspaceId, newUrl);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { [name]: { serverUrl: newUrl } } });
  });

  it("cleans the short Antigravity key and leftover owned long-hash entries together", async () => {
    const { path, writer } = await antigravityWorkspace();
    await mkdir(dirname(path));
    const otherServers = {
      "netsuite-mcp-remote": { serverUrl: "https://example.com/selected-profile/mcp" },
      "netsuite-mcp-stdio": { command: "other-tool" },
      unrelated: { serverUrl: url }
    };
    await writeFile(path, JSON.stringify({
      settings: true,
      mcpServers: {
        [name]: { serverUrl: url },
        [legacyName]: { serverUrl: url },
        ...otherServers
      }
    }, null, 2));

    await writer.removeAllManaged(["antigravity"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ settings: true, mcpServers: otherServers });
  });

  it("keeps Antigravity-prefixed tool names within the 64-character client limit", async () => {
    const { path, writer } = await antigravityWorkspace();
    const longWorkspaceId = "a".repeat(64);
    await writer.install(["antigravity"], longWorkspaceId, url);
    const config = JSON.parse(await readFile(path, "utf8")) as { mcpServers: Record<string, { serverUrl: string }> };
    expect(Object.keys(config.mcpServers)).toEqual([name]);
    const tools = ["ns_getRecord", "ns_runCustomSuiteQL", "ns_createRecord", "ns_updateRecord", "ns_deleteRecord"];
    for (const tool of tools) {
      const prefixed = `mcp_${name}_${tool}`;
      expect(prefixed.length, prefixed).toBeLessThanOrEqual(64);
    }
    expect(`mcp_netsuite-mcp-${longWorkspaceId}_ns_getRecord`.length).toBeGreaterThan(64);
  });

  it("rejects an .agents link to a directory outside the workspace", async () => {
    const { path, writer } = await antigravityWorkspace();
    const { root: outside } = await workspace();
    await symlink(outside, dirname(path), process.platform === "win32" ? "junction" : "dir");
    const outsidePath = join(outside, "mcp_config.json");
    const original = JSON.stringify({ mcpServers: { [name]: { serverUrl: url } } });
    await writeFile(outsidePath, original);

    await expect(writer.install(["antigravity"], workspaceId, url)).rejects.toMatchObject({ code: "mcp-config-symlink" });
    await expect(writer.removeAllManaged(["antigravity"])).rejects.toMatchObject({ code: "mcp-config-symlink" });
    await writer.refreshExisting(workspaceId, "http://127.0.0.1:54321/selected-profile/mcp");
    expect(await readFile(outsidePath, "utf8")).toBe(original);
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
