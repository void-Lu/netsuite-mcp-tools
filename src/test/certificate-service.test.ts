import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "../config/environment-store";
import { CertificateService } from "../security/certificate-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("CertificateService on Windows", () => {
  it("stores a PEM public certificate and a DPAPI-encrypted private key", async () => {
    const root = await mkdtemp(join(tmpdir(), "netsuite-mcp-certificate-"));
    roots.push(root);
    const store = new EnvironmentStore(root);
    const state = await store.load();
    const service = new CertificateService(store.paths, state.workspaceId);
    const created = await store.createDraftProfile("9832121-sb1", "sandbox", "read", new Date("2027-07-28T00:00:00.000Z"));

    await service.createProfileCertificate(created.profile);

    const publicPem = await readFile(join(store.paths.dataDirectory, created.profile.publicCertificatePath), "utf8");
    const encryptedPrivateKey = await readFile(join(store.paths.dataDirectory, created.profile.privateKeyPath));
    const privatePem = await service.readPrivateKey(created.profile);
    expect(publicPem).toContain("BEGIN CERTIFICATE");
    expect(privatePem).toContain("BEGIN PRIVATE KEY");
    expect(encryptedPrivateKey.toString("utf8")).not.toContain("BEGIN PRIVATE KEY");
  }, 30_000);
});
