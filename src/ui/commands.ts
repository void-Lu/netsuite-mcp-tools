import * as vscode from "vscode";
import { EnvironmentStore } from "../config/environment-store";
import { McpConfigWriter } from "../config/mcp-config-writer";
import { AgentTarget, NetSuiteMcpError } from "../domain/types";
import { ProfileManager, ProfileSummary } from "../services/profile-manager";

export type BarState =
  | { kind: "needsFix" }
  | { kind: "unconfigured"; hasValidConfig: boolean; profiles: ProfileSummary[] }
  | { kind: "connected"; profiles: ProfileSummary[] };

interface ProfilePickItem extends vscode.QuickPickItem {
  summary: ProfileSummary;
}

interface ActionItem extends vscode.QuickPickItem {
  action: () => Promise<void>;
}

interface AgentPickItem extends vscode.QuickPickItem {
  target: AgentTarget;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  manager: ProfileManager,
  store: EnvironmentStore,
  configWriter: McpConfigWriter,
  refreshStatus: () => Promise<void>,
  computeState: () => Promise<BarState>
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("netsuiteMcp.statusBarClick", () => runCommand(() => handleStatusBarClick(computeState, manager, store, configWriter, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.configureProfile", () => runCommand(() => configureProfile(manager, store))),
    vscode.commands.registerCommand("netsuiteMcp.startConnection", () => runCommand(() => startConnection(manager, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.generateClientConfig", () => runCommand(() => generateClientConfig(manager, store, configWriter))),
    vscode.commands.registerCommand("netsuiteMcp.disconnect", () => runCommand(() => disconnect(manager, refreshStatus)))
  );
}

// ---------------------------------------------------------------------------
// 状态栏路由命令
// ---------------------------------------------------------------------------

async function handleStatusBarClick(
  computeState: () => Promise<BarState>,
  manager: ProfileManager,
  store: EnvironmentStore,
  configWriter: McpConfigWriter,
  refreshStatus: () => Promise<void>
): Promise<void> {
  const state = await computeState();
  switch (state.kind) {
    case "needsFix":
      await vscode.window.showErrorMessage("本地代理端口被占用。请释放 environment.json 中登记的端口后重新加载窗口。");
      break;
    case "unconfigured":
      if (!state.hasValidConfig) {
        await configureProfile(manager, store);
      }
      await showActionMenu(state, manager, store, configWriter, refreshStatus);
      break;
    case "connected":
      await showActionMenu(state, manager, store, configWriter, refreshStatus);
      break;
  }
}

// ---------------------------------------------------------------------------
// 下拉操作菜单
// ---------------------------------------------------------------------------

async function showActionMenu(
  state: BarState,
  manager: ProfileManager,
  store: EnvironmentStore,
  configWriter: McpConfigWriter,
  refreshStatus: () => Promise<void>
): Promise<void> {
  const items: ActionItem[] = [];

  switch (state.kind) {
    case "unconfigured": {
      const hasTestableProfile = state.profiles.some(({ profile }) => profile.clientId?.trim());
      items.push({ label: "打开连接配置", action: () => configureProfile(manager, store) });
      if (hasTestableProfile) {
        items.push({ label: "启动连接", action: () => startConnection(manager, refreshStatus) });
      } else {
        items.push({
          label: "启动连接",
          description: "(尚未配置 Client ID)",
          action: async () => {
            await vscode.window.showInformationMessage("尚未配置 Client ID。请先在 environment.json 中填写 Public Client ID 后再次点击。");
          }
        });
      }
      items.push({ label: "清理 MCP 配置", action: () => cleanMcpConfig(configWriter) });
      break;
    }
    case "connected": {
      items.push({ label: "重新授权", action: () => startConnection(manager, refreshStatus) });
      items.push({ label: "生成 Agent 配置", action: () => generateClientConfig(manager, store, configWriter) });
      items.push({ label: "断开连接", action: () => disconnect(manager, refreshStatus) });
      items.push({ label: "打开 environment.json", action: () => openEnvironmentFile(store) });
      items.push({ label: "清理 MCP 配置", action: () => cleanMcpConfig(configWriter) });
      break;
    }
    case "needsFix":
      return;
  }

  const selected = await vscode.window.showQuickPick(items, { title: "NetSuite MCP" });
  if (selected) {
    await selected.action();
  }
}

// ---------------------------------------------------------------------------
// 各操作实现
// ---------------------------------------------------------------------------

async function configureProfile(manager: ProfileManager, store: EnvironmentStore): Promise<void> {
  const result = await store.ensureConfigurationTemplate();
  const redirectUri = await manager.prepareAuthorizationCallback();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(store.paths.environmentFile));
  await vscode.window.showTextDocument(document, { preview: false });
  void vscode.window.showInformationMessage(
    result === "initialized"
      ? `已初始化 environment.json。请填写 accountId、环境、access 和 Public Client ID；不要编辑 profile id 或状态。Integration 必须为 Public Client、Authorization Code Grant、AI Connector Service scope，并配置 Redirect URI：${redirectUri}`
      : result === "completed"
        ? `已安全补全或迁移 environment.json，并保留 Client ID。请确认 Integration 使用 Public Client、Authorization Code Grant、AI Connector Service scope 与 Redirect URI：${redirectUri}`
        : `已打开 environment.json。请确认 Public Client ID 与 NetSuite Integration 的 Redirect URI：${redirectUri}`
  );
}

async function openEnvironmentFile(store: EnvironmentStore): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(store.paths.environmentFile));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function startConnection(manager: ProfileManager, refreshStatus: () => Promise<void>): Promise<void> {
  const selected = await pickProfile(manager, "选择要启动的 NetSuite 连接", (summary) => Boolean(summary.profile.clientId?.trim()));
  if (!selected) {
    return;
  }
  if (selected.environment.environmentType === "production" && !await confirmProduction(selected.environment.accountId, "启动连接")) {
    return;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "请在浏览器完成 NetSuite 授权；随后执行零数据 MCP 健康检查…" },
    () => manager.authorizeAndVerify(selected.profile.id, async (authorizationUrl) => vscode.env.openExternal(vscode.Uri.parse(authorizationUrl)))
  );
  await refreshStatus();
  await vscode.window.showInformationMessage(`MCP 健康检查成功：${result.environment.accountId}。`);
}

async function generateClientConfig(
  manager: ProfileManager,
  store: EnvironmentStore,
  configWriter: McpConfigWriter
): Promise<void> {
  const selected = await pickProfile(manager, "选择要写入 MCP 配置的连接", (summary) => summary.profile.status === "verified");
  if (!selected) {
    return;
  }
  const targets = await pickAgentTargets("选择需要配置的 Agent");
  if (targets.length === 0) {
    return;
  }
  const state = await store.getState();
  const url = await manager.getMcpUrl(selected.profile.id);
  const server = await configWriter.install(targets, state.workspaceId, url);

  if (targets.includes("codex")) {
    await detectAndPromptStaleCodexEntries(configWriter, store);
  }

  await vscode.window.showInformationMessage(`已生成 MCP 配置：${server.name}`);
}

async function disconnect(manager: ProfileManager, refreshStatus: () => Promise<void>): Promise<void> {
  await manager.disconnect();
  await refreshStatus();
  await vscode.window.showInformationMessage("已断开 NetSuite MCP 连接。");
}

async function cleanMcpConfig(configWriter: McpConfigWriter): Promise<void> {
  const targets = await pickAgentTargets("选择需要清理的 Agent");
  if (targets.length === 0) {
    return;
  }
  await configWriter.removeAllManaged(targets);
  await vscode.window.showInformationMessage("已清理所选 Agent 的 MCP 配置条目。");
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

async function pickProfile(
  manager: ProfileManager,
  title: string,
  predicate: (summary: ProfileSummary) => boolean
): Promise<ProfileSummary | undefined> {
  const profiles = (await manager.listProfiles()).filter(predicate);
  if (profiles.length === 0) {
    await vscode.window.showInformationMessage("没有符合条件的 NetSuite 连接。请先配置连接。");
    return undefined;
  }
  if (profiles.length === 1) {
    return profiles[0];
  }
  const items: ProfilePickItem[] = profiles.map((summary) => ({
    label: `${summary.environment.accountId}`,
    description: `${summary.environment.environmentType} · ${summary.profile.status}`,
    detail: summary.profile.clientId?.trim() ? "Public Client ID 已填写" : "尚未填写 Public Client ID",
    summary
  }));
  return (await vscode.window.showQuickPick(items, { title }))?.summary;
}

async function pickAgentTargets(title: string): Promise<AgentTarget[]> {
  const items: AgentPickItem[] = [
    { label: "VS Code Copilot", target: "vscode" },
    { label: "Claude Code", target: "claude-code" },
    { label: "Codex", target: "codex" }
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title,
    canPickMany: true
  });
  return picked?.map((item) => item.target) ?? [];
}

async function detectAndPromptStaleCodexEntries(
  configWriter: McpConfigWriter,
  store: EnvironmentStore
): Promise<void> {
  const entries = await configWriter.listCodexManagedEntries();
  if (entries.length === 0) {
    return;
  }
  const state = await store.getState();
  const knownPorts = new Set(state.allocatedPorts);
  const stale = entries.filter((entry) => {
    const portMatch = entry.url.match(/127\.0\.0\.1:(\d+)/);
    if (!portMatch) {
      return false;
    }
    return !knownPorts.has(Number(portMatch[1]));
  });
  if (stale.length === 0) {
    return;
  }
  const message = stale.length === 1
    ? `Codex 配置中存在 1 个陈旧条目：${stale[0].name}。是否清理？`
    : `Codex 配置中存在 ${stale.length} 个陈旧条目。是否全部清理？`;
  const confirmed = await vscode.window.showWarningMessage(message, { modal: true }, "清理陈旧条目");
  if (confirmed !== "清理陈旧条目") {
    return;
  }
  for (const entry of stale) {
    await configWriter.removeCodexServer(entry.name);
  }
}

async function confirmProduction(accountId: string, action = "执行操作"): Promise<boolean> {
  const selected = await vscode.window.showWarningMessage(
    `目标为 production：${accountId}。${action}会使用该生产账户对应的 NetSuite 权限。`,
    { modal: true },
    "确认生产环境"
  );
  return selected === "确认生产环境";
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof NetSuiteMcpError || error instanceof Error ? error.message : "发生未知错误。";
    await vscode.window.showErrorMessage(`NetSuite MCP：${message}`);
  }
}
