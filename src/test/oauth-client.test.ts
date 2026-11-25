import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectionProfile } from "../domain/types";
import { buildNetSuiteEndpoints } from "../net/endpoints";
import { OAuthClient, parsePersistedToken, serializePersistedToken, tokenSecretKey, TokenSecretStore } from "../net/oauth-client";

const profile: ConnectionProfile = {
  id: "test-profile",
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

    await client.invalidateAccessToken(profile.id, "first-access");
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

describe("persisted OAuth tokens", () => {
  const endpoints = buildNetSuiteEndpoints("9832121-sb1");
  const access = "access-token-not-logged";
  const refresh = "refresh-token-not-logged";

  it("builds a versioned secret key and rejects unknown token fields", () => {
    expect(tokenSecretKey("workspace-1", profile.id)).toBe(`netsuite-mcp.token.v1.workspace-1.${profile.id}`);
    expect(parsePersistedToken(JSON.stringify({ accessToken: access, expiresAt: 10, refreshToken: refresh, httpStatus: 200 }))).toBeUndefined();
    expect(parsePersistedToken("not-json")).toBeUndefined();
    expect(parsePersistedToken(JSON.stringify({ accessToken: "", expiresAt: 10 }))).toBeUndefined();
  });

  it("writes the token triple after authorization and clear does not delete it", async () => {
    const secrets = memorySecrets();
    const client = new OAuthClient(tokenFetch(), secrets);
    await completeAuthorization(client);
    expect(parsePersistedToken(secrets.data.get(profile.id) ?? "")).toMatchObject({ accessToken: access, refreshToken: refresh });
    expect(secrets.data.get(profile.id)).not.toContain("httpStatus");
    expect(secrets.data.get(profile.id)).not.toContain("authorization-code-not-logged");

    const pending = client.beginAuthorization(profile, endpoints, redirectUri);
    await client.clear();
    expect(client.hasActiveSession(profile.id)).toBe(false);
    expect(secrets.data.has(profile.id)).toBe(true);
    await expect(pending.completion).rejects.toMatchObject({ code: "authorization-cancelled" });
  });

  it("restores an unexpired token with zero token requests", async () => {
    const secrets = memorySecrets({
      [profile.id]: serializePersistedToken({ accessToken: access, expiresAt: Date.now() + 10 * 60 * 1000, refreshToken: refresh })
    });
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new OAuthClient(fetchImplementation, secrets);

    await expect(client.restorePersistedSession(profile, endpoints)).resolves.toBe(true);
    await expect(client.getAccessToken(profile, endpoints)).resolves.toBe(access);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(secrets.data.has(profile.id)).toBe(true);
  });

  it("refreshes exactly once inside the skew window and replaces the stored triple", async () => {
    const secrets = memorySecrets({
      [profile.id]: serializePersistedToken({ accessToken: "old-access", expiresAt: Date.now() + 4 * 60 * 1000, refreshToken: "old-refresh" })
    });
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse("second-access", "second-refresh"));
    const client = new OAuthClient(fetchImplementation, secrets);

    await expect(client.restorePersistedSession(profile, endpoints)).resolves.toBe(true);

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(fetchImplementation.mock.calls[0][1]?.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
    expect(parsePersistedToken(secrets.data.get(profile.id) ?? "")).toMatchObject({
      accessToken: "second-access",
      refreshToken: "second-refresh"
    });
    expect(secrets.data.get(profile.id)).not.toContain("httpStatus");
    expect(await client.getAccessToken(profile, endpoints)).toBe("second-access");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("deletes the secret when refresh fails or no refresh token exists, without another request", async () => {
    const failed = memorySecrets({
      [profile.id]: serializePersistedToken({ accessToken: access, expiresAt: Date.now() - 1000, refreshToken: refresh })
    });
    const fetchImplementation = vi.fn<typeof fetch>(async () => { throw new Error("network down"); });
    const client = new OAuthClient(fetchImplementation, failed);
    await expect(client.restorePersistedSession(profile, endpoints)).resolves.toBe(false);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(failed.data.has(profile.id)).toBe(false);
    expect(client.hasActiveSession(profile.id)).toBe(false);

    const missingRefresh = memorySecrets({
      [profile.id]: serializePersistedToken({ accessToken: access, expiresAt: 0 })
    });
    const quiet = vi.fn<typeof fetch>();
    await expect(new OAuthClient(quiet, missingRefresh).restorePersistedSession(profile, endpoints)).resolves.toBe(false);
    expect(quiet).not.toHaveBeenCalled();
    expect(missingRefresh.data.has(profile.id)).toBe(false);
  });

  it("deletes corrupt secrets and keeps secrets when the store cannot be read", async () => {
    const corrupt = memorySecrets({
      [profile.id]: JSON.stringify({ accessToken: access, expiresAt: Date.now() + 10 * 60 * 1000, httpStatus: 200 })
    });
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(new OAuthClient(fetchImplementation, corrupt).restorePersistedSession(profile, endpoints)).resolves.toBe(false);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(corrupt.data.has(profile.id)).toBe(false);

    const kept = serializePersistedToken({ accessToken: access, expiresAt: Date.now() + 10 * 60 * 1000, refreshToken: refresh });
    const data = new Map([[profile.id, kept]]);
    const locked: TokenSecretStore = {
      get: async () => { throw new Error(`locked ${access}`); },
      set: async () => undefined,
      delete: async (id) => { data.delete(id); }
    };
    const warnings: string[] = [];
    const client = new OAuthClient(fetchImplementation, locked, {
      warn: (event, fields) => { warnings.push(JSON.stringify({ event, fields })); }
    });
    await expect(client.restorePersistedSession(profile, endpoints)).resolves.toBe(false);
    expect(data.get(profile.id)).toBe(kept);
    expect(client.hasActiveSession(profile.id)).toBe(false);
    expect(warnings.join("\n")).not.toContain(access);
    expect(warnings.join("\n")).toContain("token_secret_read_failed");
  });

  it("keeps the new memory token when persistence fails and does not log it", async () => {
    const warnings: string[] = [];
    const secrets: TokenSecretStore = {
      get: async () => undefined,
      set: async () => { throw new Error(`failed to store ${access}`); },
      delete: async () => undefined
    };
    const client = new OAuthClient(tokenFetch(), secrets, {
      warn: (event, fields) => { warnings.push(JSON.stringify({ event, fields })); }
    });
    await completeAuthorization(client);
    expect(client.hasActiveSession(profile.id)).toBe(true);
    expect(warnings.join("\n")).toContain("token_persist_failed");
    expect(warnings.join("\n")).not.toContain(access);
    expect(warnings.join("\n")).not.toContain(refresh);
  });

  it("expires a stored access token after 401 and keeps the refresh token for the next session", async () => {
    const secrets = memorySecrets();
    const client = new OAuthClient(tokenFetch(), secrets);
    await completeAuthorization(client);
    await client.invalidateAccessToken(profile.id, access);

    const stored = parsePersistedToken(secrets.data.get(profile.id) ?? "");
    expect(stored?.expiresAt).toBe(0);
    expect(stored?.refreshToken).toBe(refresh);
    expect(secrets.data.get(profile.id)).not.toContain("httpStatus");

    const restartFetch = vi.fn<typeof fetch>(async () => tokenResponse("second-access", "second-refresh"));
    const restarted = new OAuthClient(restartFetch, secrets);
    await expect(restarted.restorePersistedSession(profile, endpoints)).resolves.toBe(true);
    expect(restartFetch).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(restartFetch.mock.calls[0][1]?.body as URLSearchParams).get("refresh_token")).toBe(refresh);
  });

  it("does not replace a stored token until the new authorization succeeds", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse(access, refresh))
      .mockResolvedValueOnce(tokenResponse("second-access", "second-refresh"));
    const client = new OAuthClient(fetchImplementation, secrets);
    await completeAuthorization(client);
    const previous = secrets.data.get(profile.id);
    const pending = client.beginAuthorization(profile, endpoints, redirectUri);
    expect(secrets.data.get(profile.id)).toBe(previous);

    const callback = new URL(`${redirectUri}?state=${new URL(pending.authorizationUrl).searchParams.get("state")}&code=next-code`);
    await client.completeAuthorizationCallback(callback);
    await pending.completion;
    expect(parsePersistedToken(secrets.data.get(profile.id) ?? "")?.accessToken).toBe("second-access");
  });

  it("deletes a stored token only through deleteStoredToken", async () => {
    const secrets = memorySecrets();
    const client = new OAuthClient(tokenFetch(), secrets);
    await completeAuthorization(client);
    client.invalidate(profile.id);
    expect(secrets.data.has(profile.id)).toBe(true);
    await client.deleteStoredToken(profile.id);
    expect(secrets.data.has(profile.id)).toBe(false);

    let deleted = false;
    const absent: TokenSecretStore = {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => { deleted = true; }
    };
    await expect(new OAuthClient(vi.fn<typeof fetch>(), absent).deleteStoredToken(profile.id)).resolves.toBeUndefined();
    expect(deleted).toBe(false);
  });

  it("does not restore a refresh that finishes after the secret is deleted", async () => {
    let releaseRefresh: (value: Response) => void = () => undefined;
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse(access, refresh))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseRefresh = resolve; }));
    const secrets = memorySecrets({
      "other-profile": serializePersistedToken({
        accessToken: "other-access",
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: "other-refresh"
      })
    });
    const client = new OAuthClient(fetchImplementation, secrets);
    await completeAuthorization(client);
    await client.invalidateAccessToken(profile.id, access);
    const refreshing = client.getAccessToken(profile, endpoints);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));

    await client.deleteStoredToken(profile.id);
    releaseRefresh(tokenResponse("new-access", "new-refresh"));
    await refreshing;

    expect(secrets.data.has(profile.id)).toBe(false);
    expect(client.hasActiveSession(profile.id)).toBe(false);
    expect(parsePersistedToken(secrets.data.get("other-profile") ?? "")?.refreshToken).toBe("other-refresh");
  });

  it("does not let a stale 401 overwrite a newer refresh token", async () => {
    const secrets = memorySecrets({
      [profile.id]: serializePersistedToken({
        accessToken: "new-access",
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: "new-refresh"
      })
    });
    const client = new OAuthClient(vi.fn<typeof fetch>(), secrets);
    await client.restorePersistedSession(profile, endpoints);

    await client.invalidateAccessToken(profile.id, "old-access");

    expect(parsePersistedToken(secrets.data.get(profile.id) ?? "")).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh"
    });
    expect(client.hasActiveSession(profile.id)).toBe(true);
  });

  it("applies a paused 401 read before a newer refresh write, so the new refresh wins", async () => {
    const oldRaw = serializePersistedToken({
      accessToken: "old-access",
      expiresAt: Date.now() + 10 * 60 * 1000,
      refreshToken: "old-refresh"
    });
    const data = new Map([[profile.id, oldRaw]]);
    let reads = 0;
    let releaseRead: (value: string) => void = () => undefined;
    const secrets: TokenSecretStore = {
      get: async () => {
        reads += 1;
        if (reads === 1) {
          return oldRaw;
        }
        return new Promise<string>((resolve) => { releaseRead = resolve; });
      },
      set: async (id, value) => { data.set(id, value); },
      delete: async (id) => { data.delete(id); }
    };
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse("new-access", "new-refresh"));
    const client = new OAuthClient(fetchImplementation, secrets);
    await client.restorePersistedSession(profile, endpoints);

    const invalidating = client.invalidateAccessToken(profile.id, "old-access");
    await vi.waitFor(() => expect(reads).toBe(2));
    const refreshed = client.getAccessToken(profile, endpoints);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));
    releaseRead(oldRaw);
    await invalidating;
    await refreshed;

    expect(parsePersistedToken(data.get(profile.id) ?? "")).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh"
    });
  });

  it("does not create a secret when the callback arrives after the profile is deleted", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse(access, refresh));
    const secrets = memorySecrets();
    const client = new OAuthClient(fetchImplementation, secrets);
    const request = client.beginAuthorization(profile, endpoints, redirectUri);
    await client.deleteStoredToken(profile.id);

    const callback = new URL(`${redirectUri}?state=${new URL(request.authorizationUrl).searchParams.get("state")}&code=late-code`);
    await expect(client.completeAuthorizationCallback(callback)).resolves.toMatchObject({ statusCode: 400 });
    await expect(request.completion).rejects.toMatchObject({ code: "authorization-cancelled" });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(secrets.data.has(profile.id)).toBe(false);
    expect(client.hasActiveSession(profile.id)).toBe(false);
  });

  it("does not save an in-flight token exchange after close cancels authorization", async () => {
    let releaseExchange: (value: Response) => void = () => undefined;
    const fetchImplementation = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { releaseExchange = resolve; }));
    const secrets = memorySecrets({
      [profile.id]: serializePersistedToken({
        accessToken: "kept-access",
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: "kept-refresh"
      })
    });
    const client = new OAuthClient(fetchImplementation, secrets);
    const request = client.beginAuthorization(profile, endpoints, redirectUri);
    const callback = new URL(`${redirectUri}?state=${new URL(request.authorizationUrl).searchParams.get("state")}&code=late-code`);
    const completing = client.completeAuthorizationCallback(callback);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));

    await client.clear();
    await expect(request.completion).rejects.toMatchObject({ code: "authorization-cancelled" });
    releaseExchange(tokenResponse("new-access", "new-refresh"));
    await expect(completing).resolves.toMatchObject({ statusCode: 400 });
    expect(parsePersistedToken(secrets.data.get(profile.id) ?? "")?.accessToken).toBe("kept-access");
    expect(client.hasActiveSession(profile.id)).toBe(false);
  });

  it("keeps the memory session and secret when deletion fails", async () => {
    const secrets = memorySecrets();
    const client = new OAuthClient(tokenFetch(), secrets);
    await completeAuthorization(client);
    secrets.delete = async () => { throw new Error("secret-locked"); };

    await expect(client.deleteStoredToken(profile.id)).rejects.toThrow("secret-locked");

    expect(secrets.data.has(profile.id)).toBe(true);
    expect(client.hasActiveSession(profile.id)).toBe(true);
    await expect(client.getAccessToken(profile, endpoints)).resolves.toBe(access);
  });
});

function memorySecrets(initial: Record<string, string> = {}): TokenSecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (id) => data.get(id),
    set: async (id, value) => { data.set(id, value); },
    delete: async (id) => { data.delete(id); }
  };
}

function tokenResponse(accessToken: string, refreshToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 }), { status: 200 });
}

function tokenFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async () => tokenResponse("access-token-not-logged", "refresh-token-not-logged"));
}

async function completeAuthorization(client: OAuthClient): Promise<void> {
  const request = client.beginAuthorization(profile, buildNetSuiteEndpoints("9832121-sb1"), redirectUri);
  const callback = new URL(`${redirectUri}?state=${new URL(request.authorizationUrl).searchParams.get("state")}&code=authorization-code-not-logged`);
  await client.completeAuthorizationCallback(callback);
  await request.completion;
}
