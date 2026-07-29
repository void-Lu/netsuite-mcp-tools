import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { ConnectionProfile, NetSuiteEndpoints, NetSuiteMcpError } from "../domain/types";
import { OAuthClient } from "../net/oauth-client";
import { RedactedLogger } from "../services/redacted-logger";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export interface ProxyRoute {
  profile: ConnectionProfile;
  endpoints: NetSuiteEndpoints;
}

export type ResolveProxyRoute = (profileId: string) => Promise<ProxyRoute | undefined>;

export class McpProxy {
  private server: Server | undefined;
  private port: number | undefined;

  public constructor(
    private readonly oauthClient: OAuthClient,
    private readonly resolveRoute: ResolveProxyRoute,
    private readonly logger: RedactedLogger
  ) {}

  public async start(port: number): Promise<number> {
    if (this.server?.listening) {
      return this.port ?? port;
    }
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("代理服务器未初始化。"));
        return;
      }
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port, exclusive: true });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("无法确定本地代理端口。");
    }
    this.port = address.port;
    await this.logger.info("proxy_started", { port: this.port });
    return this.port;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await this.logger.info("proxy_stopped");
  }

  public isListening(): boolean {
    return this.server?.listening ?? false;
  }

  public getUrl(profileId: string): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/${profileId}/mcp` : undefined;
  }

  public getAuthorizationCallbackUrl(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/oauth/callback` : undefined;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const localUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (localUrl.pathname === "/oauth/callback") {
        if (request.method !== "GET") {
          this.respond(response, 405, "OAuth 回调只接受 GET 请求。");
          return;
        }
        const result = await this.oauthClient.completeAuthorizationCallback(localUrl);
        this.respondAuthorizationCallback(response, result.statusCode, result.message);
        return;
      }
      const segments = localUrl.pathname.split("/").filter(Boolean);
      if (segments.length !== 2 || segments[1] !== "mcp") {
        this.respond(response, 404, "未找到 MCP 入口。");
        return;
      }
      const route = await this.resolveRoute(segments[0]);
      if (!route) {
        this.respond(response, 503, "该 MCP 连接未启用。请在 VS Code 中启动连接。");
        return;
      }
      const body = await readRequestBody(request);
      await this.forward(route, request, response, localUrl.search, body);
    } catch (error) {
      await this.logger.error("proxy_request_failed", { message: error instanceof Error ? error.message : "unknown" });
      if (!response.headersSent) {
        if (error instanceof NetSuiteMcpError && error.code === "authorization-required") {
          this.respond(response, 503, error.message);
          return;
        }
        this.respond(response, 502, "本地 MCP 代理无法完成请求。请检查连接状态和诊断日志。");
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  }

  private async forward(
    route: ProxyRoute,
    request: IncomingMessage,
    response: ServerResponse,
    query: string,
    body: Buffer
  ): Promise<void> {
    const token = await this.oauthClient.getAccessToken(route.profile, route.endpoints);
    const mcpUrl = new URL(route.endpoints.mcpUrl);
    const headers = filterRequestHeaders(request.headers);
    headers.host = route.endpoints.host;
    headers.authorization = `Bearer ${token}`;
    headers["content-length"] = String(body.byteLength);

    await new Promise<void>((resolve, reject) => {
      const upstream = httpsRequest(
        {
          protocol: mcpUrl.protocol,
          hostname: mcpUrl.hostname,
          port: mcpUrl.port || undefined,
          method: request.method,
          path: `${mcpUrl.pathname}${query}`,
          headers
        },
        (upstreamResponse) => {
          if (upstreamResponse.statusCode === 401) {
            // 绝不重放 MCP 工具调用：它可能已在服务端产生写入副作用。仅使当前
            // 内存 access token 过期，让下一次独立请求按正常刷新路径取得新 token。
            this.oauthClient.invalidateAccessToken(route.profile.id);
          }
          const responseHeaders = filterResponseHeaders(upstreamResponse.headers);
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(response);
          upstreamResponse.once("end", () => {
            void this.logger.info("proxy_request", {
              profile: route.profile.id.slice(0, 8),
              statusCode: upstreamResponse.statusCode ?? 502,
              method: request.method
            });
            resolve();
          });
          upstreamResponse.once("error", reject);
        }
      );
      upstream.once("error", reject);
      upstream.end(body);
    });
  }

  private respond(response: ServerResponse, statusCode: number, message: string): void {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: message }));
  }

  private respondAuthorizationCallback(response: ServerResponse, statusCode: number, message: string): void {
    response.writeHead(statusCode, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff"
    });
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>NetSuite MCP 授权</title><body><p>${message}</p></body></html>`);
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error("MCP 请求体超过 1 MB 限制。");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function filterRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      const normalized = name.toLowerCase();
      if (value === undefined || HOP_BY_HOP_HEADERS.has(normalized) || normalized === "host" || normalized === "authorization") {
        return [];
      }
      return [[name, value]];
    })
  );
}

function filterResponseHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[] | number | undefined> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()))
  );
}
