import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyEdits, modify, parse, ParseError } from "jsonc-parser";
import { AgentTarget, ManagedMcpServer, NetSuiteMcpError } from "../domain/types";
import { atomicWriteFile, ensureDirectory, isNodeError, readTextIfExists } from "../util/files";

const execFileAsync = promisify(execFile);
const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
const ANTIGRAVITY_CONFIG_PATH = ".agents/mcp_config.json";
export const CLINE_MCP_SERVER_NAME = "netsuite-mcp";
export const ANTIGRAVITY_MCP_SERVER_NAME = "netsuite-mcp";

type JsonMcpFormat = "http" | "streamableHttp" | "antigravity";

export function resolveClineSettingsPath(settingsPath: string | undefined = process.env.CLINE_MCP_SETTINGS_PATH, userHome: string = homedir()): string {
  return settingsPath || join(userHome, ".cline", "data", "settings", "cline_mcp_settings.json");
}

export class McpConfigWriter {
  private readonly antigravityConfigPath: string;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly codexConfigPath: string = join(workspaceRoot, ".codex", "config.toml"),
    private readonly clineConfigPath: string = resolveClineSettingsPath()
  ) {
    this.antigravityConfigPath = join(workspaceRoot, ANTIGRAVITY_CONFIG_PATH);
  }

  /**
   * 写入所选 Agent 的 MCP 配置。
   */
  public async install(
    targets: readonly AgentTarget[],
    workspaceId: string,
    url: string
  ): Promise<ManagedMcpServer> {
    const server: ManagedMcpServer = {
      name: managedServerName(workspaceId),
      url
    };
    const changes: Promise<{ path: string; next: string }>[] = [];
    if (targets.includes("vscode")) {
      changes.push(this.prepareUpsert(join(this.workspaceRoot, ".vscode", "mcp.json"), "servers", server));
    }
    if (targets.includes("claude-code")) {
      changes.push(this.prepareUpsert(join(this.workspaceRoot, ".mcp.json"), "mcpServers", server));
    }
    if (targets.includes("cline")) {
      changes.push(this.prepareUpsert(this.clineConfigPath, "mcpServers", { name: CLINE_MCP_SERVER_NAME, url }, "streamableHttp"));
    }
    const installAntigravity = targets.includes("antigravity");
    if (installAntigravity) {
      changes.push(this.prepareUpsert(
        this.antigravityConfigPath,
        "mcpServers",
        { name: ANTIGRAVITY_MCP_SERVER_NAME, url },
        "antigravity"
      ));
    }
    const results = await Promise.all(changes);
    if (installAntigravity) {
      await this.ensureAntigravityGitIgnore();
    }
    await Promise.all(results.map(({ path, next }) => writeIfChanged(path, next)));
    if (targets.includes("codex")) {
      await this.installCodex(workspaceId, url);
    }
    return server;
  }

  /** 写入项目根目录 .codex/config.toml，使用 workspaceId 命名。 */
  public async installCodex(workspaceId: string, url: string): Promise<void> {
    const name = managedServerName(workspaceId);
    await this.assertNotTracked(this.codexConfigPath);
    const source = (await readTextIfExists(this.codexConfigPath)) ?? "";
    const next = tomlUpsertServer(source, name, url);
    await ensureDirectory(dirname(this.codexConfigPath));
    await atomicWriteFile(this.codexConfigPath, next.endsWith("\n") ? next : `${next}\n`);
  }

  public async remove(workspaceId: string): Promise<void> {
    const name = managedServerName(workspaceId);
    await Promise.all([
      this.removeServer(join(this.workspaceRoot, ".vscode", "mcp.json"), "servers", name),
      this.removeServer(join(this.workspaceRoot, ".mcp.json"), "mcpServers", name),
      this.removeCodexServer(name)
    ]);
  }

  /** 扫描并删除所有由本扩展托管的 MCP server 条目（名称以 netsuite-mcp- 开头且 URL 指向 loopback）。 */
  public async removeAllManaged(targets: readonly AgentTarget[]): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (targets.includes("vscode")) {
      tasks.push(this.removeAllManagedInFile(join(this.workspaceRoot, ".vscode", "mcp.json"), "servers"));
    }
    if (targets.includes("claude-code")) {
      tasks.push(this.removeAllManagedInFile(join(this.workspaceRoot, ".mcp.json"), "mcpServers"));
    }
    if (targets.includes("codex")) {
      tasks.push(this.removeAllCodexManaged());
    }
    if (targets.includes("cline")) {
      tasks.push(this.removeServer(this.clineConfigPath, "mcpServers", CLINE_MCP_SERVER_NAME));
    }
    if (targets.includes("antigravity")) {
      tasks.push(this.removeAllManagedInFile(this.antigravityConfigPath, "mcpServers", "antigravity"));
    }
    await Promise.all(tasks);
  }

  public async refreshExisting(workspaceId: string, url: string): Promise<void> {
    const server: ManagedMcpServer = { name: managedServerName(workspaceId), url };
    await Promise.all([
      this.refreshIfOwned(join(this.workspaceRoot, ".vscode", "mcp.json"), "servers", server),
      this.refreshIfOwned(join(this.workspaceRoot, ".mcp.json"), "mcpServers", server),
      this.refreshCodexIfOwned(server.name, url),
      this.refreshClineIfOwned(url),
      this.refreshAntigravityIfOwned(url).catch(() => {
        // 无法安全刷新 Antigravity 配置时，仍继续刷新其他 Agent。
      })
    ]);
  }

  /** 删除 Codex 配置中指定名称的条目（仅当 URL 指向 loopback 时）。 */
  public async removeCodexServer(name: string): Promise<void> {
    const source = await readTextIfExists(this.codexConfigPath);
    if (!source) {
      return;
    }
    await this.assertNotTracked(this.codexConfigPath);
    const next = tomlRemoveServer(source, name);
    if (next !== source) {
      await atomicWriteFile(this.codexConfigPath, next.endsWith("\n") ? next : `${next}\n`);
    }
  }

  // -----------------------------------------------------------------------
  // JSON / JSONC 文件操作
  // -----------------------------------------------------------------------

  private async prepareUpsert(path: string, rootProperty: string, server: ManagedMcpServer, format: JsonMcpFormat = "http"): Promise<{ path: string; next: string }> {
    await this.assertNotTracked(path, format);
    const source = (await readMcpConfig(path, format)) ?? "{}\n";
    const current = parseMcpServers(source, path, rootProperty, format)?.[server.name];
    if (current !== undefined && !ownedServerUrl(current, format)) {
      throw new NetSuiteMcpError("mcp-name-conflict", `MCP 配置中的 ${server.name} 已由其他工具使用，扩展不会覆盖它。`);
    }
    let next = upsertJsonServer(source, rootProperty, server, format);
    if (format === "antigravity") {
      next = removeOwnedLegacyAntigravityNames(next, path, rootProperty);
    }
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
    if (!ownedServerUrl(current)) {
      return;
    }
    const next = applyEdits(source, modify(source, [rootProperty, name], undefined, { formattingOptions }));
    await atomicWriteFile(path, next.endsWith("\n") ? next : `${next}\n`);
  }

  private async removeAllManagedInFile(path: string, rootProperty: string, format: JsonMcpFormat = "http"): Promise<void> {
    const source = await readMcpConfig(path, format);
    if (source === undefined || (source === "" && format !== "antigravity")) {
      return;
    }
    await this.assertNotTracked(path, format);
    const group = parseMcpServers(source, path, rootProperty, format);
    if (!group) {
      return;
    }
    let next = source;
    let changed = false;
    for (const name of Object.keys(group)) {
      if (isAntigravityManagedName(name, format) && ownedServerUrl(group[name], format)) {
        next = applyEdits(next, modify(next, [rootProperty, name], undefined, { formattingOptions }));
        changed = true;
      }
    }
    if (changed) {
      await atomicWriteFile(path, next.endsWith("\n") ? next : `${next}\n`);
    }
  }

  private async refreshAntigravityIfOwned(url: string): Promise<void> {
    const path = this.antigravityConfigPath;
    const source = await readMcpConfig(path, "antigravity");
    if (!source) {
      return;
    }
    await this.assertNotTracked(path, "antigravity");
    const group = parseMcpServers(source, path, "mcpServers", "antigravity");
    if (!group) {
      return;
    }
    const shortCurrent = group[ANTIGRAVITY_MCP_SERVER_NAME];
    const shortUrl = ownedServerUrl(shortCurrent, "antigravity");
    if (shortCurrent !== undefined && !shortUrl) {
      return;
    }
    const hasMatchingLegacy = Object.entries(group).some(([name, value]) => {
      if (!name.startsWith("netsuite-mcp-")) {
        return false;
      }
      const ownedUrl = ownedServerUrl(value, "antigravity");
      return Boolean(ownedUrl && hasMatchingProfilePath(ownedUrl, url));
    });
    let next = source;
    if (shortUrl) {
      if (hasMatchingProfilePath(shortUrl, url) && shortUrl !== url) {
        next = upsertJsonServer(next, "mcpServers", { name: ANTIGRAVITY_MCP_SERVER_NAME, url }, "antigravity");
      }
      next = removeOwnedLegacyAntigravityNames(next, path, "mcpServers");
    } else if (hasMatchingLegacy) {
      next = upsertJsonServer(next, "mcpServers", { name: ANTIGRAVITY_MCP_SERVER_NAME, url }, "antigravity");
      next = removeOwnedLegacyAntigravityNames(next, path, "mcpServers");
    } else {
      return;
    }
    if (next !== source) {
      await atomicWriteFile(path, next.endsWith("\n") ? next : `${next}\n`);
    }
  }

  private async refreshIfOwned(path: string, rootProperty: string, server: ManagedMcpServer, format: JsonMcpFormat = "http"): Promise<void> {
    const source = await readMcpConfig(path, format);
    if (!source) {
      return;
    }
    await this.assertNotTracked(path, format);
    const current = parseMcpServers(source, path, rootProperty, format)?.[server.name];
    const currentUrl = ownedServerUrl(current, format);
    if (!currentUrl) {
      return;
    }
    if (format === "antigravity" && (currentUrl === server.url || !hasMatchingProfilePath(currentUrl, server.url))) {
      return;
    }
    const next = upsertJsonServer(source, rootProperty, server, format);
    await atomicWriteFile(path, next.endsWith("\n") ? next : `${next}\n`);
  }

  private async refreshClineIfOwned(url: string): Promise<void> {
    const source = await readTextIfExists(this.clineConfigPath);
    if (!source) {
      return;
    }
    await this.assertNotTracked(this.clineConfigPath);
    const root = parseJsoncObject(source, this.clineConfigPath);
    const currentUrl = ownedServerUrl(getNestedObject(root, "mcpServers", CLINE_MCP_SERVER_NAME));
    if (!currentUrl || !hasMatchingProfilePath(currentUrl, url)) {
      return;
    }
    const next = applyEdits(source, modify(source, ["mcpServers", CLINE_MCP_SERVER_NAME], { type: "streamableHttp", url }, { formattingOptions }));
    if (next !== source) {
      await atomicWriteFile(this.clineConfigPath, next.endsWith("\n") ? next : `${next}\n`);
    }
  }

  // -----------------------------------------------------------------------
  // Codex TOML 文件操作（<workspace>/.codex/config.toml）
  // -----------------------------------------------------------------------

  private async removeAllCodexManaged(): Promise<void> {
    const source = await readTextIfExists(this.codexConfigPath);
    if (!source) {
      return;
    }
    await this.assertNotTracked(this.codexConfigPath);
    const next = tomlRemoveAllManaged(source);
    if (next !== source) {
      await atomicWriteFile(this.codexConfigPath, next.endsWith("\n") ? next : `${next}\n`);
    }
  }

  private async refreshCodexIfOwned(name: string, url: string): Promise<void> {
    const source = await readTextIfExists(this.codexConfigPath);
    if (!source) {
      return;
    }
    await this.assertNotTracked(this.codexConfigPath);
    const table = tomlFindTable(source, name);
    if (!table || !tomlIsOwnedServer(table.content)) {
      return;
    }
    const next = tomlUpsertServer(source, name, url);
    if (next !== source) {
      await atomicWriteFile(this.codexConfigPath, next.endsWith("\n") ? next : `${next}\n`);
    }
  }

  // -----------------------------------------------------------------------
  // 共享工具
  // -----------------------------------------------------------------------

  private async ensureAntigravityGitIgnore(): Promise<void> {
    const path = join(this.workspaceRoot, ".gitignore");
    await assertNotSymlink(path);
    const source = (await readTextIfExists(path)) ?? "";
    const rule = `/${ANTIGRAVITY_CONFIG_PATH}`;
    const lines = source.split(/\r?\n/);
    if (lines.includes(rule) && await this.isAntigravityIgnored()) {
      return;
    }
    if (source.trimEnd().split(/\r?\n/).at(-1) !== rule) {
      const eol = source.includes("\r\n") ? "\r\n" : "\n";
      const separator = source && !source.endsWith("\n") ? eol : "";
      await atomicWriteFile(path, `${source}${separator}${rule}${eol}`);
    }
    if (!(await this.isAntigravityIgnored())) {
      throw new NetSuiteMcpError("mcp-config-not-ignored", `${ANTIGRAVITY_CONFIG_PATH} 未被 Git 忽略。请检查工作区的 .gitignore 规则。`);
    }
  }

  private async isAntigravityIgnored(): Promise<boolean> {
    try {
      await execFileAsync("git", ["check-ignore", "--no-index", "-q", "--", ANTIGRAVITY_CONFIG_PATH], {
        cwd: this.workspaceRoot,
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C" }
      });
      return true;
    } catch (error) {
      if (isObject(error) && error.code === 1) {
        return false;
      }
      if (isObject(error) && error.code === 128 && typeof error.stderr === "string" && error.stderr.includes("not a git repository")) {
        return true;
      }
      throw new NetSuiteMcpError("git-check-failed", `无法确认 ${ANTIGRAVITY_CONFIG_PATH} 是否被 Git 忽略。`, error);
    }
  }

  private async assertNotTracked(path: string, format: JsonMcpFormat = "http"): Promise<void> {
    const workspaceRoot = resolve(this.workspaceRoot);
    const absolutePath = resolve(path);
    const repositoryPath = relative(workspaceRoot, absolutePath);
    if (repositoryPath === ".." || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) {
      return;
    }
    // Windows 上同一 Antigravity 配置在 Git 索引中的路径大小写可能不同。
    const pathspec = format === "antigravity" ? `:(icase,literal)${ANTIGRAVITY_CONFIG_PATH}` : repositoryPath;
    try {
      await execFileAsync("git", ["ls-files", "--error-unmatch", "--", pathspec], { cwd: this.workspaceRoot, windowsHide: true });
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

/** 工作区级 JSON 和 Codex 项目级配置统一使用 workspaceId 命名：netsuite-mcp-<workspaceId>。 */
export function managedServerName(workspaceId: string): string {
  return `netsuite-mcp-${workspaceId}`;
}

// ===========================================================================
// JSON / JSONC 辅助函数
// ===========================================================================

async function readMcpConfig(path: string, format: JsonMcpFormat): Promise<string | undefined> {
  if (format === "antigravity") {
    await assertNotSymlink(dirname(path));
    await assertNotSymlink(path);
  }
  return readTextIfExists(path);
}

async function assertNotSymlink(path: string): Promise<void> {
  const stats = await lstat(path).catch((error: unknown) => {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  });
  if (stats?.isSymbolicLink()) {
    throw new NetSuiteMcpError("mcp-config-symlink", `${path} 是链接。Antigravity 配置必须位于当前工作区。`);
  }
}

function parseMcpServers(source: string, path: string, rootProperty: string, format: JsonMcpFormat): Record<string, unknown> | undefined {
  const group = parseJsoncObject(source, path)[rootProperty];
  if (isObject(group)) {
    return group;
  }
  if (format === "antigravity" && group !== undefined) {
    throw new NetSuiteMcpError("invalid-mcp-config", `${path} 中的 ${rootProperty} 必须为对象，扩展没有改动该文件。`);
  }
}

function isAntigravityManagedName(name: string, format: JsonMcpFormat): boolean {
  if (format === "antigravity") {
    return name === ANTIGRAVITY_MCP_SERVER_NAME || name.startsWith("netsuite-mcp-");
  }
  return name.startsWith("netsuite-mcp-");
}

function removeOwnedLegacyAntigravityNames(source: string, path: string, rootProperty: string): string {
  const group = parseMcpServers(source, path, rootProperty, "antigravity");
  if (!group) {
    return source;
  }
  let next = source;
  for (const name of Object.keys(group)) {
    if (name.startsWith("netsuite-mcp-") && ownedServerUrl(group[name], "antigravity")) {
      next = applyEdits(next, modify(next, [rootProperty, name], undefined, { formattingOptions }));
    }
  }
  return next;
}

function upsertJsonServer(source: string, rootProperty: string, server: ManagedMcpServer, format: JsonMcpFormat): string {
  const location = [rootProperty, server.name];
  const edits = format === "antigravity"
    ? modify(source, [...location, "serverUrl"], server.url, { formattingOptions })
    : modify(source, location, { type: format, url: server.url }, { formattingOptions });
  return applyEdits(source, edits);
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

function ownedServerUrl(value: unknown, format: JsonMcpFormat = "http"): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (format === "antigravity") {
    if ("command" in value || value.type === "stdio" || typeof value.serverUrl !== "string") {
      return undefined;
    }
    const route = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/[^/?#\s\\]+\/mcp$/.exec(value.serverUrl);
    return route && Number(route[1]) > 0 && Number(route[1]) <= 65535 ? value.serverUrl : undefined;
  }
  if ((value.type === "http" || value.type === "streamableHttp") && typeof value.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\//.test(value.url)) {
    return value.url;
  }
}

function hasMatchingProfilePath(currentUrl: string, incomingUrl: string): boolean {
  try {
    return new URL(currentUrl).pathname === new URL(incomingUrl).pathname;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpectedGitAbsence(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: unknown }).code === 1 || (error as { code?: unknown }).code === 128);
}

async function writeIfChanged(path: string, next: string): Promise<void> {
  const current = await readTextIfExists(path);
  if (current !== next) {
    await atomicWriteFile(path, next);
  }
}

// ===========================================================================
// Codex TOML 辅助函数
// ===========================================================================

interface TomlTableRange {
  /** 表头行起始位置（含前导换行符之后） */
  headerStart: number;
  /** 表内容结束位置（下一个表头之前或文件末尾） */
  tableEnd: number;
  /** 表的完整文本 */
  content: string;
}

/**
 * 在 TOML 源文本中查找 `[mcp_servers.<name>]` 表的范围。
 * 表从 `[mcp_servers.<name>]` 行开始，到下一个行首 `[` 之前或文件末尾结束。
 */
function tomlFindTable(source: string, name: string): TomlTableRange | undefined {
  const header = `[mcp_servers.${name}]`;
  const headerIdx = source.indexOf(header);
  if (headerIdx === -1) {
    return undefined;
  }
  // 确保匹配在行首
  if (headerIdx > 0 && source[headerIdx - 1] !== "\n") {
    return undefined;
  }
  // 查找表内容结束位置：下一个行首 [ 或文件末尾
  const afterHeader = headerIdx + header.length;
  const rest = source.slice(afterHeader);
  const nextHeaderMatch = /\n\[/m.exec(rest);
  const tableEnd = nextHeaderMatch ? afterHeader + nextHeaderMatch.index + 1 : source.length;
  return {
    headerStart: headerIdx,
    tableEnd,
    content: source.slice(headerIdx, tableEnd)
  };
}

/** 从 TOML 表内容中提取 `url` 值。 */
function tomlExtractUrl(tableContent: string): string | undefined {
  const match = /^url\s*=\s*"(.+)"/m.exec(tableContent);
  return match?.[1];
}

/** 判断 TOML 表是否由本扩展托管：url 指向 127.0.0.1 loopback。 */
function tomlIsOwnedServer(tableContent: string): boolean {
  const url = tomlExtractUrl(tableContent);
  return url !== undefined && /^http:\/\/127\.0\.0\.1:\d+\//.test(url);
}

/**
 * 在 TOML 源文本中插入或更新 `[mcp_servers.<name>]` 表。
 * 若表已存在且 url 指向非 loopback 地址，抛出名称冲突错误。
 */
function tomlUpsertServer(source: string, name: string, url: string): string {
  const table = tomlFindTable(source, name);
  if (table) {
    const existingUrl = tomlExtractUrl(table.content);
    if (existingUrl && !/^http:\/\/127\.0\.0\.1:\d+\//.test(existingUrl)) {
      throw new NetSuiteMcpError("mcp-name-conflict", `MCP 配置中的 ${name} 已由其他工具使用，扩展不会覆盖它。`);
    }
    const urlMatch = /^url\s*=\s*".*"/m.exec(table.content);
    let newTableContent: string;
    if (urlMatch) {
      newTableContent = table.content.replace(urlMatch[0], `url = "${url}"`);
    } else {
      // 在表头行后插入 url 行
      const firstNewline = table.content.indexOf("\n");
      if (firstNewline === -1) {
        newTableContent = `${table.content}\nurl = "${url}"\n`;
      } else {
        newTableContent = `${table.content.slice(0, firstNewline + 1)}url = "${url}"\n${table.content.slice(firstNewline + 1)}`;
      }
    }
    return source.slice(0, table.headerStart) + newTableContent + source.slice(table.tableEnd);
  }
  // 追加新表
  const trimmed = source.replace(/\s+$/, "");
  return `${trimmed}\n\n[mcp_servers.${name}]\nurl = "${url}"\n`;
}

/** 从 TOML 源文本中删除 `[mcp_servers.<name>]` 表（仅当 url 指向 loopback 时）。 */
function tomlRemoveServer(source: string, name: string): string {
  const table = tomlFindTable(source, name);
  if (!table || !tomlIsOwnedServer(table.content)) {
    return source;
  }
  return source.slice(0, table.headerStart) + source.slice(table.tableEnd);
}

/** 从 TOML 源文本中删除所有 `netsuite-mcp-*` 托管表。 */
function tomlRemoveAllManaged(source: string): string {
  const regex = /^\[mcp_servers\.(netsuite-mcp-[^\]]+)\]/gm;
  const ranges: { start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    const table = tomlFindTable(source, name);
    if (table && tomlIsOwnedServer(table.content)) {
      ranges.push({ start: table.headerStart, end: table.tableEnd });
    }
  }
  // 从后向前删除以保持索引有效
  ranges.sort((a, b) => b.start - a.start);
  let result = source;
  for (const { start, end } of ranges) {
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}
