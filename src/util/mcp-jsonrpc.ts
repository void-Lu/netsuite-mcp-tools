/**
 * Small JSON-RPC helpers for the local MCP proxy.
 *
 * Cline's Streamable HTTP transport treats any non-2xx HTTP status as a
 * transport failure (fires onerror → reconnect loop), even when the body is a
 * valid JSON-RPC application error such as -32601 Method not found.
 * NetSuite answers some capability probes (notably resources/templates/list)
 * with HTTP 400 + Capability not supported — rewrite those to HTTP 200 so
 * clients see a normal JSON-RPC error / empty result instead of restarting.
 */

export interface JsonRpcRequestInfo {
  method: string;
  id: string | number | null | undefined;
  hasId: boolean;
}

export function parseJsonRpcRequest(body: Buffer): JsonRpcRequestInfo | undefined {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.method !== "string" || record.method.length === 0) {
      return undefined;
    }
    const hasId = Object.prototype.hasOwnProperty.call(record, "id");
    return {
      method: record.method,
      id: hasId ? (record.id as string | number | null) : undefined,
      hasId
    };
  } catch {
    return undefined;
  }
}

/** Methods NetSuite advertises loosely but rejects; answer locally. */
export const LOCALLY_STUBBED_EMPTY_LIST_METHODS: Readonly<Record<string, string>> = {
  "resources/templates/list": "resourceTemplates"
};

export function buildEmptyListResultBody(method: string, id: string | number | null): string | undefined {
  const resultKey = LOCALLY_STUBBED_EMPTY_LIST_METHODS[method];
  if (!resultKey) {
    return undefined;
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { [resultKey]: [] }
  });
}

/**
 * If `statusCode` is a client/server error and `body` is a JSON-RPC message
 * with an `error` field (single object or batch), the HTTP status should be
 * 200 so Streamable HTTP clients do not treat it as a transport failure.
 */
export function shouldNormalizeJsonRpcErrorHttpStatus(statusCode: number, bodyUtf8: string): boolean {
  if (statusCode < 400) {
    return false;
  }
  const trimmed = bodyUtf8.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }
  try {
    const parsed = JSON.parse(bodyUtf8) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }
      return Object.prototype.hasOwnProperty.call(item, "error");
    });
  } catch {
    return false;
  }
}
