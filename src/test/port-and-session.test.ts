import { createServer, Server } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentStore } from "../config/environment-store";
import { McpConfigWriter } from "../config/mcp-config-writer";
import { buildNetSuiteEndpoints } from "../net/endpoints";
import { OAuthClient, parsePersistedToken, serializePersistedToken, TokenSecretStore } from "../net/oauth-client";
import { HealthCheckService } from "../services/health-check";
import { PortManager } from "../services/port-manager";
import { ProfileManager } from "../services/profile-manager";
import { RedactedLogger } from "../services/redacted-logger";
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

  it("starts the proxy when a verified profile already has an active session", async () => {
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

    expect(oauth.deleteStoredToken).toHaveBeenCalledWith(created.profile.id);
    expect((oauth.deleteStoredToken as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((oauth.invalidate as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(oauth.invalidate).toHaveBeenCalledWith(created.profile.id);
    expect(proxy.stop).toHaveBeenCalledTimes(1);
    const profile = (await store.findProfile(created.profile.id))?.profile;
    expect(profile?.status).toBe("registered");
    expect(profile?.verifiedAt).toBeUndefined();
  });

  it("does not listen when a verified profile has no recoverable session", async () => {
    const store = new EnvironmentStore(await workspace("no-session"));
    const created = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(created.profile.id, "client-id");
    await store.markVerified(created.profile.id);
    const proxy = fakeProxy();
    const oauth = fakeOAuth(false);
    const manager = new ProfileManager(store, oauth, {} as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);

    await manager.initialize();

    expect(oauth.restorePersistedSession).toHaveBeenCalledTimes(1);
    expect(proxy.start).not.toHaveBeenCalled();
    expect((await store.findProfile(created.profile.id))?.profile.status).toBe("verified");
  });

  it("does not restore a non-verified profile", async () => {
    const store = new EnvironmentStore(await workspace("registered-only"));
    const created = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(created.profile.id, "client-id");
    const proxy = fakeProxy();
    const oauth = fakeOAuth(false);
    const manager = new ProfileManager(store, oauth, {} as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);

    await manager.initialize();

    expect(oauth.restorePersistedSession).not.toHaveBeenCalled();
    expect(proxy.start).not.toHaveBeenCalled();
  });

  it("resumes an unexpired verified session without a token request", async () => {
    const store = new EnvironmentStore(await workspace("resume"));
    const created = await verifiedProfile(store);
    const access = "kept-access-not-in-files";
    const refresh = "kept-refresh-not-in-files";
    const secrets = memorySecrets({
      [created.profile.id]: serializePersistedToken({
        accessToken: access,
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: refresh
      })
    });
    const fetchImplementation = vi.fn<typeof fetch>();
    const proxy = fakeProxy();
    const manager = new ProfileManager(
      store,
      new OAuthClient(fetchImplementation, secrets),
      {} as HealthCheckService,
      fakePortManager(),
      proxy as unknown as McpProxy
    );

    await manager.initialize();

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(proxy.start).toHaveBeenCalledWith(53123);
    const persisted = await readFile(store.paths.environmentFile, "utf8");
    expect(persisted).not.toContain(access);
    expect(persisted).not.toContain(refresh);
    expect((await store.findProfile(created.profile.id))?.profile.status).toBe("verified");
  });

  it("refreshes one expired profile without failing activation of another", async () => {
    const store = new EnvironmentStore(await workspace("mixed-resume"));
    const expired = await verifiedProfile(store);
    const current = await verifiedProfile(store);
    const secrets = memorySecrets({
      [expired.profile.id]: serializePersistedToken({ accessToken: "old-access", expiresAt: 0, refreshToken: "old-refresh" }),
      [current.profile.id]: serializePersistedToken({
        accessToken: "current-access",
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: "current-refresh"
      })
    });
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    const proxy = fakeProxy();
    const manager = new ProfileManager(
      store,
      new OAuthClient(fetchImplementation, secrets),
      {} as HealthCheckService,
      fakePortManager(),
      proxy as unknown as McpProxy
    );

    await manager.initialize();

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(secrets.data.has(expired.profile.id)).toBe(false);
    expect(secrets.data.has(current.profile.id)).toBe(true);
    expect(proxy.start).toHaveBeenCalledTimes(1);
    expect((await store.findProfile(expired.profile.id))?.profile.status).toBe("verified");
  });

  it("does not write token material to the log or environment file when persistence fails", async () => {
    const store = new EnvironmentStore(await workspace("secret-log"));
    const created = await verifiedProfile(store);
    const access = "logged-access-must-not-appear";
    const refresh = "logged-refresh-must-not-appear";
    const rotatedAccess = "rotated-access-must-not-appear";
    const rotatedRefresh = "rotated-refresh-must-not-appear";
    const secrets: TokenSecretStore = {
      get: async (id) => id === created.profile.id
        ? serializePersistedToken({ accessToken: access, expiresAt: 0, refreshToken: refresh })
        : undefined,
      set: async () => { throw new Error(`failed to store ${access} ${refresh} ${rotatedAccess}`); },
      delete: async () => undefined
    };
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: rotatedAccess,
      refresh_token: rotatedRefresh,
      expires_in: 3600
    }), { status: 200 }));
    const proxy = fakeProxy();
    const manager = new ProfileManager(
      store,
      new OAuthClient(fetchImplementation, secrets, new RedactedLogger(store.paths.logsDirectory)),
      {} as HealthCheckService,
      fakePortManager(),
      proxy as unknown as McpProxy
    );

    await manager.initialize();

    expect(proxy.start).toHaveBeenCalledTimes(1);
    const log = await readFile(join(store.paths.logsDirectory, "netsuite-mcp.log"), "utf8");
    const persisted = await readFile(store.paths.environmentFile, "utf8");
    for (const secret of [access, refresh, rotatedAccess, rotatedRefresh]) {
      expect(log).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    expect(log).toContain("token_persist_failed");
  });

  it("does not downgrade or stop the proxy when secret deletion fails", async () => {
    const store = new EnvironmentStore(await workspace("disconnect-locked"));
    const created = await verifiedProfile(store);
    const oauth = fakeOAuth();
    (oauth.deleteStoredToken as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("secret-locked"));
    const proxy = fakeProxy();
    const manager = new ProfileManager(store, oauth, {} as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);

    await expect(manager.disconnect()).rejects.toThrow("secret-locked");

    expect(oauth.invalidate).not.toHaveBeenCalled();
    expect(proxy.stop).not.toHaveBeenCalled();
    expect((await store.findProfile(created.profile.id))?.profile.status).toBe("verified");
  });

  it("does not remove a profile when secret deletion fails", async () => {
    const store = new EnvironmentStore(await workspace("remove-locked"));
    const created = await verifiedProfile(store);
    const oauth = fakeOAuth();
    (oauth.deleteStoredToken as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("secret-locked"));
    const manager = new ProfileManager(store, oauth, {} as HealthCheckService, fakePortManager(), fakeProxy() as unknown as McpProxy);

    await expect(manager.remove(created.profile.id)).rejects.toThrow("secret-locked");

    expect(await store.findProfile(created.profile.id)).toBeDefined();
    expect(oauth.invalidate).not.toHaveBeenCalled();
  });

  it("removes the stored token before removing the profile", async () => {
    const store = new EnvironmentStore(await workspace("remove-secret"));
    const created = await verifiedProfile(store);
    const secrets = memorySecrets({
      [created.profile.id]: serializePersistedToken({ accessToken: "remove-access", expiresAt: 1, refreshToken: "remove-refresh" })
    });
    const manager = new ProfileManager(
      store,
      new OAuthClient(vi.fn<typeof fetch>(), secrets),
      {} as HealthCheckService,
      fakePortManager(),
      fakeProxy() as unknown as McpProxy
    );

    await manager.remove(created.profile.id);

    expect(secrets.data.has(created.profile.id)).toBe(false);
    expect(await store.findProfile(created.profile.id)).toBeUndefined();
  });

  it("clears a secret left on a registered profile and does not touch another profile when removing one", async () => {
    const store = new EnvironmentStore(await workspace("registered-secret"));
    const registered = await store.createDraftProfile("9832121-sb1", "sandbox");
    await store.registerProfile(registered.profile.id, "client-id");
    const other = await verifiedProfile(store);
    const secrets = memorySecrets({
      [registered.profile.id]: serializePersistedToken({ accessToken: "reg-access", expiresAt: 1, refreshToken: "reg-refresh" }),
      [other.profile.id]: serializePersistedToken({ accessToken: "other-access", expiresAt: 1, refreshToken: "other-refresh" })
    });
    const manager = new ProfileManager(
      store,
      new OAuthClient(vi.fn<typeof fetch>(), secrets),
      {} as HealthCheckService,
      fakePortManager(),
      fakeProxy() as unknown as McpProxy
    );

    await manager.disconnect();

    expect(secrets.data.has(registered.profile.id)).toBe(false);
    expect(secrets.data.has(other.profile.id)).toBe(false);
    expect((await store.findProfile(registered.profile.id))?.profile.status).toBe("registered");
    expect((await store.findProfile(other.profile.id))?.profile.status).toBe("registered");
  });

  it("removes one profile secret without clearing another", async () => {
    const store = new EnvironmentStore(await workspace("remove-one"));
    const created = await verifiedProfile(store);
    const other = await verifiedProfile(store);
    const secrets = memorySecrets({
      [created.profile.id]: serializePersistedToken({ accessToken: "remove-access", expiresAt: 1, refreshToken: "remove-refresh" }),
      [other.profile.id]: serializePersistedToken({ accessToken: "keep-access", expiresAt: 1, refreshToken: "keep-refresh" })
    });
    const manager = new ProfileManager(
      store,
      new OAuthClient(vi.fn<typeof fetch>(), secrets),
      {} as HealthCheckService,
      fakePortManager(),
      fakeProxy() as unknown as McpProxy
    );

    await manager.remove(created.profile.id);

    expect(secrets.data.has(created.profile.id)).toBe(false);
    expect(parsePersistedToken(secrets.data.get(other.profile.id) ?? "")?.refreshToken).toBe("keep-refresh");
    expect((await store.findProfile(other.profile.id))?.profile.status).toBe("verified");
  });

  it("keeps a usable session when disconnect cannot delete the secret", async () => {
    const store = new EnvironmentStore(await workspace("disconnect-session"));
    const created = await verifiedProfile(store);
    const secrets = memorySecrets({
      [created.profile.id]: serializePersistedToken({
        accessToken: "still-usable",
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: "still-refresh"
      })
    });
    secrets.delete = async () => { throw new Error("secret-locked"); };
    const oauth = new OAuthClient(vi.fn<typeof fetch>(), secrets);
    await oauth.restorePersistedSession(created.profile, buildNetSuiteEndpoints("9832121-sb1"));
    const proxy = fakeProxy();
    const manager = new ProfileManager(store, oauth, {} as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);

    await expect(manager.disconnect()).rejects.toThrow("secret-locked");

    expect(oauth.hasActiveSession(created.profile.id)).toBe(true);
    expect(parsePersistedToken(secrets.data.get(created.profile.id) ?? "")?.accessToken).toBe("still-usable");
    expect((await store.findProfile(created.profile.id))?.profile.status).toBe("verified");
    expect(proxy.stop).not.toHaveBeenCalled();
  });

  it("does not persist a token exchange that finishes after stop", async () => {
    const store = new EnvironmentStore(await workspace("stop-exchange"));
    const created = await verifiedProfile(store);
    const profile = (await store.findProfile(created.profile.id))?.profile;
    if (!profile) {
      throw new Error("verified profile missing");
    }
    let releaseExchange: (value: Response) => void = () => undefined;
    const fetchImplementation = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { releaseExchange = resolve; }));
    const secrets = memorySecrets({
      [created.profile.id]: serializePersistedToken({
        accessToken: "kept-access",
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: "kept-refresh"
      })
    });
    const oauth = new OAuthClient(fetchImplementation, secrets);
    const proxy = fakeProxy();
    const manager = new ProfileManager(store, oauth, {} as HealthCheckService, fakePortManager(), proxy as unknown as McpProxy);
    const request = oauth.beginAuthorization(profile, buildNetSuiteEndpoints("9832121-sb1"), "http://127.0.0.1:53123/oauth/callback");
    const callback = new URL(`http://127.0.0.1:53123/oauth/callback?state=${new URL(request.authorizationUrl).searchParams.get("state")}&code=late-code`);
    const completing = oauth.completeAuthorizationCallback(callback);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));

    await manager.stop();
    releaseExchange(new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), { status: 200 }));
    await expect(completing).resolves.toMatchObject({ statusCode: 400 });
    await expect(request.completion).rejects.toMatchObject({ code: "authorization-cancelled" });
    expect(parsePersistedToken(secrets.data.get(created.profile.id) ?? "")?.accessToken).toBe("kept-access");
    expect(oauth.hasActiveSession(created.profile.id)).toBe(false);
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

function fakeOAuth(session = true): OAuthClient {
  return {
    authorize: vi.fn(async () => ({ accessToken: "not-logged", httpStatus: 200 })),
    invalidate: vi.fn(),
    clear: vi.fn(),
    deleteStoredToken: vi.fn(async () => undefined),
    restorePersistedSession: vi.fn(async () => undefined),
    hasActiveSession: vi.fn(() => session)
  } as unknown as OAuthClient;
}

async function verifiedProfile(store: EnvironmentStore): Promise<Awaited<ReturnType<EnvironmentStore["createDraftProfile"]>>> {
  const created = await store.createDraftProfile("9832121-sb1", "sandbox");
  await store.registerProfile(created.profile.id, "client-id");
  await store.markVerified(created.profile.id);
  return created;
}

function memorySecrets(initial: Record<string, string> = {}): TokenSecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (id) => data.get(id),
    set: async (id, value) => { data.set(id, value); },
    delete: async (id) => { data.delete(id); }
  };
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
