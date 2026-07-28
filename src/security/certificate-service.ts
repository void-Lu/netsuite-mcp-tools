import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import "reflect-metadata";
import { Dpapi, isPlatformSupported } from "@primno/dpapi";
import { Crypto } from "@peculiar/webcrypto";
import { X509CertificateGenerator } from "@peculiar/x509";
import { ConnectionProfile, NetSuiteMcpError, WorkspacePaths } from "../domain/types";
import { atomicWriteFile, assertPathInside } from "../util/files";

const CERTIFICATE_VALIDITY_DAYS = 365;

export class CertificateService {
  private readonly crypto = new Crypto();

  public constructor(private readonly paths: WorkspacePaths, private readonly workspaceId: string) {}

  public async createProfileCertificate(profile: ConnectionProfile): Promise<void> {
    this.assertSupported();
    const algorithm: RsaHashedKeyGenParams = {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    };
    const keys = await this.crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
    if (!("privateKey" in keys) || !("publicKey" in keys)) {
      throw new NetSuiteMcpError("certificate-generation-failed", "无法生成 RSA 密钥对。");
    }
    const now = new Date();
    const certificate = await X509CertificateGenerator.createSelfSigned(
      {
        serialNumber: createHash("sha256").update(profile.id).digest("hex").slice(0, 32),
        name: `CN=NetSuite MCP ${profile.id}`,
        notBefore: now,
        notAfter: new Date(now.getTime() + CERTIFICATE_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
        signingAlgorithm: algorithm,
        keys
      },
      this.crypto
    );
    const exportedPrivateKey = await this.crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKeyPem = toPem("PRIVATE KEY", Buffer.from(exportedPrivateKey));
    const encryptedPrivateKey = Dpapi.protectData(Buffer.from(privateKeyPem, "utf8"), this.entropy(profile.id), "CurrentUser");

    await atomicWriteFile(this.resolveProfilePath(profile.publicCertificatePath), certificate.toString("pem"));
    await atomicWriteFile(this.resolveProfilePath(profile.privateKeyPath), encryptedPrivateKey);
  }

  public async readPrivateKey(profile: ConnectionProfile): Promise<string> {
    this.assertSupported();
    const encryptedPath = this.resolveProfilePath(profile.privateKeyPath);
    const encrypted = await import("node:fs/promises").then(({ readFile }) => readFile(encryptedPath));
    try {
      return Buffer.from(Dpapi.unprotectData(encrypted, this.entropy(profile.id), "CurrentUser")).toString("utf8");
    } catch (error) {
      throw new NetSuiteMcpError("private-key-unavailable", "无法解密本机私钥。该项目可能已迁移到其他 Windows 用户或设备。", error);
    }
  }

  public async removeProfileCertificate(profile: ConnectionProfile): Promise<void> {
    await Promise.all([
      rm(this.resolveProfilePath(profile.publicCertificatePath), { force: true }),
      rm(this.resolveProfilePath(profile.privateKeyPath), { force: true })
    ]);
  }

  public getCertificateValidityDays(): number {
    return CERTIFICATE_VALIDITY_DAYS;
  }

  private resolveProfilePath(path: string): string {
    return assertPathInside(this.paths.dataDirectory, join(this.paths.dataDirectory, path));
  }

  private entropy(profileId: string): Buffer {
    return createHash("sha256").update(`${this.workspaceId}:${profileId}`).digest();
  }

  private assertSupported(): void {
    if (process.platform !== "win32" || !isPlatformSupported) {
      throw new NetSuiteMcpError("dpapi-unavailable", "此扩展仅支持可用 Windows DPAPI 的本机 VS Code 环境。不会以明文存储私钥。");
    }
  }
}

function toPem(label: string, value: Buffer): string {
  const body = value.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
