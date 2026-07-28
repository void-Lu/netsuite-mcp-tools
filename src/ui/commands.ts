import * as vscode from "vscode";
import { EnvironmentStore } from "../config/environment-store";
import { McpConfigWriter } from "../config/mcp-config-writer";
import { NetSuiteMcpError } from "../domain/types";
import { ProfileManager, ProfileSummary } from "../services/profile-manager";

interface ProfilePickItem extends vscode.QuickPickItem {
  summary: ProfileSummary;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  manager: ProfileManager,
  store: EnvironmentStore,
  configWriter: McpConfigWriter,
  refreshStatus: () => Promise<void>
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("netsuiteMcp.configureProfile", () => runCommand(() => configureProfile(manager, store))),
    vscode.commands.registerCommand("netsuiteMcp.testConnection", () => runCommand(() => testConnection(manager, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.generateClientConfig", () => runCommand(() => generateClientConfig(manager, configWriter))),
    vscode.commands.registerCommand("netsuiteMcp.enableWrite", () => runCommand(() => enableWrite(manager, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.disableWrite", () => runCommand(() => disableWrite(manager, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.removeProfile", () => runCommand(() => removeProfile(manager, configWriter, refreshStatus)))
  );
}

async function configureProfile(manager: ProfileManager, store: EnvironmentStore): Promise<void> {
  const result = await store.ensureConfigurationTemplate();
  const redirectUri = await manager.prepareAuthorizationCallback();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(store.paths.environmentFile));
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.window.showInformationMessage(
    result === "initialized"
      ? `已初始化 environment.json。请填写 accountId、环境、access 和 Public Client ID；不要编辑 profile id 或状态。Integration 必须为 Public Client、Authorization Code Grant、AI Connector Service scope，并配置 Redirect URI：${redirectUri}`
      : result === "completed"
        ? `已安全补全或迁移 environment.json，并保留 Client ID。请确认 Integration 使用 Public Client、Authorization Code Grant、AI Connector Service scope 与 Redirect URI：${redirectUri}`
        : `已打开 environment.json。请确认 Public Client ID 与 NetSuite Integration 的 Redirect URI：${redirectUri}`
  );
}

async function testConnection(manager: ProfileManager, refreshStatus: () => Promise<void>): Promise<void> {
  const selected = await pickProfile(manager, "选择要测试的 NetSuite 连接", (summary) => Boolean(summary.profile.clientId?.trim()));
  if (!selected) {
    return;
  }
  if (selected.environment.environmentType === "production" && !await confirmProduction(selected.environment.accountId, "测试连接")) {
    return;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "请在浏览器完成 NetSuite 授权；随后执行零数据 MCP 健康检查…" },
    () => manager.authorizeAndVerify(selected.profile.id, async (authorizationUrl) => vscode.env.openExternal(vscode.Uri.parse(authorizationUrl)))
  );
  await refreshStatus();
  await vscode.window.showInformationMessage(`MCP 健康检查成功：${result.environment.accountId} / ${result.profile.access}。`);
}

async function generateClientConfig(manager: ProfileManager, configWriter: McpConfigWriter): Promise<void> {
  const selected = await pickProfile(manager, "选择要写入 MCP 配置的连接", (summary) => summary.profile.status === "verified");
  if (!selected) {
    return;
  }
  await installAgentConfig(selected, manager, configWriter);
}

async function installAgentConfig(selected: ProfileSummary, manager: ProfileManager, configWriter: McpConfigWriter): Promise<void> {
  if (selected.profile.access === "write") {
    const confirmed = await vscode.window.showWarningMessage(
      `将为 ${selected.environment.accountId} 写入 write MCP 配置。写入端点仍需每次 VS Code 会话显式启用。`,
      { modal: true },
      "写入配置"
    );
    if (confirmed !== "写入配置") {
      return;
    }
  }
  const url = await manager.getMcpUrl(selected.profile.id);
  const server = await configWriter.install(selected.profile.id, selected.environment.accountId, selected.profile.access, url);
  await vscode.window.showInformationMessage(`已生成本机 MCP 配置：${server.name}`);
}

async function enableWrite(manager: ProfileManager, refreshStatus: () => Promise<void>): Promise<void> {
  const selected = await pickProfile(manager, "选择 write 连接", (summary) => summary.profile.access === "write" && summary.profile.status !== "draft");
  if (!selected) {
    return;
  }
  if (selected.environment.environmentType === "production" && !await confirmProduction(selected.environment.accountId, "启用写入")) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `确认启用 ${selected.environment.accountId} 的写入 MCP 端点？权限由对应 NetSuite Role 决定，并在重启 VS Code 后自动关闭。`,
    { modal: true },
    "启用写入"
  );
  if (confirmed !== "启用写入") {
    return;
  }
  await manager.enableWrite(selected.profile.id);
  await refreshStatus();
  await vscode.window.showWarningMessage("NetSuite MCP 写入连接已启用。本次 VS Code 会话结束时会自动关闭。");
}

async function disableWrite(manager: ProfileManager, refreshStatus: () => Promise<void>): Promise<void> {
  const selected = await pickProfile(manager, "选择要关闭的 write 连接", (summary) => summary.profile.access === "write" && manager.isWriteEnabled(summary.profile.id));
  if (!selected) {
    return;
  }
  manager.disableWrite(selected.profile.id);
  await refreshStatus();
  await vscode.window.showInformationMessage("写入 MCP 连接已关闭。");
}

async function removeProfile(manager: ProfileManager, configWriter: McpConfigWriter, refreshStatus: () => Promise<void>): Promise<void> {
  const selected = await pickProfile(manager, "选择要移除的连接", () => true);
  if (!selected) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `将删除 ${selected.environment.accountId} 的本机连接元数据、当前 OAuth 内存会话和受管 MCP 配置。不会撤销 NetSuite 远端 Integration 或授权。是否继续？`,
    { modal: true },
    "移除连接"
  );
  if (confirmed !== "移除连接") {
    return;
  }
  await configWriter.remove(selected.environment.accountId, selected.profile.access);
  await manager.remove(selected.profile.id);
  await refreshStatus();
  await vscode.window.showInformationMessage("本机连接已移除。请按需自行在 NetSuite 撤销 Integration 或授权。");
}

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
  const items: ProfilePickItem[] = profiles.map((summary) => ({
    label: `${summary.environment.accountId} · ${summary.profile.access}`,
    description: `${summary.environment.environmentType} · ${summary.profile.status}`,
    detail: summary.profile.clientId?.trim() ? "Public Client ID 已填写" : "尚未填写 Public Client ID",
    summary
  }));
  return (await vscode.window.showQuickPick(items, { title }))?.summary;
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
