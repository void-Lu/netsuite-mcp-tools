import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, ensureDirectory, readTextIfExists } from "../util/files";
import { sanitizeLogFields } from "../util/redaction";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class RedactedLogger {
  public constructor(private readonly logsDirectory: string) {}

  public async info(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    await this.write("info", event, fields);
  }

  public async warn(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    await this.write("warn", event, fields);
  }

  public async error(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    await this.write("error", event, fields);
  }

  private async write(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): Promise<void> {
    await ensureDirectory(this.logsDirectory);
    await this.rotate();
    const file = join(this.logsDirectory, "netsuite-mcp.log");
    const previous = (await readTextIfExists(file)) ?? "";
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitizeLogFields(fields)
    });
    const next = `${previous}${record}\n`;
    await atomicWriteFile(file, Buffer.byteLength(next, "utf8") > MAX_LOG_BYTES ? `${record}\n` : next);
  }

  private async rotate(): Promise<void> {
    try {
      const names = await readdir(this.logsDirectory);
      const cutoff = Date.now() - MAX_LOG_AGE_MS;
      await Promise.all(
        names.filter((name) => name.endsWith(".log")).map(async (name) => {
          const path = join(this.logsDirectory, name);
          const details = await stat(path);
          if (details.mtimeMs < cutoff) {
            await unlink(path);
          }
        })
      );
    } catch {
      // 记录日志失败不应阻断代理；下次写入会再次创建目录。
    }
  }
}
