import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { McpConfigWriter } from "../config/mcp-config-writer";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("McpConfigWriter", () => {
  it("preserves unrelated servers while writing both client formats", async () => {
    const root = await workspace();
    await writeFile(join(root, ".mcp.json"), "{\n  // existing local MCP\n  \"mcpServers\": {\n    \"other\": { \"type\": \"http\", \"url\": \"http://127.0.0.1:3000/mcp\" }\n  }\n}\n");
    const writer = new McpConfigWriter(root);
    await writer.install("profile-id", "9832121-sb1", "read", "http://127.0.0.1:51234/profile-id/mcp");

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, { url: string }> };
    expect(claude.mcpServers.other.url).toBe("http://127.0.0.1:3000/mcp");
    expect(claude.mcpServers["netsuite-mcp-9832121-sb1-read"].url).toContain("51234");
    expect(vscodeConfig.servers["netsuite-mcp-9832121-sb1-read"].url).toContain("profile-id");
  });

  it("refreshes both generated configs after repairing the local port", async () => {
    const root = await workspace();
    const writer = new McpConfigWriter(root);
    await writer.install("profile-id", "9832121-sb1", "read", "http://127.0.0.1:51234/profile-id/mcp");
    await writer.refreshExisting("9832121-sb1", "read", "http://127.0.0.1:54321/profile-id/mcp");

    const claude = parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    const vscodeConfig = JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8")) as { servers: Record<string, { url: string }> };
    expect(claude.mcpServers["netsuite-mcp-9832121-sb1-read"].url).toContain("54321");
    expect(vscodeConfig.servers["netsuite-mcp-9832121-sb1-read"].url).toContain("54321");
  });

  it("does not overwrite a non-owned server with the managed name", async () => {
    const root = await workspace();
    await writeFile(join(root, ".mcp.json"), "{\n  \"mcpServers\": {\n    \"netsuite-mcp-9832121-read\": { \"command\": \"other-tool\" }\n  }\n}\n");
    const writer = new McpConfigWriter(root);
    await expect(writer.install("profile-id", "9832121", "read", "http://127.0.0.1:51234/profile-id/mcp")).rejects.toThrow("其他工具使用");
    await expect(readFile(join(root, ".vscode", "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-config-"));
  roots.push(root);
  return root;
}
