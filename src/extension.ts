import * as vscode from "vscode";
import { EnvironmentStore } from "./config/environment-store";
import { McpConfigWriter } from "./config/mcp-config-writer";
import { OAuthClient } from "./net/oauth-client";
import { CertificateService } from "./security/certificate-service";
import { HealthCheckService } from "./services/health-check";
import { PortManager } from "./services/port-manager";
import { ProfileManager } from "./services/profile-manager";
import { RedactedLogger } from "./services/redacted-logger";
import { McpProxy } from "./transport/mcp-proxy";
import { registerCommands } from "./ui/commands";

let activeManager: ProfileManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getSupportedWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }
  const store = new EnvironmentStore(workspaceRoot);
  const state = await store.load();
  const logger = new RedactedLogger(store.paths.logsDirectory);
  const certificateService = new CertificateService(store.paths, state.workspaceId);
  const oauthClient = new OAuthClient(certificateService);
  const healthCheck = new HealthCheckService(oauthClient);
  const portManager = new PortManager(store);
  const profileManagerRef: { current?: ProfileManager } = {};
  const proxy = new McpProxy(
    oauthClient,
    async (profileId) => profileManagerRef.current?.resolveProxyRoute(profileId),
    logger
  );
  const manager = new ProfileManager(store, certificateService, healthCheck, portManager, proxy);
  profileManagerRef.current = manager;
  activeManager = manager;
  const configWriter = new McpConfigWriter(workspaceRoot);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "netsuiteMcp.configureProfile";
  context.subscriptions.push(statusBar);

  const refreshStatus = async (): Promise<void> => {
    const profiles = await manager.listProfiles();
    const activeWrites = profiles.filter(({ profile }) => profile.access === "write" && manager.isWriteEnabled(profile.id));
    const activeReads = profiles.filter(({ profile }) => profile.access === "read" && profile.status === "verified");
    if (activeWrites.length > 0) {
      statusBar.text = "$(warning) NetSuite MCP：写入已启用";
      statusBar.tooltip = "写入连接将在关闭或重启 VS Code 后自动关闭。";
    } else if (activeReads.length > 0) {
      statusBar.text = "$(plug) NetSuite MCP：只读已连接";
      statusBar.tooltip = "只读 MCP 代理已在本机 loopback 地址运行。";
    } else {
      statusBar.text = "$(plug) NetSuite MCP：未配置";
      statusBar.tooltip = "点击配置 NetSuite MCP 连接。";
    }
    statusBar.show();
  };

  registerCommands(context, manager, store, configWriter, refreshStatus);
  context.subscriptions.push(new vscode.Disposable(() => {
    if (activeManager === manager) {
      activeManager = undefined;
    }
    void manager.stop();
  }));

  try {
    await manager.initialize();
    await refreshStatus();
    await warnAboutExpiringCertificates(manager);
    await logger.info("extension_activated");
  } catch (error) {
    await logger.error("extension_activation_failed", { message: error instanceof Error ? error.message : "unknown" });
    statusBar.text = "$(error) NetSuite MCP：需要修复";
    statusBar.tooltip = "本地代理未启动。运行“NetSuite MCP：修复本地端口”或查看诊断日志。";
    statusBar.show();
  }
}

async function warnAboutExpiringCertificates(manager: ProfileManager): Promise<void> {
  const profiles = await manager.getProfilesExpiringWithin(7);
  if (profiles.length === 0) {
    return;
  }
  const names = profiles.slice(0, 3).map(({ environment, profile }) => `${environment.accountId}/${profile.access}`).join("、");
  const remainder = profiles.length > 3 ? ` 等 ${profiles.length} 个` : "";
  void vscode.window.showWarningMessage(
    `NetSuite MCP：${names}${remainder} 的客户端证书将在 7 天内到期。请轮换证书，并在 NetSuite 中完成新的证书映射。`
  );
}

export async function deactivate(): Promise<void> {
  await activeManager?.stop();
  activeManager = undefined;
}

function getSupportedWorkspaceRoot(): string | undefined {
  if (process.platform !== "win32" || vscode.env.remoteName) {
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length !== 1 || folders[0].uri.scheme !== "file") {
    return undefined;
  }
  return folders[0].uri.fsPath;
}
