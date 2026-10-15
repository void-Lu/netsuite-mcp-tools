import { describe, expect, it } from "vitest";
import {
  buildEmptyListResultBody,
  parseJsonRpcRequest,
  shouldNormalizeJsonRpcErrorHttpStatus
} from "../util/mcp-jsonrpc";

describe("mcp-jsonrpc helpers", () => {
  it("parses method and id from a JSON-RPC request body", () => {
    const info = parseJsonRpcRequest(
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/templates/list", params: {} }), "utf8")
    );
    expect(info).toEqual({ method: "resources/templates/list", id: 3, hasId: true });
  });

  it("builds an empty resourceTemplates result for the Cline probe", () => {
    expect(JSON.parse(buildEmptyListResultBody("resources/templates/list", 3)!)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { resourceTemplates: [] }
    });
    expect(buildEmptyListResultBody("tools/list", 1)).toBeUndefined();
  });

  it("normalizes HTTP 400 JSON-RPC errors but not plain 400s", () => {
    expect(
      shouldNormalizeJsonRpcErrorHttpStatus(
        400,
        JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Capability not supported" } })
      )
    ).toBe(true);
    expect(shouldNormalizeJsonRpcErrorHttpStatus(400, "not json")).toBe(false);
    expect(
      shouldNormalizeJsonRpcErrorHttpStatus(
        200,
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "x" } })
      )
    ).toBe(false);
  });
});
