import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface IsolatedBrowserCommand {
  command: string;
  args: string[];
}

/**
 * SuiteCloud Development Integration 的 OAuth 同意策略常为「从不询问」。
 * 若 MCP 授权走默认浏览器配置，随后 SuiteCloud PKCE 续期会继承这次选的 Role，
 * 并改写 ~/.suitecloud-sdk/credentials_browser_based.p12。
 * InPrivate/Incognito 把 MCP 登录隔离在一次性会话里。
 * ponytail: 只覆盖 Edge/Chrome；Firefox 或其他浏览器回退系统默认打开。
 */
export function isolatedBrowserCommands(authorizationUrl: string): IsolatedBrowserCommand[] {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value));
  const commands: IsolatedBrowserCommand[] = [];
  for (const root of roots) {
    commands.push({ command: join(root, "Microsoft", "Edge", "Application", "msedge.exe"), args: ["--inprivate", authorizationUrl] });
    commands.push({ command: join(root, "Google", "Chrome", "Application", "chrome.exe"), args: ["--incognito", authorizationUrl] });
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
