import * as vscode from "vscode";
import {
  AllocatedPortRegistry,
  isValidAllocatedPort,
  normalizeAllocatedPorts,
  parseAllocatedPorts
} from "./allocated-port-registry";

const CONFIGURATION_SECTION = "netsuiteMcp";
const CONFIGURATION_KEY = "allocatedPorts";

/** VS Code 用户全局设置的适配层；不能用于推导或修改 workspace callback URI。 */
export class VsCodeAllocatedPortRegistry implements AllocatedPortRegistry {
  public async getAllocatedPorts(): Promise<readonly number[]> {
    return parseAllocatedPorts(this.globalValue());
  }

  public async addAllocatedPort(port: number): Promise<void> {
    if (!isValidAllocatedPort(port)) {
      return;
    }
    const raw = this.globalValue();
    const current = await this.getAllocatedPorts();
    const next = normalizeAllocatedPorts([...current, port]);
    if (next.join(",") !== raw) {
      await this.update(next);
    }
  }

  public async mergeAllocatedPorts(ports: readonly number[]): Promise<void> {
    const normalizedIncoming = normalizeAllocatedPorts(ports);
    if (normalizedIncoming.length === 0) {
      return;
    }
    const raw = this.globalValue();
    const current = await this.getAllocatedPorts();
    const next = normalizeAllocatedPorts([...current, ...normalizedIncoming]);
    if (next.join(",") !== raw) {
      await this.update(next);
    }
  }

  private configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  }

  private globalValue(): string {
    return this.configuration().inspect<string>(CONFIGURATION_KEY)?.globalValue ?? "";
  }

  private async update(ports: readonly number[]): Promise<void> {
    await this.configuration().update(CONFIGURATION_KEY, ports.join(","), vscode.ConfigurationTarget.Global);
  }
}
