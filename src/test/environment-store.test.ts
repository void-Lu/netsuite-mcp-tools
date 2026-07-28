import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "../config/environment-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("EnvironmentStore", () => {
  it("keeps Public Client IDs for different account IDs in independent profiles", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    const sandbox = await store.createDraftProfile("9832121-sb1", "sandbox", "read");
    const production = await store.createDraftProfile("9832121", "production", "read");
    await store.registerProfile(sandbox.profile.id, "sandbox-client");
    await store.registerProfile(production.profile.id, "production-client");

    const state = await store.getState();
    expect(state.environments["9832121-sb1"].profiles[0]).toMatchObject({ clientId: "sandbox-client" });
    expect(state.environments["9832121"].profiles[0]).toMatchObject({ clientId: "production-client" });
    expect(state.environments["9832121-sb1"].profiles[0].id).not.toBe(state.environments["9832121"].profiles[0].id);
    const gitIgnore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitIgnore).toContain("/.netsuite-mcp/logs/");
    expect(gitIgnore).toContain("/.vscode/mcp.json");
    expect(gitIgnore).toContain("/.mcp.json");
    expect(gitIgnore).not.toContain("/.netsuite-mcp/\n");
  });

  it("refuses to silently change an existing environment type", async () => {
    const store = new EnvironmentStore(await createWorkspace());
    await store.createDraftProfile("9832121", "production", "read");
    await expect(store.createDraftProfile("9832121", "sandbox", "read")).rejects.toThrow("环境标签");
  });

  it("creates an editable client-only template without token, secret or certificate fields", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    expect(await store.ensureConfigurationTemplate()).toBe("initialized");
    expect(await store.ensureConfigurationTemplate()).toBe("unchanged");

    const profile = (await store.getState()).environments.YOUR_NETSUITE_ACCOUNT_ID.profiles[0];
    expect(profile).toMatchObject({ access: "read", status: "draft", clientId: "" });
    expect(Object.keys(profile)).toEqual(["id", "access", "status", "clientId", "createdAt"]);
    const persisted = await readFile(store.paths.environmentFile, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({ schemaVersion: 2, listener: { host: "127.0.0.1", port: 0 }, allocatedPorts: [] });
    expect(persisted).not.toMatch(/certificate|private.?key|access.?token|refresh.?token|client.?secret/i);
  });

  it("initializes a whitespace-only environment file as a complete editable template", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    await mkdir(store.paths.dataDirectory, { recursive: true });
    await writeFile(store.paths.environmentFile, " \r\n\t ");
    expect(await store.ensureConfigurationTemplate()).toBe("initialized");
    expect((await store.getState()).environments.YOUR_NETSUITE_ACCOUNT_ID.profiles.map(({ access }) => access)).toEqual(["read", "write"]);
  });

  it("safely completes a partial schema while retaining a manually entered Public Client ID", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    await mkdir(store.paths.dataDirectory, { recursive: true });
    await writeFile(store.paths.environmentFile, JSON.stringify({
      environments: { "9832121-sb1": { profiles: [{ access: "read", clientId: "existing-client-id" }] } }
    }));

    expect(await store.ensureConfigurationTemplate()).toBe("completed");
    const profile = (await store.getState()).environments["9832121-sb1"].profiles[0];
    expect(profile).toMatchObject({ access: "read", clientId: "existing-client-id", status: "draft" });
    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Date.parse(profile.createdAt)).toBeGreaterThan(0);
  });

  it("migrates the known v1 certificate metadata by preserving only Public Client ID", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    const legacy = {
      schemaVersion: 1,
      workspaceId: "workspace-id",
      listener: { host: "127.0.0.1", port: 53123 },
      environments: {
        "9832121-sb1": {
          accountId: "9832121-sb1",
          environmentType: "sandbox",
          profiles: [{
            id: "legacy-profile", access: "read", status: "verified", clientId: "legacy-client", certificateId: "legacy-cert",
            publicCertificatePath: "certificates/legacy.public.pem", privateKeyPath: "certificates/legacy.private.dpapi",
            expiresAt: "2027-07-28T00:00:00.000Z", createdAt: "2026-07-28T00:00:00.000Z"
          }]
        }
      }
    };
    await mkdir(store.paths.dataDirectory, { recursive: true });
    await writeFile(store.paths.environmentFile, JSON.stringify(legacy));

    expect(await store.ensureConfigurationTemplate()).toBe("completed");
    const persisted = await readFile(store.paths.environmentFile, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({ schemaVersion: 2 });
    expect(JSON.parse(persisted).allocatedPorts).toEqual([]);
    expect(persisted).toContain("legacy-client");
    expect(persisted).not.toMatch(/certificate|privateKey|expiresAt/);
  });

  it("loads a pre-allocation v2 environment and persists the shared port index on the next save", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    await mkdir(store.paths.dataDirectory, { recursive: true });
    await writeFile(store.paths.environmentFile, JSON.stringify({
      schemaVersion: 2,
      workspaceId: "workspace-id",
      listener: { host: "127.0.0.1", port: 53123 },
      environments: {}
    }));

    expect((await store.getState()).allocatedPorts).toEqual([]);
    await store.setListenerPort(53123);
    expect(JSON.parse(await readFile(store.paths.environmentFile, "utf8")).allocatedPorts).toEqual([]);
  });

  it("migrates the legacy data-directory ignore rule while retaining local Agent configuration ignores", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, ".gitignore"), "/.netsuite-mcp/\n/.vscode/mcp.json\n/.mcp.json\nnode_modules/\n");
    const store = new EnvironmentStore(root);
    await store.createDraftProfile("9832121-sb1", "sandbox", "read");

    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("/.vscode/mcp.json\n/.mcp.json\nnode_modules/\n/.netsuite-mcp/logs/\n");
  });

  it("rejects unknown sensitive fields without overwriting the original file", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    const raw = JSON.stringify({ environments: { "9832121-sb1": { profiles: [{ access: "read", clientId: "keep-client", accessToken: "must-not-persist" }] } } }, null, 2);
    await mkdir(store.paths.dataDirectory, { recursive: true });
    await writeFile(store.paths.environmentFile, raw);
    await expect(store.ensureConfigurationTemplate()).rejects.toThrow("结构不受当前扩展支持");
    expect(await readFile(store.paths.environmentFile, "utf8")).toBe(raw);
  });

  it("rejects malformed JSON and type errors without overwriting the original file", async () => {
    const root = await createWorkspace();
    const store = new EnvironmentStore(root);
    await mkdir(store.paths.dataDirectory, { recursive: true });
    await writeFile(store.paths.environmentFile, "{ \"environments\": [");
    await expect(store.ensureConfigurationTemplate()).rejects.toThrow("不是有效 JSON");
    await writeFile(store.paths.environmentFile, JSON.stringify({ listener: { host: "127.0.0.1", port: "53123" } }));
    await expect(store.ensureConfigurationTemplate()).rejects.toThrow("结构不受当前扩展支持");
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-tools-"));
  temporaryRoots.push(root);
  return root;
}
