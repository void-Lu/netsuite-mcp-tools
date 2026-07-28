import { createServer, Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentStore } from "../config/environment-store";
import { CertificateService } from "../security/certificate-service";
import { HealthCheckService } from "../services/health-check";
import { PortManager } from "../services/port-manager";
import { ProfileManager } from "../services/profile-manager";
import { McpProxy } from "../transport/mcp-proxy";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace port and write-session isolation", () => {
  it("allocates different ports to concurrently listening workspaces", async () => {
    const first = new PortManager(new EnvironmentStore(await workspace("one")));
    const second = new PortManager(new EnvironmentStore(await workspace("two")));
    const firstPort = await first.getOrAllocate();
    await listen(firstPort);
    const secondPort = await second.getOrAllocate();
    await listen(secondPort);

    expect(secondPort).not.toBe(firstPort);
  });

  it("auto-starts verified read profiles while write authorization resets with a new session manager", async () => {
    const store = new EnvironmentStore(await workspace("session"));
    const read = await store.createDraftProfile("9832121-sb1", "sandbox", "read", new Date("2027-07-28T00:00:00Z"));
    const write = await store.createDraftProfile("9832121-sb1", "sandbox", "write", new Date("2027-07-28T00:00:00Z"));
    await store.registerProfile(read.profile.id, "read-client", "read-cert");
    await store.registerProfile(write.profile.id, "write-client", "write-cert");
    await store.markVerified(read.profile.id);
    await store.markVerified(write.profile.id);

    const proxy = fakeProxy();
    const manager = new ProfileManager(
      store,
      {} as CertificateService,
      {} as HealthCheckService,
      fakePortManager(),
      proxy as unknown as McpProxy
    );
    await manager.initialize();
    expect(proxy.start).toHaveBeenCalledWith(53123);

    await manager.enableWrite(write.profile.id);
    expect(manager.isWriteEnabled(write.profile.id)).toBe(true);

    const restartedManager = new ProfileManager(
      store,
      {} as CertificateService,
      {} as HealthCheckService,
      fakePortManager(),
      fakeProxy() as unknown as McpProxy
    );
    expect(restartedManager.isWriteEnabled(write.profile.id)).toBe(false);
  });

  it("only reports registered certificates that expire within the next seven days", async () => {
    const store = new EnvironmentStore(await workspace("expiry"));
    const expiring = await store.createDraftProfile("9832121-sb1", "sandbox", "read", new Date("2026-08-03T00:00:00Z"));
    const farAway = await store.createDraftProfile("9832121-sb1", "sandbox", "write", new Date("2026-08-10T00:00:00Z"));
    const draft = await store.createDraftProfile("9832121-sb1", "sandbox", "read", new Date("2026-08-01T00:00:00Z"));
    await store.registerProfile(expiring.profile.id, "client-one", "cert-one");
    await store.registerProfile(farAway.profile.id, "client-two", "cert-two");

    const manager = new ProfileManager(
      store,
      {} as CertificateService,
      {} as HealthCheckService,
      fakePortManager(),
      fakeProxy() as unknown as McpProxy
    );
    const profiles = await manager.getProfilesExpiringWithin(7, Date.parse("2026-07-28T00:00:00Z"));

    expect(profiles.map(({ profile }) => profile.id)).toEqual([expiring.profile.id]);
    expect(profiles.map(({ profile }) => profile.id)).not.toContain(draft.profile.id);
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
    allocateReplacement: vi.fn(async () => 53124)
  } as unknown as PortManager;
}

function fakeProxy(): { isListening: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; getUrl: ReturnType<typeof vi.fn> } {
  return {
    isListening: vi.fn(() => false),
    start: vi.fn(async () => 53123),
    stop: vi.fn(async () => undefined),
    getUrl: vi.fn(() => undefined)
  };
}
