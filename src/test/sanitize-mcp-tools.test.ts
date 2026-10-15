import { describe, expect, it } from "vitest";
import {
  SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX,
  isToolsListRequestBody,
  sanitizeToolDefinition,
  sanitizeToolsListResponseBody
} from "../util/sanitize-mcp-tools";

describe("sanitizeToolDefinition", () => {
  it("truncates description longer than the SuiteCloud-safe max", () => {
    const long = "a".repeat(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX + 500);
    const sanitized = sanitizeToolDefinition({
      name: "ns_runCustomSuiteQL",
      description: long,
      inputSchema: { type: "object", properties: {} }
    }) as { description: string };

    expect(sanitized.description.length).toBe(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX);
    expect(sanitized.description).toBe(long.slice(0, SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX));
  });

  it("leaves descriptions at or under the max unchanged", () => {
    const exact = "b".repeat(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX);
    const short = "short desc";
    expect(
      (sanitizeToolDefinition({ name: "t", description: exact }) as { description: string }).description
    ).toBe(exact);
    expect(
      (sanitizeToolDefinition({ name: "t", description: short }) as { description: string }).description
    ).toBe(short);
  });

  it("strips root title from inputSchema and parameters without touching nested titles", () => {
    const sanitized = sanitizeToolDefinition({
      name: "wiki_write_note",
      description: "ok",
      title: "keep-mcp-title",
      inputSchema: {
        title: "kill-me",
        type: "object",
        properties: {
          title: { type: "string", title: "Note title" }
        }
      },
      parameters: {
        title: "also-kill",
        type: "object",
        properties: { title: { type: "string" } }
      }
    }) as {
      title?: string;
      inputSchema: { title?: string; properties: { title: { title?: string } } };
      parameters: { title?: string; properties: { title: unknown } };
    };

    expect(sanitized.title).toBe("keep-mcp-title");
    expect(sanitized.inputSchema.title).toBeUndefined();
    expect(sanitized.parameters.title).toBeUndefined();
    expect(sanitized.inputSchema.properties.title.title).toBe("Note title");
    expect(sanitized.parameters.properties.title).toEqual({ type: "string" });
  });

  it("returns non-object tools unchanged", () => {
    expect(sanitizeToolDefinition(null)).toBeNull();
    expect(sanitizeToolDefinition("x")).toBe("x");
  });
});

describe("sanitizeToolsListResponseBody", () => {
  it("sanitizes tools in a JSON-RPC tools/list result", () => {
    const long = "c".repeat(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX + 1);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "ns_runCustomSuiteQL",
            description: long,
            inputSchema: { title: "bad", type: "object" }
          }
        ]
      }
    });

    const out = JSON.parse(sanitizeToolsListResponseBody(body)) as {
      result: { tools: Array<{ description: string; inputSchema: { title?: string } }> };
    };
    expect(out.result.tools[0].description.length).toBe(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX);
    expect(out.result.tools[0].inputSchema.title).toBeUndefined();
  });

  it("sanitizes tools embedded in SSE data lines", () => {
    const long = "d".repeat(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX + 10);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "t", description: long, inputSchema: { title: "x", type: "object" } }] }
    });
    const sse = `event: message\ndata: ${payload}\n\n`;
    const out = sanitizeToolsListResponseBody(sse);
    expect(out.startsWith("event: message\ndata: ")).toBe(true);
    const dataLine = out.split("\n").find((line) => line.startsWith("data: "))!;
    const parsed = JSON.parse(dataLine.slice("data: ".length)) as {
      result: { tools: Array<{ description: string; inputSchema: { title?: string } }> };
    };
    expect(parsed.result.tools[0].description.length).toBe(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX);
    expect(parsed.result.tools[0].inputSchema.title).toBeUndefined();
  });

  it("returns non-tools JSON-RPC bodies unchanged", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    expect(sanitizeToolsListResponseBody(body)).toBe(body);
  });

  it("returns unparseable bodies unchanged", () => {
    expect(sanitizeToolsListResponseBody("not-json")).toBe("not-json");
  });
});

describe("SuiteCloud safe description max", () => {
  it("stays at or below the known SuiteCloud 4096 hard limit with margin", () => {
    expect(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX).toBeLessThanOrEqual(4096);
    expect(SUITECLOUD_SAFE_TOOL_DESCRIPTION_MAX).toBe(4000);
  });
});

describe("isToolsListRequestBody", () => {
  it("detects tools/list JSON-RPC requests", () => {
    expect(isToolsListRequestBody(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }))).toBe(true);
    expect(isToolsListRequestBody(Buffer.from(JSON.stringify({ method: "tools/list" })))).toBe(true);
  });

  it("rejects other methods and invalid bodies", () => {
    expect(isToolsListRequestBody(JSON.stringify({ method: "initialize" }))).toBe(false);
    expect(isToolsListRequestBody("")).toBe(false);
    expect(isToolsListRequestBody("not-json")).toBe(false);
  });
});
