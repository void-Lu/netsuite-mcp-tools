import { createServer, Server } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentStore } from "../config/environment-store";
import { McpConfigWriter } from "../config/mcp-config-writer";
import { OAuthClient } from "../net/oauth-client";
import { HealthCheckService } from "../services/health-check";
import { PortManager } from "../services/port-manager";
import { ProfileManager } from "../services/profile-manager";
import { AllocatedPortRegistry, parseAllocatedPorts } from "../services/allocated-port-registry";
import { McpProxy } from "../transport/mcp-proxy";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace port and OAuth-session isolation", () => {
  it("allocates different ports to concurrently listening workspaces", async () => {
    const first = new PortManager(new EnvironmentStore(await workspace("one")));
    const second = new PortManager(new EnvironmentStore(await workspace("two")));
    const firstPort = await first.getOrAllocate();
    await listen(firstPort);
    const secondPort = await second.getOrAllocate();
    await listen(secondPort);
    expect(secondPort).not.toBe(firstPort);
  });

  it("selects an initial high port outside both shared and user allocation indexes", async () => {
    const store = new EnvironmentStore(await workspace("excluded"));
    await store.addAllocatedPort(49153);
    const registry = fakeRegistry([49152]);
    const candidates = [49152, 49153, 49154];
    const manager = new PortManager(store, registry, () => candidates.shift() ?? 49154, async (port) => port === 49154);

    await expect(manager.getOrAllocate()).resolves.toBe(49154);
    expect((await store.getState()).listener.port).toBe(49154);
    expect(registry.mergeAllocatedPorts).toHaveBeenCalledWith(expect.arrayContaining([49152, 49153]));
  });

  it("propagates successful ports from the user index into environment.json without reserving an untested current listener", async () => {
    const store = new EnvironmentStore(await workspace("sync"));
    await store.setListenerPort(53123);
    const registry = fakeRegistry([49152, 53123]);
    const manager = new PortManager(store, registry);

    await manager.synchronizeAllocatedPorts();

    expect((await store.getState()).allocatedPorts).toEqual([49152]);
    expect(registry.mergeAllocatedPorts).toHaveBeenCalledWith([49152]);
  });

  it("auto-allocates a new port when the persisted listener port is occupied", async () => {
    const store = new EnvironmentStore(await workspace("fixed"));
    await store.setListenerPort(53123);
    const manager = new PortManager(store, fakeRegistry(), () => 49152, async (port) => port !== 53123);

    const port = await manager.getOrAllocate();
    expect(port).toBe(49152);
    expect((await store.getState()).listener.port).toBe(49152);
  });

  it("excludes the occupied listener port when auto-allocating a replacement", async () => {
    const store = new EnvironmentStore(await workspace("exclude-old"));
    await store.setListenerPort(53123);
    const candidates = [53123, 49154];
    const manager = new PortManager(store, fakeRegistry(), () => candidates.shift() ?? 49154, async (port) => port !== 53123);

    const port = await manager.getOrAllocate();
    expect(port).toBe(49154);
    expect((await store.getState()).listener.port).toBe(49154);
  });

  it("normalizes the comma-separated user allocation index without accepting invalid ports", () => {
    expect(parseAllocatedPorts(" 49153,49152,49153,invalid,0,65536 ")).toEqual([49152, 49153]);
  });

  it("auto-starts verified profiles on initialize", async () => {
    const store = new EnvironmentStore(await workspace("session"));
    const profile = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(profile.profile.id, "client-id");
    await store.markVerified(profile.profile.id);

    const proxy = fakeProxy();
    const manager = new ProfileManager(store, fakeOAuth(), {} as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);
    await manager.initialize();
    expect(proxy.start).toHaveBeenCalledWith(53123);
  });

  it("retries with a new port when the proxy loses the availability-check race", async () => {
    const store = new EnvironmentStore(await workspace("listen-race"));
    const profile = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(profile.profile.id, "read-client");
    await store.markVerified(profile.profile.id);
    await store.setListenerPort(53123);
    const proxy = fakeProxy();
    proxy.start.mockRejectedValueOnce(Object.assign(new Error("address in use"), { code: "EADDRINUSE" }));
    const manager = new ProfileManager(store, fakeOAuth(), {} as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);

    await manager.initialize();
    expect(proxy.start).toHaveBeenCalledTimes(2);
  });

  it("refreshes MCP configs when the listener port changes", async () => {
    const store = new EnvironmentStore(await workspace("port-change"));
    const created = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(created.profile.id, "client-id");
    await store.markVerified(created.profile.id);
    await store.setListenerPort(53123);
    const swappedPortManager = {
      getOrAllocate: vi.fn(async () => 54000),
      synchronizeAllocatedPorts: vi.fn(async () => undefined),
      recordSuccessfulConnection: vi.fn(async () => undefined)
    } as unknown as PortManager;
    const configWriter = { refreshExisting: vi.fn(async () => undefined) } as unknown as McpConfigWriter;
    const manager = new ProfileManager(store, fakeOAuth(), {} as HealthCheckService, swappedPortManager, fakeProxy() as unknown as McpProxy, configWriter);

    await manager.initialize();

    expect(configWriter.refreshExisting).toHaveBeenCalledWith(
      expect.any(String),
      `http://127.0.0.1:54000/${created.profile.id}/mcp`
    );
  });

  it("does not refresh MCP configs when the listener port stays the same", async () => {
    const store = new EnvironmentStore(await workspace("port-same"));
    const created = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(created.profile.id, "client-id");
    await store.markVerified(created.profile.id);
    await store.setListenerPort(53123);
    const configWriter = { refreshExisting: vi.fn(async () => undefined) } as unknown as McpConfigWriter;
    const manager = new ProfileManager(store, fakeOAuth(), {} as HealthCheckService, fakePortManager(), fakeProxy() as unknown as McpProxy, configWriter);

    await manager.initialize();

    expect(configWriter.refreshExisting).not.toHaveBeenCalled();
  });

  it("verifies a draft profile whose Public Client ID was filled in environment.json", async () => {
    const root = await workspace("manual-json");
    const initialStore = new EnvironmentStore(root);
    await initialStore.ensureConfigurationTemplate();
    const state = await initialStore.getState();
    const environment = state.environments.YOUR_NETSUITE_ACCOUNT_ID;
    const profile = environment.profiles[0];
    environment.accountId = "9832121-sb1";
    environment.environmentType = "sandbox";
    profile.clientId = "client-from-json";
    delete state.environments.YOUR_NETSUITE_ACCOUNT_ID;
    state.environments[environment.accountId] = environment;
    await writeFile(initialStore.paths.environmentFile, `${JSON.stringify(state, null, 2)}\n`);

    const store = new EnvironmentStore(root);
    const healthCheck = { verify: vi.fn(async () => undefined) } as unknown as HealthCheckService;
    const manager = new ProfileManager(store, fakeOAuth(), healthCheck, fakePortManager(), fakeProxy() as unknown as McpProxy);
    const verified = await manager.verify(profile.id);

    expect(healthCheck.verify).toHaveBeenCalledTimes(1);
    expect(verified.profile.status).toBe("verified");
    expect((await store.findProfile(profile.id))?.profile.status).toBe("verified");
  });

  it("uses the persistent loopback callback URL before opening browser authorization", async () => {
    const store = new EnvironmentStore(await workspace("callback"));
    const created = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(created.profile.id, "public-client");
    const oauth = fakeOAuth();
    const proxy = fakeProxy();
    const manager = new ProfileManager(store, oauth, { verify: vi.fn(async () => undefined) } as unknown as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);

    await manager.authorizeAndVerify(created.profile.id, vi.fn(async () => true));

    expect(proxy.start).toHaveBeenCalledWith(53123);
    expect(oauth.authorize).toHaveBeenCalledWith(expect.objectContaining({ id: created.profile.id }), expect.objectContaining({ accountId: "9832121-sb1" }), "http://127.0.0.1:53123/oauth/callback", expect.any(Function));
  });

  it("delegates hasActiveSession to the OAuth client", async () => {
    const store = new EnvironmentStore(await workspace("has-session"));
    const profile = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(profile.profile.id, "read-client");
    const oauth = fakeOAuth();
    (oauth.hasActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const manager = new ProfileManager(store, oauth, {} as HealthCheckService, fakePortManager(), fakeProxy() as unknown as McpProxy);

    expect(manager.hasActiveSession(profile.profile.id)).toBe(false);
    expect(oauth.hasActiveSession).toHaveBeenCalledWith(profile.profile.id);
  });

  it("disconnects by invalidating tokens, reverting status, and stopping the proxy", async () => {
    const store = new EnvironmentStore(await workspace("disconnect"));
    const created = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(created.profile.id, "client-id");
    await store.markVerified(created.profile.id);
    const oauth = fakeOAuth();
    const proxy = fakeProxy();
    const manager = new ProfileManager(store, oauth, {} as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);

    await manager.disconnect();

    expect(oauth.invalidate).toHaveBeenCalledWith(created.profile.id);
    expect(proxy.stop).toHaveBeenCalledTimes(1);
    const profile = (await store.findProfile(created.profile.id))?.profile;
    expect(profile?.status).toBe("registered");
    expect(profile?.verifiedAt).toBeUndefined();
  });
});

