import * as vscode from "vscode";
import { EnvironmentStore } from "./config/environment-store";
import { McpConfigWriter } from "./config/mcp-config-writer";
import { OAuthClient } from "./net/oauth-client";
import { HealthCheckService } from "./services/health-check";
import { VsCodeAllocatedPortRegistry } from "./services/vscode-allocated-port-registry";
import { PortManager } from "./services/port-manager";
import { ProfileManager } from "./services/profile-manager";
import { RedactedLogger } from "./services/redacted-logger";
import { McpProxy } from "./transport/mcp-proxy";
import { BarState, registerCommands } from "./ui/commands";

let activeManager: ProfileManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getSupportedWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }
  const store = new EnvironmentStore(workspaceRoot);
  await store.load();
  const logger = new RedactedLogger(store.paths.logsDirectory);
  const oauthClient = new OAuthClient();
  const healthCheck = new HealthCheckService(oauthClient, fetch, logger);
  const portManager = new PortManager(store, new VsCodeAllocatedPortRegistry());
  const profileManagerRef: { current?: ProfileManager } = {};
  const proxy = new McpProxy(
    oauthClient,
    async (profileId) => profileManagerRef.current?.resolveProxyRoute(profileId),
    logger
  );
  const manager = new ProfileManager(store, oauthClient, healthCheck, portManager, proxy);
  profileManagerRef.current = manager;
  activeManager = manager;
  const configWriter = new McpConfigWriter(workspaceRoot);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "netsuiteMcp.statusBarClick";
  context.subscriptions.push(statusBar);

  let proxyFailed = false;

  const computeState = async (): Promise<BarState> => {
    if (proxyFailed) {
      return { kind: "needsFix" };
    }
    const profiles = await manager.listProfiles();
    const active = profiles.filter(({ profile }) =>
      profile.status === "verified" && manager.hasActiveSession(profile.id));
    if (active.length > 0) {
      return { kind: "connected", profiles };
    }
    const hasValidConfig = profiles.some(({ profile }) => profile.clientId?.trim());
    return { kind: "unconfigured", hasValidConfig, profiles };
  };

  const refreshStatus = async (): Promise<void> => {
    const state = await computeState();
    switch (state.kind) {
      case "needsFix":
        statusBar.text = "$(error) NetSuite MCP：需要修复";
        statusBar.tooltip = "本地代理未启动。请释放 environment.json 中登记的端口后重试，或查看诊断日志。";
        break;
      case "connected":
        statusBar.text = "$(plug) NetSuite MCP：已连接";
        statusBar.tooltip = "MCP 代理已在本机 loopback 地址运行。";
        break;
      case "unconfigured":
        statusBar.text = "$(plug) NetSuite MCP：未连接";
        statusBar.tooltip = state.hasValidConfig
          ? "点击启动 NetSuite MCP 连接。"
          : "点击配置 NetSuite MCP 连接。";
        break;
    }
    statusBar.show();
  };

  registerCommands(context, manager, store, configWriter, refreshStatus, computeState);
  context.subscriptions.push(new vscode.Disposable(() => {
    if (activeManager === manager) {
      activeManager = undefined;
    }
    void manager.stop();
  }));

  try {
    await manager.initialize();
    await refreshStatus();
    await logger.info("extension_activated");
  } catch (error) {
    proxyFailed = true;
    await logger.error("extension_activation_failed", { message: error instanceof Error ? error.message : "unknown" });
    statusBar.text = "$(error) NetSuite MCP：需要修复";
    statusBar.tooltip = "本地代理未启动。请释放 environment.json 中登记的端口后重试，或查看诊断日志。";
    statusBar.show();
  }
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
