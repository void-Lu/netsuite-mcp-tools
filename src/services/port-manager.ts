import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { EnvironmentStore } from "../config/environment-store";
import { NetSuiteMcpError } from "../domain/types";

const MIN_PORT = 49152;
const MAX_PORT = 65535;
const MAX_ATTEMPTS = 128;

export class PortManager {
  public constructor(private readonly store: EnvironmentStore) {}

  public async getOrAllocate(): Promise<number> {
    const state = await this.store.getState();
    if (state.listener.port > 0) {
      return state.listener.port;
    }
    return this.allocateReplacement();
  }

  public async allocateReplacement(): Promise<number> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const port = randomInt(MIN_PORT, MAX_PORT + 1);
      if (await isPortAvailable(port)) {
        await this.store.setListenerPort(port);
        return port;
      }
    }
    throw new NetSuiteMcpError("port-allocation-failed", "无法分配可用的本地高位端口。请关闭冲突程序后重试。");
  }
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}