async function workspace(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `netsuite-mcp-${label}-`));
  roots.push(root);
  return root;
}

async function listen(port: number): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
}

function fakePortManager(): PortManager {
  return {
    getOrAllocate: vi.fn(async () => 53123),
    synchronizeAllocatedPorts: vi.fn(async () => undefined),
    recordSuccessfulConnection: vi.fn(async () => undefined)
  } as unknown as PortManager;
}

function fakeRegistry(ports: readonly number[] = []): AllocatedPortRegistry & {
  mergeAllocatedPorts: ReturnType<typeof vi.fn>;
} {
  return {
    getAllocatedPorts: vi.fn(async () => ports),
    addAllocatedPort: vi.fn(async () => undefined),
    mergeAllocatedPorts: vi.fn(async () => undefined)
  };
}

function fakeOAuth(): OAuthClient {
  return {
    authorize: vi.fn(async () => ({ accessToken: "not-logged", httpStatus: 200 })),
    invalidate: vi.fn(),
    clear: vi.fn(),
    hasActiveSession: vi.fn(() => true)
  } as unknown as OAuthClient;
}

function fakeProxy(): {
  isListening: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getUrl: ReturnType<typeof vi.fn>;
  getAuthorizationCallbackUrl: ReturnType<typeof vi.fn>;
} {
  return {
    isListening: vi.fn(() => false),
    start: vi.fn(async () => 53123),
    stop: vi.fn(async () => undefined),
    getUrl: vi.fn(() => undefined),
    getAuthorizationCallbackUrl: vi.fn(() => "http://127.0.0.1:53123/oauth/callback")
  };
}
