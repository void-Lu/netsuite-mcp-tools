import { describe, expect, it } from "vitest";
import { sanitizeLogFields } from "../util/redaction";

describe("log redaction", () => {
  it("drops credentials and request payloads from structured fields", () => {
    expect(sanitizeLogFields({ authorization: "Bearer token", accessToken: "token", method: "tools/list", statusCode: 200 })).toEqual({
      method: "tools/list",
      statusCode: 200
    });
  });
});
