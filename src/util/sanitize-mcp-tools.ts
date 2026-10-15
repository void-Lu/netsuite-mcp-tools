/**
 * Sanitize outbound MCP tool definitions for clients that choke on Oracle's
 * full tool metadata — notably SuiteCloud Developer Assistant.
 *
 * Evidence (2026-10-15): SuiteCloud DA returns HTTP 204 with an empty body when
 * an OpenAI-style tool `description` exceeds 4096 characters (4096 OK, 4097+
 * → 204). It also 204s when `parameters.title` / root `inputSchema.title` is
 * present. Cap descriptions below 4096 so there is margin for client-side
 * wrapping, and strip those root titles defensively.
 */
export const SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX = 4000;

const SCHEMA_KEYS = ["inputSchema", "parameters"] as const;

export function sanitizeToolDefinition(tool: unknown): unknown {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    return tool;
  }

  const source = tool as Record<string, unknown>;
  const sanitized: Record<string, unknown> = { ...source };

  if (typeof sanitized.description === "string" && sanitized.description.length > SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX) {
    sanitized.description = sanitized.description.slice(0, SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX);
  }

  for (const key of SCHEMA_KEYS) {
    const schema = sanitized[key];
    if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
      const copy = { ...(schema as Record<string, unknown>) };
      delete copy.title;
      sanitized[key] = copy;
    }
  }

  return sanitized;
}

function sanitizeJsonRpcEnvelope(value: unknown): { changed: boolean; value: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { changed: false, value };
  }

  const envelope = value as Record<string, unknown>;
  const result = envelope.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { changed: false, value };
  }

  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) {
    return { changed: false, value };
  }

  const sanitizedTools = tools.map((tool) => sanitizeToolDefinition(tool));
  return {
    changed: true,
    value: {
      ...envelope,
      result: {
        ...(result as Record<string, unknown>),
        tools: sanitizedTools
      }
    }
  };
}

/**
 * Rewrite a `tools/list` HTTP response body (plain JSON-RPC or SSE with
 * `data:` lines). Non-tools payloads and unparseable bodies are returned as-is.
 */
export function sanitizeToolsListResponseBody(body: string): string {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const { changed, value } = sanitizeJsonRpcEnvelope(parsed);
      return changed ? JSON.stringify(value) : body;
    } catch {
      return body;
    }
  }

  if (!body.includes("data:")) {
    return body;
  }

  let changed = false;
  const rewritten = body.split("\n").map((line) => {
    const match = /^(data:\s*)(.*)$/.exec(line);
    if (!match) {
      return line;
    }
    const [, prefix, payload] = match;
    if (!payload || payload === "[DONE]") {
      return line;
    }
    try {
      const parsed = JSON.parse(payload) as unknown;
      const result = sanitizeJsonRpcEnvelope(parsed);
      if (!result.changed) {
        return line;
      }
      changed = true;
      return `${prefix}${JSON.stringify(result.value)}`;
    } catch {
      return line;
    }
  }).join("\n");

  return changed ? rewritten : body;
}

/** True when a JSON-RPC request body is a tools/list call (id optional). */
export function isToolsListRequestBody(body: Buffer | string): boolean {
  const text = typeof body === "string" ? body : body.toString("utf8");
  if (!text) {
    return false;
  }
  try {
    const parsed = JSON.parse(text) as { method?: unknown };
    return parsed.method === "tools/list";
  } catch {
    return false;
  }
}
