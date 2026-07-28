import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectionProfile } from "../domain/types";
import { buildNetSuiteEndpoints } from "../net/endpoints";
import { OAuthClient } from "../net/oauth-client";
import { CertificateService } from "../security/certificate-service";

const profile: ConnectionProfile = {
  id: "test-profile",
  access: "read",
  status: "verified",
  clientId: "client-id",
  certificateId: "certificate-id",
  publicCertificatePath: "certificates/test.public.pem",
  privateKeyPath: "certificates/test.private.dpapi",
  expiresAt: "2027-07-28T00:00:00.000Z",
  createdAt: "2026-07-28T00:00:00.000Z"
};

describe("OAuthClient", () => {
  it("creates a PS256 assertion and caches the token per profile", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certificates = { readPrivateKey: vi.fn(async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString()) } as unknown as CertificateService;
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ access_token: "not-logged", expires_in: 3600 }), { status: 200 }));
    const client = new OAuthClient(certificates, fetchImplementation);
    const endpoints = buildNetSuiteEndpoints("9832121-sb1");

    const assertion = await client.createClientAssertion(profile, endpoints);
    const [header, payload] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toMatchObject({ alg: "PS256", kid: "certificate-id" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toMatchObject({ iss: "client-id", aud: endpoints.tokenUrl });
    await expect(client.getAccessToken(profile, endpoints)).resolves.toBe("not-logged");
    await expect(client.getAccessToken(profile, endpoints)).resolves.toBe("not-logged");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
