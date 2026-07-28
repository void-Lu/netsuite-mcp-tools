import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "../config/environment-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("EnvironmentStore", () => {
  it("keeps credentials for different account ids in independent profiles", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    const sandbox = await store.createDraftProfile("9832121-sb1", "sandbox", "read", new Date("2027-07-28T00:00:00Z"));
    const production = await store.createDraftProfile("9832121", "production", "read", new Date("2027-07-28T00:00:00Z"));
    await store.registerProfile(sandbox.profile.id, "sandbox-client", "sandbox-cert");
    await store.registerProfile(production.profile.id, "production-client", "production-cert");

    const state = await store.getState();
    expect(state.environments["9832121-sb1"].profiles[0].clientId).toBe("sandbox-client");
    expect(state.environments["9832121"].profiles[0].clientId).toBe("production-client");
    expect(state.environments["9832121-sb1"].profiles[0].privateKeyPath).not.toBe(state.environments["9832121"].profiles[0].privateKeyPath);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain("/.netsuite-mcp/");
  });

  it("refuses to silently change an existing environment type", async () => {
    const store = new EnvironmentStore(await createWorkspace());
    await store.createDraftProfile("9832121", "production", "read", new Date());
    await expect(store.createDraftProfile("9832121", "sandbox", "read", new Date())).rejects.toThrow("环境标签");
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-tools-"));
  temporaryRoots.push(root);
  return root;
}
