import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectionProfile } from "../domain/types";
import { buildNetSuiteEndpoints } from "../net/endpoints";
import { OAuthClient } from "../net/oauth-client";

const profile: ConnectionProfile = {
  id: "test-profile",
  access: "read",
  status: "registered",
  clientId: "public-client-id",
  createdAt: "2026-07-28T00:00:00.000Z"
};

const redirectUri = "http://127.0.0.1:53123/oauth/callback";

describe("OAuthClient", () => {
  it("uses a one-time state and S256 PKCE verifier to exchange an authorization code", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: "access-token-not-logged",
      refresh_token: "refresh-token-not-logged",
      expires_in: 3600
    }), { status: 200 }));
    const client = new OAuthClient(fetchImplementation);
    const endpoints = buildNetSuiteEndpoints("9832121-sb1");
    const request = client.beginAuthorization(profile, endpoints, redirectUri);
    const authorizeUrl = new URL(request.authorizationUrl);

    expect(authorizeUrl.origin).toBe("https://9832121-sb1.app.netsuite.com");
    expect(authorizeUrl.pathname).toBe("/app/login/oauth2/authorize.nl");
    expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "public-client-id",
      redirect_uri: redirectUri,
      scope: "mcp",
      code_challenge_method: "S256"
    });
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{22,1024}$/);

    const callback = new URL(redirectUri);
    callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "authorization-code-not-logged");
    await expect(client.completeAuthorizationCallback(callback)).resolves.toMatchObject({ statusCode: 200 });
    await expect(request.completion).resolves.toEqual({ accessToken: "access-token-not-logged", httpStatus: 200 });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [tokenUrl, init] = fetchImplementation.mock.calls[0];
    expect(tokenUrl).toBe(endpoints.tokenUrl);
    expect(init?.headers).not.toHaveProperty("authorization");
    const form = new URLSearchParams(init?.body as URLSearchParams);
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      code: "authorization-code-not-logged",
      client_id: "public-client-id",
      redirect_uri: redirectUri
    });
    const verifier = form.get("code_verifier");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash("sha256").update(verifier ?? "", "ascii").digest("base64url")).toBe(authorizeUrl.searchParams.get("code_challenge"));
  });

  it("rejects unknown or replayed callback state without a token request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new OAuthClient(fetchImplementation);
    const request = client.beginAuthorization(profile, buildNetSuiteEndpoints("9832121-sb1"), redirectUri);
    const callback = new URL(redirectUri);
    callback.searchParams.set("state", "invalid-state-that-is-long-enough");
    callback.searchParams.set("code", "ignored");
    await expect(client.completeAuthorizationCallback(callback)).resolves.toMatchObject({ statusCode: 400 });
    expect(fetchImplementation).not.toHaveBeenCalled();

    const state = new URL(request.authorizationUrl).searchParams.get("state") ?? "";
    callback.searchParams.set("state", state);
    callback.searchParams.set("error", "access_denied");
    await expect(client.completeAuthorizationCallback(callback)).resolves.toMatchObject({ statusCode: 400 });
    await expect(request.completion).rejects.toMatchObject({ code: "authorization-denied" });
    await expect(client.completeAuthorizationCallback(callback)).resolves.toMatchObject({ statusCode: 400 });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("refreshes only from the volatile refresh token and atomically replaces it", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "first-access", refresh_token: "first-refresh", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "second-access", refresh_token: "second-refresh", expires_in: 3600 }), { status: 200 }));
    const client = new OAuthClient(fetchImplementation);
    const endpoints = buildNetSuiteEndpoints("9832121-sb1");
    const request = client.beginAuthorization(profile, endpoints, redirectUri);
    const callback = new URL(`${redirectUri}?state=${new URL(request.authorizationUrl).searchParams.get("state")}&code=first-code`);
    await client.completeAuthorizationCallback(callback);
    await request.completion;

    client.invalidateAccessToken(profile.id);
    await expect(client.getAccessToken(profile, endpoints)).resolves.toBe("second-access");

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [, refreshInit] = fetchImplementation.mock.calls[1];
    const form = new URLSearchParams(refreshInit?.body as URLSearchParams);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "refresh_token", refresh_token: "first-refresh", client_id: "public-client-id" });
    expect(refreshInit?.headers).not.toHaveProperty("authorization");
  });

  it("requires browser authorization before the proxy can obtain a token", async () => {
    const client = new OAuthClient(vi.fn<typeof fetch>());
    await expect(client.getAccessToken(profile, buildNetSuiteEndpoints("9832121-sb1"))).rejects.toMatchObject({ code: "authorization-required" });
  });

  it("reports hasActiveSession only after a token is cached", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600
    }), { status: 200 }));
    const client = new OAuthClient(fetchImplementation);
    const endpoints = buildNetSuiteEndpoints("9832121-sb1");

    expect(client.hasActiveSession(profile.id)).toBe(false);

    const request = client.beginAuthorization(profile, endpoints, redirectUri);
    const callback = new URL(`${redirectUri}?state=${new URL(request.authorizationUrl).searchParams.get("state")}&code=auth-code`);
    await client.completeAuthorizationCallback(callback);
    await request.completion;

    expect(client.hasActiveSession(profile.id)).toBe(true);
    client.invalidate(profile.id);
    expect(client.hasActiveSession(profile.id)).toBe(false);
  });
});
