import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface IsolatedBrowserCommand {
  command: string;
  args: string[];
}

/**
 * 独立 --user-data-dir 把 MCP 登录留在本扩展专用配置里，不动默认浏览器会话。
 * ponytail: 只覆盖 Edge/Chrome；其他浏览器回退系统默认打开。
 */
export function isolatedBrowserProfileDir(): string {
  const root = process.env.LOCALAPPDATA?.trim() || homedir();
  return join(root, "netsuite-mcp-tools", "browser-profile");
}

export function isolatedBrowserCommands(authorizationUrl: string): IsolatedBrowserCommand[] {
  const profileDir = isolatedBrowserProfileDir();
  const args = [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", authorizationUrl];
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value));
  const commands: IsolatedBrowserCommand[] = [];
  for (const root of roots) {
    commands.push({ command: join(root, "Microsoft", "Edge", "Application", "msedge.exe"), args });
    commands.push({ command: join(root, "Google", "Chrome", "Application", "chrome.exe"), args });
  }
  return commands;
}

export async function openAuthorizationBrowser(
  authorizationUrl: string,
  openExternal: (url: string) => Promise<boolean>
): Promise<boolean> {
  for (const candidate of isolatedBrowserCommands(authorizationUrl)) {
    if (!existsSync(candidate.command)) {
      continue;
    }
    try {
      const child = spawn(candidate.command, candidate.args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      return true;
    } catch {
      // 下一个候选浏览器
    }
  }
  return openExternal(authorizationUrl);
}
