import { join } from "node:path";
import * as vscode from "vscode";
import { EnvironmentStore } from "../config/environment-store";
import { McpConfigWriter } from "../config/mcp-config-writer";
import { EnvironmentType, NetSuiteMcpError } from "../domain/types";
import { inferEnvironmentType, normalizeAccountId } from "../net/endpoints";
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
    vscode.commands.registerCommand("netsuiteMcp.configureProfile", () => runCommand(() => configureProfile(manager, store, configWriter, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.testConnection", () => runCommand(() => testConnection(manager, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.generateClientConfig", () => runCommand(() => generateClientConfig(manager, configWriter))),
    vscode.commands.registerCommand("netsuiteMcp.enableWrite", () => runCommand(() => enableWrite(manager, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.disableWrite", () => runCommand(() => disableWrite(manager, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.rotateCertificate", () => runCommand(() => rotateCertificate(manager, store))),
    vscode.commands.registerCommand("netsuiteMcp.repairPort", () => runCommand(() => repairPort(manager, configWriter, refreshStatus))),
    vscode.commands.registerCommand("netsuiteMcp.removeProfile", () => runCommand(() => removeProfile(manager, configWriter, refreshStatus)))
  );
}

async function configureProfile(manager: ProfileManager, store: EnvironmentStore, configWriter: McpConfigWriter, refreshStatus: () => Promise<void>): Promise<void> {
  const accountInput = await vscode.window.showInputBox({
    title: "NetSuite MCP：配置连接",
    prompt: "输入 NetSuite accountId，例如 9832121-sb1",
    validateInput: (value) => {
      try {
        normalizeAccountId(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "accountId 无效。";
      }
    }
  });
  if (!accountInput) {
    return;
  }
  const accountId = normalizeAccountId(accountInput);
  const environmentType = await pickEnvironmentType(inferEnvironmentType(accountId));
  if (!environmentType) {
    return;
  }
  if (environmentType === "production" && !await confirmProduction(accountId)) {
    return;
  }
  const access = await vscode.window.showQuickPick(
    [
      { label: "只读连接（推荐）", value: "read" as const, detail: "默认自动启动；权限由 NetSuite 的只读 Role 控制。" },
      { label: "写入连接", value: "write" as const, detail: "需要独立的 NetSuite Role；建立后仍默认关闭。" }
    ],
    { title: "选择 NetSuite 连接权限" }
  );
  if (!access) {
    return;
  }
  const created = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在生成本机 NetSuite 证书…" },
    () => manager.createDraftProfile(accountId, environmentType, access.value)
  );
  const certificatePath = join(store.paths.dataDirectory, created.profile.publicCertificatePath);
  await vscode.window.showInformationMessage(
    "已生成公钥证书。请在 NetSuite 创建专用 Integration，并在 OAuth 2.0 Client Credentials (M2M) Setup 上传该证书后，再回填两个标识。",
    "继续录入"
  );
  const clientId = await vscode.window.showInputBox({ title: "NetSuite Client ID", prompt: "创建 Integration 时生成的 Client ID（请勿输入 Client Secret）" });
  if (!clientId) {
    await vscode.window.showInformationMessage(`草稿证书保留在 ${certificatePath}，可稍后重新运行“配置连接”完成新的档案。`);
    return;
  }
  const certificateId = await vscode.window.showInputBox({ title: "NetSuite Certificate ID", prompt: "M2M 映射保存后返回的 Certificate ID" });
  if (!certificateId) {
    return;
  }
  const verified = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在验证 NetSuite token 与 MCP 连接…", cancellable: false },
    () => manager.registerAndVerify(created.profile.id, clientId, certificateId)
  );
  await refreshStatus();
  await vscode.window.showInformationMessage(`连接已验证：${verified.environment.accountId}（${verified.profile.access}）。`, "生成 Agent 配置").then(async (choice) => {
    if (choice === "生成 Agent 配置") {
      await installAgentConfig(verified, manager, configWriter);
    }
  });
}

async function testConnection(manager: ProfileManager, refreshStatus: () => Promise<void>): Promise<void> {
  const selected = await pickProfile(manager, "选择要测试的 NetSuite 连接", (summary) => summary.profile.status !== "draft");
  if (!selected) {
    return;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在执行零数据 NetSuite MCP 健康检查…" },
    () => manager.verify(selected.profile.id)
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

async function rotateCertificate(manager: ProfileManager, store: EnvironmentStore): Promise<void> {
  const selected = await pickProfile(manager, "选择要轮换证书的连接", (summary) => summary.profile.status !== "draft");
  if (!selected) {
    return;
  }
  const replacement = await manager.createRotationDraft(selected.profile.id);
  const path = join(store.paths.dataDirectory, replacement.profile.publicCertificatePath);
  await vscode.window.showInformationMessage(`已生成轮换证书：${path}。请在 NetSuite 建立新的 M2M 映射并配置新的 Client ID / Certificate ID；验证成功前旧连接不会改变。`);
}

async function repairPort(manager: ProfileManager, configWriter: McpConfigWriter, refreshStatus: () => Promise<void>): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage("将分配新的本机端口并更新已受管的 MCP 配置。是否继续？", { modal: true }, "修复端口");
  if (confirmed !== "修复端口") {
    return;
  }
  const port = await manager.repairPort();
  const profiles = await manager.listProfiles();
  await Promise.all(profiles.filter(({ profile }) => profile.status === "verified").map(async (summary) => {
    await configWriter.refreshExisting(summary.environment.accountId, summary.profile.access, await manager.getMcpUrl(summary.profile.id));
  }));
  await refreshStatus();
  await vscode.window.showInformationMessage(`本地 MCP 端口已修复为 ${port}，已同步受管配置。`);
}

async function removeProfile(manager: ProfileManager, configWriter: McpConfigWriter, refreshStatus: () => Promise<void>): Promise<void> {
  const selected = await pickProfile(manager, "选择要移除的连接", () => true);
  if (!selected) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `将删除 ${selected.environment.accountId} 的本机证书、加密私钥和受管 MCP 配置。不会撤销 NetSuite 远端证书。是否继续？`,
    { modal: true },
    "移除连接"
  );
  if (confirmed !== "移除连接") {
    return;
  }
  await configWriter.remove(selected.environment.accountId, selected.profile.access);
  await manager.remove(selected.profile.id);
  await refreshStatus();
  await vscode.window.showInformationMessage("本机连接已移除。请按需自行在 NetSuite 撤销 Certificate ID。");
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
    detail: `证书到期：${new Date(summary.profile.expiresAt).toLocaleDateString()}`,
    summary
  }));
  return (await vscode.window.showQuickPick(items, { title }))?.summary;
}

async function pickEnvironmentType(inferred: EnvironmentType): Promise<EnvironmentType | undefined> {
  const selected = await vscode.window.showQuickPick(
    [
      { label: "Sandbox", value: "sandbox" as const, description: inferred === "sandbox" ? "根据 accountId 推断（推荐）" : undefined },
      { label: "Production", value: "production" as const, description: inferred === "production" ? "根据 accountId 推断（请确认）" : undefined }
    ],
    { title: "确认 NetSuite 环境类型" }
  );
  return selected?.value;
}

async function confirmProduction(accountId: string, action = "配置连接"): Promise<boolean> {
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
