import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";
import { applyEdits, modify, parse, ParseError } from "jsonc-parser";
import { AccessMode, ManagedMcpServer, NetSuiteMcpError } from "../domain/types";
import { atomicWriteFile, ensureDirectory, readTextIfExists } from "../util/files";

const execFileAsync = promisify(execFile);
const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

export class McpConfigWriter {
  public constructor(private readonly workspaceRoot: string) {}

  public async install(profileId: string, accountId: string, access: AccessMode, url: string): Promise<ManagedMcpServer> {
    const server: ManagedMcpServer = {
      name: managedServerName(accountId, access),
      access,
      url
    };
    const changes = await Promise.all([
      this.prepareUpsert(join(this.workspaceRoot, ".vscode", "mcp.json"), "servers", server),
      this.prepareUpsert(join(this.workspaceRoot, ".mcp.json"), "mcpServers", server)
    ]);
    await Promise.all(changes.map(({ path, next }) => atomicWriteFile(path, next)));
    return server;
  }

  public async remove(accountId: string, access: AccessMode): Promise<void> {
    const name = managedServerName(accountId, access);
    await Promise.all([
      this.removeServer(join(this.workspaceRoot, ".vscode", "mcp.json"), "servers", name),
      this.removeServer(join(this.workspaceRoot, ".mcp.json"), "mcpServers", name)
    ]);
  }

  public async refreshExisting(accountId: string, access: AccessMode, url: string): Promise<void> {
    const server: ManagedMcpServer = { name: managedServerName(accountId, access), access, url };
    await Promise.all([
      this.refreshIfOwned(join(this.workspaceRoot, ".vscode", "mcp.json"), "servers", server),
      this.refreshIfOwned(join(this.workspaceRoot, ".mcp.json"), "mcpServers", server)
    ]);
  }

  private async prepareUpsert(path: string, rootProperty: string, server: ManagedMcpServer): Promise<{ path: string; next: string }> {
    await this.assertNotTracked(path);
    const source = (await readTextIfExists(path)) ?? "{}\n";
    const root = parseJsoncObject(source, path);
    const current = getNestedObject(root, rootProperty, server.name);
    if (current !== undefined && !isOwnedServer(current)) {
      throw new NetSuiteMcpError("mcp-name-conflict", `MCP 配置中的 ${server.name} 已由其他工具使用，扩展不会覆盖它。`);
    }
    const value = { type: "http", url: server.url };
    const next = applyEdits(source, modify(source, [rootProperty, server.name], value, { formattingOptions }));
    await ensureDirectory(dirname(path));
    return { path, next: next.endsWith("\n") ? next : `${next}\n` };
  }

  private async removeServer(path: string, rootProperty: string, name: string): Promise<void> {
    const source = await readTextIfExists(path);
    if (!source) {
      return;
    }
    await this.assertNotTracked(path);
    const root = parseJsoncObject(source, path);
    const current = getNestedObject(root, rootProperty, name);
    if (current === undefined || !isOwnedServer(current)) {
      return;
    }
    const next = applyEdits(source, modify(source, [rootProperty, name], undefined, { formattingOptions }));
    await atomicWriteFile(path, next.endsWith("\n") ? next : `${next}\n`);
  }

  private async refreshIfOwned(path: string, rootProperty: string, server: ManagedMcpServer): Promise<void> {
    const source = await readTextIfExists(path);
    if (!source) {
      return;
    }
    await this.assertNotTracked(path);
    const root = parseJsoncObject(source, path);
    const current = getNestedObject(root, rootProperty, server.name);
    if (!isOwnedServer(current)) {
      return;
    }
    const next = applyEdits(source, modify(source, [rootProperty, server.name], { type: "http", url: server.url }, { formattingOptions }));
    await atomicWriteFile(path, next.endsWith("\n") ? next : `${next}\n`);
  }

  private async assertNotTracked(path: string): Promise<void> {
    const repositoryPath = relative(this.workspaceRoot, path);
    try {
      await execFileAsync("git", ["ls-files", "--error-unmatch", "--", repositoryPath], { cwd: this.workspaceRoot, windowsHide: true });
      throw new NetSuiteMcpError("mcp-config-tracked", `${repositoryPath} 已被 Git 跟踪。扩展不会改写可能共享的 MCP 配置。请先将它改为本机配置。`);
    } catch (error) {
      if (error instanceof NetSuiteMcpError) {
        throw error;
      }
      if (isExpectedGitAbsence(error)) {
        // git 以退出码 1 表示文件未被跟踪；128 表示该本地文件夹尚未初始化为 Git 仓库。
        return;
      }
      throw new NetSuiteMcpError("git-check-failed", `无法确认 ${repositoryPath} 是否受 Git 跟踪，扩展没有改动该文件。`, error);
    }
  }
}

export function managedServerName(accountId: string, access: AccessMode): string {
  return `netsuite-mcp-${accountId}-${access}`;
}

function parseJsoncObject(source: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !isObject(parsed)) {
    throw new NetSuiteMcpError("invalid-mcp-config", `${path} 不是可安全修改的 JSONC 对象，扩展没有改动该文件。`);
  }
  return parsed;
}

function getNestedObject(root: Record<string, unknown>, rootProperty: string, name: string): unknown {
  const group = root[rootProperty];
  return isObject(group) ? group[name] : undefined;
}

function isOwnedServer(value: unknown): boolean {
  return isObject(value) && value.type === "http" && typeof value.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\//.test(value.url);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpectedGitAbsence(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: unknown }).code === 1 || (error as { code?: unknown }).code === 128);
}
