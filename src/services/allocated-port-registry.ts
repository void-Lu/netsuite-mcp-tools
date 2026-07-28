/** 仅保存本机已知端口的用户级索引；environment.json 才是 workspace 回调地址的来源。 */
export interface AllocatedPortRegistry {
  getAllocatedPorts(): Promise<readonly number[]>;
  addAllocatedPort(port: number): Promise<void>;
  mergeAllocatedPorts(ports: readonly number[]): Promise<void>;
}

export const noOpAllocatedPortRegistry: AllocatedPortRegistry = {
  getAllocatedPorts: async () => [],
  addAllocatedPort: async () => undefined,
  mergeAllocatedPorts: async () => undefined
};

export function parseAllocatedPorts(value: string): number[] {
  return normalizeAllocatedPorts(value.split(",").map((entry) => Number(entry.trim())));
}

export function normalizeAllocatedPorts(ports: readonly number[]): number[] {
  return [...new Set(ports.filter(isValidAllocatedPort))].sort((left, right) => left - right);
}

export function isValidAllocatedPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}
