import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { EnvironmentStore } from "../config/environment-store";
import { NetSuiteMcpError } from "../domain/types";
import { AllocatedPortRegistry, noOpAllocatedPortRegistry } from "./allocated-port-registry";

const MIN_PORT = 49152;
const MAX_PORT = 65535;
const MAX_ATTEMPTS = 128;

export class PortManager {
  public constructor(
    private readonly store: EnvironmentStore,
    private readonly allocatedPortRegistry: AllocatedPortRegistry = noOpAllocatedPortRegistry,
    private readonly randomPort: () => number = () => randomInt(MIN_PORT, MAX_PORT + 1),
    private readonly isAvailable: (port: number) => Promise<boolean> = isPortAvailable
  ) {}

  /** 将共享 environment.json 的排除端口传播到当前 Windows 用户的本机索引。 */
  public async synchronizeAllocatedPorts(): Promise<void> {
    const initialState = await this.store.getState();
    const localPorts = await this.allocatedPortRegistry.getAllocatedPorts();
    const currentListenerIsUnconfirmed = initialState.listener.port > 0 && !initialState.allocatedPorts.includes(initialState.listener.port);
    await this.store.mergeAllocatedPorts(localPorts.filter((port) => !currentListenerIsUnconfirmed || port !== initialState.listener.port));
    await this.allocatedPortRegistry.mergeAllocatedPorts((await this.store.getState()).allocatedPorts);
  }

  public async getOrAllocate(): Promise<number> {
    const state = await this.store.getState();
    if (state.listener.port > 0 && await this.isAvailable(state.listener.port)) {
      return state.listener.port;
    }
    // listener.port 为 0 或已被占用：同步排除索引后分配新端口
    await this.synchronizeAllocatedPorts();
    const excludedPorts = new Set([
      ...state.allocatedPorts,
      ...await this.allocatedPortRegistry.getAllocatedPorts()
    ]);
    if (state.listener.port > 0) {
      excludedPorts.add(state.listener.port);
    }
    return this.allocateInitialPort(excludedPorts);
  }

  /** 在首次注册 callback URI 前选择一个未登记、可绑定的高位端口。 */
  private async allocateInitialPort(excludedPorts: ReadonlySet<number>): Promise<number> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const port = this.randomPort();
      if (!excludedPorts.has(port) && await this.isAvailable(port)) {
        await this.store.setListenerPort(port);
        return port;
      }
    }
    throw new NetSuiteMcpError("port-allocation-failed", "无法分配可用的本地高位端口。请关闭冲突程序后重试。");
  }

  /** 仅在完整测试连接成功后，把当前 callback 端口登记到两份排除索引。 */
  public async recordSuccessfulConnection(): Promise<void> {
    const port = (await this.store.getState()).listener.port;
    if (port === 0) {
      throw new NetSuiteMcpError("listener-port-unassigned", "本地 OAuth 回调端口尚未分配，无法完成连接测试。");
    }
    await this.store.addAllocatedPort(port);
    await this.allocatedPortRegistry.addAllocatedPort(port);
  }
}

export function listenerPortOccupied(port: number): NetSuiteMcpError {
  return new NetSuiteMcpError(
    "listener-port-occupied",
    `本地端口 ${port} 已被其他进程占用，多次自动分配新端口均失败。请关闭占用高位端口的程序后重试。`
  );
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
